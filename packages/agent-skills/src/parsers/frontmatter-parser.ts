import {
  frontmatterFencesOf,
  type FrontmatterFence,
  isPerRunParseRefusal,
  MARKDOWN_BY_CONTRACT,
  type MeasuredContent,
  parseContentCached,
  parseInputRefusal,
  parseRefusal,
  type ParseRoute,
  SKILL_TEXT_DECLARATION,
} from '@vibe-agent-toolkit/resources';

export interface FrontmatterSuccess {
  success: true;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface FrontmatterError {
  success: false;
  error: string;
  /**
   * The parse worker's refusal of the block for this run — a `ParseLimitError`
   * or `ParseWorkerDiedError` (`isPerRunParseRefusal`) — or `undefined` for a
   * refusal of the BYTES (no delimiter, invalid YAML, not a mapping, empty).
   * Carried so a caller reports a refusal as `RESOURCE_PARSE_LIMIT_EXCEEDED` /
   * `RESOURCE_PARSE_WORKER_DIED` (`parseRefusalIssue`) without reading `error`'s text.
   */
  cause: unknown;
}

export type FrontmatterResult = FrontmatterSuccess | FrontmatterError;

/** The frontmatter, or why there is none: {@link FrontmatterResult} without the body. */
type FrontmatterVerdict = Omit<FrontmatterSuccess, 'body'> | FrontmatterError;

/** What the parse worker decoded a document's frontmatter block to: `parseFrontmatterSource`'s result. */
interface DecodedFrontmatter {
  readonly frontmatter: Record<string, unknown> | undefined;
  readonly frontmatterError: string | undefined;
  readonly frontmatterNotAMapping: boolean;
}

/** A block the worker never decoded: no fences, or nothing between them. */
const NOTHING_DECODED: DecodedFrontmatter = { frontmatter: undefined, frontmatterError: undefined, frontmatterNotAMapping: false };

/** The refusal for a block that declares nothing. */
const EMPTY_BLOCK: FrontmatterError = {
  success: false,
  error: 'Frontmatter is empty: the block between the "---" delimiters declares no fields',
  cause: undefined,
};

/** U+0000, which CommonMark replaces before any extension reads the block. */
const NUL = String.fromCodePoint(0);

/** U+FFFD, what the markdown parser reads a {@link NUL} as. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xff_fd);

/**
 * A block's source as the markdown parser reads it back: CommonMark replaces
 * every U+0000 with U+FFFD before an extension sees the text (line endings and
 * a leading BOM are already normalized by the time this is called), so the
 * worker's `frontmatterSource` for a block holding a NUL is this, never the
 * bytes handed over.
 *
 * @param source - The block's YAML, as found by the fence rule
 * @returns What the parser's frontmatter extension reads for it
 */
function asParserReads(source: string): string {
  return source.replaceAll(NUL, REPLACEMENT_CHARACTER);
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: Description here
 * ---
 * Body content...
 * ```
 *
 * ## The decode is the parse worker's, never this thread's
 *
 * `yaml`'s composer recurses once per nesting level, so a deep block overflows
 * the stack of whatever thread decodes it, and a cyclic anchor (`a: &x [*x]`)
 * nests without end. Only the worker decodes, under its limits (ADR I8): this
 * function finds the block, hands exactly that block to the bounded route as a
 * one-block markdown document, and reads back the worker's decode — the one
 * `parseFrontmatterSource`, the one `isPlainMapping` and the one output check
 * (`outputBreach`: depth, rows, bytes, cycles) every crawl applies to the same
 * YAML. So both lanes give one answer per block, and a block the worker refuses
 * is refused here under the same code (`cause`). A cache hit starts no worker.
 *
 * ## Where the block is — the crawl lane's fence rule
 *
 * `frontmatterFencesOf` (resources) owns the rule, so the skill-text core's
 * body families count lines in exactly the body returned here: a leading BOM
 * dropped, `\r\n` and a lone `\r` each one line ending (as they are to the
 * markdown parser), the first line a fence (exactly three dashes, then optional
 * spaces or tabs, as `remark-frontmatter` reads one), the block ended by the
 * next fence line; no closing fence, no frontmatter.
 *
 * @param input - Full SKILL.md content, measured in the bytes it came from: a file lane's own read
 *   (`readContentForParse`), so the cap is in the unit that read was held to; content never read,
 *   through `inMemoryContent`
 * @param route - Where the parse runs: the run's dispatcher when a run decodes many
 *   blocks, or `{ dispatcher: undefined }` for one read, whose cache miss builds a one-thread pool for this
 *   call. Required, so a caller holding a run's dispatcher cannot forget to pass it
 * @returns Parsed frontmatter and body, or the refusal
 * @throws `ParserUnavailableError` for a broken install, and anything else the
 *   bounded route throws that is not a per-run refusal of this block
 */
export function parseFrontmatter(input: MeasuredContent, route: ParseRoute): Promise<FrontmatterResult> {
  // The whole content is held to the route's input cap, as a file read for a parse is
  // (`readContentForParse`): content past it is refused, never cut down to a block that fits.
  const tooLarge = parseInputRefusal(input.byteLength, route);
  if (tooLarge !== undefined) return Promise.resolve(refused(tooLarge));
  const { content } = input;
  const { lines, opened, closing } = frontmatterFencesOf(content, SKILL_TEXT_DECLARATION);

  if (!opened) return Promise.resolve(withBody(frontmatterVerdictOf('none', NOTHING_DECODED), ''));
  if (closing === -1) return Promise.resolve(withBody(frontmatterVerdictOf('unclosed', NOTHING_DECODED), ''));

  const { lineSeparator } = SKILL_TEXT_DECLARATION;
  const source = lines.slice(1, closing).join(lineSeparator);
  const body = lines.slice(closing + 1).join(lineSeparator);

  // A block that declares NOTHING — empty, whitespace, comment-only, `~`, `null`
  // — is the rule `parseFrontmatterSource` (the crawl lane's decode) applies:
  // "no value" by the document's own word, NOT a non-mapping, and no keys. A
  // skill without frontmatter fields is not a skill, so it is refused — saying
  // it is empty, never that it is not a mapping.
  if (source.trim() === '') return Promise.resolve(withBody(frontmatterVerdictOf('closed', NOTHING_DECODED), body));

  return decodeBlock(source, body, route);
}

/**
 * A SKILL.md's frontmatter verdict from where its fences are and what its block
 * decoded to: the ONE wording of every refusal of the bytes, which
 * {@link parseFrontmatter} returns and a lane holding a document's stored facts
 * (the record's `frontmatterFence`, the parse's frontmatter verdict) returns
 * without reading the file. A per-run refusal (`cause`) is not one of these: a
 * caller with the document's facts never met one, and this parser returns its
 * own.
 *
 * A closed block that declares NOTHING (empty, whitespace, comment-only, `~`,
 * `null`) is "no value" by the document's own word, as `parseFrontmatterSource`
 * reads it: NOT a non-mapping, and no keys. A skill without frontmatter fields
 * is not a skill, so it is refused, saying it is empty. A block that decoded
 * but is not a PLAIN mapping (a scalar, a sequence, a `!!set` / `!!omap` /
 * `!!timestamp` / `!!binary` root) is refused saying so, because "no
 * frontmatter" over a file that plainly has a `---` block sends the author to
 * the wrong fix.
 *
 * @param fence - Where the fences are
 * @param decoded - The block's decode; nothing for a document whose fences are not closed
 * @returns The frontmatter, or the refusal
 */
export function frontmatterVerdictOf(fence: FrontmatterFence, decoded: DecodedFrontmatter): FrontmatterVerdict {
  if (fence === 'none') {
    return { success: false, error: 'No frontmatter found - must start at beginning with "---" delimiter', cause: undefined };
  }
  if (fence === 'unclosed') return { success: false, error: 'No closing delimiter found', cause: undefined };
  if (decoded.frontmatterError !== undefined) {
    return { success: false, error: `Failed to parse YAML frontmatter: ${decoded.frontmatterError}`, cause: undefined };
  }
  if (decoded.frontmatterNotAMapping) {
    return {
      success: false,
      error:
        'Frontmatter is not a YAML mapping: the block between the "---" delimiters is a sequence, a scalar or a typed value, not key: value fields',
      cause: undefined,
    };
  }
  if (decoded.frontmatter === undefined) return EMPTY_BLOCK;
  return { success: true, frontmatter: decoded.frontmatter };
}

/**
 * @param error - A per-run refusal of the content or its block (`isPerRunParseRefusal`)
 * @returns This parser's result for it
 */
function refused(error: Parameters<typeof parseRefusal>[0]): FrontmatterError {
  return { success: false, error: `Frontmatter was not decoded: ${parseRefusal(error).reason}`, cause: error };
}

/**
 * The worker's decode of one block's YAML source, as this parser's result.
 *
 * @param source - The block's YAML, delimiters excluded
 * @param body - What follows the closing fence
 * @param route - Where the parse runs
 * @returns The frontmatter, or the refusal
 */
async function decodeBlock(source: string, body: string, route: ParseRoute): Promise<FrontmatterResult> {
  let parsed: Awaited<ReturnType<typeof parseContentCached>>;
  try {
    parsed = await parseContentCached(`---\n${source}\n---\n`, MARKDOWN_BY_CONTRACT, route);
  } catch (error) {
    if (!isPerRunParseRefusal(error)) throw error;
    return refused(error);
  }

  // The block handed over is fenced by construction, so the worker reads back
  // exactly `source`, normalized as CommonMark normalizes it (`asParserReads`).
  // Anything else is VAT's defect, never a fact about the bytes.
  if (parsed.frontmatterSource !== asParserReads(source)) {
    throw new Error(
      'VAT defect: the parse worker read a different frontmatter block than the one it was handed. Please report it.',
    );
  }

  const verdict = frontmatterVerdictOf('closed', {
    frontmatter: parsed.frontmatter,
    frontmatterError: parsed.frontmatterError,
    frontmatterNotAMapping: parsed.frontmatterNotAMapping === true,
  });
  return withBody(verdict, body);
}

/**
 * @param verdict - A block's verdict
 * @param body - What follows its closing fence
 * @returns This parser's result: the body beside the frontmatter, a refusal as it is
 */
function withBody(verdict: FrontmatterVerdict, body: string): FrontmatterResult {
  return verdict.success ? { ...verdict, body } : verdict;
}

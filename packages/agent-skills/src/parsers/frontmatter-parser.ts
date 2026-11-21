import {
  frontmatterFencesOf,
  isPerRunParseRefusal,
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

  if (!opened) {
    return Promise.resolve({
      success: false,
      error: 'No frontmatter found - must start at beginning with "---" delimiter',
      cause: undefined,
    });
  }

  if (closing === -1) {
    return Promise.resolve({ success: false, error: 'No closing delimiter found', cause: undefined });
  }

  const { lineSeparator } = SKILL_TEXT_DECLARATION;
  const source = lines.slice(1, closing).join(lineSeparator);
  const body = lines.slice(closing + 1).join(lineSeparator);

  // A block that declares NOTHING — empty, whitespace, comment-only, `~`, `null`
  // — is the rule `parseFrontmatterSource` (the crawl lane's decode) applies:
  // "no value" by the document's own word, NOT a non-mapping, and no keys. A
  // skill without frontmatter fields is not a skill, so it is refused — saying
  // it is empty, never that it is not a mapping.
  if (source.trim() === '') return Promise.resolve(EMPTY_BLOCK);

  return decodeBlock(source, body, route);
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
    parsed = await parseContentCached(`---\n${source}\n---\n`, 'markdown', route);
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

  if (parsed.frontmatterError !== undefined) {
    return { success: false, error: `Failed to parse YAML frontmatter: ${parsed.frontmatterError}`, cause: undefined };
  }

  // A block that decoded but is not a PLAIN mapping is refused HERE, by the
  // rule every lane reads (`isPlainMapping`, applied by the worker): a scalar,
  // a sequence, and the typed roots `!!set` / `!!omap` / `!!timestamp` /
  // `!!binary`. The refusal says so, because "no frontmatter" over a file that
  // plainly has a `---` block sends the author to the wrong fix.
  if (parsed.frontmatterNotAMapping === true) {
    return {
      success: false,
      error:
        'Frontmatter is not a YAML mapping: the block between the "---" delimiters is a sequence, a scalar or a typed value, not key: value fields',
      cause: undefined,
    };
  }

  if (parsed.frontmatter === undefined) return EMPTY_BLOCK;
  return { success: true, frontmatter: parsed.frontmatter, body };
}

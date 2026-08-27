/**
 * The markdown composer — one `ParseResult` from one parser's capabilities plus
 * VAT's own derivations.
 *
 * What a parser supplies and what VAT derives are two different lists, and
 * keeping them apart is the point of `parse-capabilities.ts`:
 *
 * | From the parser | Derived here, from raw source and spans |
 * |---|---|
 * | `links`, `anchors`, `frontmatterSource` (spans-and-kinds) | `estimatedTokenCount` |
 * | flat headings (structure) | `unresolvedReferences`, `lexicalReferences` |
 * | | `contentMeasures`, `frontmatter`, `frontmatterError` |
 * | | heading slugs and the heading tree |
 *
 * Also defines the format-neutral `ParseResult` contract shared with the HTML
 * parser (`html-link-parser.ts`). The `HtmlParseError` shape is Zod-sourced from
 * `schemas/resource-metadata.ts` (single source of truth).
 */

import { stat } from 'node:fs/promises';

import { readTextContent } from '@vibe-agent-toolkit/utils/fs';
import GithubSlugger from 'github-slugger';

import { parseFrontmatterSource } from './frontmatter-source.js';
import { estimateTokens } from './link-classify.js';
import {
  type FlatHeading,
  type MarkdownParser,
  MissingCapabilityError,
  type SpanFacts,
  type StructureFacts,
} from './parse-capabilities.js';
import {
  ParsePass,
  ParserKind,
  parseTimingStart,
  recordParsedDocument,
  recordParsePass,
} from './parse-timing.js';
import { measureContent } from './projection/blob-facts.js';
import { codeContextRangesFrom, findLexicalReferences } from './reference-lexer.js';
import { remarkParser } from './remark-parser.js';
import type { ContentMeasures, LexicalReference } from './schemas/parse-facts.js';
import type { HtmlParseError } from './schemas/resource-metadata.js';
import type { HeadingNode, ResourceLink, UnresolvedReference } from './types.js';
import { findUnresolvedReferences } from './unresolved-references.js';

/**
 * Result of parsing a resource file (markdown or HTML).
 */
export interface ParseResult {
  links: ResourceLink[];
  headings: HeadingNode[];
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  /**
   * The frontmatter block's YAML **source**, delimiters excluded.
   *
   * Absent (key omitted) when the document has no frontmatter block at all;
   * present-and-empty (`''`) for a block whose body is empty — so "empty block"
   * stays distinguishable from "no block", which is a distinction neither
   * {@link frontmatter} nor {@link frontmatterError} can make (an empty block
   * leaves both absent, exactly as no block does).
   *
   * ## Why the source is carried next to the parsed object
   *
   * {@link frontmatter} cannot survive a JSON round trip, so nothing that
   * stores a `ParseResult` as JSON — a disk-backed parse cache, chiefly — can
   * reconstruct it from that field. Measured: `yaml` decodes `.inf` to
   * `Infinity`, `.nan` to `NaN` and `!!binary` to a `Buffer`; `JSON.stringify`
   * then maps the first two to `null` and mangles the third into an envelope
   * object, and a cyclic YAML anchor makes it throw outright — meaning such a
   * document could not be stored at all.
   *
   * Storing the source and re-running {@link parseFrontmatterSource} on a hit
   * is lossless **by construction**, because it is literally the same
   * computation the cold path runs. That is the only reason this field exists;
   * it is not a convenience copy.
   *
   * HTML documents leave it undefined, exactly as they leave
   * {@link frontmatter} undefined.
   */
  frontmatterSource?: string;
  content: string;
  sizeBytes: number;
  estimatedTokenCount: number;
  /**
   * Fragment targets declared as `id`/`name` attributes. HTML documents index
   * every element's; markdown indexes those in raw-HTML nodes (lowercased, to
   * match markdown's case-folded fragment policy) and omits the key entirely
   * when a document declares none.
   */
  anchors?: string[];
  /** HTML well-formedness diagnostics. Markdown leaves this undefined. */
  parseErrors?: HtmlParseError[];
  /**
   * Full (`[text][label]`) and collapsed (`[label][]`) reference-style link
   * occurrences whose label has no matching `[label]: url` definition. HTML
   * leaves this undefined; markdown always populates it (possibly empty).
   */
  unresolvedReferences?: UnresolvedReference[];
  /**
   * Reference candidates the markdown AST cannot produce: `@`-prefixed tokens,
   * variable-anchored paths, and bounded path-shaped bare tokens. See
   * `reference-lexer.ts` for what qualifies and what is excluded.
   *
   * The key is **omitted** when a document has none, matching {@link anchors}:
   * no own property of a `ParseResult` is ever valued `undefined`, which is
   * what makes the cache's JSON round trip exact under `toStrictEqual`. HTML
   * documents leave it undefined.
   */
  lexicalReferences?: LexicalReference[];
  /**
   * Word and code-unit accounting for this blob, split by code context —
   * `BlobRow`'s `wordCount` / `proseCodeUnits` / `codeBlockCodeUnits`.
   *
   * Computed at parse time rather than at population time because
   * `codeBlockCodeUnits` needs the code-block spans, which only a parse
   * reports. Both parsers currently always supply it, so the absent state is
   * defensive rather than reachable; the key stays optional to match
   * {@link anchors} and {@link lexicalReferences}, and because a `ParseResult`
   * assembled by hand (tests, a future producer) legitimately has nothing to
   * say here.
   */
  contentMeasures?: ContentMeasures;
}

/**
 * Parse a markdown file and extract all links, headings, and metadata.
 *
 * Reads the bytes, then delegates every parsing decision to
 * {@link parseMarkdownContent}. The only thing decided here is the byte size
 * attributed to the document: `stat().size`, the real size on disk.
 *
 * @param filePath - Absolute path to the markdown file
 * @returns Parsed markdown data including links, headings, size, and token estimate
 * @throws Error if file cannot be read or parsed
 *
 * @example
 * ```typescript
 * const result = await parseMarkdown('/path/to/document.md');
 * console.log(`Found ${result.links.length} links`);
 * console.log(`Document has ${result.headings.length} top-level headings`);
 * ```
 */
export async function parseMarkdown(filePath: string): Promise<ParseResult> {
  // Read file content and stats
  // `readTextContent`, never `readFile(path, 'utf-8')`: this reads a CORPUS
  // document, whose encoding VAT does not choose. See text-content.ts.
  const [decoded, stats] = await Promise.all([
    readTextContent(filePath),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is user-provided path parameter
    stat(filePath),
  ]);

  // `stats.size` is RAW bytes and stays raw — see the `sizeBytes` note on
  // `parseMarkdownContent` for why it cannot be derived from the decoded string.
  return parseMarkdownContent(decoded.text, stats.size);
}

/**
 * Parse markdown **source** — the content-addressable half of
 * {@link parseMarkdown}.
 *
 * This is a pure function of its arguments: no filesystem access, no path, no
 * ambient state. That is what makes it cacheable by content, and it is what a
 * history replay needs — a historical blob read out of git is not on disk under
 * any path, so anything that insists on a `filePath` cannot parse it.
 * {@link parseMarkdown} is now just "read the bytes, then call this".
 *
 * ## Why `sizeBytes` is a parameter and NOT derived from `content`
 *
 * `content` is a **decoded** string; `sizeBytes` is a count of **bytes on
 * disk**. Those are not recoverable from one another:
 *
 * - `content.length` is UTF-16 code units — wrong for anything non-ASCII.
 * - `Buffer.byteLength(content, 'utf-8')` is the byte length of a *re-encoded*
 *   string, which diverges from the file's real size whenever the source bytes
 *   were not already well-formed UTF-8 (invalid sequences decode to U+FFFD and
 *   re-encode to three bytes each, so the round trip does not preserve length)
 *   — and it silently ignores a UTF-8 BOM the decoder stripped.
 *
 * The value reaches packaged-output accounting elsewhere in the toolkit, so it
 * must stay the caller's decision rather than a guess made here.
 * {@link parseMarkdown} passes `stat().size`, exactly as it always has; a
 * caller replaying a git blob passes that blob's byte length.
 *
 * @param content - Decoded markdown source
 * @param sizeBytes - Byte size the caller attributes to this content
 * @param parser - Which implementation supplies the two read-side capabilities.
 *   The default is the only one VAT ships; the conformance suite is what passes
 *   anything else, and it is the reason this is a parameter at all.
 * @returns Parsed markdown data including links, headings, size, and token estimate
 * @throws MissingCapabilityError if `parser` does not serve both read capabilities
 *
 * @example
 * ```typescript
 * const result = parseMarkdownContent('# Title\n', 8);
 * console.log(`Found ${result.links.length} links`);
 * ```
 */
export function parseMarkdownContent(
  content: string,
  sizeBytes: number,
  parser: MarkdownParser = remarkParser,
): ParseResult {
  // Every `passStartedAt` / `recordParsePass` pair is the sub-phase timing seam
  // (`parse-timing.ts`), off unless `VAT_PARSE_TIMING` names a dump directory.
  // `totalStartedAt` brackets the whole body, so a reader can compute
  // unattributed overhead as `markdown-total - sum(this kind's passes)`.
  // `parseHtmlContent` is instrumented the same way, into its own group.
  const totalStartedAt = parseTimingStart();

  let passStartedAt = parseTimingStart();
  const estimatedTokenCount = estimateTokens(content);
  recordParsePass(ParsePass.EstimateTokens, passStartedAt);

  // The parser's own passes — processor construction, tokenize/tree build and
  // the fact walk — are bracketed inside the implementation, so an arm's cost
  // stays attributable to the arm rather than to this composer.
  const session = parser.open(content);
  const { links, anchors, spans, frontmatterSource } = requireSpans(parser, session);
  const { headings } = requireStructure(parser, session);

  // Detect dangling reference-style links (full/collapsed forms with no
  // matching definition) — see findUnresolvedReferences for why this is a
  // raw-source scan rather than a structural one.
  passStartedAt = parseTimingStart();
  const unresolvedReferences = findUnresolvedReferences(content, spans);
  recordParsePass(ParsePass.UnresolvedReferences, passStartedAt);

  // Spans, sorted once for every consumer of code context. Both the lexer and
  // the measures want this partition, and computing it twice would sort the
  // same list twice on the cold path CI always pays.
  passStartedAt = parseTimingStart();
  const ranges = codeContextRangesFrom(spans);
  recordParsePass(ParsePass.CodeContextRanges, passStartedAt);

  // Reference candidates the parser reports as plain text — `@`-prefixed
  // tokens, variable-anchored paths, path-shaped bare tokens. A raw-source
  // scan, and for the same structural reason.
  passStartedAt = parseTimingStart();
  const lexicalReferences = findLexicalReferences(content, ranges);
  recordParsePass(ParsePass.LexicalReferences, passStartedAt);

  // Fenced AND indented code blocks are both `code-block` spans, so both count
  // as code here — which is the useful reading: neither is prose.
  passStartedAt = parseTimingStart();
  const contentMeasures = measureContent(content, ranges.fences);
  recordParsePass(ParsePass.MeasureContent, passStartedAt);

  // The parse decision is `parseFrontmatterSource`'s, not this function's, so a
  // cache rebuilding a hit reaches the identical logic.
  const { frontmatter, frontmatterError } =
    frontmatterSource === undefined
      ? {}
      : parseFrontmatterSource(frontmatterSource);

  // With exactOptionalPropertyTypes: true, we must conditionally include the property
  // rather than assigning undefined to it
  const result: ParseResult = {
    links,
    headings: toHeadingTree(headings),
    unresolvedReferences,
    ...(lexicalReferences.length > 0 && { lexicalReferences }),
    ...(anchors.length > 0 && { anchors }),
    ...(frontmatter !== undefined && { frontmatter }),
    ...(frontmatterError !== undefined && { frontmatterError }),
    ...(frontmatterSource !== undefined && { frontmatterSource }),
    contentMeasures,
    content,
    sizeBytes,
    estimatedTokenCount,
  };

  recordParsedDocument(ParserKind.Markdown, sizeBytes);
  recordParsePass(ParsePass.MarkdownTotal, totalStartedAt);

  return result;
}

/**
 * The session's spans-and-kinds facts, or a legible failure naming the parser.
 *
 * @throws MissingCapabilityError when the session does not serve the capability
 */
function requireSpans(parser: MarkdownParser, session: { spansAndKinds?: () => SpanFacts }): SpanFacts {
  if (session.spansAndKinds === undefined) {
    throw new MissingCapabilityError(parser.name, 'spans-and-kinds');
  }
  return session.spansAndKinds();
}

/**
 * The session's structure facts, or a legible failure naming the parser.
 *
 * @throws MissingCapabilityError when the session does not serve the capability
 */
function requireStructure(parser: MarkdownParser, session: { structure?: () => StructureFacts }): StructureFacts {
  if (session.structure === undefined) {
    throw new MissingCapabilityError(parser.name, 'structure');
  }
  return session.structure();
}

/**
 * Slug and nest a flat heading list — the two GitHub conventions VAT owns.
 *
 * Kept out of the `structure` capability deliberately: `github-slugger`'s
 * `-1`/`-2` suffixing and the parent/child nesting are conventions of the
 * *renderer*, not facts about the markdown dialect, so asking an implementation
 * for them would be asking it to reproduce something it has no reason to know.
 *
 * ⚠️ The slugger is stateful and MUST see headings in document order — that is
 * how it reproduces GitHub's duplicate suffixing.
 *
 * @param flatHeadings - Headings in document order, from the structure capability
 * @returns Top-level headings with children nested beneath them
 */
function toHeadingTree(flatHeadings: FlatHeading[]): HeadingNode[] {
  const slugger = new GithubSlugger();
  return buildHeadingTree(
    flatHeadings.map((heading) => ({
      level: heading.level,
      text: heading.text,
      slug: slugger.slug(heading.text),
      // Absent beats undefined-valued: it is what makes a fresh `ParseResult`
      // equal to its own JSON round trip, which a JSON-backed cache needs.
      ...(heading.line !== undefined && { line: heading.line }),
    })),
  );
}

/**
 * Build a nested heading tree from a flat list of headings.
 *
 * Uses a stack-based algorithm to correctly nest headings:
 * - When encountering a higher-level heading, pop stack until we find the parent
 * - Add the heading as a child of the top of stack
 * - Push the heading onto the stack
 *
 * @param flatHeadings - Array of headings in document order
 * @returns Array of top-level headings with nested children
 *
 * @example
 * For markdown:
 * ```
 * # Main
 * ## Sub
 * ### Deep
 * ## Sub2
 * ```
 *
 * Returns (note that a LEAF carries no `children` key at all — not an empty
 * array, and not an `undefined` value; see {@link cleanupEmptyChildren}):
 * ```
 * [
 *   {
 *     level: 1,
 *     text: 'Main',
 *     slug: 'main',
 *     children: [
 *       { level: 2, text: 'Sub', slug: 'sub', children: [
 *         { level: 3, text: 'Deep', slug: 'deep' }
 *       ]},
 *       { level: 2, text: 'Sub2', slug: 'sub2' }
 *     ]
 *   }
 * ]
 * ```
 */
function buildHeadingTree(flatHeadings: HeadingNode[]): HeadingNode[] {
  if (flatHeadings.length === 0) {
    return [];
  }

  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (const heading of flatHeadings) {
    // Initialize children array
    const headingWithChildren: HeadingNode = {
      ...heading,
      children: [],
    };

    // Pop stack until we find a heading with lower level (the parent)
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      // This is a root-level heading
      roots.push(headingWithChildren);
    } else {
      // Add as child of the top of stack
      const parent = stack.at(-1);
      if (parent) {
        parent.children ??= [];
        parent.children.push(headingWithChildren);
      }
    }

    // Push current heading onto stack
    stack.push(headingWithChildren);
  }

  // Leaves are built with `children: []`; strip the key back off them.
  cleanupEmptyChildren(roots);

  return roots;
}

/**
 * Strip the `children` key off leaf headings — **deleting** it, never assigning
 * `undefined`.
 *
 * ## Why `delete` and not `= undefined`
 *
 * The two are indistinguishable to every consumer (all of them use truthiness
 * or optional chaining, and the Zod schema uses `.optional()`), but they are
 * NOT indistinguishable to serialization: `JSON.stringify` drops an
 * undefined-valued key entirely, so a heading that went through a JSON-backed
 * parse cache comes back with the key ABSENT while a freshly parsed one has it
 * PRESENT-but-`undefined`. `assert.deepStrictEqual` and vitest's
 * `toStrictEqual` treat those as different values, so a cold-vs-warm
 * equivalence gate would go red on essentially every document in a corpus over
 * a difference nothing observes.
 *
 * Deleting makes the fresh result already equal to its own JSON round trip,
 * which is the property such a cache needs.
 *
 * @param headings - Array of headings to clean up, mutated in place
 */
function cleanupEmptyChildren(headings: HeadingNode[]): void {
  for (const heading of headings) {
    if (heading.children?.length === 0) {
      delete heading.children;
    } else if (heading.children && heading.children.length > 0) {
      cleanupEmptyChildren(heading.children);
    }
  }
}

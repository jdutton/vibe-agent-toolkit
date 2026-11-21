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

import { parseFrontmatterSource } from './frontmatter-source.js';
import { toHeadingTree } from './heading-tree.js';
import { estimateTokens } from './link-classify.js';
import {
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
   * Present (`true`) when the block is valid YAML that decodes to a sequence or
   * a scalar: no keys can be read from it, and `frontmatter` and
   * `frontmatterError` are both absent. A block that declares nothing (`~`,
   * `null`, comment-only) does not set it. Decided by the one decode, in the
   * parse worker — only the decoded VALUE tells the two apart, and the parent
   * never decodes YAML (`frontmatter-source.ts`).
   */
  frontmatterNotAMapping?: true;
  /**
   * The frontmatter block's YAML **source**, delimiters excluded.
   *
   * Absent (key omitted) when the document has no frontmatter block at all;
   * present-and-empty (`''`) for a block whose body is empty — so "empty block"
   * stays distinguishable from "no block", which is a distinction neither
   * {@link frontmatter} nor {@link frontmatterError} can make (an empty block
   * leaves both absent, exactly as no block does).
   *
   * The block as written, for readers that report or rewrite it. It is never
   * re-decoded to rebuild {@link frontmatter}: the worker's decode crosses the
   * thread boundary and the parse cache as `frontmatter-codec.ts`'s encoding.
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
 * Compose the parse facts for markdown **source** — the composer the parse
 * worker runs (`parser-loader.ts`), and nothing else in shipped code: every
 * caller reaches it through the bounded pool (`parse-dispatcher.ts`).
 *
 * This is a pure function of its arguments: no filesystem access, no path, no
 * ambient state. That is what makes it cacheable by content, and it is what a
 * history replay needs — a historical blob read out of git is not on disk under
 * any path, so anything that insists on a `filePath` cannot parse it.
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
 * The dispatcher passes the raw byte count of what it read.
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

  // The decode is `parseFrontmatterSource`'s, the one decode of a block. In the
  // parse worker it runs under the worker's stack limit; a cache hit and the
  // parent never re-run it — they rebuild the mapping from the worker's encoding.
  const { frontmatter, frontmatterError, frontmatterNotAMapping } =
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
    ...(frontmatterNotAMapping === true && { frontmatterNotAMapping }),
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

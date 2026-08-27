/**
 * `markdown-it` as a VAT parser implementation — test-only, never shipped.
 *
 * ## What this is for, and what it is not
 *
 * It is **not** a proposal to swap parsers. A single-implementation interface is
 * a claim nobody has tested, and a toolkit whose thesis is portability across
 * LLMs, frameworks and targets should be able to demonstrate parser
 * pluggability in its own core. This is the second implementation that turns
 * "loosely coupled" from an assertion into a measurement.
 *
 * It lives in `dev-tools` — not in `resources` — for two reasons that point the
 * same way: `markdown-it` is already a dependency here (`parser-bakeoff.ts`),
 * and putting it here keeps it out of every published package's dependency
 * graph.
 *
 * ## 🚩 Written so a gap is the PARSER's, never the adapter's
 *
 * A rival handed less work to do is a rival flattered by the result — the trap
 * `parser-bakeoff.ts` names for timing, and it applies to fidelity just as
 * hard. So this adapter is built to try everything short of forking
 * `markdown-it`, and {@link createMarkdownItProcessor} is configured to match
 * what VAT's remark chain is asked for rather than what is cheapest:
 *
 * | VAT's remark chain | The matching `markdown-it` configuration |
 * |---|---|
 * | remark parses raw HTML | `html: true` — the default preset escapes it as text |
 * | `remark-frontmatter` | `markdown-it-front-matter` |
 * | `remark-gfm` autolink literals | `linkify: true` |
 * | mdast `definition` nodes | the {@link capturePositions} block-rule wrapper |
 * | mdast tells `link` from `linkReference` | the {@link capturePositions} inline-rule wrapper |
 *
 * The two wrappers are the part worth reading. `markdown-it` resolves a link
 * definition into `env.references` and emits **no token** for it, and it
 * resolves a reference link into the same `link_open` token an inline link
 * produces — so on the face of it VAT's dangling-reference detection and its
 * `nodeType` field are both simply unreachable. They are not: a rule's *extent*
 * is observable by wrapping the rule, which is ordinary plugin practice and is
 * what an adopter would write. Reporting those two as parser limitations
 * without wrapping would have been the adapter's failure, reported as the
 * rival's.
 *
 * ## What remains genuinely out of reach, and why
 *
 * Every remaining gap traces to one fact: **`markdown-it` gives a position to
 * block tokens only.** Inline tokens carry `map: null`, and the offsets an
 * inline rule sees are indices into the *inline content string* — a paragraph's
 * lines joined and trimmed, with block indentation stripped — which cannot be
 * mapped back to source offsets for anything inside a list or a blockquote.
 * So:
 *
 * - **No inline spans.** `code-span`, `inline-link`, `image` and
 *   `reference-link` extents are absent rather than guessed. A guess would turn
 *   a conformance finding into a silently wrong mask, and a mask at the wrong
 *   offset suppresses real findings.
 * - **No `line` or offsets on a link.** Same cause, same refusal.
 * - **Block spans are line-aligned**, which is exact for a construct that
 *   begins a line and is why only block tokens are converted here. See
 *   {@link blockSpanFromMap} for the one place it is not free.
 * - **A duplicated `[label]: url` reports the FIRST definition's href.**
 *   `env.references` is first-write-wins with no record of the later ones, and
 *   parsing a destination out of the source would mean reimplementing
 *   `markdown-it`'s destination parser. The span and the label are still exact.
 */

import type {
  FlatHeading,
  MarkdownParser,
  ParseSession,
  ResourceLink,
  SourceSpan,
  SpanFacts,
  StructureFacts,
} from '@vibe-agent-toolkit/resources';
import { classifyLink } from '@vibe-agent-toolkit/resources';
import MarkdownIt from 'markdown-it';
import referenceRule from 'markdown-it/lib/rules_block/reference.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import linkRule from 'markdown-it/lib/rules_inline/link.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import frontMatter from 'markdown-it-front-matter';

/** Block token types that become a span, and the kind each becomes. */
const BLOCK_SPAN_KINDS: Readonly<Record<string, SourceSpan['kind'] | undefined>> = {
  fence: 'code-block',
  code_block: 'code-block',
  html_block: 'raw-html',
  front_matter: 'frontmatter',
};

/** `id="…"` / `name="…"` attribute, single- or double-quoted. */
const HTML_ANCHOR_ATTRIBUTE = /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * A reference definition's label: `[` to the first unescaped `]`.
 *
 * Applied to the definition's own source slice, which the block-rule wrapper
 * has already delimited — so this is reading a known extent, not scanning for
 * one.
 */
const DEFINITION_LABEL = /^\[((?:[^\]\\]|\\.)*)\]/u;

/** One `[label]: url` the block-rule wrapper saw go past, as line numbers. */
interface CapturedDefinition {
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, exclusive. */
  endLine: number;
}

/** What {@link capturePositions} writes into the parse `env`. */
interface CaptureEnv {
  /** `markdown-it`'s own resolved definitions, keyed by normalized label. */
  references?: Record<string, { href: string } | undefined>;
  /** Every definition's extent, in document order. */
  vatDefinitions?: CapturedDefinition[];
}

/** Set by the inline-rule wrapper on each `link_open` token it produced. */
interface LinkOrigin {
  /** `[text](dest)` rather than `[text][label]` / `[text][]` / `[text]`. */
  inline: boolean;
}

/**
 * Record what `markdown-it` parses but does not report.
 *
 * Two rules are replaced by wrappers that call the original and observe what it
 * consumed. Neither changes a parse decision — remove the recording and the
 * token stream is byte-for-byte what the unwrapped parser produces.
 *
 * - **`reference`** emits no token at all, so a `[label]: url` has no extent in
 *   the output. The wrapper reads `state.line` after a successful call, which
 *   is the definition's end, and stores the line range. That range is what
 *   becomes a `link-definition` span, and a `link-definition` span carrying a
 *   label is the only thing `findUnresolvedReferences` collects defined labels
 *   from. Without this, a document's one *resolvable* reference reads as
 *   dangling.
 * - **`link`** produces the same `link_open` token for `[a](b)` and `[a][b]`.
 *   The wrapper slices the source the rule consumed and tags the token, so
 *   `nodeType` can be `link` or `linkReference` rather than always the first.
 *   The test is total: an inline link's destination clause always closes the
 *   construct with `)`, and all three reference forms close with `]`.
 *
 * @param md - The instance to install into
 */
function capturePositions(md: MarkdownIt): void {
  md.block.ruler.at('reference', (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const parsed = referenceRule(state, startLine, endLine, silent);
    if (parsed && !silent) {
      const env = state.env as CaptureEnv;
      env.vatDefinitions ??= [];
      env.vatDefinitions.push({ startLine, endLine: state.line });
    }
    return parsed;
  });

  md.inline.ruler.at('link', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    const parsed = linkRule(state, silent);
    if (parsed && !silent) {
      tagLinkOrigin(state.tokens, { inline: state.src.slice(start, state.pos).endsWith(')') });
    }
    return parsed;
  });
}

/**
 * Tag the `link_open` the inline `link` rule just pushed.
 *
 * The rule pushes `link_open`, tokenizes the label into the same array, then
 * pushes `link_close` — so the token to tag is the last `link_open` in the
 * array. Markdown forbids a link inside a link's text, so no nested
 * `link_open` can be in between.
 *
 * @param tokens - The inline token array the rule appended to
 * @param origin - What the wrapper observed about the construct
 */
function tagLinkOrigin(tokens: readonly Token[], origin: LinkOrigin): void {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token?.type === 'link_open') {
      token.meta = origin;
      return;
    }
  }
}

/**
 * `markdown-it`, configured to be asked what VAT's remark chain is asked.
 *
 * See this module's docstring for the option-by-option correspondence. The
 * closest configuration to VAT's remark chain that `markdown-it` has, rather
 * than the cheapest one that parses.
 *
 * ⚠️ Shared with `parser-bakeoff.ts` so the speed verdict and the fidelity
 * verdict are statements about the SAME parser. Two differently-configured
 * instances would make them statements about two parsers, and nothing would
 * say so. That cuts both ways on purpose: the HTML, the frontmatter and the two
 * wrappers are work the timed arm now pays for, because VAT needs their output.
 *
 * @returns A fresh instance; the bake-off shares one, a conformance run may not
 */
export function createMarkdownItProcessor(): MarkdownIt {
  return (
    new MarkdownIt({ html: true, linkify: true })
      // The plugin's callback is how it reports frontmatter to a renderer; this
      // adapter reads the token instead, so there is nothing to do here.
      .use(frontMatter, () => undefined)
      .use(capturePositions)
  );
}

/**
 * Offset of the first character of each line, plus a final entry one past the
 * end so an exclusive end-line always indexes something.
 *
 * This is the whole of `markdown-it`'s offset story: it reports lines, VAT asks
 * for characters, and this is the only bridge available. It is exact for a
 * construct that begins at a line start and wrong for every construct that does
 * not — which is why only block tokens are converted here.
 *
 * @param content - The source being parsed
 * @returns `lineStarts[n]` is the offset where line `n` (0-based) begins
 */
function computeLineStarts(content: string): number[] {
  const starts = [0];
  // `indexOf` rather than a scan: it walks UTF-16 code units, which is the unit
  // the offsets are in, and it does not need the whole string materialised as
  // characters the way iterating would.
  let newline = content.indexOf('\n');
  while (newline !== -1) {
    starts.push(newline + 1);
    newline = content.indexOf('\n', newline + 1);
  }
  starts.push(content.length);
  return starts;
}

/** A block construct's character extent, or `undefined` for an unusable range. */
interface BlockExtent {
  startOffset: number;
  endOffset: number;
}

/**
 * Convert a `markdown-it` `[startLine, endLine)` line range to a character
 * extent.
 *
 * ⚠️ The terminating newline is **not** part of the construct. A line range's
 * exclusive end is the *start of the following line*, so taking it verbatim
 * swallows the newline that ended the last line — and that one code unit is
 * enough to make `contentMeasures.codeBlockCodeUnits` disagree with remark for
 * every fenced block in a document. Trimming it is exact rather than a
 * correction: the character being dropped is the line terminator the range's
 * own end marker implies.
 *
 * @param map - The token's line range
 * @param lineStarts - Line-start offsets for the same document
 * @param content - The same source those offsets index into
 * @returns The extent, or `undefined` when the range does not resolve
 */
function blockSpanFromMap(
  map: readonly [number, number],
  lineStarts: readonly number[],
  content: string,
): BlockExtent | undefined {
  const startOffset = lineStarts[map[0]];
  const lineAfter = lineStarts[map[1]];
  if (startOffset === undefined || lineAfter === undefined) return undefined;
  const endOffset = content[lineAfter - 1] === '\n' ? lineAfter - 1 : lineAfter;
  return startOffset < endOffset ? { startOffset, endOffset } : undefined;
}

/**
 * Flatten an inline token's children to text, image `alt` excluded.
 *
 * The counterpart to `mdast-util-to-string`: `token.content` on an `inline`
 * token is the RAW markdown of the run, so a `**bold**` heading would yield its
 * asterisks and therefore a different slug. Concatenating the leaf `text` and
 * `code_inline` children is what reproduces VAT's extracted text.
 *
 * @param children - An inline token's children, or null
 * @returns The visible text
 */
function flattenInline(children: readonly Token[] | null): string {
  if (children === null) return '';
  let text = '';
  for (const child of children) {
    if (child.type === 'text' || child.type === 'code_inline') text += child.content;
  }
  return text;
}

/** The three link buckets, kept apart because `links` is ordered by kind. */
interface LinkBuckets {
  inline: ResourceLink[];
  reference: ResourceLink[];
  definition: ResourceLink[];
}

/**
 * Collect the links of one `inline` token into their buckets.
 *
 * Walks to the matching `link_close` by nesting depth rather than assuming the
 * next token closes it, so a link containing emphasis or a code span keeps its
 * whole text.
 *
 * ⚠️ No `line` and no offsets: inline tokens carry `map: null`, and the
 * positions the inline rules see index the inline content string rather than
 * the source. See this module's docstring.
 *
 * @param inline - An `inline` token
 * @param buckets - Accumulator
 */
function collectInlineLinks(inline: Token, buckets: LinkBuckets): void {
  const children = inline.children ?? [];
  for (const [index, child] of children.entries()) {
    if (child.type !== 'link_open') continue;
    const href = child.attrGet('href') ?? '';
    // Absent only if `capturePositions` was not installed — an unwrapped
    // instance cannot tell the two apart, and reading it as inline would be the
    // silent wrong answer this adapter exists to avoid.
    const origin = child.meta as LinkOrigin | null;
    const bucket = origin?.inline === false ? buckets.reference : buckets.inline;
    bucket.push({
      text: linkText(children, index),
      href,
      type: classifyLink(href),
      nodeType: origin?.inline === false ? 'linkReference' : 'link',
    });
  }
}

/**
 * The visible text of the link opening at `index`.
 *
 * @param children - The enclosing inline token's children
 * @param index - Position of the `link_open`
 */
function linkText(children: readonly Token[], index: number): string {
  let depth = 0;
  let text = '';
  for (const following of children.slice(index)) {
    if (following.type === 'link_open') depth++;
    else if (following.type === 'link_close') {
      depth--;
      if (depth === 0) break;
    } else if (following.type === 'text' || following.type === 'code_inline') {
      text += following.content;
    }
  }
  return text;
}

/**
 * Turn the captured definition extents into spans and links.
 *
 * The label is read from the definition's own source rather than from the
 * `env.references` key, because that key is `normalizeReference`d — uppercased
 * — and the source spelling is what an author wrote. VAT normalizes whatever it
 * is given (`referenceLabelKeys`), so handing it the raw spelling is both
 * faithful and sufficient.
 *
 * @param env - The parse env the block-rule wrapper wrote into
 * @param normalize - `markdown-it`'s own label normalization, for the href lookup
 * @param lineStarts - Line-start offsets for the document
 * @param content - The document
 * @param buckets - Accumulator for the definition links
 * @returns One `link-definition` span per definition, in document order
 */
function collectDefinitions(
  env: CaptureEnv,
  normalize: (label: string) => string,
  lineStarts: readonly number[],
  content: string,
  buckets: LinkBuckets,
): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const definition of env.vatDefinitions ?? []) {
    const extent = blockSpanFromMap([definition.startLine, definition.endLine], lineStarts, content);
    if (extent === undefined) continue;
    const label = DEFINITION_LABEL.exec(content.slice(extent.startOffset, extent.endOffset))?.[1];
    if (label === undefined) continue;
    const href = env.references?.[normalize(label)]?.href ?? '';
    spans.push({ kind: 'link-definition', ...extent, label });
    buckets.definition.push({
      text: label,
      href,
      type: classifyLink(href),
      line: definition.startLine + 1,
      ...extent,
      nodeType: 'definition',
    });
  }
  return spans;
}

/**
 * Collect explicit fragment targets from a raw-HTML token's source.
 *
 * Reads both `html_block` and `html_inline`, because remark's `html` node
 * covers both and an `<a id="…">` alone on a line is an *inline* run under
 * CommonMark — the block conditions do not match a complete open-and-close pair.
 * An anchor needs no position, so this is the one thing inline HTML can still
 * supply.
 *
 * @param anchors - Accumulator; insertion order becomes the emitted order
 * @param source - A raw-HTML token's content
 */
function collectHtmlAnchors(anchors: Set<string>, source: string): void {
  for (const match of source.matchAll(HTML_ANCHOR_ATTRIBUTE)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value !== '') anchors.add(value.toLowerCase());
  }
}

/** Everything one pass over the token stream yields. */
interface MarkdownItFacts {
  spanFacts: SpanFacts;
  structure: StructureFacts;
}

/** Mutable state threaded through the single token walk. */
interface TokenWalkState {
  spans: SourceSpan[];
  buckets: LinkBuckets;
  headings: FlatHeading[];
  anchors: Set<string>;
  frontmatterSource?: string;
  /**
   * The level of a `heading_open` whose text has not arrived yet.
   *
   * Required-but-nullable rather than optional: it is cleared on every heading,
   * and under `exactOptionalPropertyTypes` an optional property cannot be
   * assigned `undefined` — only deleted, which would make the clear read as a
   * removal rather than a reset.
   */
  pendingHeadingLevel: number | undefined;
}

/**
 * What one block-level token contributes beyond its links and headings.
 *
 * @param state - The walk's accumulator
 * @param token - A top-level token
 * @param lineStarts - Line-start offsets for the document
 * @param content - The document
 */
function collectBlockToken(
  state: TokenWalkState,
  token: Token,
  lineStarts: readonly number[],
  content: string,
): void {
  if (token.type === 'front_matter') state.frontmatterSource = token.meta as string;
  if (token.type === 'html_block') collectHtmlAnchors(state.anchors, token.content);

  const kind = BLOCK_SPAN_KINDS[token.type];
  if (kind === undefined || token.map === null) return;
  const extent = blockSpanFromMap([token.map[0], token.map[1]], lineStarts, content);
  if (extent !== undefined) state.spans.push({ kind, ...extent });
}

/**
 * What one `inline` token contributes.
 *
 * @param state - The walk's accumulator
 * @param token - An `inline` token
 */
function collectInlineToken(state: TokenWalkState, token: Token): void {
  collectInlineLinks(token, state.buckets);
  for (const child of token.children ?? []) {
    if (child.type === 'html_inline') collectHtmlAnchors(state.anchors, child.content);
  }

  if (state.pendingHeadingLevel === undefined) return;
  state.headings.push({
    level: state.pendingHeadingLevel,
    text: flattenInline(token.children),
    // `map` on the inline token is the enclosing block's line range, and
    // markdown-it counts lines from 0 where VAT counts from 1.
    ...(token.map !== null && { line: token.map[0] + 1 }),
  });
  state.pendingHeadingLevel = undefined;
}

/**
 * Walk the flat token stream once for both capabilities.
 *
 * @param tokens - `markdown-it`'s output for one document
 * @param lineStarts - Line-start offsets for the same document
 * @param content - The document
 * @param env - The parse env, carrying what the rule wrappers recorded
 * @param normalize - `markdown-it`'s own label normalization
 */
function collectTokenFacts(
  tokens: readonly Token[],
  lineStarts: readonly number[],
  content: string,
  env: CaptureEnv,
  normalize: (label: string) => string,
): MarkdownItFacts {
  const state: TokenWalkState = {
    spans: [],
    buckets: { inline: [], reference: [], definition: [] },
    headings: [],
    anchors: new Set<string>(),
    pendingHeadingLevel: undefined,
  };

  for (const token of tokens) {
    if (token.type === 'heading_open') {
      state.pendingHeadingLevel = Number(token.tag.slice(1));
      continue;
    }
    if (token.type === 'inline') collectInlineToken(state, token);
    else collectBlockToken(state, token, lineStarts, content);
  }

  const definitionSpans = collectDefinitions(env, normalize, lineStarts, content, state.buckets);
  const spans = [...state.spans, ...definitionSpans].sort((left, right) => left.startOffset - right.startOffset);

  return {
    // `links` is ordered BY KIND, not by document position — see `SpanFacts`.
    // That is a contract on the capability, not a property of a parser, so an
    // implementation that emitted document order would be an adapter defect.
    spanFacts: {
      links: [...state.buckets.inline, ...state.buckets.reference, ...state.buckets.definition],
      anchors: [...state.anchors],
      spans,
      ...(state.frontmatterSource !== undefined && { frontmatterSource: state.frontmatterSource }),
    },
    structure: { headings: state.headings },
  };
}

/**
 * Open a `markdown-it` parse of `content`.
 *
 * @param processor - The shared configuration, so one parser is under test
 * @param content - Decoded markdown source
 * @returns A session serving both read capabilities from one token pass
 */
function openMarkdownItSession(processor: MarkdownIt, content: string): ParseSession {
  const env: CaptureEnv = {};
  const tokens = processor.parse(content, env);
  const lineStarts = computeLineStarts(content);
  let facts: MarkdownItFacts | undefined;
  const walk = (): MarkdownItFacts =>
    (facts ??= collectTokenFacts(tokens, lineStarts, content, env, processor.utils.normalizeReference));

  return {
    spansAndKinds: () => walk().spanFacts,
    structure: () => walk().structure,
  };
}

/** Built on first use and kept — see {@link markdownItParser}. */
let sharedProcessor: MarkdownIt | undefined;

/** The shared instance, built on first use. */
function processor(): MarkdownIt {
  sharedProcessor ??= createMarkdownItProcessor();
  return sharedProcessor;
}

/**
 * `markdown-it`, as a {@link MarkdownParser}.
 *
 * ⚠️ It claims `spans-and-kinds` and `structure` and **not** `faithful-edit`,
 * because it reports line ranges rather than character offsets. The claim is
 * what the conformance suite falsifies, and the suite checks span fidelity
 * whether or not the capability is claimed — so declining to claim it is a
 * statement about this parser, not a way of avoiding the test.
 */
export const markdownItParser: MarkdownParser = {
  name: 'markdown-it',
  capabilities: ['spans-and-kinds', 'structure'],
  // One shared instance, as the bake-off uses: a fresh parser per document
  // would put allocation in a cost comparison the bake-off keeps out of it.
  open: (content) => openMarkdownItSession(processor(), content),
};

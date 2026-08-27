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
 * ⚠️ Both wrappers replace their rule with {@link MarkdownIt.block}`.ruler.at`,
 * which resets a rule's `alt` chain to empty when called without options — that
 * would change which blocks may terminate a paragraph. It is harmless only
 * because `reference` and `link` are the two rules in `markdown-it`'s own tables
 * that declare no `alt`. Wrapping any other rule this way needs the original's
 * `alt` passed back in.
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
 * - **A duplicated `[label]: url` reports the FIRST definition's href.**
 *   `env.references` is first-write-wins with no record of the later ones, and
 *   parsing a destination out of the source would mean reimplementing
 *   `markdown-it`'s destination parser. The span and the label are still exact.
 *
 * A block token's `map`, by contrast, is not out of reach — it is merely a
 * *line* range where a character extent was asked for, and both of its ends need
 * work before it is one. {@link blockSpanFromMap} is that work, and the shape of
 * it generalises: a line range flatters an implementation on any document whose
 * constructs all begin at column zero and end on an LF, which is most probe
 * documents and no real corpus.
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

/**
 * What one block token contributes: the span kind, and the characters its
 * construct may begin with.
 *
 * `openers` is how a line range becomes a construct extent inside a container.
 * `map` addresses whole lines, but a fence in a list item or a blockquote does
 * not begin its line — remark anchors such a node at its own marker and lets the
 * container prefixes fall inside the extent, so scanning the start line for the
 * first opener reproduces it exactly. An indented code block is the one kind
 * with no marker to anchor on: its opener *is* the indentation, so it takes the
 * line start and gets no `openers`.
 */
const BLOCK_SPANS: Readonly<Record<string, { kind: SourceSpan['kind']; openers?: string } | undefined>> = {
  fence: { kind: 'code-block', openers: '`~' },
  code_block: { kind: 'code-block' },
  html_block: { kind: 'raw-html', openers: '<' },
  front_matter: { kind: 'frontmatter', openers: '-' },
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
    const appendFrom = state.tokens.length;
    const parsed = linkRule(state, silent);
    if (parsed && !silent) {
      tagLinkOrigin(state.tokens, appendFrom, { inline: state.src.slice(start, state.pos).endsWith(')') });
    }
    return parsed;
  });
}

/**
 * Tag the `link_open` the inline `link` rule just pushed.
 *
 * The rule pushes `link_open` **first**, then tokenizes the label into the same
 * array, then pushes `link_close` — so the token to tag is the FIRST
 * `link_open` at or after where the array stood when the rule was entered.
 *
 * 🪤 Neither of the two shorter spellings works. Taking the last `link_open` in
 * the array tags a nested one instead: `parseLinkLabel`'s `disableNested` only
 * rejects nesting a `[` opens, so an **autolink** inside a link's text parses
 * and pushes its own `link_open` — and then a reference link reads as inline
 * while the autolink inside it reads as a reference. And taking
 * `tokens[appendFrom]` directly misses, because `state.push` flushes
 * `state.pending` first and the flushed text token takes that slot.
 *
 * @param tokens - The inline token array the rule appended to
 * @param appendFrom - Length of that array before the rule ran
 * @param origin - What the wrapper observed about the construct
 */
function tagLinkOrigin(tokens: readonly Token[], appendFrom: number, origin: LinkOrigin): void {
  for (let index = appendFrom; index < tokens.length; index++) {
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
 * ⚠️ **Neither end of a line range is an end of the construct**, and the two
 * failures look nothing alike:
 *
 * - The exclusive end is the *start of the following line*, so taking it
 *   verbatim swallows the terminator that ended the last line. One code unit is
 *   enough to make `contentMeasures.codeBlockCodeUnits` disagree with remark for
 *   every fenced block in a document — and on CRLF source it is two, which is
 *   why both are dropped rather than just `\n`. Trimming is exact rather than a
 *   correction: the characters dropped are the terminator the range's own end
 *   marker implies.
 * - The start is the line's first character, which is the construct's own first
 *   character only outside a container. `openers` is what closes that gap: the
 *   marker is on the start line by definition, so scanning to it reproduces
 *   remark's anchor exactly, for a blockquote, a list item, and a fence indented
 *   up to three spaces at top level alike.
 *
 * @param map - The token's line range
 * @param lineStarts - Line-start offsets for the same document
 * @param content - The same source those offsets index into
 * @param openers - Characters the construct may begin with; the line start is
 *   taken as-is when omitted
 * @returns The extent, or `undefined` when the range does not resolve
 */
function blockSpanFromMap(
  map: readonly [number, number],
  lineStarts: readonly number[],
  content: string,
  openers?: string,
): BlockExtent | undefined {
  const lineStart = lineStarts[map[0]];
  const lineAfter = lineStarts[map[1]];
  if (lineStart === undefined || lineAfter === undefined) return undefined;

  let endOffset = lineAfter;
  if (content[endOffset - 1] === '\n') endOffset--;
  if (content[endOffset - 1] === '\r') endOffset--;

  const startOffset = openers === undefined ? lineStart : findOpener(content, lineStart, openers);
  if (startOffset === undefined) return undefined;
  return startOffset < endOffset ? { startOffset, endOffset } : undefined;
}

/**
 * Offset of the first `openers` character on the line beginning at `lineStart`.
 *
 * Bounded to the one line, so a construct whose marker is not where the token
 * says it is yields no span rather than a span reaching into the next line. A
 * container prefix — `>` and spaces, or a list marker — holds none of the
 * opener characters any kind here declares, so the scan cannot stop short.
 *
 * @param content - The document
 * @param lineStart - Offset the construct's first line begins at
 * @param openers - Characters the construct may begin with
 * @returns The offset, or `undefined` when the line holds no opener
 */
function findOpener(content: string, lineStart: number, openers: string): number | undefined {
  for (let offset = lineStart; offset < content.length; offset++) {
    const character = content[offset];
    if (character === undefined || character === '\n') return undefined;
    if (openers.includes(character)) return offset;
  }
  return undefined;
}

/** Leaf inline token types whose content is part of the flattened text. */
const FLATTENED_INLINE_TYPES = new Set(['text', 'code_inline', 'html_inline']);

/**
 * The frontmatter block's body, read from the source between its delimiters.
 *
 * 🪤 Read from the source rather than from `front_matter`'s own `token.meta`,
 * which is the body as `markdown-it` holds it — and `markdown-it`'s `normalize`
 * core rule rewrites every `\r\n` to `\n` before any rule sees the document. VAT
 * asks for the frontmatter *source*, and a CRLF file round-tripped through the
 * normalized copy comes back with different bytes. This is the same principle
 * that makes {@link collectDefinitions} read a label out of the source instead
 * of out of the `normalizeReference`d `env.references` key: where the two
 * disagree, the parser's copy is the derived one.
 *
 * @param openLine - 0-based line of the opening delimiter
 * @param afterLine - 0-based line after the closing delimiter
 * @param lineStarts - Line-start offsets for the document
 * @param content - The document
 * @returns The body, delimiters and their terminators excluded
 */
function frontmatterBody(
  openLine: number,
  afterLine: number,
  lineStarts: readonly number[],
  content: string,
): string | undefined {
  const bodyStart = lineStarts[openLine + 1];
  let bodyEnd = lineStarts[afterLine - 1];
  if (bodyStart === undefined || bodyEnd === undefined || bodyEnd < bodyStart) return undefined;
  if (content[bodyEnd - 1] === '\n') bodyEnd--;
  if (content[bodyEnd - 1] === '\r') bodyEnd--;
  return bodyStart <= bodyEnd ? content.slice(bodyStart, bodyEnd) : '';
}

/**
 * Flatten an inline token's children to text, image `alt` excluded.
 *
 * The counterpart to `mdast-util-to-string`: `token.content` on an `inline`
 * token is the RAW markdown of the run, so a `**bold**` heading would yield its
 * asterisks and therefore a different slug. Concatenating the leaf children is
 * what reproduces VAT's extracted text.
 *
 * 🪤 `html_inline` belongs in that set precisely **because** this adapter sets
 * `html: true`. Under the default preset `<text>` in `### vat rag query <text>`
 * is an ordinary `text` token and lands here for free; enabling raw HTML —
 * required for `anchors` — turns it into an `html_inline` token, and omitting it
 * would silently truncate the heading. `mdast-util-to-string` returns an `html`
 * node's value for the same reason. A heading feeds the stateful slugger, so
 * this is an anchor and a navigation entry, not one string.
 *
 * @param children - An inline token's children, or null
 * @returns The visible text
 */
function flattenInline(children: readonly Token[] | null): string {
  if (children === null) return '';
  let text = '';
  for (const child of children) {
    if (FLATTENED_INLINE_TYPES.has(child.type)) text += child.content;
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
    } else if (FLATTENED_INLINE_TYPES.has(following.type)) {
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
 * ⚠️ A definition inside a blockquote or a list item is the case this owes its
 * `[` opener to. Without it the extent starts at the container prefix, the label
 * pattern does not match, and the definition is dropped — which is not merely a
 * lost span: a `link-definition` span carrying a label is the only thing
 * `findUnresolvedReferences` collects defined labels from, so dropping one turns
 * a resolvable reference into a reported dangling link.
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
    const extent = blockSpanFromMap([definition.startLine, definition.endLine], lineStarts, content, '[');
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
  if (token.type === 'front_matter' && token.map !== null) {
    const body = frontmatterBody(token.map[0], token.map[1], lineStarts, content);
    if (body !== undefined) state.frontmatterSource = body;
  }
  if (token.type === 'html_block') collectHtmlAnchors(state.anchors, token.content);

  const span = BLOCK_SPANS[token.type];
  if (span === undefined || token.map === null) return;
  const extent = blockSpanFromMap([token.map[0], token.map[1]], lineStarts, content, span.openers);
  if (extent !== undefined) state.spans.push({ kind: span.kind, ...extent });
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

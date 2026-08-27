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
 * graph. It builds its parser with {@link createMarkdownItProcessor} so the
 * fidelity verdict and the speed verdict are statements about the same parser.
 *
 * ## Written to be honest, not to pass
 *
 * Every place `markdown-it` cannot supply what the capability asks for, this
 * reports nothing rather than guessing. A guess would turn a conformance
 * finding into a silent wrong answer, which is the exact failure the suite
 * exists to prevent. The gaps are real properties of `markdown-it@14`:
 *
 * - **No character offsets.** Block tokens carry `map`, a `[startLine, endLine)`
 *   pair; inline tokens carry `map: null`. Offsets below are reconstructed from
 *   line starts, so block spans are line-aligned and inline constructs get no
 *   span at all.
 * - **No token for a link definition.** `[label]: url` lands in `env.references`
 *   with no position, so a `link-definition` span cannot be produced — and that
 *   is precisely the span `findUnresolvedReferences` collects labels from.
 * - **Reference links are indistinguishable from inline links.** Both arrive as
 *   `link_open`, so `nodeType` cannot be `linkReference`.
 * - **No raw HTML under the default preset.** `html: false` escapes it as text,
 *   so `<a id="…">` anchors are invisible.
 * - **No frontmatter.** The default preset has no frontmatter rule, so a
 *   document's `---` block parses as a thematic break and a heading.
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
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

import { createMarkdownItProcessor } from './parser-bakeoff.js';

/** Block token types that become a span, and the kind each becomes. */
const BLOCK_SPAN_KINDS: Readonly<Record<string, SourceSpan['kind'] | undefined>> = {
  fence: 'code-block',
  code_block: 'code-block',
  html_block: 'raw-html',
};

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

/**
 * Collect the inline links of one `inline` token.
 *
 * Walks to the matching `link_close` by nesting depth rather than assuming the
 * next token closes it, so a link containing emphasis or a code span keeps its
 * whole text.
 *
 * ⚠️ Every link here gets `nodeType: 'link'`. `markdown-it` resolves a reference
 * link into the same `link_open` token an inline link produces, so the two are
 * not distinguishable at this layer — a conformance finding, not a shortcut.
 *
 * ⚠️ No `line` and no offsets: inline tokens carry `map: null`.
 *
 * @param inline - An `inline` token
 * @param links - Accumulator
 */
function collectInlineLinks(inline: Token, links: ResourceLink[]): void {
  const children = inline.children ?? [];
  for (const [index, child] of children.entries()) {
    if (child.type !== 'link_open') continue;
    const href = child.attrGet('href') ?? '';
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
    links.push({ text, href, type: classifyLink(href), nodeType: 'link' });
  }
}

/** Everything one pass over the token stream yields. */
interface MarkdownItFacts {
  spanFacts: SpanFacts;
  structure: StructureFacts;
}

/**
 * Walk the flat token stream once for both capabilities.
 *
 * @param tokens - `markdown-it`'s output for one document
 * @param lineStarts - Line-start offsets for the same document
 */
function collectTokenFacts(tokens: readonly Token[], lineStarts: readonly number[]): MarkdownItFacts {
  const spans: SourceSpan[] = [];
  const links: ResourceLink[] = [];
  const headings: FlatHeading[] = [];
  let pendingHeadingLevel: number | undefined;

  for (const token of tokens) {
    const kind = BLOCK_SPAN_KINDS[token.type];
    if (kind !== undefined && token.map !== null) {
      const [startLine, endLine] = token.map;
      const startOffset = lineStarts[startLine];
      const endOffset = lineStarts[endLine];
      if (startOffset !== undefined && endOffset !== undefined) {
        spans.push({ kind, startOffset, endOffset });
      }
    }

    if (token.type === 'heading_open') {
      pendingHeadingLevel = Number(token.tag.slice(1));
      continue;
    }

    if (token.type !== 'inline') continue;

    collectInlineLinks(token, links);
    if (pendingHeadingLevel !== undefined) {
      headings.push({
        level: pendingHeadingLevel,
        text: flattenInline(token.children),
        // `map` on the inline token is the enclosing block's line range, and
        // markdown-it counts lines from 0 where VAT counts from 1.
        ...(token.map !== null && { line: token.map[0] + 1 }),
      });
      pendingHeadingLevel = undefined;
    }
  }

  // `anchors` is empty rather than absent, and `frontmatterSource` is absent
  // rather than empty: the first is "this parser found none", the second is
  // "this parser cannot look". Collapsing them would hide which is which.
  return { spanFacts: { links, anchors: [], spans }, structure: { headings } };
}

/**
 * Open a `markdown-it` parse of `content`.
 *
 * @param processor - The shared configuration, so one parser is under test
 * @param content - Decoded markdown source
 * @returns A session serving both read capabilities from one token pass
 */
function openMarkdownItSession(processor: MarkdownIt, content: string): ParseSession {
  const tokens = processor.parse(content, {});
  const lineStarts = computeLineStarts(content);
  let facts: MarkdownItFacts | undefined;
  const walk = (): MarkdownItFacts => (facts ??= collectTokenFacts(tokens, lineStarts));

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

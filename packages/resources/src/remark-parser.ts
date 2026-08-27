/**
 * VAT's `spans-and-kinds` and `structure` capabilities, implemented on remark.
 *
 * This is the reference implementation of `parse-capabilities.ts` — the one
 * every other implementation is measured against by `parse-conformance.ts`. It
 * is also the only implementation VAT ships: a second one exists to prove the
 * interface discriminates, not to be depended on.
 *
 * ## One walk, both capabilities
 *
 * The interface lets a caller ask for spans without paying for structure. This
 * implementation does not exploit that, and the reason is arithmetic rather
 * than laziness: remark's answer to both questions is one tree, and serving
 * them from two traversals would walk it twice. So {@link openRemarkSession}
 * parses, and the first call to either capability performs a single filtered
 * walk that collects everything; the second call reads the memo.
 *
 * That walk replaced three. `collectAstFacts` (links, headings, anchors,
 * frontmatter), `collectCodeContextRanges` (fence and exclusion ranges) and
 * `collectMaskFacts` (the dangling-reference mask) each traversed the same tree
 * for facts that are all available from one pass over the union of their node
 * kinds. The two range consumers now filter {@link SpanFacts.spans} instead —
 * see `codeContextRangesFrom` and `maskFactsFrom`.
 */

import type { Code, Definition, Heading, Html, Image, InlineCode, Link, LinkReference, Root, Yaml } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';

import { classifyLink } from './link-classify.js';
import { createMarkdownProcessor } from './markdown-processor.js';
import type {
  FlatHeading,
  MarkdownParser,
  ParseSession,
  SourceSpan,
  SpanFacts,
  SpanKind,
  StructureFacts,
} from './parse-capabilities.js';
import { ParsePass, parseTimingStart, recordParsePass } from './parse-timing.js';
import { probeTokenize } from './parse-tokenize-probe.js';
import type { ResourceLink } from './types.js';

/**
 * Node kinds the walk reacts to, as ONE filtered traversal.
 *
 * Passed to `visit` as its test so the walk stays a single traversal while the
 * visitor's parameter narrows to exactly these kinds — which is what lets
 * {@link collectNode}'s switch be exhaustive, and therefore lets the compiler
 * enforce that adding a kind here adds a case there.
 *
 * Nine kinds, serving three consumers: the six that produce links, headings,
 * anchors and frontmatter, plus `code`, `inlineCode` and `image`, which only
 * ever contribute a span.
 */
const COLLECTED_NODE_TYPES = [
  'link',
  'linkReference',
  'definition',
  'heading',
  'html',
  'yaml',
  'code',
  'inlineCode',
  'image',
] as const;

/** mdast node type → the VAT-vocabulary span it becomes. */
const SPAN_KIND_BY_NODE_TYPE: Readonly<Record<(typeof COLLECTED_NODE_TYPES)[number], SpanKind | undefined>> = {
  link: 'inline-link',
  linkReference: 'reference-link',
  definition: 'link-definition',
  html: 'raw-html',
  yaml: 'frontmatter',
  code: 'code-block',
  inlineCode: 'code-span',
  image: 'image',
  // A heading bounds a section, not a construct any consumer masks or excludes.
  heading: undefined,
};

/** The node kinds {@link collectNode} narrows over. */
type CollectedNode =
  | Code
  | Definition
  | Heading
  | Html
  | Image
  | InlineCode
  | Link
  | LinkReference
  | Yaml;

/**
 * Mutable state threaded through the single AST walk.
 *
 * The three link buckets exist because `links` is ordered **by node kind, not
 * by document position** — all `link`s, then all `linkReference`s, then all
 * `definition`s — a contract the parse-fact goldens pin by ordinal. A single
 * walk sees the three kinds interleaved, so it buckets them and concatenates in
 * kind order afterwards. Within a bucket, walk order IS document order.
 */
interface AstWalkState {
  /**
   * `[ref]: url` targets. Complete only once the walk finishes.
   *
   * First-write-wins, and that is the CommonMark contract rather than a
   * preference: a duplicated `[ref]: url` label resolves to the FIRST
   * definition in every renderer. For
   *
   *     A [ref][dup].
   *     [dup]: ./first.md
   *     [dup]: ./last.md
   *
   * a last-wins map would make VAT check a target the reader never visits.
   * `case 'definition'` therefore calls `definitions.set(id, url)` only when
   * `!definitions.has(id)`; each later re-declaration still gets its own
   * `definitionLinks` entry. A refactor that reintroduces an unconditional
   * `.set()` here regresses silently to last-wins.
   */
  definitions: Map<string, string>;
  /** `[text](href)` and autolinks. */
  inlineLinks: ResourceLink[];
  /** Deferred: resolving these needs the *completed* `definitions` map. */
  linkReferenceNodes: LinkReference[];
  /** `[ref]: url` definitions, as links in their own right. */
  definitionLinks: ResourceLink[];
  /** Every construct's extent, in document order. */
  spans: SourceSpan[];
  headings: FlatHeading[];
  anchors: Set<string>;
  frontmatterSource?: string;
}

/** Everything one walk of the markdown AST yields. */
interface RemarkAstFacts {
  spanFacts: SpanFacts;
  structure: StructureFacts;
}

/**
 * Walk the markdown AST **once** and extract every fact VAT's two read-side
 * capabilities report.
 *
 * Output ordering is stable by construction: a filtered `visit` yields nodes of
 * its types in the same relative order an unfiltered one does, so bucketing
 * links by kind and concatenating reproduces the by-kind contract, and every
 * other collection is plain document order.
 *
 * @param tree - Markdown AST from unified/remark
 * @returns The spans-and-kinds facts and the flat heading list
 */
function collectAstFacts(tree: Root): RemarkAstFacts {
  const state: AstWalkState = {
    definitions: new Map<string, string>(),
    inlineLinks: [],
    linkReferenceNodes: [],
    definitionLinks: [],
    spans: [],
    headings: [],
    anchors: new Set<string>(),
  };

  visit(tree, [...COLLECTED_NODE_TYPES], (node) => {
    collectSpan(state, node);
    collectNode(state, node);
  });

  const spanFacts: SpanFacts = {
    links: [...state.inlineLinks, ...resolveLinkReferences(state), ...state.definitionLinks],
    anchors: [...state.anchors],
    spans: state.spans,
    ...(state.frontmatterSource !== undefined && { frontmatterSource: state.frontmatterSource }),
  };

  return { spanFacts, structure: { headings: state.headings } };
}

/**
 * Record one node's extent, if it has one and if its kind is a construct.
 *
 * A node with no offsets contributes no span rather than a guessed one: the
 * consumers use spans to decide what to mask, and a mask at offset 0 suppresses
 * the top of the document. See {@link toResourceLink} for who produces
 * position-less nodes and how often.
 */
function collectSpan(state: AstWalkState, node: CollectedNode): void {
  const kind = SPAN_KIND_BY_NODE_TYPE[node.type];
  if (kind === undefined) return;
  const startOffset = node.position?.start.offset;
  const endOffset = node.position?.end.offset;
  if (startOffset === undefined || endOffset === undefined) return;
  state.spans.push({
    kind,
    startOffset,
    endOffset,
    // Only a definition carries one, and VAT normalizes whatever spelling it
    // gets — see `SourceSpan.label`.
    ...(node.type === 'definition' && { label: node.identifier }),
  });
}

/**
 * Record whatever one AST node contributes beyond its extent. Kinds that only
 * ever contribute a span fall through untouched.
 */
function collectNode(state: AstWalkState, node: CollectedNode): void {
  switch (node.type) {
    case 'link': {
      state.inlineLinks.push(toResourceLink(node, extractLinkText(node), node.url, 'link'));
      break;
    }
    case 'linkReference': {
      state.linkReferenceNodes.push(node);
      break;
    }
    case 'definition': {
      if (!state.definitions.has(node.identifier)) {
        state.definitions.set(node.identifier, node.url);
      }
      state.definitionLinks.push(toResourceLink(node, node.identifier, node.url, 'definition'));
      break;
    }
    case 'heading': {
      state.headings.push(toFlatHeading(node));
      break;
    }
    case 'html': {
      collectHtmlAnchors(state.anchors, node);
      break;
    }
    case 'yaml': {
      state.frontmatterSource = node.value;
      break;
    }
    case 'code':
    case 'inlineCode':
    case 'image': {
      break;
    }
  }
}

/**
 * Build a `ResourceLink` from any of the three link-bearing node kinds.
 *
 * `text` and `href` are passed in because each kind derives them differently
 * (a `definition`'s text is its identifier and a `linkReference`'s href comes
 * from the definitions map, not the node), while position and classification
 * are shared.
 *
 * `line` is spread conditionally so the key is ABSENT rather than
 * undefined-valued when a node carries no position — the property that makes a
 * fresh `ParseResult` equal to its own JSON round trip, which is what a
 * JSON-backed parse cache needs.
 *
 * ⚠️ The position-less case is REACHABLE, it FIRES, and it is measured firing:
 * `blob-population.ts`'s `referencesSkippedForMissingLine` records **77
 * position-less reference candidates over this repository's 4,425 blobs**, with
 * the cause and a minimal repro.
 *
 * The producer is `mdast-util-gfm-autolink-literal`. A GFM autolink literal the
 * tokenizer does not see is reconstructed afterwards by its `findAndReplace`
 * post-pass, which builds the `link` node with no `position` at all.
 *
 * ⚠️ It takes BOTH conditions, and the pair was measured rather than assumed:
 * the literal must be the **protocol-less `www.` form**, AND it must not stand
 * on its own text run. A glued `https://` literal keeps its position, and so
 * does a glued email — the tokenizer handles both inline, so `findAndReplace`
 * never has to rebuild them:
 *
 * ```text
 * 'See www.anthropic.com for more.'          → line 1   (tokenized)
 * 'See domain:www.anthropic.com for more.'   → NO `line` key   ← the only shape
 * 'See domain:https://anthropic.com for…'    → line 1
 * 'Mail domain:me@anthropic.com please.'     → line 1
 * ```
 *
 * The one shape that reproduces is not contrived — it is how a
 * `WebFetch(domain:…)` permission string reads wherever a document quotes one,
 * and this repo's own `.claude/settings.json` is such a document.
 *
 * Pinned in `link-parser.test.ts` under *own-property discipline*, together
 * with the positioned control that makes the pair a test of the GUARD rather
 * than of the parser.
 *
 * ⚠️ Every literal this reaches is an http/www/email target, so none of them is
 * a closure edge and nothing routable is lost today. That is a MEASURED
 * property of GFM autolink literals, not a guarantee this function makes: a
 * position-less node from some future producer could name a local file, and the
 * row would then be absent rather than reported. The counter is what makes that
 * visible; do not stop counting on the strength of the current sample.
 */
function toResourceLink(
  node: Definition | Link | LinkReference,
  text: string,
  href: string,
  nodeType: NonNullable<ResourceLink['nodeType']>,
): ResourceLink {
  return {
    text,
    href,
    type: classifyLink(href),
    ...(node.position !== undefined && { line: node.position.start.line }),
    // The whole node's span — `[text](href)`, not the href alone. mdast gives a
    // position for the construct and none for the href within it, and the wider
    // span is the one a rewriter wants anyway: shortening a path usually means
    // reconsidering the text beside it, and a caller that only wants the href
    // has the raw source and the span to find it in.
    //
    // Spread on `start.offset` rather than on `position`, because the two are
    // independently optional in mdast's own types: a node can carry a position
    // whose offsets are absent, and reading `line` while silently defaulting an
    // offset to 0 would put a rewrite at the top of the document.
    ...(node.position?.start.offset !== undefined && node.position.end.offset !== undefined && {
      startOffset: node.position.start.offset,
      endOffset: node.position.end.offset,
    }),
    nodeType,
  };
}

/**
 * Resolve the deferred `linkReference` nodes against the completed definitions
 * map, in document order.
 *
 * Invariant: every `linkReference` node reaching this point already has a
 * matching `definition` — CommonMark resolves link references at PARSE time, so
 * micromark only ever emits a `linkReference` node when a definition matched. A
 * reference with no matching definition never becomes a node at all; it
 * degrades to literal bracketed text in the AST (and in the rendered document),
 * which is exactly why an AST-based checker is structurally blind to it. That
 * dangling case is detected separately, by `findUnresolvedReferences`'
 * raw-source scan, which reports it as `LINK_UNRESOLVED_REFERENCE`.
 *
 * The `undefined` branch below is therefore NOT the dangling-reference case —
 * it is unreachable unless micromark's own parse-time contract breaks. It
 * degrades (skips the node) rather than throwing because this parser runs over
 * third-party markdown on the `vat audit` / `vat skills validate` paths: a
 * parser quirk must not abort a whole audit run (repo CLAUDE.md, "be liberal in
 * what you accept" for data we do not control).
 */
function resolveLinkReferences(state: AstWalkState): ResourceLink[] {
  const links: ResourceLink[] = [];
  for (const node of state.linkReferenceNodes) {
    const resolvedUrl = state.definitions.get(node.identifier);
    if (resolvedUrl === undefined) continue;
    links.push(toResourceLink(node, extractLinkText(node), resolvedUrl, 'linkReference'));
  }
  return links;
}

/**
 * Extract text content from a link node.
 *
 * Delegates to `mdast-util-to-string` (the canonical mdast text-extraction
 * implementation) rather than a hand-rolled walker — it recurses through
 * container inline nodes (`strong`, `emphasis`, `delete`, nested links).
 *
 * `includeImageAlt: false` is passed explicitly: the library's default is `true`
 * (fold image/imageReference `alt` text into the result), and VAT's extracted
 * text — and, for headings, the anchor slugs derived from it — excludes it.
 * Swapping the implementation must not silently change either.
 *
 * @param node - Link or LinkReference node
 * @returns Text content of the link
 */
function extractLinkText(node: Link | LinkReference): string {
  return mdastToString(node, { includeImageAlt: false });
}

/** `id="…"` / `name="…"` attribute, single- or double-quoted. */
const HTML_ANCHOR_ATTRIBUTE = /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Collect explicit fragment targets declared as raw HTML inside markdown.
 *
 * An author can write `<a id="short"></a>` above a long heading and link to
 * `#short`; GitHub renders that id into the DOM and the fragment resolves.
 * Indexing heading slugs alone therefore reports a working link as broken.
 *
 * Only mdast `html` nodes reach here, which is what keeps this honest: a fenced
 * block is a `code` node, an indented block is a `code` node, and a backticked
 * span is `inlineCode`, so an `<a id="…">` being *documented* rather than
 * *declared* is never indexed. That is the whole reason this reads the AST
 * instead of scanning raw source.
 *
 * Values are lowercased because markdown fragments are matched case-folded (the
 * heading-slug policy — see `fragmentIndexEntry`). That is marginally more
 * permissive than a browser, which compares ids exactly; erring toward
 * resolving is deliberate, since the cost of the other direction is a false
 * `LINK_BROKEN_ANCHOR` on a link that works.
 *
 * @param anchors - Accumulator; insertion order becomes the emitted order
 * @param node - A raw-HTML node encountered during the walk
 */
function collectHtmlAnchors(anchors: Set<string>, node: Html): void {
  for (const match of node.value.matchAll(HTML_ANCHOR_ATTRIBUTE)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value !== '') {
      anchors.add(value.toLowerCase());
    }
  }
}

/**
 * Flatten one heading node.
 *
 * No slug and no nesting: both are GitHub conventions VAT owns, applied by
 * `link-parser.ts`'s composer. See `FlatHeading` for why an implementation is
 * not asked for them.
 *
 * `line` is spread conditionally for the same reason as in
 * {@link toResourceLink} — absent beats undefined-valued. Unlike there, the
 * guard is defensive: remark always sets `position` on a heading.
 */
function toFlatHeading(node: Heading): FlatHeading {
  return {
    level: node.depth,
    text: extractHeadingText(node),
    ...(node.position !== undefined && { line: node.position.start.line }),
  };
}

/**
 * Extract text content from a heading node.
 *
 * Uses `mdast-util-to-string` (see {@link extractLinkText}) so that styled
 * headings — e.g. `### **CRITICAL: ...**` — produce the same text (and
 * therefore the same GitHub slug) as their plain-text equivalents. Without
 * recursing into container inline nodes, bold/italic headings yield empty text
 * and bogus slugs, causing false LINK_BROKEN_ANCHOR errors for links targeting
 * them.
 *
 * `includeImageAlt: false` (see {@link extractLinkText}) excludes image alt text
 * from heading text, and therefore from the slug fed to `github-slugger`.
 * Whether GitHub (or another renderer) includes image alt text when computing a
 * heading's anchor is NOT verified here. If a renderer is confirmed to include
 * it, flipping the option is a separate, deliberate change with its own
 * anchor-validation consequences — it moves the slug of every heading
 * containing an image — and must not be done on assumption alone.
 *
 * @param node - Heading node
 * @returns Text content of the heading
 */
function extractHeadingText(node: Heading): string {
  return mdastToString(node, { includeImageAlt: false });
}

/**
 * A remark session, narrowed so both capabilities are known to be present.
 *
 * {@link ParseSession} leaves them optional because an implementation serving
 * only one is legitimate. This one serves both, and saying so in the type is
 * what spares every in-repo caller a presence check it would then have to
 * decide what to do about.
 */
export interface RemarkSession extends ParseSession {
  spansAndKinds(): SpanFacts;
  structure(): StructureFacts;
}

/**
 * Open a remark parse of `content`.
 *
 * The processor is rebuilt per document on purpose and timed as its own pass —
 * `remark-processor`, ~0.004 ms/doc, which is what makes "the processor is not
 * the cost" a measured statement rather than an assumption.
 *
 * @param content - Decoded markdown source
 * @returns A session serving both read-side capabilities from one memoized walk
 */
export function openRemarkSession(content: string): RemarkSession {
  let passStartedAt = parseTimingStart();
  const processor = createMarkdownProcessor();
  recordParsePass(ParsePass.RemarkProcessor, passStartedAt);

  // The split probe brackets a SECOND, redundant tokenize so `remark-parse` can
  // be divided into tokenizing and tree building. Both calls are no-ops unless
  // `VAT_PARSE_TIMING_SPLIT` names one of them; see `parse-tokenize-probe.ts`
  // for why the order is the gate's value and what each order bounds.
  probeTokenize(content, 'before');
  passStartedAt = parseTimingStart();
  const tree = processor.parse(content) as Root;
  recordParsePass(ParsePass.RemarkParse, passStartedAt);
  probeTokenize(content, 'after');

  let facts: RemarkAstFacts | undefined;
  const walk = (): RemarkAstFacts => {
    if (facts === undefined) {
      const startedAt = parseTimingStart();
      facts = collectAstFacts(tree);
      recordParsePass(ParsePass.AstFacts, startedAt);
    }
    return facts;
  };

  return {
    spansAndKinds: () => walk().spanFacts,
    structure: () => walk().structure,
  };
}

/**
 * remark, as a {@link MarkdownParser}.
 *
 * `faithful-edit` is claimed because remark reports character offsets into the
 * exact source string it was handed, which is what `html-transform.ts` and
 * `frontmatter-editor.ts` splice at. `parse-conformance.ts` is what tests the
 * claim rather than trusting it.
 */
export const remarkParser: MarkdownParser = {
  name: 'remark-parse',
  capabilities: ['spans-and-kinds', 'structure', 'faithful-edit'],
  open: openRemarkSession,
};

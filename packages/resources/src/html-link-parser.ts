/**
 * HTML resource parser.
 *
 * Parses local HTML files into the shared `ParseResult` shape:
 * - `<a href>` and `<img src>` links (classified by `classifyLink`)
 * - `id` / `name` attributes as fragment anchors
 * - well-formedness diagnostics from parse5's `onParseError`
 *
 * Uses parse5 (WHATWG-conformant). The parse5 document + element walker are
 * exported so the link rewriter (html-transform.ts) shares one parser path.
 *
 * Non-goal: `<base href>` is not honored — relative links are resolved against
 * the file's own directory, not a document base.
 */

import { stat } from 'node:fs/promises';

import { readTextContent } from '@vibe-agent-toolkit/utils/fs';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

import { classifyLink, estimateTokens } from './link-classify.js';
import type { ParseResult } from './link-parser.js';
import {
  ParsePass,
  ParserKind,
  parseTimingStart,
  recordParsedDocument,
  recordParsePass,
} from './parse-timing.js';
import { measureContent } from './projection/blob-facts.js';
import type { HtmlParseError } from './schemas/resource-metadata.js';
import type { ResourceLink } from './types.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5ChildNode = DefaultTreeAdapterMap['childNode'];

/** A parsed parse5 document together with any well-formedness diagnostics. */
export interface HtmlDocument {
  document: DefaultTreeAdapterMap['document'];
  parseErrors: HtmlParseError[];
}

/**
 * Parse an HTML source string with source-location info and collect parser
 * errors. Shared by `parseHtml` (link/anchor extraction) and `rewriteHtmlLinks`
 * (attribute offset splicing).
 */
export function parseHtmlDocument(source: string): HtmlDocument {
  const parseErrors: HtmlParseError[] = [];
  const document = parse(source, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => {
      // parse5's ParserError extends Location which always has startLine: number.
      // We always include line since it is always present.
      parseErrors.push({ message: err.code, line: err.startLine });
    },
  });
  return { document, parseErrors };
}

/**
 * Depth-first walk yielding every element node in the tree.
 *
 * Deliberate gap: a `<template>` element's content lives in its separate
 * `content` fragment (not `childNodes`), so links inside `<template>` are not
 * walked, and foreign-content (SVG/MathML) subtrees are not special-cased.
 * Both are rare in the content link graph we rewrite.
 */
export function* walkElements(node: P5Node): Generator<P5Element> {
  if ('tagName' in node) {
    yield node;
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes as P5ChildNode[]) {
      yield* walkElements(child);
    }
  }
}

function getAttr(element: P5Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

/** One parse5 attribute token, as it appears on `element.attrs`. */
type P5Attribute = P5Element['attrs'][number];

function findAttr(element: P5Element, name: string): P5Attribute | undefined {
  return element.attrs.find((a) => a.name === name);
}

/**
 * The attribute's spelling **in the source**, which is the key
 * `sourceCodeLocation.attrs` is indexed by.
 *
 * ⛔ Not the same string as `attr.name`, and the difference is not cosmetic.
 * parse5 splits a namespaced attribute into a `prefix` and a `name`, so an SVG
 * `<a xlink:href="doc.md">` arrives as `{ prefix: 'xlink', name: 'href' }` —
 * `attrs.find(a => a.name === 'href')` matches it, and then a location lookup
 * keyed on `'href'` misses, because parse5 recorded the span under
 * `'xlink:href'`. The link was therefore emitted span-less and dropped
 * downstream: the same silent zero the whole-attribute span fix removes for
 * ordinary `href`, surviving in the one shape nothing tested.
 *
 * @param attr - The attribute token to spell
 * @returns `prefix:name` when the attribute is namespaced, `name` otherwise
 */
function sourceSpelling(attr: P5Attribute): string {
  return attr.prefix === undefined || attr.prefix === '' ? attr.name : `${attr.prefix}:${attr.name}`;
}

/**
 * Concatenate the text of every descendant text node, depth-first.
 *
 * Mirrors what `link-parser.ts › extractLinkText` does for mdast via
 * `mdast-util-to-string`, but hand-rolled: parse5's tree has no equivalent
 * library, and the walk is the same three lines as {@link walkElements} reuses
 * — `'value' in child` singles out a `TextNode` (only that node kind carries a
 * `value` property; `CommentNode` carries `data` instead, and neither
 * `DocumentType` nor a void element like `<img>` carries either), `'childNodes'
 * in child` singles out `Element | Template` for recursion. A `<template>`'s
 * own content lives in its separate `content` fragment and is not visited here
 * either, for the same reason {@link walkElements} does not descend into it.
 *
 * @param element - The element whose text content to concatenate
 * @returns The concatenated text of every text-node descendant, in document order
 */
function elementText(element: P5Element): string {
  let text = '';
  for (const child of element.childNodes) {
    if ('value' in child) {
      text += child.value;
    } else if ('childNodes' in child) {
      text += elementText(child);
    }
  }
  return text;
}

/**
 * One link, carrying the source span of the attribute that authored it.
 *
 * ⛔ The span is **not optional decoration** — a consumer drops the link
 * without it. `blob-references.ts › astCandidates` requires `line`,
 * `startOffset` and `endOffset` together and skips any link missing one, so
 * emitting a line alone put every HTML reference in the skip count and
 * contributed **zero** `blob_references` rows for every HTML blob.
 *
 * The span is the **whole attribute** — `href="foo.md"`, not the value inside
 * the quotes.
 *
 * ⛔ That used to be justified as matching the markdown producer, "because
 * mdast gives the `[text](href)` construct rather than the URL within it
 * (`link-parser.ts › linkFromNode`)". Two things were wrong. The cited symbol
 * does not exist — the function is `toResourceLink` — and the analogy does not
 * hold: `[text](href)` *contains* the link text, while `href="foo.md"`
 * contains neither the text nor the tag, so the two are not one construct in
 * two syntaxes and "means the same thing whichever parser filled it" was not
 * something the wide span bought.
 *
 * What is true is that the choice is UNRESOLVED, and the wide span is its
 * conservative side. `projection-blobs.ts` says of these columns "⚠️ The span
 * is what it would REPLACE, and nothing more" — and the one HTML rewriter that
 * ships, `html-transform.ts › rewriteHtmlLinks`, replaces only the *value*,
 * re-deriving it with `valueSpan()` from this wider attribute span. So the
 * stored span is strictly wider than what that rewriter would replace, and the
 * schema's sentence is not true of an HTML row today. Widening loses nothing a
 * consumer cannot recover (`valueSpan` recovers it from exactly these
 * offsets), whereas narrowing to the value would hide the quoting a rewriter
 * has to re-encode against. Tightening the columns is a schema-level decision
 * and is not made silently here.
 *
 * parse5 records locations only when `sourceCodeLocationInfo` is set, and it is
 * set on the one shared parse ({@link parseHtmlDocument}). The spread is still
 * conditional, for a shape the tree builder really produces: an element
 * **reconstructed** from the active-formatting-elements list — the clone made
 * when an open `<a>` is re-opened inside a block — can carry no
 * `sourceCodeLocation` at all.
 *
 * ⛔ "Can", not "does". This paragraph used to say a reconstructed clone
 * "carries no `sourceCodeLocation` at all" flatly, and the sentence below used
 * to add that a clone "is line-less and offset-less **together**". Both were
 * generalizations from the ONE fixture that had been tried
 * (`RECONSTRUCTED_ANCHOR_HTML` in the test file). parse5 produces **two**
 * distinct clone shapes, and the claim is true of only the first — measured in
 * this repo, both `<a>` elements inspected directly:
 *
 * | source | `<a>` elements | the clone's location |
 * |---|---|---|
 * | `<a href="./x.md"><div><a href="./y.md">…` | 3 | **absent** (`undefined`) |
 * | `<p><a href="./r.md">1</p>2</a>` | 2 | **full** — span `[6, 19]`, line 1 |
 * | `<ul><li><a href="./l.md">a<li>b</a></ul>` | 2 | **full** — span `[11, 24]` |
 *
 * The second and third rows are the whole reason {@link pushLink} exists: the
 * clone's span is not merely present, it is byte-for-byte the ORIGINAL
 * attribute's span, so one authored `href` produced two `ResourceLink`s that
 * no span-based filter could tell apart. See `pushLink` for the de-duplication
 * and why identity is the only workable key.
 *
 * ⛔ The absent case also used to read "carries `sourceCodeLocation === null`
 * outright". Measured, it is `undefined` (`typeof === 'undefined'`), never
 * `null`: a mutation written straight off the old wording was a silent no-op,
 * because `?.` short-circuits on both alike and no assertion told them apart.
 *
 * Where a location IS absent it is absent for line and offsets **together**,
 * so no branch here has to invent half a position.
 *
 * ⚠️ That branch is now DEFENSIVE ONLY, and this is stated rather than left
 * for a reader to discover: the only elements parse5 leaves un-located are
 * clones, and a clone always shares its original's attribute tokens (measured
 * — identity holds for the located and un-located shapes alike), so
 * {@link pushLink} drops every one of them before `makeLink` is reached. It is
 * kept rather than deleted because nothing enumerates every parse5 shape, but
 * no fixture exercises it any more and no test can pin it.
 *
 * The emitted KEY SET is still pinned in `html-link-parser.test.ts`. It now
 * runs over links that all carry a span, so it guards the object's SHAPE — no
 * stray key, no missing one — rather than the presence/absence branch it was
 * written for.
 *
 * ⛔ The reason given for that used to be "`toEqual` cannot tell an absent key
 * from an `undefined` one, so a `0`/`0` fallback would pass any assertion on
 * the object itself". The first half is true (measured: `toEqual({a: 1}, {a: 1,
 * b: undefined})` passes, `toStrictEqual` fails). The second half is false — a
 * `0` is not an `undefined`, so a plain `toEqual` on the object rejects a
 * `0`/`0` fallback outright. The key set is uniquely load-bearing against one
 * mutant only: an `undefined`-VALUED fallback (`{ startOffset:
 * span?.startOffset, endOffset: span?.endOffset }`), which every assertion on
 * values waves through and which `.strict()` Zod parsing would then reject far
 * downstream. It is a SET, not a list: key order is specified by nothing, so
 * asserting insertion order would fail a spread reorder that changes no fact.
 *
 * ⚠️ And that mutant is now UNWITNESSED, which is a coverage loss worth
 * naming: the fallback only differs from the correct code when `span` is
 * `undefined`, which only happens on an un-located clone, which
 * {@link pushLink} no longer lets through. The key-set assertion survives for
 * the shape guard above; the mutant it was aimed at cannot be reached from any
 * HTML this parser can be handed.
 *
 * `nodeType` is stated, not left to be inferred. Every one of these links is an
 * HTML attribute, and saying so is what lets `blob_references` label the row
 * `html-link` instead of inheriting `markdown-link` from an `undefined` — see
 * `LinkNodeTypeSchema` and `syntacticFormFor`.
 *
 * `line` is the **attribute's** own start line, taken from `span.startLine`,
 * not the element's. For a start tag split across lines —
 * ```html
 * <a
 *   href="./deep.md">x</a>
 * ```
 * — the element starts on line 1 but `href` lives on line 2; a `line` and a
 * span that name different lines is a row no consumer can trust ("does this
 * blob's line 1 contain this row's span?" would be false). Falling back to
 * `element.sourceCodeLocation?.startLine` when there is no span is dead in
 * every case reached today, and dead in both clone shapes for OPPOSITE
 * reasons: the un-located clone (`RECONSTRUCTED_ANCHOR_HTML` in the test file)
 * has no `sourceCodeLocation` either, so neither side has a line to offer,
 * while the located clone has a full one whose `attrs` entry is present — so
 * the span is found and the fallback is never consulted. Both are moot now
 * that {@link pushLink} drops every clone, but the fallback is kept rather
 * than assumed away, because nothing enumerates every parse5 shape that could
 * produce an element location without a matching attribute location.
 *
 * ⛔ This used to take `line` from the caller, computed once in `visitElement`
 * off `element.sourceCodeLocation?.startLine` and shared by the `<a>` and
 * `<img>` branches. That was wrong for exactly the multi-line-attribute shape
 * above, and it was wrong silently: nothing compared `line` against the span
 * it was supposedly describing, so a disagreeing pair passed every test that
 * existed.
 *
 * `text` is the anchor's own text content — `elementText(element)` walks its
 * children — for `<a>`, and `''` for `<img>`, which has no children to walk.
 *
 * ⛔ This used to hardcode `text: ''` unconditionally, with `''` justified in
 * `projection-blob-references.test.ts` as "the honest value — an `<a href>`'s
 * link text is its child nodes, **which this parser does not collect**". That
 * was true when written and became false the moment collecting them was this
 * easy: `''` on `<a href="./g.md">Guide</a>` asserts "there is link text and
 * it is empty", which is false — the text is `Guide`, sitting in the very
 * child node the old comment named as uncollected. `ResourceLinkSchema.text`
 * is `z.string()`, not nullable, so `<img src>` — which genuinely carries no
 * text, and whose `alt` is emphatically not link text — still gets `''`
 * rather than `null`; widening the schema to distinguish "empty" from "absent"
 * is a schema-level decision this function does not make. The downstream
 * fixture above hard-codes `text: ''` for BOTH real HTML rows in this file's
 * fixture, at least one of which (`<a href="./guide.md">the guide</a>`) now
 * carries real text — that assertion is `projection-blob-references.test.ts`'s
 * to update, not this file's.
 *
 * @param element - The element carrying the attribute
 * @param attr - The attribute the href was read from, for its source spelling
 * @returns The link, with its span and line when parse5 recorded them
 */
function makeLink(element: P5Element, attr: P5Attribute): ResourceLink {
  const span = element.sourceCodeLocation?.attrs?.[sourceSpelling(attr)];
  const line = span?.startLine ?? element.sourceCodeLocation?.startLine;
  return {
    text: element.tagName === 'a' ? elementText(element) : '',
    href: attr.value,
    type: classifyLink(attr.value),
    nodeType: 'htmlAttribute',
    ...(line !== undefined && { line }),
    ...(span !== undefined && { startOffset: span.startOffset, endOffset: span.endOffset }),
  };
}

/** What one document's walk accumulates, threaded through {@link visitElement}. */
interface LinkCollector {
  links: ResourceLink[];
  anchors: Set<string>;
  /**
   * The parse5 attribute tokens that have already produced a link.
   *
   * Per-document, created in {@link parseHtmlContent} and thrown away with it —
   * NOT module state. Module state would make the second parse of a page emit
   * nothing, an order-dependent silent zero that no single-document test could
   * see. Pinned by the "de-duplicates within ONE document only" test.
   */
  seenAttributes: Set<P5Attribute>;
}

/**
 * Emit a link for `attr` unless this exact authored attribute already did.
 *
 * ⛔ HTML's **adoption agency algorithm** means the number of `<a>` elements
 * parse5 hands back is not the number of `<a href>` the author wrote. When a
 * formatting element is still on the active-formatting-elements list as a block
 * boundary closes out from under it, the tree builder RE-OPENS it, and the
 * reconstructed element carries a **full** `sourceCodeLocation` pointing at the
 * SAME source attribute (measured — see {@link makeLink}'s table). One authored
 * `href` therefore produced two `ResourceLink`s with an identical span, which
 * is a defect and not a cosmetic duplicate:
 *
 * - `blob_references` got two rows for one authored reference;
 * - `hasReferenceSpan` could not filter the clone out — the clone HAS a span;
 * - every ordering column was equal, so `edges.refOrdinal` was ambiguous
 *   between the two.
 *
 * The key is parse5 **attribute-token identity** — `===` on the `P5Attribute`
 * object — and nothing weaker will do:
 *
 * - **Not the value.** Two separate `<a href="./same.md">` on one page are two
 *   legitimate references, and any key derived from `href` collapses them.
 * - **Not the span.** The span is what the clone copies; keying on it is just
 *   the value problem with extra steps, and it cannot express "same attribute"
 *   for an un-located clone at all.
 * - **Not the emitted object.** The two clone rows are NOT byte-identical
 *   `ResourceLink`s: `text` differs, because each element wraps a different
 *   slice of the misnested content (`elementText` gives `'1'` for the original
 *   and `'2'` for the clone in the `<p>` case). A de-dupe on the emitted link
 *   would see two distinct objects and keep both.
 *
 * Identity is exactly the "same authored attribute" predicate because of how
 * parse5 builds the tree: each source attribute is tokenized into ONE object,
 * an element's `attrs` array holds those objects, and a clone is created from
 * the original's `attrs` — reusing the array and its members by reference. So
 * two elements share an attribute object if and only if one was cloned from the
 * other, while two genuinely authored attributes are always distinct objects
 * even when they spell the same thing.
 *
 * Applied at the PUSH point rather than special-cased to `<a>`: `<img>` is a
 * void element and cannot be re-opened this way, but the invariant being
 * enforced ("one authored attribute, one link") is a property of link emission,
 * not of the anchor branch, and a rule stated where it applies does not need
 * re-deriving when a third link-bearing element is added.
 *
 * The FIRST occurrence wins. In every measured shape the original precedes its
 * clone in document order, so keeping the first keeps the element the author
 * actually wrote — and, for the un-located shape, keeps the one that has a
 * position over the one that does not.
 *
 * @param element - The element carrying the attribute
 * @param attr - The attribute token, which doubles as the de-duplication key
 * @param collector - This document's links and already-seen attribute tokens
 */
function pushLink(element: P5Element, attr: P5Attribute, collector: LinkCollector): void {
  if (collector.seenAttributes.has(attr)) {
    return;
  }
  collector.seenAttributes.add(attr);
  collector.links.push(makeLink(element, attr));
}

function visitElement(element: P5Element, collector: LinkCollector): void {
  if (element.tagName === 'a') {
    const href = findAttr(element, 'href');
    if (href !== undefined) {
      pushLink(element, href, collector);
    }
    const name = getAttr(element, 'name');
    if (name !== undefined && name !== '') {
      collector.anchors.add(name);
    }
  } else if (element.tagName === 'img') {
    const src = findAttr(element, 'src');
    if (src !== undefined) {
      pushLink(element, src, collector);
    }
  }

  const id = getAttr(element, 'id');
  if (id !== undefined && id !== '') {
    collector.anchors.add(id);
  }
}

/**
 * Parse HTML source text into a `ParseResult`.
 *
 * This is the content-addressable half of `parseHtml`: a pure function of its
 * two arguments with no filesystem access, no path handling and no I/O, so the
 * same `(content, sizeBytes)` pair always yields the same result and callers may
 * cache it keyed on the content.
 *
 * `sizeBytes` is a **parameter rather than something derived from `content`**
 * because the two are not interchangeable. The on-disk byte count
 * (`stat().size`) is what reaches packaged output; `Buffer.byteLength(content)`
 * and `content.length` are computed from the *decoded* string and diverge from
 * it on malformed UTF-8 (lone surrogates decode to U+FFFD, changing the byte
 * count). Making it a parameter keeps the choice of authority with the caller
 * that actually has the file — see `parseHtml`, which passes `stat().size`.
 *
 * @param content - The HTML source text.
 * @param sizeBytes - Byte size to report; the caller owns where it comes from.
 */
export function parseHtmlContent(content: string, sizeBytes: number): ParseResult {
  // Every `passStartedAt` / `recordParsePass` pair is the sub-phase timing seam
  // (`parse-timing.ts`), off unless `VAT_PARSE_TIMING` names a dump directory.
  // This parser reports into its OWN group with its OWN passes — an HTML-heavy
  // tree must not be described by markdown's pass list, and the two share a pass
  // name only where they genuinely run the same operation.
  const totalStartedAt = parseTimingStart();

  let passStartedAt = parseTimingStart();
  const { document, parseErrors } = parseHtmlDocument(content);
  recordParsePass(ParsePass.HtmlParse, passStartedAt);

  // Scoped to THIS call, so the de-duplication in `pushLink` can never reach
  // across two documents — see `LinkCollector.seenAttributes`.
  const collector: LinkCollector = {
    links: [],
    anchors: new Set<string>(),
    seenAttributes: new Set<P5Attribute>(),
  };

  // ONE walk: the generator and the per-element visit are inseparable in the
  // cost sense, so they are bracketed together rather than pretending the
  // traversal and the extraction are separable passes.
  passStartedAt = parseTimingStart();
  for (const element of walkElements(document)) {
    visitElement(element, collector);
  }
  recordParsePass(ParsePass.HtmlElementWalk, passStartedAt);

  const { links } = collector;
  const anchorList = [...collector.anchors];

  // Hoisted out of the object literal below purely so they can be bracketed;
  // both are pure, so the order they run in is not observable.
  passStartedAt = parseTimingStart();
  const estimatedTokenCount = estimateTokens(content);
  recordParsePass(ParsePass.HtmlEstimateTokens, passStartedAt);

  // No fences: HTML has no fenced-code construct, so an HTML blob is all prose.
  // This is a modelling choice, not a stub — `<pre><code>` is markup with no
  // offset range the parse5 tree exposes as "code context", and treating a
  // `<pre>` block as code would need a second, HTML-specific definition of the
  // column that markdown's `code` nodes already define.
  passStartedAt = parseTimingStart();
  const contentMeasures = measureContent(content, []);
  recordParsePass(ParsePass.HtmlMeasureContent, passStartedAt);

  const result: ParseResult = {
    links,
    headings: [],
    content,
    sizeBytes,
    estimatedTokenCount,
    contentMeasures,
    ...(anchorList.length > 0 && { anchors: anchorList }),
    ...(parseErrors.length > 0 && { parseErrors }),
  };

  recordParsedDocument(ParserKind.Html, sizeBytes);
  recordParsePass(ParsePass.HtmlTotal, totalStartedAt);

  return result;
}

/**
 * Parse an HTML file into a `ParseResult`.
 *
 * @param filePath - Absolute path to the HTML file.
 */
export async function parseHtml(filePath: string): Promise<ParseResult> {
  // `readTextContent`, never `readFile(path, 'utf-8')`: this reads a CORPUS
  // document, whose encoding VAT does not choose. See text-content.ts.
  const [decoded, stats] = await Promise.all([
    readTextContent(filePath),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is a user-provided path parameter
    stat(filePath),
  ]);

  return parseHtmlContent(decoded.text, stats.size);
}

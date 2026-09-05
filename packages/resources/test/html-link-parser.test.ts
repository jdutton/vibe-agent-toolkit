/* eslint-disable security/detect-non-literal-fs-filename -- test writes to temp dirs from computed paths */
import { readFile, stat } from 'node:fs/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { parseHtml, parseHtmlContent } from '../src/html-link-parser.js';
import { blobReferencesFor } from '../src/projection/blob-references.js';
import type { ResourceLink } from '../src/types.js';

import { scratchFixtureWriter } from './test-helpers.js';

const fixtures = scratchFixtureWriter('vat-html-');

afterAll(fixtures.cleanup);

/**
 * Cut `source` with each link's span, or `undefined` where a link carries none.
 *
 * Slicing is the only assertion that proves an offset pair is *right*. Two
 * plausible integers are indistinguishable from correct ones until you cut the
 * source with them — a suite that asserts `startOffset === 3` still passes when
 * the pair drifts to some other self-consistent-looking spot, whereas one that
 * asserts the slice equals `href="./x.md"` does not.
 *
 * Absent spans map to `undefined` rather than being filtered out so that a
 * location-less link stays visible in the result array and cannot be confused
 * with a zero-offset one, which would slice to `''`.
 */
function sliceSpans(source: string, links: readonly ResourceLink[]): (string | undefined)[] {
  return links.map((link) =>
    link.startOffset === undefined || link.endOffset === undefined
      ? undefined
      : source.slice(link.startOffset, link.endOffset),
  );
}

/** Parse `source` as content and slice it by the spans that came back. */
function parseAndSliceSpans(source: string): (string | undefined)[] {
  return sliceSpans(source, parseHtmlContent(source, source.length).links);
}

/** One emitted link, reduced to the facts a duplicate cannot hide behind. */
interface LinkPosition {
  href: string;
  text: string;
  line: number | undefined;
  slice: string | undefined;
  startOffset: number | undefined;
  endOffset: number | undefined;
}

/**
 * Every emitted link as a {@link LinkPosition}, in emission order.
 *
 * Asserting the WHOLE array against a literal is what makes a duplicate
 * visible. `links.map(l => l.href)` would show `['./r.md', './r.md']` and could
 * be waved through as "two references on the page"; the tuple form shows the
 * two carrying the *same* offsets, which is the thing that cannot be true of
 * two authored references. The slice rides along so a plausible-but-wrong
 * offset pair fails here rather than passing (see {@link sliceSpans}), and
 * `text` rides along because it is the ONE field the two clone rows differ in
 * — the reason a de-dupe on the emitted object could never have worked.
 */
function parseLinkPositions(source: string): LinkPosition[] {
  const { links } = parseHtmlContent(source, source.length);
  const slices = sliceSpans(source, links);
  return links.map((link, index) => ({
    href: link.href,
    text: link.text,
    line: link.line,
    slice: slices[index],
    startOffset: link.startOffset,
    endOffset: link.endOffset,
  }));
}

/**
 * A page whose second `<a>` is *reconstructed* by the tree builder rather than
 * read from a start tag.
 *
 * The open `<a>` is still on the active-formatting-elements list when the inner
 * `<div>` forces a re-open, so parse5 clones it — and this clone carries no
 * `sourceCodeLocation` at all, not merely a missing `attrs` entry.
 *
 * ⛔ This said `sourceCodeLocation === null`. Measured: it is `undefined`
 * (`typeof === 'undefined'`). The distinction is not pedantry — a mutation
 * written straight off the old wording (comparing against `null`) was a silent
 * no-op, so the old text made the guard look tested when nothing tested it.
 *
 * ⛔ This also said it was "the one shape found (by brute-forcing
 * malformed/misnested fixtures through parse5) that reaches the location-less
 * branch in `makeLink`". Both halves have since been falsified:
 *
 * 1. There is a SECOND clone shape — `<p><a href="./r.md">1</p>2</a>` and the
 *    `<li>` twin in the A5 describe — and its clone carries a **full**
 *    `sourceCodeLocation` over the same source attribute. "A clone has no
 *    location" was a claim about this fixture generalized to a producer.
 * 2. This shape no longer reaches the location-less branch at all, because the
 *    clone here shares its original's parse5 attribute TOKEN by reference
 *    (measured: `attrs` array identity AND `href` token identity both `true`,
 *    exactly as in the located-clone shapes), so `pushLink` de-duplicates it
 *    away before `makeLink` is ever called for it. The location-less branch in
 *    `makeLink` is therefore defensive-only now — see its docstring.
 *
 * The remaining negatives still hold: `<template>` does not reach it, because
 * `walkElements` never descends into its separate `content` fragment, and an
 * unterminated quote does not, because the element is dropped at EOF instead.
 *
 * ⚠️ Twinned, deliberately, in `projection-blob-references.test.ts`, which
 * still asserts THREE parsed links here (`[1, undefined, 1]` lines and
 * `[3, undefined, 25]` offsets) to prove the row builder drops a location-less
 * link. That twin is now stale and is that file's owner to update: the parser
 * emits two links for this page, and neither lacks a position. Its other two
 * tests are unaffected — `halfPositionedLink` subtracts a half-position from
 * the FIRST link, which still carries one.
 */
const RECONSTRUCTED_ANCHOR_HTML =
  '<a href="./x.md"><div><a href="./y.md"><div>d</div></a></div>';

/**
 * Parse one file through both entry points, from the same bytes on disk.
 *
 * `sizeBytes` comes from `stat()` rather than the decoded string, because the
 * two diverge on malformed UTF-8 and the file half is the authority — that is
 * the whole reason `parseHtmlContent` takes it as a parameter. Both callers
 * need `content` back as well, to slice spans out of the exact source.
 *
 * @param file - Absolute path to an HTML file already written
 * @returns The two parse results and the decoded source they came from
 */
async function parseBothWays(file: string): Promise<{
  fromFile: Awaited<ReturnType<typeof parseHtml>>;
  fromContent: ReturnType<typeof parseHtmlContent>;
  content: string;
}> {
  const fromFile = await parseHtml(file);
  const [content, stats] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);
  return { fromFile, fromContent: parseHtmlContent(content, stats.size), content };
}

describe('parseHtml', () => {
  it('extracts <a href> and <img src> links', async () => {
    const file = await fixtures.write(
      'page.html',
      '<html><body><a href="./other.html">x</a><img src="img/logo.png"></body></html>',
    );
    const result = await parseHtml(file);
    const hrefs = result.links.map((l) => l.href).sort((a, b) => a.localeCompare(b));
    expect(hrefs).toEqual(['./other.html', 'img/logo.png']);
    expect(result.links.find((l) => l.href === './other.html')?.type).toBe('local_file');
  });

  it('collects id and name attributes as anchors', async () => {
    const file = await fixtures.write(
      'anchors.html',
      '<html><body><h2 id="intro">Intro</h2><a name="legacy"></a></body></html>',
    );
    const result = await parseHtml(file);
    expect(new Set(result.anchors)).toEqual(new Set(['intro', 'legacy']));
    expect(result.headings).toEqual([]);
  });

  it('reports malformed markup via parseErrors', async () => {
    const file = await fixtures.write('bad.html', '<html><body><p>unclosed</body></html>');
    const result = await parseHtml(file);
    expect(result.parseErrors).toBeDefined();
    expect((result.parseErrors ?? []).length).toBeGreaterThan(0);
  });

  it('omits anchors/parseErrors when there are none', async () => {
    const file = await fixtures.write('clean.html', '<!doctype html><title>t</title><p>hi</p>');
    const result = await parseHtml(file);
    expect(result.anchors).toBeUndefined();
    expect(result.parseErrors).toBeUndefined();
  });
});

describe('parseHtmlContent', () => {
  it('is equivalent to parseHtml for the same file', async () => {
    const file = await fixtures.write(
      'equivalence.html',
      [
        // No doctype on purpose: parse5 reports `missing-doctype`, so this
        // fixture exercises the optional `parseErrors` key as well as `anchors`.
        '<html><head><title>Equivalence</title></head>',
        '<body><h1 id="top">Top</h1>',
        '<a href="./other.html">other</a>',
        '<a name="legacy"></a>',
        '<img src="img/logo.png">',
        '<p>unclosed',
        '</body></html>',
      ].join('\n'),
    );

    const { fromFile, fromContent } = await parseBothWays(file);

    expect(fromContent).toEqual(fromFile);
    // Shape guards: HTML omits unresolvedReferences entirely and does populate
    // parseErrors — the inverse of the markdown parser. Both halves must agree.
    expect('unresolvedReferences' in fromContent).toBe(false);
    expect('unresolvedReferences' in fromFile).toBe(false);
    expect(fromContent.parseErrors).toBeDefined();
  });

  it('parses content that corresponds to no file on disk', () => {
    const result = parseHtmlContent(
      '<html><body><h2 id="virtual">V</h2><a href="https://example.com">e</a></body></html>',
      4242,
    );

    expect(result.links.map((l) => l.href)).toEqual(['https://example.com']);
    expect(result.anchors).toEqual(['virtual']);
    expect(result.headings).toEqual([]);
    // sizeBytes is whatever the caller supplied — never derived from content.
    expect(result.sizeBytes).toBe(4242);
  });

  it('reports the on-disk byte count, not the decoded string length', async () => {
    // A lone 0xFF is invalid UTF-8 and decodes to U+FFFD, which re-encodes to
    // THREE bytes. So the file is 17 bytes on disk but its decoded form measures
    // 19 — the only condition under which `stat().size`,
    // `Buffer.byteLength(content)` and `content.length` disagree.
    //
    // This fixture exists because the suite could not otherwise tell them apart:
    // with ASCII-only fixtures, swapping `stat().size` for
    // `Buffer.byteLength(content)` in `parseHtml` leaves every test green. That
    // swap is a real defect — `sizeBytes` reaches packaged output bytes via
    // content-transform.ts — so it must be falsifiable here.
    const file = await fixtures.write(
      'malformed.html',
      Uint8Array.from([...Buffer.from('<p id="bad">'), 0xff, ...Buffer.from('</p>')]),
    );

    const [content, stats] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);

    // Guard the guard: if these ever stop differing the fixture has lost its
    // power and the assertions below become vacuous.
    expect(stats.size).toBe(17);
    expect(Buffer.byteLength(content)).toBe(19);
    expect(content).toHaveLength(17);

    const fromFile = await parseHtml(file);
    expect(fromFile.sizeBytes).toBe(stats.size);
    expect(fromFile.sizeBytes).not.toBe(Buffer.byteLength(content));

    // And the content-only half reports exactly what it was handed.
    expect(parseHtmlContent(content, stats.size).sizeBytes).toBe(17);
    expect(parseHtmlContent(content, Buffer.byteLength(content)).sizeBytes).toBe(19);
  });
});

/**
 * Spans are what `blob-references.ts › astCandidates` requires before it will
 * emit a row: it needs `line`, `startOffset` and `endOffset` together and skips
 * any link missing one. Emitting a line alone once put every HTML reference in
 * the skip count, so these tests guard the edges where the lookup could quietly
 * return `undefined` again and nothing else would go red.
 */
describe('link source spans', () => {
  it('gives <img src> its own span, distinct from a sibling <a href>', () => {
    // The two attributes are read under different names off different elements,
    // so a lookup hardcoded to `href` would give the img the anchor's span (or
    // none) and nothing about the href assertions would notice.
    const source = '<a href="./guide.md">g</a><img src="./logo.png" alt="l">';

    expect(parseAndSliceSpans(source)).toEqual(['href="./guide.md"', 'src="./logo.png"']);
  });

  it('finds the span through uppercase and mixed-case attribute names', () => {
    // This pins a *parse5* contract, not a branch of ours: parse5 lowercases the
    // key of `sourceCodeLocation.attrs` while leaving the source text's own
    // casing intact. Our lookup key is the hardcoded lowercase `href`/`src`, so
    // if parse5 ever keyed that record by the source casing instead, the lookup
    // would return `undefined` with no type error and no other failing test —
    // the exact silent regression that dropped every HTML reference before.
    // Note the sliced text keeps the original casing; only the key is folded.
    const source = '<A HrEf="./up.md">u</A><IMG SRC="./up.png">';

    expect(parseAndSliceSpans(source)).toEqual(['HrEf="./up.md"', 'SRC="./up.png"']);
  });

  it('finds the span of a namespaced attribute through its SOURCE spelling', () => {
    // parse5 splits `xlink:href` into `{ prefix: 'xlink', name: 'href' }`, so
    // `attrs.find(a => a.name === 'href')` matches it and the link IS emitted —
    // while `sourceCodeLocation.attrs` keys the span under the undivided source
    // spelling `xlink:href`. A lookup on `attr.name` therefore misses, the link
    // comes back span-less, and `astCandidates` drops it: the same silent zero
    // the whole-attribute span fix removes for ordinary `href`, surviving in
    // the one shape nothing covered.
    //
    // Asserted by SLICING, so a lookup that found some other attribute's span
    // (`alt`, say) fails here rather than passing on a plausible integer pair.
    const source = '<svg><a xlink:href="./icon.md"><text>i</text></a></svg>';

    expect(parseAndSliceSpans(source)).toEqual(['xlink:href="./icon.md"']);
  });

  it('states nodeType on every link', () => {
    // `htmlAttribute` is what keeps these rows out of the markdown forms that
    // `closure-extent` and `claude-context-discovery` follow. It is a fact
    // about the producer, not about whether parse5 managed to record a
    // position, so a mutant that made it conditional on the span turns this
    // red.
    //
    // ⛔ The title was 'states nodeType on every link, span or no span' and
    // this asserted THREE entries, the middle one being the location-less
    // clone. `pushLink` now de-duplicates that clone away — it shares the
    // first anchor's parse5 attribute token — so this page yields two links
    // and both carry spans. The "span or no span" half of the claim is no
    // longer exercisable through this parser at all; see
    // {@link RECONSTRUCTED_ANCHOR_HTML}.
    const { links } = parseHtmlContent(
      RECONSTRUCTED_ANCHOR_HTML,
      RECONSTRUCTED_ANCHOR_HTML.length,
    );

    expect(links.map((link) => link.nodeType)).toEqual(['htmlAttribute', 'htmlAttribute']);
  });

  it('spans the whole attribute for single-quoted and unquoted values', () => {
    // The span deliberately covers the construct, not the URL inside it, to
    // match what the markdown producer carries for mdast. These two quotings
    // are where "whole attribute" and "just the value" differ most visibly.
    const source = ["<a href='./sq.md'>s</a>", '<a href=./uq.md>u</a>'].join('\n');

    expect(parseAndSliceSpans(source)).toEqual(["href='./sq.md'", 'href=./uq.md']);
  });

  it('spans the first of a repeated attribute, matching the value it kept', () => {
    // Per the HTML spec parse5 keeps the FIRST duplicate and discards the rest.
    // The span has to agree with that choice: a span over `./second.md` beside a
    // value of `./first.md` would make the row self-contradictory.
    const source = '<a href="./first.md" href="./second.md">x</a>';
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.href)).toEqual(['./first.md']);
    expect(sliceSpans(source, links)).toEqual(['href="./first.md"']);
  });

  it('drops the location-less clone, leaving one link per authored href', () => {
    const { links } = parseHtmlContent(
      RECONSTRUCTED_ANCHOR_HTML,
      RECONSTRUCTED_ANCHOR_HTML.length,
    );

    // ⛔ This test was 'omits line and offsets entirely when parse5 recorded no
    // location' and expected `['./x.md', './x.md', './y.md']` — the middle
    // entry being the tree builder's clone of the first anchor, emitted with
    // neither `line` nor offsets. It was justified as "the location-less link
    // is still a LINK — dropping it would lose a real reference from the
    // graph". That justification was FALSE: the clone is the same authored
    // `href="./x.md"` attribute as the first link (measured — the two elements
    // share one parse5 attribute-token object by reference), so dropping it
    // loses nothing; `./x.md` is still in the graph, once. The page authors two
    // references and now yields two links.
    //
    // ⚠️ COVERAGE LOST, recorded rather than hidden: the location-less branch
    // in `makeLink` had exactly one real-parser witness, this clone, and
    // de-duplicating clones is precisely what removes it — an element with no
    // `sourceCodeLocation` is only ever a clone, and a clone always shares its
    // original's attribute tokens. The branch is kept as defensive code (see
    // its docstring) but is no longer reachable end to end, so the
    // `undefined`-VALUED fallback mutant (`{ startOffset: span?.startOffset, …
    // }`) that the key-set assertion below was written to catch now has no
    // fixture that can expose it through this parser.
    expect(links.map((link) => link.href)).toEqual(['./x.md', './y.md']);

    // Asserting WHICH KEYS EXIST, not their values, still guards the shape:
    // Vitest's `toEqual` cannot tell an absent key from an `undefined`-valued
    // one (measured: `toEqual({a: 1}, {a: 1, b: undefined})` passes,
    // `toStrictEqual` fails), so a value-only assertion would wave through a
    // link carrying `startOffset: undefined`.
    //
    // ⛔ The reason recorded here used to be "a `{ startOffset: 0, endOffset: 0
    // }` fallback would satisfy any `toEqual` on the link object". Measured
    // false: `0` is not `undefined`, so a plain `toEqual` on the object rejects
    // a `0`/`0` fallback on its own. Only the first half of the old claim held.
    //
    // Sorted, NOT in insertion order: no schema specifies key order, so
    // reordering the two conditional spreads in `makeLink` yields an object
    // with the same keys, the same values and the same JSON — a mutant that
    // changes no fact must not turn this red, or the next refactor does.
    expect(links.map((link) => Object.keys(link).sort((a, b) => a.localeCompare(b)))).toEqual([
      ['endOffset', 'href', 'line', 'nodeType', 'startOffset', 'text', 'type'],
      ['endOffset', 'href', 'line', 'nodeType', 'startOffset', 'text', 'type'],
    ]);

    // Sliced, so the surviving pair cannot be a plausible-but-wrong offset
    // pair: keeping the FIRST occurrence is what makes `./x.md` land on the
    // authored attribute at offset 3 rather than on nothing.
    expect(sliceSpans(RECONSTRUCTED_ANCHOR_HTML, links)).toEqual([
      'href="./x.md"',
      'href="./y.md"',
    ]);
  });

  it('keeps offsets strictly increasing and non-overlapping down the page', () => {
    const source = [
      '<p><a href="./a.md">a</a> <a href="./b.md">b</a></p>',
      '<p><img src="./c.png"><a href="./d.md">d</a></p>',
    ].join('\n');
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.line)).toEqual([1, 1, 2, 2]);
    expect(sliceSpans(source, links)).toEqual([
      'href="./a.md"',
      'href="./b.md"',
      'src="./c.png"',
      'href="./d.md"',
    ]);

    // Flattening to [start, end, start, end, …] turns "ordered AND disjoint"
    // into one property: the sequence is strictly increasing. Sorted-copy
    // equality gives non-decreasing; distinct values rule out the ties, which
    // is what an empty or a shared span would look like.
    const bounds = links.flatMap((link) => [link.startOffset ?? -1, link.endOffset ?? -1]);
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b));
    expect(new Set(bounds).size).toBe(bounds.length);
  });

  it('reports the same offsets from a file as from the identical bytes', async () => {
    // The equivalence test above compares whole results, so it stays green if
    // BOTH halves lose their offsets. This one additionally proves the offsets
    // exist, by slicing with them.
    const body = ['<a href="./one.md">1</a>', '<img src="./two.png">'].join('\n');
    const file = await fixtures.write('offsets.html', body);

    const { fromFile, fromContent, content } = await parseBothWays(file);

    const expected = ['href="./one.md"', 'src="./two.png"'];
    expect(sliceSpans(content, fromFile.links)).toEqual(expected);
    expect(sliceSpans(content, fromContent.links)).toEqual(expected);
    expect(fromFile.links).toEqual(fromContent.links);
  });
});

/**
 * The module header's non-goal claim: "`<base href>` is not honored —
 * relative links are resolved against the file's own directory, not a
 * document base." `visitElement` only pushes a link for `tagName === 'a'` or
 * `'img'`, so `<base>` itself is never a candidate — verified below rather
 * than assumed. The second half (hrefs recorded raw, un-resolved against any
 * base) is also true, and true for a reason outside this file: this parser
 * never fills `resolvedPath` at all, so there is nothing here for a `<base>`
 * to influence even in principle — resolution against the file's own
 * directory happens downstream, in `utils.ts › resolveLocalHref`, which takes
 * `sourceDir`, never a document base. Both halves hold as written; nothing
 * to fix.
 */
describe('A1 — <base href> is not a link row and does not rewrite other hrefs', () => {
  it('does not emit <base href> as a link', () => {
    const source = '<html><head><base href="/x/"></head><body></body></html>';
    const { links } = parseHtmlContent(source, source.length);

    expect(links).toEqual([]);
  });

  it('records <a href> raw, ignoring a <base href> earlier in the document', () => {
    const source = [
      '<html><head><base href="/x/"></head>',
      '<body><a href="./deep.md">d</a></body></html>',
    ].join('\n');
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.href)).toEqual(['./deep.md']);
  });
});

/**
 * `makeLink` reads `line` from the attribute's own span (`span.startLine`),
 * not the element's start line. For a start tag split across lines the two
 * disagree: the element starts on line 1, `href` lives on line 2. A `line`
 * that names a different line than the span it accompanies is a row no
 * consumer can trust — "does this blob's line contain this row's span?"
 * would be false.
 */
describe('A2 — line agrees with the span on a multi-line start tag', () => {
  it('reports the line the href attribute is actually on, not the element start line', () => {
    const source = ['<a', '  href="./deep.md">x</a>'].join('\n');
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.line)).toEqual([2]);
    expect(sliceSpans(source, links)).toEqual(['href="./deep.md"']);
  });
});

/**
 * `ResourceLinkSchema.text` is `z.string()` — required, not nullable — so
 * `null` (`"this form carries no text"`) is out of reach without widening the
 * schema, which is out of scope here (see `makeLink`'s docstring). The
 * remaining option is to populate it: an `<a>`'s text is its child nodes,
 * walked by `elementText`. `<img src>` has no children to walk and keeps
 * `''`, which is honest for it — an image genuinely carries no text, and
 * `alt` is explicitly not link text.
 */
describe('A3 — anchor text content, not a hardcoded empty string', () => {
  it.each([
    {
      name: "populates text from the <a> element's child text content",
      source: '<a href="./g.md">Guide</a>',
      texts: ['Guide'],
    },
    {
      name: 'concatenates text through nested inline markup inside the <a>',
      source: '<a href="./g.md"><b>Bold</b> and plain</a>',
      texts: ['Bold and plain'],
    },
    {
      name: 'leaves text empty for <img src>, which has no child nodes to collect',
      source: '<img src="./logo.png" alt="Logo">',
      texts: [''],
    },
  ])('$name', ({ source, texts }) => {
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.text)).toEqual(texts);
  });
});

/**
 * `classifyLink` (`link-parser.ts`) and `lexicalFeatures` (`blob-references.ts`)
 * are not this file's — this describe only PINS what this parser hands them
 * (the raw `href`) and what comes back, so a regression in either is visible
 * from here without editing either owner's file.
 */
describe('A4 — protocol-relative and query-string/fragment hrefs', () => {
  it('stores the raw href with its query string and fragment intact, and keeps classifying it local_file', () => {
    // Correct as observed: the `./` prefix short-circuits `classifyLink`
    // before it ever inspects the extension, so the query string and fragment
    // riding along do not change the type here.
    const source = '<a href="./guide.md?v=2">a</a><a href="./guide.md#section">b</a>';
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.href)).toEqual(['./guide.md?v=2', './guide.md#section']);
    expect(links.map((link) => link.type)).toEqual(['local_file', 'local_file']);
  });

  // Was a FINDING, not this file's to fix (`classifyLink` lives in
  // `link-parser.ts`, owned by Task B) — now fixed there and promoted from
  // `it.fails` to `it`, per this repo's idiom: an `it.fails` that starts
  // passing is itself a failure, so leaving it pinned as "expected to fail"
  // once it is fixed would turn the suite red in a confusing way.
  it('classifies a protocol-relative href as external, per RFC 3986 (finding: classifyLink in link-parser.ts)', () => {
    const source = '<img src="//cdn.example.com/x.js">';
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.type)).toEqual(['external']);
  });

  // Was a FINDING, not this file's to fix (`EXTENSION_SUFFIX` lives in
  // `blob-references.ts › lexicalFeatures`, owned by Task B) — now fixed there
  // and promoted from `it.fails` to `it`, per this repo's idiom: an `it.fails`
  // that starts passing is itself a failure, so leaving it pinned as "expected
  // to fail" once it is fixed would turn the suite red in a confusing way.
  // Demonstrated through the real pipeline (`parseHtmlContent` →
  // `blobReferencesFor`, both exported, neither edited) rather than by
  // reaching into an unexported function.
  it('sees the .md extension through a trailing query string (finding: lexicalFeatures in blob-references.ts)', () => {
    const source = '<a href="./guide.md?v=2">a</a>';
    const parsed = parseHtmlContent(source, source.length);
    const rows = blobReferencesFor(`html.${'f'.repeat(64)}`, parsed);

    expect(rows.map((row) => row.hasExtension)).toEqual([true]);
  });
});

/**
 * A5 — one authored `href`, one `ResourceLink`, however many elements the tree
 * builder ends up with.
 *
 * HTML's **adoption agency algorithm** re-opens a formatting element that is
 * still on the active-formatting-elements list when a block boundary closes
 * out from under it. parse5 therefore produces MORE `<a>` elements than the
 * source authored, and — in the shape below — gives the extra one a **full**
 * `sourceCodeLocation` pointing back at the same source attribute. One
 * authored `href` then became two `ResourceLink`s carrying a byte-identical
 * span, which is not a cosmetic duplicate:
 *
 * - `blob_references` gets two rows for one authored reference;
 * - `hasReferenceSpan` cannot filter the clone out — the clone HAS a span;
 * - every ordering column is equal, so `edges.refOrdinal` is ambiguous between
 *   them.
 *
 * The fix de-duplicates on parse5 **attribute-token identity** (`===` on the
 * `P5Attribute` object), which is exactly the "same authored attribute"
 * predicate: parse5 builds one attribute object per source attribute, and a
 * clone reuses the original array and objects by reference. No value-based key
 * could work — see the negative control, where two separately authored
 * `<a href="./same.md">` are two legitimate references.
 */
describe('A5 — an adoption-agency clone does not double-emit its authored href', () => {
  it('emits ONE link when a still-open <a> is re-opened across a </p>', () => {
    // `</p>` closes the paragraph while `<a>` is still open, so the trailing
    // `2</a>` forces parse5 to re-open the anchor. Both elements report the
    // span of the ONE `href` at offset 6.
    expect(parseLinkPositions('<p><a href="./r.md">1</p>2</a>')).toEqual([
      { href: './r.md', text: '1', line: 1, slice: 'href="./r.md"', startOffset: 6, endOffset: 19 },
    ]);
  });

  it('emits ONE link when an <a> is re-opened across an implied </li>', () => {
    // A second `<li>` implicitly closes the first; same mechanism, different
    // block element, so this fails independently of any `<p>`-specific fix.
    expect(parseLinkPositions('<ul><li><a href="./l.md">a<li>b</a></ul>')).toEqual([
      { href: './l.md', text: 'a', line: 1, slice: 'href="./l.md"', startOffset: 11, endOffset: 24 },
    ]);
  });

  it('keeps BOTH links when one page authors the same href twice', () => {
    // ⭐ THE MUTATION GUARD. Every cheaper de-dupe key — the `href` string, the
    // `(href, span)` pair, a JSON of the emitted object — passes the two tests
    // above and turns this one red, because two separately authored anchors are
    // two real references that happen to point at the same target. Only
    // attribute-token identity separates "the parser cloned an element" from
    // "the author wrote it twice": parse5 mints a fresh attribute object per
    // source attribute, so the clone is the only case where two elements share
    // one object.
    const source = '<a href="./same.md">1</a><a href="./same.md">2</a>';

    expect(parseLinkPositions(source)).toEqual([
      { href: './same.md', text: '1', line: 1, slice: 'href="./same.md"', startOffset: 3, endOffset: 19 },
      { href: './same.md', text: '2', line: 1, slice: 'href="./same.md"', startOffset: 28, endOffset: 44 },
    ]);
  });

  it('leaves a well-nested <a> spanning a block element alone — no clone to drop', () => {
    // The control for the two misnesting fixtures: the `<a>` here also wraps a
    // block-level `<div>`, but it is properly closed, so no adoption agency
    // runs and parse5 yields ONE element. Without this, a "fix" that dropped
    // every `<a>` after the first would still pass the two tests above.
    const source = '<div><a href="./d.md">x<div>y</div>z</a></div>';

    expect(parseLinkPositions(source)).toEqual([
      { href: './d.md', text: 'xyz', line: 1, slice: 'href="./d.md"', startOffset: 8, endOffset: 21 },
    ]);
  });

  it('de-duplicates within ONE document only, never across two parses', () => {
    // The seen-set is created per `parseHtmlContent` call. If it were module
    // state, the second parse of an identical page would emit nothing — a
    // corpus-order-dependent silent zero that no single-document test can see.
    const source = '<p><a href="./r.md">1</p>2</a>';

    expect(parseLinkPositions(source)).toEqual(parseLinkPositions(source));
    expect(parseLinkPositions(source)).toHaveLength(1);
  });
});

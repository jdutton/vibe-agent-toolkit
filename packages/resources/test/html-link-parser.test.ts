/* eslint-disable security/detect-non-literal-fs-filename -- test writes to temp dirs from computed paths */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { parseHtml, parseHtmlContent } from '../src/html-link-parser.js';
import { blobReferencesFor } from '../src/projection/blob-references.js';
import type { ResourceLink } from '../src/types.js';

const dirs: string[] = [];

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

/**
 * A page whose second `<a>` is *reconstructed* by the tree builder rather than
 * read from a start tag.
 *
 * The open `<a>` is still on the active-formatting-elements list when the inner
 * `<div>` forces a re-open, so parse5 clones it — and a clone carries no
 * `sourceCodeLocation` at all, not merely a missing `attrs` entry.
 *
 * ⛔ This said `sourceCodeLocation === null`. Measured: it is `undefined`
 * (`typeof === 'undefined'`). The distinction is not pedantry — a mutation
 * written straight off the old wording (comparing against `null`) was a silent
 * no-op, so the old text made the guard look tested when nothing tested it.
 *
 * This is the one shape found (by brute-forcing malformed/misnested fixtures
 * through parse5) that reaches the location-less branch in `makeLink`;
 * `<template>` does not, because `walkElements` never descends into its
 * separate `content` fragment, and an unterminated quote does not, because the
 * element is dropped at EOF instead.
 *
 * ⚠️ Twinned, deliberately, in `projection-blob-references.test.ts`: the row
 * builder needs the same real parser output to prove it drops a location-less
 * link. It is restated there rather than imported, because importing one test
 * file from another re-registers its whole suite inside the importer.
 */
const RECONSTRUCTED_ANCHOR_HTML =
  '<a href="./x.md"><div><a href="./y.md"><div>d</div></a></div>';

async function writeHtml(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-html-'));
  dirs.push(dir);
  const file = safePath.join(dir, name);
  await writeFile(file, body, 'utf-8');
  return file;
}

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

/**
 * Write raw bytes, bypassing UTF-8 encoding.
 *
 * Needed because every ASCII fixture makes `stat().size` and
 * `Buffer.byteLength(decodedContent)` equal, so an ASCII-only suite cannot tell
 * the two apart — and telling them apart is the whole point of `sizeBytes`
 * being a parameter.
 */
async function writeHtmlBytes(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-html-'));
  dirs.push(dir);
  const file = safePath.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('parseHtml', () => {
  it('extracts <a href> and <img src> links', async () => {
    const file = await writeHtml(
      'page.html',
      '<html><body><a href="./other.html">x</a><img src="img/logo.png"></body></html>',
    );
    const result = await parseHtml(file);
    const hrefs = result.links.map((l) => l.href).sort((a, b) => a.localeCompare(b));
    expect(hrefs).toEqual(['./other.html', 'img/logo.png']);
    expect(result.links.find((l) => l.href === './other.html')?.type).toBe('local_file');
  });

  it('collects id and name attributes as anchors', async () => {
    const file = await writeHtml(
      'anchors.html',
      '<html><body><h2 id="intro">Intro</h2><a name="legacy"></a></body></html>',
    );
    const result = await parseHtml(file);
    expect(new Set(result.anchors)).toEqual(new Set(['intro', 'legacy']));
    expect(result.headings).toEqual([]);
  });

  it('reports malformed markup via parseErrors', async () => {
    const file = await writeHtml('bad.html', '<html><body><p>unclosed</body></html>');
    const result = await parseHtml(file);
    expect(result.parseErrors).toBeDefined();
    expect((result.parseErrors ?? []).length).toBeGreaterThan(0);
  });

  it('omits anchors/parseErrors when there are none', async () => {
    const file = await writeHtml('clean.html', '<!doctype html><title>t</title><p>hi</p>');
    const result = await parseHtml(file);
    expect(result.anchors).toBeUndefined();
    expect(result.parseErrors).toBeUndefined();
  });
});

describe('parseHtmlContent', () => {
  it('is equivalent to parseHtml for the same file', async () => {
    const file = await writeHtml(
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
    const file = await writeHtmlBytes(
      'malformed.html',
      Uint8Array.from([...Buffer.from('<p id="bad">'), 0xff, ...Buffer.from('</p>')]),
    );

    const [content, stats] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);

    // Guard the guard: if these ever stop differing the fixture has lost its
    // power and the assertions below become vacuous.
    expect(stats.size).toBe(17);
    expect(Buffer.byteLength(content)).toBe(19);
    expect(content.length).toBe(17);

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

  it('states nodeType on every link, span or no span', () => {
    // `htmlAttribute` is what keeps these rows out of the markdown forms that
    // `closure-extent` and `claude-context-discovery` follow. It is a fact
    // about the producer, so it must not be conditional on parse5 having
    // recorded a location — the reconstructed clone carries no span and is
    // still an HTML attribute link.
    const { links } = parseHtmlContent(
      RECONSTRUCTED_ANCHOR_HTML,
      RECONSTRUCTED_ANCHOR_HTML.length,
    );

    expect(links.map((link) => link.nodeType)).toEqual([
      'htmlAttribute',
      'htmlAttribute',
      'htmlAttribute',
    ]);
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

  it('omits line and offsets entirely when parse5 recorded no location', () => {
    const { links } = parseHtmlContent(
      RECONSTRUCTED_ANCHOR_HTML,
      RECONSTRUCTED_ANCHOR_HTML.length,
    );

    expect(links.map((link) => link.href)).toEqual(['./x.md', './x.md', './y.md']);

    // Asserting WHICH KEYS EXIST, not their values, is what makes this test
    // able to fail against the one mutant no value assertion can see: an
    // `undefined`-VALUED fallback (`{ startOffset: span?.startOffset, … }`),
    // which Vitest's `toEqual` treats as identical to the absent key while
    // `.strict()` Zod parsing downstream would reject it.
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
    // `nodeType` is UNCONDITIONAL — it appears on all three, including the
    // location-less clone. That is the point: it is a fact about the producer,
    // not about whether parse5 managed to record a position, so a mutant that
    // made it conditional on the span turns this red.
    expect(links.map((link) => Object.keys(link).sort((a, b) => a.localeCompare(b)))).toEqual([
      ['endOffset', 'href', 'line', 'nodeType', 'startOffset', 'text', 'type'],
      ['href', 'nodeType', 'text', 'type'],
      ['endOffset', 'href', 'line', 'nodeType', 'startOffset', 'text', 'type'],
    ]);

    // The location-less link is still a LINK — dropping it would lose a real
    // reference from the graph; it just cannot be attributed to a byte range.
    expect(sliceSpans(RECONSTRUCTED_ANCHOR_HTML, links)).toEqual([
      'href="./x.md"',
      undefined,
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
    const file = await writeHtml('offsets.html', body);

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
  it('populates text from the <a> element\'s child text content', () => {
    const source = '<a href="./g.md">Guide</a>';
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.text)).toEqual(['Guide']);
  });

  it('concatenates text through nested inline markup inside the <a>', () => {
    const source = '<a href="./g.md"><b>Bold</b> and plain</a>';
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.text)).toEqual(['Bold and plain']);
  });

  it('leaves text empty for <img src>, which has no child nodes to collect', () => {
    const source = '<img src="./logo.png" alt="Logo">';
    const { links } = parseHtmlContent(source, source.length);

    expect(links.map((link) => link.text)).toEqual(['']);
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

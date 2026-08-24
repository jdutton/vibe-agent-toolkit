import { describe, expect, it } from 'vitest';

import { parseHtmlContent } from '../src/html-link-parser.js';
import { parseMarkdownContent, type ParseResult } from '../src/link-parser.js';
import {
  AST_SYNTACTIC_FORMS,
  blobReferencesFor,
  hasReferenceSpan,
} from '../src/projection/blob-references.js';
import { FOLLOWED_FORMS } from '../src/projection/claude-context-discovery.js';
import { LexicalSyntacticFormSchema, type LexicalReference } from '../src/schemas/parse-facts.js';
import { ExtentDeclarationSchema } from '../src/schemas/project-config.js';
import {
  ReferenceSyntacticFormSchema,
  type BlobReferenceRow,
  BlobReferenceRowSchema,
} from '../src/schemas/projection-blobs.js';
import type { LinkNodeType, ResourceLink } from '../src/schemas/resource-metadata.js';

const CONTENT_KEY = `markdown.${'c'.repeat(64)}`;
const AT_TOKEN = '@docs/setup.md';
const HREF = './b.md';
/** The `syntacticForm` an absent/`'link'` `nodeType` defaults to — the one this file names three times. */
const MARKDOWN_LINK = 'markdown-link';

function parseResult(overrides: Partial<ParseResult>): ParseResult {
  return { content: '', sizeBytes: 0, links: [], headings: [], estimatedTokenCount: 0, ...overrides };
}

/**
 * An AST link as the parser really shapes it. `nodeType` decides syntacticForm.
 *
 * The span is derived from `line` rather than passed, because these fixtures
 * assert ORDER and shape, not positions — but it has to be present and distinct
 * per line, since a link with no span is skipped rather than admitted.
 */
function link(line: number, nodeType?: LinkNodeType): ResourceLink {
  return {
    text: 'b',
    href: HREF,
    type: 'local_file',
    line,
    startOffset: line * 100,
    endOffset: line * 100 + HREF.length,
    ...(nodeType !== undefined && { nodeType }),
  };
}

/** The span columns every hand-built AST link fixture needs, at a fixed position. */
const SPAN = { startOffset: 0, endOffset: HREF.length };

/** A lexer token. Every column is explicit so a defaulted one cannot hide. */
function token(line: number, column: number, overrides: Partial<LexicalReference> = {}): LexicalReference {
  return {
    raw: AT_TOKEN,
    line,
    column,
    startOffset: line * 100 + column,
    endOffset: line * 100 + column + AT_TOKEN.length,
    syntacticForm: 'at-prefixed',
    hasExtension: true,
    leadingAt: true,
    slashCount: 1,
    variableExpansion: null,
    inCodeSpan: false,
    inFence: false,
    ...overrides,
  };
}

describe('blobReferencesFor', () => {
  it('interleaves AST links and lexer tokens into ONE ordinal space, ordered by position', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(5)],
      lexicalReferences: [token(2, 1)],
    }));

    expect(rows.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(rows[0]?.rawRef).toBe(AT_TOKEN);
    expect(rows[0]?.line).toBe(2);
    expect(rows[1]?.rawRef).toBe(HREF);
  });

  it('nulls text for a lexer-derived form and keeps its column', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      lexicalReferences: [token(1, 3, { inCodeSpan: true })],
    }));

    expect(rows[0]?.text).toBeNull();
    expect(rows[0]?.column).toBe(3);
    expect(rows[0]?.inCodeSpan).toBe(true);
  });

  it('derives syntacticForm from nodeType, defaulting an absent one to markdown-link', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [
        link(1, 'link'),
        link(2, 'linkReference'),
        link(3, 'definition'),
        link(4, 'htmlAttribute'),
        link(5),
      ],
    }));

    expect(rows.map((row) => row.syntacticForm)).toEqual([
      MARKDOWN_LINK, 'markdown-link-reference', 'markdown-definition', 'html-link',
      MARKDOWN_LINK,
    ]);
  });

  it('partitions every syntacticForm into exactly one of AST-derived or lexer-derived', () => {
    // The tripwire for the drift that made the whole-corpus population's two
    // measurements of "references dropped" disagree by 4: a consumer counted
    // AST rows from a hand-listed markdown triple, and `html-link` — a fourth
    // AST form — fell outside it and was scored as dropped.
    //
    // Neither side is restated here. `AST_SYNTACTIC_FORMS` must be exactly the
    // whole enum minus the lexer's own, so a new form lands on one side or the
    // other and never on neither.
    const lexical = new Set<string>(LexicalSyntacticFormSchema.options);
    const partitioned = ReferenceSyntacticFormSchema.options.filter(
      (form) => AST_SYNTACTIC_FORMS.has(form) !== lexical.has(form),
    );

    expect(partitioned).toEqual([...ReferenceSyntacticFormSchema.options]);
    expect(AST_SYNTACTIC_FORMS.size + lexical.size).toBe(ReferenceSyntacticFormSchema.options.length);
  });

  it('gives every row blobReferencesFor emits from links an AST form, and every lexer row a lexer form', () => {
    const lexical = new Set<string>(LexicalSyntacticFormSchema.options);
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(1, 'link'), link(2, 'linkReference'), link(3, 'definition'), link(4, 'htmlAttribute'), link(5)],
      lexicalReferences: [token(6, 1)],
    }));

    // 5 AST + 1 lexer, and the split is decided by the constant, not restated.
    expect(rows.filter((row) => AST_SYNTACTIC_FORMS.has(row.syntacticForm))).toHaveLength(5);
    expect(rows.filter((row) => lexical.has(row.syntacticForm))).toHaveLength(1);
  });

  it('drops a link missing any one of line, startOffset or endOffset', () => {
    // `hasReferenceSpan` is the producer's own predicate and the one a consumer
    // enumerating drops must reuse. A link with a LINE and no offsets is the
    // shape the HTML parser used to emit, and it is dropped just as a
    // line-less one is — asserted here because `line === undefined` alone
    // cannot see it.
    const positioned = link(1, 'link');
    const shapes: ResourceLink[] = [
      { ...positioned, line: undefined },
      { ...positioned, startOffset: undefined },
      { ...positioned, endOffset: undefined },
    ];

    expect(shapes.map((shape) => hasReferenceSpan(shape))).toEqual([false, false, false]);
    expect(hasReferenceSpan(positioned)).toBe(true);
    expect(blobReferencesFor(CONTENT_KEY, parseResult({ links: shapes }))).toEqual([]);
  });

  it('keeps html-link out of every form a closure follows', () => {
    // The whole reason `html-link` exists. `markdown-link` — what an
    // `htmlAttribute` row would collect from the default branch — is followed
    // by BOTH traversals, so an HTML row wearing it makes `vat inventory`
    // report members `vat build` does not bundle.
    //
    // Asserted against the shipped constants rather than a restated list, so
    // adding `html-link` to either one turns this red instead of leaving a
    // stale copy agreeing with itself.
    const declaration = ExtentDeclarationSchema.parse({ kind: 'skill', closureFrom: 'skills/a' });
    const followed = new Set<string>([...declaration.follow, ...FOLLOWED_FORMS]);

    expect(followed.has('html-link')).toBe(false);
    expect(followed.has(MARKDOWN_LINK)).toBe(true);
  });

  it('gives an AST link a null column, which the schema permits', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({ links: [link(1, 'link')] }));

    expect(rows[0]?.column).toBeNull();
  });

  it('sorts a null column before a real one on the same line', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(4, 'link')],
      lexicalReferences: [token(4, 20)],
    }));

    expect(rows.map((row) => row.rawRef)).toEqual([HREF, AT_TOKEN]);
  });

  it('carries every lexer column through unchanged', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      lexicalReferences: [token(1, 1, {
        raw: '${VAR}/x.md',
        syntacticForm: 'env-anchored',
        leadingAt: false,
        variableExpansion: 'brace',
        inFence: true,
      })],
    }));

    expect(rows[0]).toMatchObject({
      hasExtension: true, leadingAt: false, slashCount: 1,
      variableExpansion: 'brace', inCodeSpan: false, inFence: true,
    });
  });

  it('derives the lexical columns of an AST link from its href', () => {
    // The four lexical columns are required on every row, whichever producer
    // emitted it. Read from the href with the lexer's own rules, so a query
    // filtering on `hasExtension` reads one predicate across the table rather
    // than two. `@`-shaped and variable-bearing hrefs are both writable in
    // markdown, so neither column is constant.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [
        { text: 'plain', href: HREF, type: 'local_file', line: 1, nodeType: 'link', ...SPAN },
        { text: 'scoped', href: '@scope/pkg/docs/x.md', type: 'local_file', line: 2, nodeType: 'link', ...SPAN },
        { text: 'var', href: '${CLAUDE_PLUGIN_ROOT}/scripts/run', type: 'local_file', line: 3, nodeType: 'link', ...SPAN },
      ],
    }));

    expect(rows.map((row) => ({
      hasExtension: row.hasExtension,
      leadingAt: row.leadingAt,
      slashCount: row.slashCount,
      variableExpansion: row.variableExpansion,
    }))).toEqual([
      { hasExtension: true, leadingAt: false, slashCount: 1, variableExpansion: null },
      { hasExtension: true, leadingAt: true, slashCount: 3, variableExpansion: null },
      { hasExtension: false, leadingAt: false, slashCount: 2, variableExpansion: 'brace' },
    ]);
  });

  it('B3 — hasExtension sees an extension through a trailing query string or fragment, in either order', () => {
    // EXTENSION_SUFFIX is anchored at the end of the STRING it is tested
    // against — before this fix, that was the whole raw href, so a trailing
    // `?query` or `#fragment` pushed the real extension off the end and
    // `hasExtension` read `false` for a link that plainly has one.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [
        { text: 'q', href: './guide.md?v=2', type: 'local_file', line: 1, nodeType: 'link', ...SPAN },
        { text: 'f', href: './guide.md#section', type: 'local_file', line: 2, nodeType: 'link', ...SPAN },
        // `#` before `?` — the reverse of the common ordering. A split
        // anchored to only one delimiter would leave the other's text glued
        // to the "path" half here.
        { text: 'both', href: './guide.md#section?v=2', type: 'local_file', line: 3, nodeType: 'link', ...SPAN },
        // A bare delimiter with nothing before it: the path part is '', which
        // has no extension — must stay false, not become vacuously true.
        { text: 'bare-q', href: '?', type: 'local_file', line: 4, nodeType: 'link', ...SPAN },
        { text: 'bare-h', href: '#', type: 'local_file', line: 5, nodeType: 'link', ...SPAN },
        // Fragment-only, no path at all: genuinely no extension.
        { text: 'frag-only', href: '#section', type: 'local_file', line: 6, nodeType: 'link', ...SPAN },
      ],
    }));

    expect(rows.map((row) => row.hasExtension)).toEqual([true, true, true, false, false, false]);
  });

  it('never carries resolvedId, which production code mutates after the parse', () => {
    // `skill-packager` assigns `resolvedId` in place while bundling. A
    // content-addressed row carrying it would depend on which skill was
    // packaged first, so it must not appear on the row under any key.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [{ text: 'b', href: HREF, type: 'local_file', line: 1, nodeType: 'link', resolvedId: 'leaked', ...SPAN }],
    }));

    expect(Object.values(rows[0] ?? {})).not.toContain('leaked');
    expect(Object.keys(rows[0] ?? {})).not.toContain('resolvedId');
  });

  it('marks an AST-derived row as being in neither a fence nor a code span', () => {
    // A link inside either context is a `code`/`inlineCode` node and never
    // becomes a link row at all, so these two are structurally false here —
    // not merely unset.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({ links: [link(1, 'link')] }));

    expect(rows[0]?.inCodeSpan).toBe(false);
    expect(rows[0]?.inFence).toBe(false);
  });

  it('skips a link with no line rather than defaulting it to line 1', () => {
    // ResourceLink.line is optional; BlobReferenceRow.line is required and
    // positive(). Defaulting would pile every position-less reference onto the
    // first line, where no assertion could ever catch it.
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [{ text: 'b', href: HREF, type: 'local_file' }],
    }));

    expect(rows).toEqual([]);
  });

  it('produces rows the shipped schema accepts', () => {
    const rows = blobReferencesFor(CONTENT_KEY, parseResult({
      links: [link(1, 'link')], lexicalReferences: [token(2, 1)],
    }));

    expect(() => rows.map((row) => BlobReferenceRowSchema.parse(row))).not.toThrow();
    expect(rows).toHaveLength(2);
  });
});

/**
 * The HTML producer, driven through the REAL parser rather than a fixture.
 *
 * ⭐ Every fixture above hands `blobReferencesFor` a hand-built `ResourceLink`
 * that carries a span, because the helper's own docstring notes a span-less
 * link is skipped. That made the whole suite structurally incapable of seeing
 * the shipped bug: the HTML parser emitted `line` and **no offsets**, so every
 * `<a href>` and `<img src>` was dropped and each HTML blob contributed zero
 * rows. Only real parser output can pin this — a synthetic `ParseResult` proves
 * the row builder works on links that already have what the parser withheld.
 */
const HTML = [
  '<html><body>',
  '<p>See <a href="./guide.md">the guide</a>.</p>',
  '<p><img src="./diagram.png" alt="d"></p>',
  '</body></html>',
].join('\n');

const HTML_KEY = `html.${'d'.repeat(64)}`;

/** The two units composed: real parse, then real row derivation. */
function htmlRows(): BlobReferenceRow[] {
  return blobReferencesFor(HTML_KEY, parseHtmlContent(HTML, Buffer.byteLength(HTML)));
}

/**
 * The columns both HTML rows share, so the full-row expectation below stays one
 * readable pair rather than two near-identical fourteen-line literals.
 *
 * ⛔ This used to also carry `text: ''`, on the premise (stated here and quoted
 * in `html-link-parser.ts › makeLink`'s docstring) that "an `<a href>`'s link
 * text is its child nodes, which this parser does not collect." That premise
 * is now false: `makeLink` walks an `<a>`'s children via `elementText`, so
 * `<a href="./guide.md">the guide</a>` carries real text. The two HTML rows no
 * longer share `text` — the `<a>` row's is `'the guide'`, the `<img>` row's
 * stays `''` (an image genuinely has no children to walk) — so `text` moved out
 * of this shared base and into each row's own literal below, where the
 * difference is visible instead of papered over by a shared constant that was
 * only ever right for one of the two.
 *
 * `column: null` because an AST-derived row carries no column; `inCodeSpan` /
 * `inFence` false because HTML has no fenced-code construct at all
 * (`parseHtmlContent` hands `measureContent` an empty fence list).
 */
const HTML_ROW_BASE = {
  blob: HTML_KEY,
  column: null,
  hasExtension: true,
  leadingAt: false,
  slashCount: 1,
  variableExpansion: null,
  inCodeSpan: false,
  inFence: false,
} as const;

describe('blobReferencesFor over real HTML parser output', () => {
  it('emits a row per HTML reference instead of silently dropping every one', () => {
    // The assertion that fails on the unfixed parser: it returned [].
    expect(htmlRows().map((row) => row.rawRef)).toEqual(['./guide.md', './diagram.png']);
  });

  it('spans the whole attribute, matching what the markdown producer carries', () => {
    // mdast gives `[text](href)` — the construct, not the URL inside it — so the
    // HTML analogue is `href="./guide.md"`, not `./guide.md`. A consumer slicing
    // source by this column must not get two different meanings by extension.
    // Sliced out of the real source, so a plausible-but-wrong offset cannot pass.
    const spans = htmlRows().map((row) => HTML.slice(row.startOffset, row.endOffset));

    expect(spans).toEqual(['href="./guide.md"', 'src="./diagram.png"']);
  });

  it('produces HTML rows the shipped schema accepts, column for column', () => {
    const rows = htmlRows();

    // Parsing and comparing the RESULT beats `not.toThrow()`: `.strict()` also
    // proves no extra column crept in, and equality proves the schema stripped
    // or coerced nothing on the way through.
    expect(rows.map((row) => BlobReferenceRowSchema.parse(row))).toEqual(rows);

    // `syntacticForm` IS asserted, in the whole-row equality below. It was left
    // out while its value was still `'markdown-link'` — pinning that would have
    // blessed the defect — and the reason it was a defect is that the label is
    // load-bearing in `closure-extent.ts › shouldFollow()` and
    // `claude-context-discovery.ts › FOLLOWED_FORMS`: calling HTML a markdown
    // link makes an HTML file a door the closure traverses, contradicting
    // `walk-link-graph.ts › isRoutable()` (routing is markdown-only) and
    // letting `vat inventory` report members `vat build` will not bundle.
    // `html-link` is in neither follow list, which the sibling test above pins
    // against the shipped constants.
    expect(rows).toEqual([
      { ...HTML_ROW_BASE, text: 'the guide', syntacticForm: 'html-link', ordinal: 0, rawRef: './guide.md', line: 2, startOffset: 23, endOffset: 40 },
      { ...HTML_ROW_BASE, text: '', syntacticForm: 'html-link', ordinal: 1, rawRef: './diagram.png', line: 3, startOffset: 68, endOffset: 87 },
    ]);
  });
});

/**
 * The same page as `html-link-parser.test.ts`'s `RECONSTRUCTED_ANCHOR_HTML`:
 * parse5 reconstructs the middle `<a>` from the active-formatting-elements
 * list, and a reconstructed element carries **no** `sourceCodeLocation`
 * (`undefined`, not `null`).
 *
 * ⛔ This fixture no longer reaches `blobReferencesFor`'s location-less branch,
 * and the reason is a FIX rather than a regression. `html-link-parser.ts` now
 * de-duplicates on parse5 attribute-token identity, and the reconstructed clone
 * shares the original's token object — so the clone is dropped one layer
 * earlier, by the producer, and only two links arrive here. The page still has
 * exactly the two authored `href`s it always had; what disappeared is a third
 * link that named the SAME authored attribute as the first.
 *
 * ⇒ The HTML producer can no longer emit a position-less link at all. The
 * MARKDOWN producer still can — see {@link POSITIONLESS_MARKDOWN} — so the
 * end-to-end coverage this block exists for moved there rather than being lost.
 *
 * Restated rather than imported: importing one test file from another
 * re-registers the whole imported suite inside the importer.
 */
const RECONSTRUCTED_ANCHOR_HTML =
  '<a href="./x.md"><div><a href="./y.md"><div>d</div></a></div>';

const RECONSTRUCTED_KEY = `html.${'e'.repeat(64)}`;

/** Real parser output for {@link RECONSTRUCTED_ANCHOR_HTML}. */
function reconstructedParse(): ParseResult {
  return parseHtmlContent(RECONSTRUCTED_ANCHOR_HTML, RECONSTRUCTED_ANCHOR_HTML.length);
}

/**
 * A REAL parsed link with one HALF of its position removed.
 *
 * The guard in `astCandidates` rejects a link missing `line`, `startOffset` or
 * `endOffset` — three conditions, but no shipping parser produces a link with
 * only one half of a position: mdast fills line and offsets from one
 * `position`, and parse5's reconstructed clone withholds both together. So the
 * half-positioned shapes are unreachable end-to-end, and a suite built only
 * from real output cannot distinguish the two halves of the guard: deleting
 * either one leaves every test green (measured across all 2147 resources unit
 * tests). Yet the guard's own comment says it is kept precisely for "a third
 * one that does not" fill both.
 *
 * Subtracting from real output rather than inventing a link is the compromise:
 * the surviving half carries positions parse5 actually produced, so the test
 * cannot be satisfied by a fixture that happens to agree with a wrong offset
 * convention — the failure mode that shipped the original bug.
 *
 * @param drop - Which half of the position to remove
 * @returns The first parsed link, less that half
 */
function halfPositionedLink(drop: 'line' | 'offsets'): ResourceLink {
  const [first] = reconstructedParse().links;
  if (first === undefined) throw new Error('RECONSTRUCTED_ANCHOR_HTML yielded no links');

  const link = { ...first };
  if (drop === 'line') {
    delete link.line;
  } else {
    delete link.startOffset;
    delete link.endOffset;
  }
  return link;
}

/**
 * A GFM autolink literal remark's tokenizer does not see.
 *
 * `mdast-util-gfm-autolink-literal` reconstructs it in a `findAndReplace`
 * post-pass that builds the `link` node with **no `position`** — so
 * `toResourceLink` emits it with neither a line nor offsets. The discriminator
 * is whether the literal stands on its own text run: the bare form on line 3
 * carries a position, the glued form on line 1 does not.
 *
 * ⭐ This is the ONE producer left that can hand `blobReferencesFor` a
 * position-less link. `link-parser.ts`'s own docstring carries the measurement
 * and the minimal repro; this fixture is what makes the guard reachable from a
 * real parse rather than only from a hand-built shape.
 */
const POSITIONLESS_MARKDOWN =
  'See domain:www.anthropic.com for more.\n\nAnd [the handbook](./handbook.md) too.\n';

const POSITIONLESS_KEY = `markdown.${'f'.repeat(64)}`;

/**
 * The location-less branch, end to end through both real units.
 *
 * ⭐ Every OTHER fixture in this file hands `blobReferencesFor` a hand-built
 * link that carries a full position, so nothing here could see a link that
 * does not — which is the same structural blindness that shipped the original
 * under-report. These tests are the antidote: the input is what a real parser
 * returns for a document it cannot fully locate.
 */
describe('blobReferencesFor over a location-less real markdown link', () => {
  it('drops the autolink remark located nowhere and keeps the one it did', () => {
    const parsed = parseMarkdownContent(POSITIONLESS_MARKDOWN, POSITIONLESS_MARKDOWN.length);

    // Guard the guard: if remark ever starts locating the reconstructed
    // autolink, the fixture has lost its power and the assertion below goes
    // vacuous. Asserted as a KEY SET, because `toEqual` cannot tell an absent
    // key from an `undefined`-valued one.
    expect(parsed.links.map((l) => 'line' in l)).toEqual([false, true]);
    // Suffix, not the whole href: GFM forces `http://` onto a bare `www.`
    // autolink, and spelling that out here would trip
    // `sonarjs/no-clear-text-protocols` over a string this repo does not choose.
    expect(parsed.links[0]?.href.endsWith('//www.anthropic.com')).toBe(true);
    expect(parsed.links[1]?.href).toBe('./handbook.md');

    // Two links in, one row out — and the survivor is sliced back out of the
    // source, so a plausible-but-wrong offset pair cannot pass.
    const rows = blobReferencesFor(POSITIONLESS_KEY, parsed);

    expect(rows.map((row) => row.rawRef)).toEqual(['./handbook.md']);
    expect(rows.map((row) => POSITIONLESS_MARKDOWN.slice(row.startOffset, row.endOffset)))
      .toEqual(['[the handbook](./handbook.md)']);
  });
});

describe('blobReferencesFor over the reconstructed-anchor HTML page', () => {
  it('sees two links, because the parser de-duplicated the clone upstream', () => {
    const parsed = reconstructedParse();

    // ⛔ This assertion is the record of a BEHAVIOUR CHANGE, not a weakening.
    // It used to read `[1, undefined, 1]` — three links, the middle one
    // position-less. `html-link-parser.ts` now drops the clone on attribute-
    // token identity, so the position-less link never leaves the producer.
    expect(parsed.links.map((l) => l.line)).toEqual([1, 1]);
    expect(parsed.links.map((l) => l.startOffset)).toEqual([3, 25]);

    // Two links in, two rows out — no reference was lost by the de-dupe: the
    // dropped clone named the SAME authored attribute as the first row.
    const rows = blobReferencesFor(RECONSTRUCTED_KEY, parsed);

    expect(rows.map((row) => row.rawRef)).toEqual(['./x.md', './y.md']);
    expect(rows.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(rows.map((row) => RECONSTRUCTED_ANCHOR_HTML.slice(row.startOffset, row.endOffset)))
      .toEqual(['href="./x.md"', 'href="./y.md"']);
  });

  it('skips a link with a line but no offsets — the exact shape that shipped', () => {
    // Deleting the offset half of the guard admits this link and writes
    // `startOffset: undefined` into a column the schema requires.
    const link = halfPositionedLink('offsets');

    expect(link.line).toBe(1);
    expect(link.startOffset).toBeUndefined();
    expect(blobReferencesFor(RECONSTRUCTED_KEY, parseResult({ links: [link] }))).toEqual([]);
  });

  it('skips a link with offsets but no line', () => {
    // The mirror image: deleting the line half of the guard admits this one and
    // writes `line: undefined` into a `positive()` column.
    const link = halfPositionedLink('line');

    expect(link.line).toBeUndefined();
    expect(link.startOffset).toBe(3);
    expect(blobReferencesFor(RECONSTRUCTED_KEY, parseResult({ links: [link] }))).toEqual([]);
  });
});

/**
 * B1 — does foster parenting invert `ordinal` against source position?
 *
 * Foster parenting is the HTML tree-construction rule that MOVES a node: an
 * element not permitted directly inside a `<table>` (a bare `<div>`, `<a>`,
 * text) is re-parented to just BEFORE the `<table>` in the DOM, even though it
 * appeared INSIDE the table in the source. parse5 implements this, so
 * `walkElements`'s document-order walk can see a foster-parented link before
 * a link that is textually earlier in the source.
 *
 * `astCandidates` used to tie-break same-line candidates by their index in
 * `links` — DOM/walk order for HTML. Brute-forced across four misnesting
 * shapes (below), that inverts `ordinal` against `startOffset` whenever the
 * two links land on the SAME line, because the tie only fires when `line`
 * (now the attribute's own span line, per A2) does not already separate them.
 * `line` alone was not enough to prevent it: two links can share a line while
 * their foster-parented DOM order disagrees with their source order.
 */

/** Parse `source` as HTML and return rows in ordinal order. */
function orderedHtmlRows(source: string): BlobReferenceRow[] {
  return blobReferencesFor(HTML_KEY, parseHtmlContent(source, source.length));
}

/**
 * Whether `rows`' `startOffset`s are already in strictly non-decreasing
 * order — i.e. `ordinal` order agrees with physical position.
 *
 * @param rows - Rows already in ordinal order
 * @returns `true` when `startOffset` never decreases from one row to the next
 */
function startOffsetsAreSorted(rows: readonly BlobReferenceRow[]): boolean {
  const offsets = rows.map((row) => row.startOffset);
  return offsets.every((offset, index) => index === 0 || (offsets[index - 1] ?? 0) <= offset);
}

describe('B1 — HTML ordinal follows source position, not DOM/foster-parenting order', () => {
  it('keeps ordinal monotonic in startOffset when a trailing <a> is foster-parented before the <td> one', () => {
    // <a href="./after.md"> is not valid directly inside <table> content, so
    // parse5 foster-parents it to just before the <table> — walked BEFORE the
    // <td>'s <a href="./inside.md"> even though it is written AFTER it in the
    // source, and both end up on line 1.
    const source =
      '<table><tr><td><a href="./inside.md">i</a></td></tr><a href="./after.md">a</a></table>';
    const rows = orderedHtmlRows(source);

    expect(rows.map((row) => row.rawRef)).toEqual(['./inside.md', './after.md']);
    expect(rows.map((row) => row.ordinal)).toEqual([0, 1]);
    // Ordinal order must agree with physical order: strictly increasing startOffset.
    expect(startOffsetsAreSorted(rows)).toBe(true);
  });

  it('keeps ordinal monotonic in startOffset with a <div> wrapping the table', () => {
    const source =
      '<div><table><tr><td><a href="./deep.md">d</a></td></tr><a href="./after3.md">a</a></table></div>';
    const rows = orderedHtmlRows(source);

    expect(rows.map((row) => row.rawRef)).toEqual(['./deep.md', './after3.md']);
    expect(startOffsetsAreSorted(rows)).toBe(true);
  });

  it('keeps ordinal monotonic when a bare foster-parented text node separates two links', () => {
    const source = '<table><tr><td>x</td></tr>text<a href="./after2.md">a</a><a href="./after2b.md">b</a></table>';
    const rows = orderedHtmlRows(source);

    expect(rows.map((row) => row.rawRef)).toEqual(['./after2.md', './after2b.md']);
    expect(startOffsetsAreSorted(rows)).toBe(true);
  });

  it('does NOT reorder a case that is not inverted — one non-inverting fixture proves nothing about the class, but must still pass', () => {
    // <a href="./before.md"> is foster-parented to before the <table>, and it
    // genuinely IS textually first in the source too, so DOM order and source
    // order happen to agree here. A fix that always reversed HTML order would
    // break this case; a fix keyed on actual startOffset does not.
    const source = '<table><a href="./before.md">b</a><tr><td><a href="./inside.md">i</a></td></tr></table>';
    const rows = orderedHtmlRows(source);

    expect(rows.map((row) => row.rawRef)).toEqual(['./before.md', './inside.md']);
  });

  it('still lets `line` decide across lines, unaffected by this fix', () => {
    // Foster parenting still puts the DOM node for line-3's link before the
    // line-2 one in `links`, but the two are on DIFFERENT lines, so `line`
    // (the primary sort key) already orders them correctly regardless of the
    // tie-break — this pins that the fix does not need to, and must not,
    // touch the line-level ordering.
    const source = [
      '<table>',
      '<tr><td><a href="./inside2.md">i</a></td></tr>',
      '<a href="./after4.md">a</a>',
      '</table>',
    ].join('\n');
    const rows = orderedHtmlRows(source);

    expect(rows.map((row) => row.rawRef)).toEqual(['./inside2.md', './after4.md']);
    expect(rows.map((row) => row.line)).toEqual([2, 3]);
  });
});

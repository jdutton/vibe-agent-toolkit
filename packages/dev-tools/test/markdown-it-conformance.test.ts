/**
 * `markdown-it` run through the conformance suite — step 6 of the parser plan.
 *
 * ## What a failure here means
 *
 * ⛔ Not "markdown-it is broken", and ⛔ not "VAT should switch". This file pins
 * the *shape* of the disagreement so that it is evidence rather than opinion.
 * `markdown-it` is substantially faster on VAT's corpus and that decides
 * nothing: the only question is which facts it can and cannot supply, and it
 * cannot supply the ones every `resources` consumer depends on. The suite
 * answers that; this test records the answer and goes red if it moves.
 *
 * ⛔ No speed figure appears here or anywhere durable. A number in a comment is a
 * number someone greps later and re-opens a settled question with —
 * `bun run bakeoff:parsers` prints a fresh one whenever it is genuinely wanted.
 *
 * ## 🚩 Most of these assertions guard the ADAPTER, not the parser
 *
 * The first version of `markdown-it-parser.ts` reported seven divergent fields
 * and five were the adapter's. A later review of the *fixed* version against
 * this repository's own 293 tracked markdown files found four more, which is the
 * finding worth carrying forward: **a rival denied its configuration is a rival
 * condemned by its reviewer, and a one-document probe is how the denial stays
 * invisible.** What the probe below could not see, and now can:
 *
 * | Missed | Because the probe had no |
 * |---|---|
 * | a fence in a list item, off by its indentation on 17 documents | construct inside a container |
 * | a definition in a blockquote, dropped entirely | definition anywhere but column zero |
 * | a heading truncated at raw inline HTML, on 6 documents | heading holding markup other than `**` |
 * | every block span one code unit long on CRLF source | document with CRLF line endings |
 * | a reference link mis-read as inline, and the autolink inside it as a reference | link nested inside a link |
 *
 * So the cases that read as *capabilities* are regression guards on the
 * adapter: revert one fix and exactly one case goes red, naming what was
 * reverted.
 *
 * ## Why the assertions are about KINDS of finding, not counts
 *
 * A count would move whenever the fixture moves, and would then be updated
 * without anyone reading it. What must not move quietly is *which capabilities a
 * rival fails* — so each case names one gap, and the last cases pin the full set
 * of gap kinds and fields so a NEW divergence cannot appear unremarked.
 */

import { runParseConformance, type ConformanceFinding } from '@vibe-agent-toolkit/resources/parse-conformance';
import { describe, expect, it } from 'vitest';

import { markdownItParser } from '../src/markdown-it-parser.js';

/**
 * A document exercising every construct the two parsers might disagree about.
 *
 * One document, deliberately: this is a fidelity probe, not a corpus sweep, and
 * pointing it at a whole tree would make a unit test depend on a checkout's
 * contents. ⚠️ But a probe is only worth the constructs in it — every gap named
 * in this file's docstring hid behind a construct the earlier probe lacked, so
 * the contents below are chosen to reproduce **the full divergence set a
 * 293-document sweep of this repository produces**, which they do: `links`,
 * `lexicalReferences` and `unresolvedReferences`, and nothing else.
 */
const PROBE = {
  name: 'probe.md',
  content: [
    '---',
    'id: probe',
    '---',
    '',
    '# Title',
    '',
    '[label]: ./b.md',
    '',
    'An [inline](./a.md) link, a `code span`, and a [ref][label].',
    '',
    // An autolink INSIDE a reference link: the one nesting CommonMark permits
    // that pushes a second `link_open`, and so the case that decides whether the
    // inline-rule wrapper tags the construct it observed or something else.
    'Bare https://example.com/ and [a <https://example.org/> b][label].',
    '',
    // A full reference form inside a code span. The detector ignores shortcut
    // forms by design, so only the full form reaches the mask — and the mask is
    // built from spans.
    'A code span holding `[text][missing]` is not a reference.',
    '',
    '<a id="anchor"></a>',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '## Sub **bold** and <kbd>Esc</kbd>',
    '',
    '- item',
    '',
    '  ```sh',
    '  echo hi',
    '  ```',
    '',
    '> [quoted]: ./c.md',
    '>',
    '> See [quoted].',
    '',
  ].join('\n'),
} as const;

/**
 * The same questions over CRLF source.
 *
 * Its own document because a `\n`-joined literal cannot express the one thing it
 * tests. Every offset an implementation reports is into the string VAT handed
 * it, and `markdown-it` normalizes `\r\n` to `\n` before any rule runs — so an
 * adapter that forwards the parser's own copy, or trims one terminator where
 * there are two, is wrong on every Windows checkout and right on every fixture
 * written here.
 */
const CRLF_PROBE = {
  name: 'crlf.md',
  content: [
    '---',
    'id: crlf',
    'name: probe',
    '---',
    '',
    '[label]: ./b.md',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    'See [label].',
    '',
  ].join('\r\n'),
} as const;

const REPORT = runParseConformance(markdownItParser, [PROBE, CRLF_PROBE]);

const SPAN_FACTS = markdownItParser.open(PROBE.content).spansAndKinds?.();
const CRLF_FACTS = markdownItParser.open(CRLF_PROBE.content).spansAndKinds?.();

/** The two span kinds asserted often enough below to be worth naming. */
const DEFINITION = 'link-definition';
const CODE_BLOCK = 'code-block';

function fields(findings: readonly ConformanceFinding[]): string[] {
  return findings.flatMap((finding) => (finding.kind === 'facts-differ' ? [finding.field] : []));
}

/** Explicit collation, so a pinned list is stable rather than locale-dependent. */
const byName = (left: string, right: string): number => left.localeCompare(right);

describe('markdown-it as a VAT parser implementation', () => {
  it('parses both probes at all — the gaps below are fidelity, not a crash', () => {
    expect(REPORT.findings.some((finding) => finding.kind === 'threw')).toBe(false);
    expect(REPORT.documentsCompared).toBe(2);
    expect(REPORT.candidate).toBe('markdown-it');
    expect(REPORT.reference).toBe('remark-parse');
  });

  it('serves both read capabilities, so it is a candidate at all', () => {
    expect(REPORT.findings.some((finding) => finding.kind === 'missing-capability')).toBe(false);
  });

  it('reads the frontmatter block, so it invents no section', () => {
    // 🚩 Guards `markdown-it-front-matter` being installed. Without a
    // frontmatter rule, `---` above AND below a line makes it a **setext
    // heading**, so `id: probe` enters the outline as an h2 with slug
    // `id-probe`. That gap does not cost one field — it adds a section to every
    // document's navigation and chunking.
    expect(fields(REPORT.findings)).not.toContain('frontmatterSource');
    expect(SPAN_FACTS?.frontmatterSource).toBe('id: probe');
  });

  it('reads the frontmatter from the SOURCE, so CRLF survives it', () => {
    // 🚩 Guards reading the body out of the document rather than out of
    // `front_matter`'s `token.meta`. `markdown-it`'s `normalize` core rule
    // rewrites every `\r\n` to `\n` before any rule sees the text, so the token's
    // copy is a different string from the one VAT was asked about — and
    // `frontmatterSource` is what `frontmatter-editor.ts` splices against.
    expect(CRLF_FACTS?.frontmatterSource).toBe('id: crlf\r\nname: probe');
  });

  it('resolves the link definition, so a resolvable reference is not called dangling', () => {
    // 🚩 Guards the `reference` block-rule wrapper. `[label]: url` lands in
    // `env.references` with no token, so nothing in the output marks its
    // extent — and a `link-definition` span carrying a label is the only thing
    // `findUnresolvedReferences` collects defined labels from. Unwrapped, the
    // probe's resolvable references read as dangling.
    expect(SPAN_FACTS?.spans).toContainEqual({
      kind: DEFINITION,
      startOffset: 28,
      endOffset: 43,
      label: 'label',
    });
  });

  it('finds a definition that does not begin its line, inside a blockquote', () => {
    // 🚩 Guards the `[` opener in `blockSpanFromMap`. A block token's `map` is a
    // LINE range; inside a container the line starts at `> `, the label pattern
    // does not match, and the definition is dropped without a trace. remark
    // anchors the node at its own `[`, and so does this — byte for byte.
    expect(SPAN_FACTS?.spans).toContainEqual({
      kind: DEFINITION,
      startOffset: 350,
      endOffset: 366,
      label: 'quoted',
    });
    expect(PROBE.content.slice(350, 366)).toBe('[quoted]: ./c.md');
  });

  it('tells a reference link from an inline one, and an autolink from both', () => {
    // 🚩 Guards the `link` inline-rule wrapper AND which token it writes to.
    // Both forms arrive as the same `link_open`; the wrapper slices the source
    // the rule consumed, and that test is total — an inline link closes with
    // `)`, all three reference forms close with `]`.
    //
    // 🪤 What is NOT total is taking the LAST `link_open` in the array.
    // `parseLinkLabel`'s `disableNested` only rejects nesting a `[` opens, so
    // the autolink inside `[a <https://example.org/> b][label]` parses and
    // pushes its own — and the answer computed for the reference link lands on
    // the autolink instead, mis-reading both.
    // ⚠️ Paired with the href, because the `nodeType` sequence ALONE cannot see
    // this bug: the wrapper writing the reference link's answer onto the
    // autolink swaps which link is in which bucket without changing how many are
    // in each, so the sequence of kinds comes out identical and only the pairing
    // moves. `links` is bucketed by kind, which is exactly what hides it.
    expect(SPAN_FACTS?.links.map((link) => `${String(link.nodeType)} ${link.href}`)).toEqual([
      'link ./a.md',
      'link https://example.com/',
      'link https://example.org/',
      'linkReference ./b.md',
      'linkReference ./b.md',
      'linkReference ./c.md',
      'definition ./b.md',
      'definition ./c.md',
    ]);
    expect(REPORT.findings.some((finding) => finding.kind === 'link-order')).toBe(false);
  });

  it('sees the raw-HTML anchor, which is an inline run and not a block', () => {
    // 🚩 Guards `html: true`. The default preset escapes `<a id="anchor">` as
    // text, so the fragment target an author declared is invisible and a link
    // to `#anchor` reads as broken. ⚠️ CommonMark makes a complete
    // open-and-close pair on one line an INLINE run, so reading `html_block`
    // alone recovers nothing here — an anchor needs no position, which is why
    // inline HTML can still supply it.
    expect(fields(REPORT.findings)).not.toContain('anchors');
    expect(SPAN_FACTS?.anchors).toEqual(['anchor']);
  });

  it('keeps raw inline HTML in a heading, which `html: true` is what endangers', () => {
    // 🚩 Guards `html_inline` being in `FLATTENED_INLINE_TYPES`, and the guard
    // exists BECAUSE of the fix above: under the default preset `<kbd>` is an
    // ordinary text token and lands in the heading for free; enabling raw HTML
    // turns it into `html_inline` and dropping it truncates the heading at the
    // first tag. Headings feed the stateful slugger, so this is an anchor and a
    // navigation entry, not one string.
    expect(fields(REPORT.findings)).not.toContain('headings');
    expect(markdownItParser.open(PROBE.content).structure?.().headings).toEqual([
      { level: 1, text: 'Title', line: 5 },
      { level: 2, text: 'Sub bold and <kbd>Esc</kbd>', line: 21 },
    ]);
  });

  it('places a block span at exact character offsets, terminator excluded', () => {
    // 🚩 Guards the line-terminator trim in `blockSpanFromMap`. A line range's
    // exclusive end is the START of the following line, so taking it verbatim
    // swallows the newline — and that one code unit made
    // `contentMeasures.codeBlockCodeUnits` disagree for every fenced block.
    expect(fields(REPORT.findings)).not.toContain('contentMeasures');
    expect(SPAN_FACTS?.spans).toContainEqual({ kind: CODE_BLOCK, startOffset: 255, endOffset: 277 });
    expect(PROBE.content.slice(255, 277)).toBe('```ts\nconst x = 1;\n```');
  });

  it('trims BOTH code units of a CRLF terminator, not just the newline', () => {
    // 🚩 Guards the second trim. `\r` left on the end of every block span is
    // invisible to an opener check — the span still starts with a backtick —
    // and shows up one layer down as `codeBlockCodeUnits` drifting by the
    // document's line count.
    expect(CRLF_FACTS?.spans).toContainEqual({ kind: CODE_BLOCK, startOffset: 54, endOffset: 78 });
    expect(CRLF_PROBE.content.slice(54, 78)).toBe('```ts\r\nconst x = 1;\r\n```');
  });

  it('anchors a fence at its marker, not at the start of its line', () => {
    // 🚩 Guards the `` `~ `` openers. A fence inside a list item does not begin
    // its line, and a line-aligned span swallows the indentation — silently,
    // because `SPAN_OPENERS` admits a leading space for the sake of INDENTED
    // code blocks. Worth 17 of this repository's documents, and invisible to
    // every span check the suite has.
    expect(SPAN_FACTS?.spans).toContainEqual({ kind: CODE_BLOCK, startOffset: 325, endOffset: 346 });
    expect(PROBE.content.slice(325, 346)).toBe('```sh\n  echo hi\n  ```');
  });

  it('places NO inline span — the one gap that is the parser and not the adapter', () => {
    // 🔑 The result that decides whether the speed number is reachable, and it
    // is not about speed. `markdown-it` gives a position to BLOCK tokens only:
    // inline tokens carry `map: null`, and the offsets an inline rule sees index
    // the inline CONTENT string — a paragraph's lines joined, trimmed and
    // stripped of block indentation — which cannot be mapped back to the source
    // for anything inside a list or a blockquote.
    //
    // So of the eight span kinds VAT asks for, the four inline ones —
    // `code-span`, `inline-link`, `image`, `reference-link` — are absent from a
    // probe that contains all but one. Absent rather than guessed: a mask at the
    // wrong offset suppresses real findings instead of producing an obvious
    // failure.
    expect(SPAN_FACTS?.spans.map((span) => span.kind)).toEqual([
      'frontmatter',
      DEFINITION,
      CODE_BLOCK,
      CODE_BLOCK,
      DEFINITION,
    ]);
  });

  it('disagrees about links ONLY where a position is involved', () => {
    // Text, href, classification, `nodeType` and the by-kind bucketing all
    // agree. What is missing is `line`, `startOffset` and `endOffset` on the six
    // INLINE entries — the two definitions, being block constructs, carry all
    // three and match remark exactly, in a blockquote as at column zero.
    expect(fields(REPORT.findings)).toContain('links');
    expect(SPAN_FACTS?.links.at(-1)).toEqual({
      text: 'quoted',
      href: './c.md',
      type: 'local_file',
      line: 29,
      startOffset: 350,
      endOffset: 366,
      nodeType: 'definition',
    });
    for (const link of SPAN_FACTS?.links.slice(0, 6) ?? []) {
      expect(link).not.toHaveProperty('line');
      expect(link).not.toHaveProperty('startOffset');
    }
  });

  it('over-reports lexical references, downstream of the same missing inline span', () => {
    // Not a second defect. `codeContextRangesFrom` builds the lexer's exclusion
    // set out of spans, so an inline link with no span is a destination the
    // lexer is never told to skip — and it then offers a candidate remark's run
    // does not have. A missing span does not merely lose a fact; it changes what
    // VAT's own derivations conclude.
    expect(fields(REPORT.findings)).toContain('lexicalReferences');
  });

  it('reports a link that is not broken, which is the failure mode that decides', () => {
    // 🔑 The same missing inline span, one layer further down and now in output a
    // user reads. `[text][missing]` sits inside a code span; remark reports a
    // `code-span` extent, VAT masks it, and nothing is flagged. `markdown-it`
    // reports no inline spans, so the mask has no hole to punch and the
    // construct is offered to the detector as an ordinary dangling reference.
    //
    // ⛔ This is the cost of a swap stated exactly: not a lost fact, a FALSE
    // POSITIVE in a link report. Six of this repository's own documents produce
    // one, and the probe that preceded this one produced none.
    expect(fields(REPORT.findings)).toContain('unresolvedReferences');
  });

  it('reports no span-fidelity finding, and now that is a claim about the SPANS', () => {
    // ⚠️ It was previously a finding about the HARNESS: `SPAN_OPENERS` only ever
    // read the character at `startOffset`, so it stayed silent through a
    // seven-field adapter defect AND through its repair. `spanDefect` now checks
    // the span's END too, which is the half a line range always gets wrong —
    // so silence here has become evidence rather than the absence of it.
    expect(REPORT.findings.some((finding) => finding.kind === 'span-fidelity')).toBe(false);
    expect(markdownItParser.capabilities).not.toContain('faithful-edit');
  });

  it('pins the set of divergence kinds, so a NEW kind cannot appear unremarked', () => {
    const kinds = [...new Set(REPORT.findings.map((finding) => finding.kind))].sort(byName);
    expect(kinds).toEqual(['facts-differ']);
  });

  it('pins WHICH fields diverge, so a fixed gap shows up as a change here', () => {
    // Three, and all three are the SAME gap seen from three distances: no inline
    // span, so no inline position, so a lexical candidate the lexer was never
    // told to skip, so a reference the masker never suppressed. This is the set a
    // 293-document sweep of this repository produces — the probe reproduces it
    // rather than under-reporting it.
    expect([...new Set(fields(REPORT.findings))].sort(byName)).toEqual([
      'lexicalReferences',
      'links',
      'unresolvedReferences',
    ]);
  });

  it('carries the fact shape the verdict was taken against', () => {
    // ⛔ Not a CONFORMANCE_VERSION: a derived string that moves when the schema
    // moves, so a stored verdict says what it is about without anyone bumping.
    expect(REPORT.factsShape.length).toBeGreaterThan(0);
  });
});

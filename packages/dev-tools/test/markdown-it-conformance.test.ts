/**
 * `markdown-it` run through the conformance suite — step 6 of the parser plan.
 *
 * ## What a failure here means
 *
 * ⛔ Not "markdown-it is broken", and ⛔ not "VAT should switch". This file pins
 * the *shape* of the disagreement so that it is evidence rather than opinion:
 * `markdown-it` is several times faster on VAT's corpus, and the only thing
 * that decides whether that number is reachable is which facts it can and
 * cannot supply. The suite answers that; this test records the answer and goes
 * red if it moves.
 *
 * ## 🚩 Half these assertions guard the ADAPTER, not the parser
 *
 * The first version of `markdown-it-parser.ts` reported seven divergent fields.
 * Five of them were the adapter's: raw HTML was off, no frontmatter plugin was
 * installed, `env.references` was never read, and a line range was converted to
 * a character extent with the line terminator left on. A rival handed less work
 * to do is a rival flattered by the result, and the same trap runs the other
 * way — a rival denied the configuration it needs is a rival condemned by its
 * reviewer.
 *
 * So the cases below that read as *capabilities* (it sees the frontmatter, it
 * resolves the definition, it tells a reference link from an inline one) are
 * regression guards on the adapter's configuration: revert any one of the four
 * fixes and exactly one of them goes red, naming what was reverted.
 *
 * ## Why the assertions are about KINDS of finding, not counts
 *
 * A count would move whenever the fixture moves, and would then be updated
 * without anyone reading it. What must not move quietly is *which capabilities
 * a rival fails* — so each case names one gap, and the last cases pin the full
 * set of gap kinds and fields so a NEW divergence cannot appear unremarked.
 */

import { runParseConformance, type ConformanceFinding } from '@vibe-agent-toolkit/resources/parse-conformance';
import { describe, expect, it } from 'vitest';

import { markdownItParser } from '../src/markdown-it-parser.js';

/**
 * A document exercising every construct the two parsers might disagree about.
 *
 * One document, deliberately: this is a fidelity probe, not a corpus sweep. The
 * corpus-wide run is what `parser-bakeoff.ts` is for, and pointing this at a
 * whole tree would make a unit test depend on a checkout's contents.
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
    '<a id="anchor"></a>',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '## Sub **bold**',
    '',
  ].join('\n'),
} as const;

const REPORT = runParseConformance(markdownItParser, [PROBE]);

const SPAN_FACTS = markdownItParser.open(PROBE.content).spansAndKinds?.();

function fields(findings: readonly ConformanceFinding[]): string[] {
  return findings.flatMap((finding) => (finding.kind === 'facts-differ' ? [finding.field] : []));
}

/** Explicit collation, so a pinned list is stable rather than locale-dependent. */
const byName = (left: string, right: string): number => left.localeCompare(right);

describe('markdown-it as a VAT parser implementation', () => {
  it('parses the probe at all — the gaps below are fidelity, not a crash', () => {
    expect(REPORT.findings.some((finding) => finding.kind === 'threw')).toBe(false);
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
    expect(fields(REPORT.findings)).not.toContain('headings');
    expect(SPAN_FACTS?.frontmatterSource).toBe('id: probe');
  });

  it('resolves the link definition, so a resolvable reference is not called dangling', () => {
    // 🚩 Guards the `reference` block-rule wrapper. `[label]: url` lands in
    // `env.references` with no token, so nothing in the output marks its
    // extent — and a `link-definition` span carrying a label is the only thing
    // `findUnresolvedReferences` collects defined labels from. Unwrapped, the
    // probe's one *resolvable* reference reads as dangling.
    expect(fields(REPORT.findings)).not.toContain('unresolvedReferences');
    expect(SPAN_FACTS?.spans).toContainEqual({
      kind: 'link-definition',
      startOffset: 28,
      endOffset: 43,
      label: 'label',
    });
  });

  it('tells a reference link from an inline one', () => {
    // 🚩 Guards the `link` inline-rule wrapper. Both forms arrive as the same
    // `link_open` token; the wrapper slices the source the rule consumed, and
    // the test is total — an inline link closes with `)`, all three reference
    // forms close with `]`.
    expect(SPAN_FACTS?.links.map((link) => link.nodeType)).toEqual(['link', 'linkReference', 'definition']);
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

  it('places a block span at exact character offsets, terminator excluded', () => {
    // 🚩 Guards the line-terminator trim in `blockSpanFromMap`. A line range's
    // exclusive end is the START of the following line, so taking it verbatim
    // swallows the newline — and that one code unit made
    // `contentMeasures.codeBlockCodeUnits` disagree for every fenced block.
    expect(fields(REPORT.findings)).not.toContain('contentMeasures');
    expect(SPAN_FACTS?.spans).toContainEqual({ kind: 'code-block', startOffset: 128, endOffset: 150 });
    expect(PROBE.content.slice(128, 150)).toBe('```ts\nconst x = 1;\n```');
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
    // probe that contains three of them. Absent rather than guessed: a mask at
    // the wrong offset suppresses real findings instead of producing an obvious
    // failure.
    expect(SPAN_FACTS?.spans.map((span) => span.kind)).toEqual(['frontmatter', 'link-definition', 'code-block']);
  });

  it('disagrees about links ONLY where a position is involved', () => {
    // Text, href, classification, `nodeType` and the by-kind bucketing all
    // agree. What is missing is `line`, `startOffset` and `endOffset` on the
    // two INLINE entries — the definition, being a block construct, carries all
    // three and matches remark exactly.
    expect(fields(REPORT.findings)).toContain('links');
    expect(SPAN_FACTS?.links.at(-1)).toEqual({
      text: 'label',
      href: './b.md',
      type: 'local_file',
      line: 7,
      startOffset: 28,
      endOffset: 43,
      nodeType: 'definition',
    });
    for (const link of SPAN_FACTS?.links.slice(0, 2) ?? []) {
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

  it('reports no span-fidelity finding, which is a finding about the HARNESS', () => {
    // 🪤 `SPAN_OPENERS` catches an implementation reporting lines where
    // characters were asked for — but only for a construct that does not begin
    // a line. Every span `markdown-it` emits IS a block that begins a line, so
    // the opener check passes and this stays silent even now that three spans
    // are emitted rather than one.
    //
    // 🔑 The generalisation: the whole-`ParseFacts` diff is the instrument that
    // discriminates. The span checks are a faster path to a SUBSET of what it
    // finds and are never a substitute for it. A suite that only checked spans
    // would have called both versions of this adapter clean.
    expect(REPORT.findings.some((finding) => finding.kind === 'span-fidelity')).toBe(false);
    expect(markdownItParser.capabilities).not.toContain('faithful-edit');
  });

  it('pins the set of divergence kinds, so a NEW kind cannot appear unremarked', () => {
    const kinds = [...new Set(REPORT.findings.map((finding) => finding.kind))].sort(byName);
    expect(kinds).toEqual(['facts-differ']);
  });

  it('pins WHICH fields diverge, so a fixed gap shows up as a change here', () => {
    // Two, both of them the inline-position gap. The other five this adapter
    // used to report were its own — see this file's docstring.
    expect([...fields(REPORT.findings)].sort(byName)).toEqual(['lexicalReferences', 'links']);
  });

  it('carries the fact shape the verdict was taken against', () => {
    // ⛔ Not a CONFORMANCE_VERSION: a derived string that moves when the schema
    // moves, so a stored verdict says what it is about without anyone bumping.
    expect(REPORT.factsShape.length).toBeGreaterThan(0);
  });
});

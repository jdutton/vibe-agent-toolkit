/**
 * `markdown-it` run through the conformance suite — step 6 of the parser plan.
 *
 * ## What a failure here means
 *
 * ⛔ Not "markdown-it is broken", and ⛔ not "VAT should switch". This file pins
 * the *shape* of the disagreement so that it is evidence rather than opinion:
 * `markdown-it` is 10.62× faster on VAT's corpus, and the only thing that
 * decides whether that number is reachable is which facts it can and cannot
 * supply. The suite answers that; this test records the answer and goes red if
 * it moves.
 *
 * ## Why the assertions are about KINDS of finding, not counts
 *
 * A count would move whenever the fixture moves, and would then be updated
 * without anyone reading it. What must not move quietly is *which capabilities
 * a rival fails* — so each case names one gap, and the last case pins the full
 * set of gap kinds so a NEW kind of divergence cannot appear unremarked.
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

  it('cannot see the link definition, which is what dangling-reference detection needs', () => {
    // `[label]: url` lands in `env.references` with no token and no position, so
    // no `link-definition` span exists to collect a label from. The visible
    // consequence is that `[ref][label]` reads as dangling.
    expect(fields(REPORT.findings)).toContain('unresolvedReferences');
  });

  it('cannot see the frontmatter block, and mis-reads its body as a heading', () => {
    // The default preset has no frontmatter rule, so the block's source is never
    // captured — and the damage does not stop there. `---` above and below a
    // line makes it a **setext heading**, so `id: probe` enters the heading
    // outline as an h2 with slug `id-probe`. A parser that merely *missed*
    // frontmatter would cost one field; this one invents a section.
    expect(fields(REPORT.findings)).toContain('frontmatterSource');
    expect(fields(REPORT.findings)).toContain('headings');
  });

  it('cannot see the raw-HTML anchor under the default preset', () => {
    // `html: false` escapes `<a id="anchor">` as text, so the fragment target
    // an author declared is invisible and a link to `#anchor` reads as broken.
    expect(fields(REPORT.findings)).toContain('anchors');
  });

  it('disagrees about links, because a reference link is not distinguishable from an inline one', () => {
    expect(fields(REPORT.findings)).toContain('links');
  });

  it('produces almost no spans at all — one for the whole probe', () => {
    // 🔑 The result that decides whether the 10.62× is reachable, and it is not
    // about speed. `markdown-it` gives a position to BLOCK tokens only, so of
    // the eight span kinds VAT asks for, one document containing a fence, an
    // inline code span, two links, a definition, raw HTML and frontmatter
    // yields exactly ONE span. Everything the mask and the lexer depend on is
    // absent, which is why five separate fact fields diverge above.
    const spans = markdownItParser.open(PROBE.content).spansAndKinds?.().spans ?? [];
    expect(spans.map((span) => span.kind)).toEqual(['code-block']);
  });

  it('shows its line-vs-character offset unit as a one-code-unit measure drift', () => {
    // 🪤 A finding about the HARNESS as much as about the parser. `SPAN_OPENERS`
    // catches an implementation reporting lines where characters were asked
    // for — but only for a construct that does not begin a line. Every span
    // `markdown-it` emits IS a block that begins a line, so the opener check
    // passes and `span-fidelity` reports nothing.
    //
    // The unit mismatch surfaces one layer down instead: a line-aligned fence
    // span runs to the start of the following line, so it swallows the trailing
    // newline and `codeBlockCodeUnits` comes out one higher than remark's.
    // A conformance suite that only checked spans would have called this clean.
    expect(fields(REPORT.findings)).toContain('contentMeasures');
    expect(REPORT.findings.some((finding) => finding.kind === 'span-fidelity')).toBe(false);
    expect(markdownItParser.capabilities).not.toContain('faithful-edit');
  });

  it('pins the set of divergence kinds, so a NEW kind cannot appear unremarked', () => {
    const kinds = [...new Set(REPORT.findings.map((finding) => finding.kind))].sort(byName);
    expect(kinds).toEqual(['facts-differ']);
  });

  it('pins WHICH fields diverge, so a fixed gap shows up as a change here', () => {
    expect([...fields(REPORT.findings)].sort(byName)).toEqual([
      'anchors',
      'contentMeasures',
      'frontmatterSource',
      'headings',
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

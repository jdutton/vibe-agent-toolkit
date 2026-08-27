/**
 * The conformance suite's own tests.
 *
 * A harness that reports "no findings" is worthless unless it has been shown to
 * report findings, so every guard here is proved by MUTATION: a stub
 * implementation is derived from remark with exactly one property broken, and
 * the suite must name that property and only that property.
 *
 * The stubs are the point. Each one is a plausible way a real second
 * implementation goes wrong — `markdown-it@14` genuinely reports line ranges
 * rather than character offsets, and genuinely emits nothing for a link
 * definition — so a stub that reproduces one is a rehearsal of the real finding.
 */

import { describe, expect, it } from 'vitest';

import type { MarkdownParser, ParseSession, SourceSpan } from '../src/parse-capabilities.js';
import { runParseConformance, type ConformanceFinding } from '../src/parse-conformance.js';
import { openRemarkSession, remarkParser } from '../src/remark-parser.js';
import { parseFactsShapeSource } from '../src/schemas/parse-facts.js';

/**
 * A corpus exercising every span kind and both link-resolution paths.
 *
 * Deliberately not one document: a single-document run cannot show that a
 * finding is attributed to the right document, and `documentsCompared` would be
 * unfalsifiable at 1.
 */
const CORPUS = [
  {
    name: 'mixed.md',
    content: [
      '---',
      'id: mixed',
      '---',
      '',
      '# Title',
      '',
      // Definition FIRST, so document order and kind order genuinely disagree —
      // otherwise a document-order stub sorts into kind order by accident and
      // the bucketing guard below would pass without being exercised.
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
      '![alt](./img.png)',
      '',
      'A dangling [text][nowhere-defined] reference.',
      '',
      '## Sub',
      '',
      'Also @docs/note.md as a lexical candidate.',
      '',
      // A GFM autolink literal, which is an `inline-link` span with no opening
      // delimiter at all. It is here to hold `SPAN_OPENERS` honest: an opener
      // list of `[` and `<` makes the REFERENCE implementation fail this suite
      // on ordinary prose, which the reference-against-itself case below is what
      // catches.
      'Bare https://example.com/ in prose.',
      '',
    ].join('\n'),
  },
  {
    name: 'plain.md',
    content: '# Only a heading\n\nAnd a paragraph.\n',
  },
] as const;

/** Wrap remark, replacing the session it hands back. */
function stub(name: string, wrap: (session: ReturnType<typeof openRemarkSession>) => ParseSession): MarkdownParser {
  return {
    name,
    capabilities: ['spans-and-kinds', 'structure', 'faithful-edit'],
    open: (content) => wrap(openRemarkSession(content)),
  };
}

/** Every span-fidelity finding a candidate produces over the corpus. */
function spanFindings(candidate: MarkdownParser) {
  return findingsOfKind(runParseConformance(candidate, CORPUS).findings, 'span-fidelity');
}

/** Narrows to one finding variant, so a case can assert that variant's fields. */
function findingsOfKind<K extends ConformanceFinding['kind']>(
  findings: readonly ConformanceFinding[],
  kind: K,
): Extract<ConformanceFinding, { kind: K }>[] {
  return findings.filter((finding): finding is Extract<ConformanceFinding, { kind: K }> => finding.kind === kind);
}

describe('runParseConformance — the reference against itself', () => {
  it('reports nothing when the candidate IS the reference', () => {
    const report = runParseConformance(remarkParser, CORPUS);
    expect(report.findings).toEqual([]);
    expect(report.documentsCompared).toBe(CORPUS.length);
    expect(report.reference).toBe('remark-parse');
    expect(report.candidate).toBe('remark-parse');
  });

  it('declares the fact shape it was taken against, rather than a version', () => {
    // ⛔ The guard against someone inventing a CONFORMANCE_VERSION: the report
    // carries the schema's own derived structure, which moves when the schema
    // moves and needs nobody to remember anything.
    expect(runParseConformance(remarkParser, CORPUS).factsShape).toBe(parseFactsShapeSource());
  });
});

describe('runParseConformance — link bucketing', () => {
  it('names a document-order link list as its own finding, not an ordinal diff', () => {
    // The mutation that passes every schema check in this repo and fails every
    // parse-fact golden. `mixed.md` has one of each kind, so sorting by line
    // genuinely interleaves them.
    const documentOrder = stub('document-order-links', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        return { ...facts, links: [...facts.links].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)) };
      },
    }));

    const findings = findingsOfKind(runParseConformance(documentOrder, CORPUS).findings, 'link-order');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.document).toBe('mixed.md');
  });

  it('accepts a link list that is bucketed but internally reordered by nothing', () => {
    // Negative control: without the sort, the same stub shape is clean. Without
    // this, the case above would pass for a harness that flags every stub.
    const passthrough = stub('passthrough', (session) => ({ ...session }));
    expect(runParseConformance(passthrough, CORPUS).findings).toEqual([]);
  });
});

describe('runParseConformance — span fidelity', () => {
  it('catches line numbers reported where character offsets were asked for', () => {
    // `markdown-it@14`'s actual failure mode, reproduced: block tokens carry a
    // line range (`map`), not a character range.
    const lineRanges = stub('line-ranges', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        const spans: SourceSpan[] = facts.spans.map((span) => ({ ...span, startOffset: 0, endOffset: 3 }));
        return { ...facts, spans };
      },
    }));

    const findings = spanFindings(lineRanges);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((finding) => finding.reason)).toContain('opener-mismatch');
  });

  it('catches an offset past the end of the source', () => {
    const overrun = stub('overrun', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        const [first, ...rest] = facts.spans;
        const spans = first === undefined ? [] : [{ ...first, endOffset: 10_000 }, ...rest];
        return { ...facts, spans };
      },
    }));

    const findings = spanFindings(overrun);
    expect(findings.some((finding) => finding.reason === 'out-of-range')).toBe(true);
  });

  it('catches spans that straddle rather than nest', () => {
    // Containment is what every mask in the package tests, so a straddle
    // silently changes which candidates get suppressed instead of failing loudly.
    const straddling = stub('straddling', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        const first = facts.spans[0];
        if (first === undefined) return facts;
        const straddle: SourceSpan = {
          kind: first.kind,
          startOffset: first.startOffset + 1,
          endOffset: first.endOffset + 1,
        };
        return { ...facts, spans: [...facts.spans, straddle] };
      },
    }));

    const findings = spanFindings(straddling);
    expect(findings.some((finding) => finding.reason === 'partial-overlap')).toBe(true);
  });

  it('catches a straddle across a CONTAINED span, which is not its sorted neighbour', () => {
    // 🪤 The reason the check tracks the furthest end seen rather than the
    // previous span. Sorted by start, these are A, B, C — and C straddles A
    // while its neighbour is B, which C neither straddles nor contains. Comparing
    // neighbours alone reports nothing at all here.
    const nested = stub('nested-straddle', (session) => ({
      ...session,
      spansAndKinds: () => ({
        ...session.spansAndKinds(),
        spans: [
          { kind: 'code-block', startOffset: 0, endOffset: 10 },
          { kind: 'code-span', startOffset: 2, endOffset: 4 },
          { kind: 'code-block', startOffset: 5, endOffset: 15 },
        ] satisfies SourceSpan[],
      }),
    }));

    const findings = spanFindings(nested);
    expect(findings.some((finding) => finding.reason === 'partial-overlap')).toBe(true);
  });

  it('catches an extent that runs one terminator long', () => {
    // 🪤 The failure a line range ALWAYS has and an opener check never sees: its
    // exclusive end is the start of the following line. This is the defect
    // `markdown-it-parser.ts` shipped and had to be found by eye, because every
    // span still began with the right character. `contentMeasures` moved; the
    // span checks said nothing.
    const swallowed = stub('swallowed-terminator', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        const spans = facts.spans.map((span) => ({ ...span, endOffset: span.endOffset + 1 }));
        return { ...facts, spans };
      },
    }));

    const findings = spanFindings(swallowed);
    expect(findings.some((finding) => finding.reason === 'trailing-terminator')).toBe(true);
  });
});

describe('runParseConformance — capabilities and failures', () => {
  it('reports a capability the candidate does not serve, once per document', () => {
    const spansOnly: MarkdownParser = {
      name: 'spans-only',
      capabilities: ['spans-and-kinds'],
      open: (content) => ({ spansAndKinds: openRemarkSession(content).spansAndKinds }),
    };

    const findings = findingsOfKind(runParseConformance(spansOnly, CORPUS).findings, 'missing-capability');
    expect(findings).toHaveLength(CORPUS.length);
    expect(findings[0]?.capability).toBe('structure');
  });

  it('separates a thrown error from a capability it never claimed', () => {
    const broken = stub('broken', () => ({
      spansAndKinds: () => {
        throw new Error('tokenizer exploded');
      },
      structure: () => ({ headings: [] }),
    }));

    const findings = findingsOfKind(runParseConformance(broken, CORPUS).findings, 'threw');
    expect(findings).toHaveLength(CORPUS.length);
    expect(findings[0]?.message).toBe('tokenizer exploded');
    expect(findingsOfKind(runParseConformance(broken, CORPUS).findings, 'missing-capability')).toEqual([]);
  });
});

describe('runParseConformance — fact differences', () => {
  it('names the field that differs, not the whole record', () => {
    const noAnchors = stub('no-anchors', (session) => ({
      ...session,
      spansAndKinds: () => ({ ...session.spansAndKinds(), anchors: [] }),
    }));

    const findings = findingsOfKind(runParseConformance(noAnchors, CORPUS).findings, 'facts-differ');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field).toBe('anchors');
    expect(findings[0]?.candidate).toBe('undefined');
  });

  it('sees a field only ONE side populates', () => {
    // Iterating the reference's keys alone would miss a candidate-only field,
    // and iterating the candidate's alone would miss a reference-only one.
    const noHeadings = stub('no-headings', (session) => ({
      ...session,
      structure: () => ({ headings: [] }),
    }));

    const findings = findingsOfKind(runParseConformance(noHeadings, CORPUS).findings, 'facts-differ');
    expect(findings.map((finding) => finding.field)).toEqual(['headings', 'headings']);
  });

  it('does not report a difference in key ORDER as a difference in value', () => {
    const reordered = stub('reordered-keys', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        // Same values, rebuilt with the keys inserted in a different order.
        const links = facts.links.map(
          (link) => Object.fromEntries([...Object.entries(link)].reverse()) as typeof link,
        );
        return { ...facts, links };
      },
    }));

    expect(runParseConformance(reordered, CORPUS).findings).toEqual([]);
  });
});

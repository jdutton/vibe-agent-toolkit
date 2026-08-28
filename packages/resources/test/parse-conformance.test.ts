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

import type { MarkdownParser, ParseSession, SourceSpan, SpanKind } from '../src/parse-capabilities.js';
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
      // 🪤 And the shape the letter-only opener list still got wrong: a GFM
      // email autolink literal whose local part opens with a DIGIT or `_`. An
      // opener list of `[`, `<` and a-zA-Z made the reference implementation
      // fail against ITSELF here — a `span-fidelity` finding on remark, over
      // correct prose. Both spellings, because they are separate character
      // classes.
      'Mail 1a@example.com or _dev@example.com now.',
      '',
    ].join('\n'),
  },
  {
    name: 'plain.md',
    content: '# Only a heading\n\nAnd a paragraph.\n',
  },
] as const;

const SPANS_AND_KINDS = 'spans-and-kinds';
const CAPABILITY_CLAIM = 'capability-claim';
const FACTS_DIFFER = 'facts-differ';

/** What a fully conformant implementation declares. */
const ALL_CAPABILITIES = [SPANS_AND_KINDS, 'structure', 'faithful-edit'] as const;

/** Wrap remark, replacing the session it hands back. */
function stub(name: string, wrap: (session: ReturnType<typeof openRemarkSession>) => ParseSession): MarkdownParser {
  return {
    name,
    capabilities: [...ALL_CAPABILITIES],
    open: (content) => wrap(openRemarkSession(content)),
  };
}

/** Every finding of one kind a candidate produces over the corpus. */
function findingsFor<K extends ConformanceFinding['kind']>(candidate: MarkdownParser, kind: K) {
  return findingsOfKind(runParseConformance(candidate, CORPUS).findings, kind);
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

    const findings = findingsFor(documentOrder, 'link-order');
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

  it('catches an extent truncated by one character, which lands on no terminator', () => {
    // 🪤 The textbook inclusive/exclusive off-by-one — the closing backtick
    // falls off every code span, the closing `)` off every image. Before
    // `SPAN_CLOSERS` existed this was caught on ONE document out of 339,
    // because `trailing-terminator` only fires when the bad end happens to sit
    // on a newline. The opener check cannot see it at all: the start is right.
    const truncated = stub('truncated-by-one', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        const spans = facts.spans.map((span) => ({ ...span, endOffset: span.endOffset - 1 }));
        return { ...facts, spans };
      },
    }));

    const findings = spanFindings(truncated);
    expect(findings.some((finding) => finding.reason === 'closer-mismatch')).toBe(true);
  });

  it('reports a span kind outside the vocabulary instead of throwing', () => {
    // 🚨 The single most likely thing a real second implementation does, and it
    // used to take the whole run down with a TypeError: every table here is
    // keyed by `SpanKind`, and `markdown-it` alone has `table`, `blockquote`
    // and `list_item` tokens. The suite's own docstring promises one finding
    // per document rather than an abort, so this must be a finding.
    const foreignKind = stub('foreign-kind', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        const alien = { kind: 'table' as SpanKind, startOffset: 0, endOffset: 3 };
        return { ...facts, spans: [...facts.spans, alien] };
      },
    }));

    // Must not throw — that is the whole point.
    const findings = spanFindings(foreignKind);
    expect(findings.some((finding) => finding.reason === 'unknown-kind')).toBe(true);
  });

  it('catches spans emitted out of document order', () => {
    // `SpanFacts.spans` states "in document order" as a contract clause, and
    // nothing held an implementation to it: every consumer sorts, so reversing
    // every span list produced ZERO findings over the whole corpus.
    const reversed = stub('reversed-spans', (session) => ({
      ...session,
      spansAndKinds: () => {
        const facts = session.spansAndKinds();
        return { ...facts, spans: [...facts.spans].reverse() };
      },
    }));

    const findings = spanFindings(reversed);
    expect(findings.some((finding) => finding.reason === 'out-of-order')).toBe(true);
  });
});

describe('runParseConformance — the capability DECLARATION', () => {
  it('catches a parser that serves a capability it did not declare', () => {
    // `capabilities` is declared rather than inferred so that it CAN be
    // contradicted. Until this check existed nothing read the field: a parser
    // declaring `[]` and one declaring all three produced identical reports, so
    // deleting the field entirely would have reddened no test.
    const understated: MarkdownParser = {
      name: 'understated',
      capabilities: [SPANS_AND_KINDS],
      open: (content) => openRemarkSession(content),
    };

    const findings = findingsFor(understated, CAPABILITY_CLAIM);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.capability).toBe('structure');
    expect(findings[0]?.declared).toBe(false);
    expect(findings[0]?.served).toBe(true);
  });

  it('catches a parser that declares a capability it does not serve', () => {
    const overstated: MarkdownParser = {
      name: 'overstated',
      capabilities: [SPANS_AND_KINDS, 'structure'],
      open: (content) => ({ spansAndKinds: openRemarkSession(content).spansAndKinds }),
    };

    const findings = findingsFor(overstated, CAPABILITY_CLAIM);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.capability).toBe('structure');
    expect(findings[0]?.declared).toBe(true);
    expect(findings[0]?.served).toBe(false);
  });

  it('is emitted once per RUN, not once per document', () => {
    // It is a property of the implementation, not of any one parse, so it
    // carries no document and must not scale with the corpus.
    const understated: MarkdownParser = {
      name: 'understated',
      capabilities: [],
      open: (content) => openRemarkSession(content),
    };

    const findings = findingsFor(understated, CAPABILITY_CLAIM);
    expect(findings).toHaveLength(2);
    expect(CORPUS.length).toBeGreaterThan(1);
  });
});

describe('runParseConformance — throws are attributed to a side', () => {
  it('survives a REFERENCE that throws, and says it was the reference', () => {
    // The reference is remark by default, but the parameter exists so a caller
    // can pass something else — and an unguarded reference meant one bad
    // document cost the whole report rather than one row of it.
    const brokenReference = stub('broken-reference', () => ({
      spansAndKinds: () => {
        throw new Error('reference exploded');
      },
      structure: () => ({ headings: [] }),
    }));

    const findings = findingsOfKind(runParseConformance(remarkParser, CORPUS, brokenReference).findings, 'threw');
    expect(findings).toHaveLength(CORPUS.length);
    expect(findings.every((finding) => finding.side === 'reference')).toBe(true);
  });

  it('reports a candidate whose SECOND session throws', () => {
    // 🪤 `collectSpanFindings` opens an INDEPENDENT second session, so a throw
    // there is not already recorded by the composer's pass. An implementation
    // whose session is one-shot or stateful succeeds on the first and throws on
    // the second — and swallowing it let such a candidate read completely clean
    // on the whole span-fidelity axis.
    const seen = new Set<string>();
    const oneShot: MarkdownParser = {
      name: 'one-shot-session',
      capabilities: ['spans-and-kinds', 'structure', 'faithful-edit'],
      open: (content) => {
        if (content !== '' && seen.has(content)) throw new Error('session already consumed');
        seen.add(content);
        return openRemarkSession(content);
      },
    };

    const findings = findingsFor(oneShot, 'threw');
    expect(findings).toHaveLength(CORPUS.length);
    expect(findings.every((finding) => finding.side === 'candidate')).toBe(true);
    expect(findings[0]?.message).toContain('second session');
  });
});

describe('runParseConformance — capabilities and failures', () => {
  it('reports a capability the candidate does not serve, once per document', () => {
    const spansOnly: MarkdownParser = {
      name: 'spans-only',
      capabilities: [SPANS_AND_KINDS],
      open: (content) => ({ spansAndKinds: openRemarkSession(content).spansAndKinds }),
    };

    const findings = findingsFor(spansOnly, 'missing-capability');
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

    const findings = findingsFor(broken, 'threw');
    expect(findings).toHaveLength(CORPUS.length);
    expect(findings[0]?.message).toBe('tokenizer exploded');
    expect(findingsFor(broken, 'missing-capability')).toEqual([]);
  });
});

describe('runParseConformance — fact differences', () => {
  it('names the field that differs, not the whole record', () => {
    const noAnchors = stub('no-anchors', (session) => ({
      ...session,
      spansAndKinds: () => ({ ...session.spansAndKinds(), anchors: [] }),
    }));

    const findings = findingsFor(noAnchors, FACTS_DIFFER);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field).toBe('anchors');
    expect(findings[0]?.candidate).toBe('undefined');
  });

  it('sees a field the REFERENCE populates and the candidate empties', () => {
    const noHeadings = stub('no-headings', (session) => ({
      ...session,
      structure: () => ({ headings: [] }),
    }));

    const findings = findingsFor(noHeadings, FACTS_DIFFER);
    expect(findings.map((finding) => finding.field)).toEqual(['headings', 'headings']);
  });

  it('sees a field only the CANDIDATE populates', () => {
    // 🪤 The direction the union of keys exists for, and the one every other
    // stub here misses: they all drop or alter a key the REFERENCE has, which
    // reference-side iteration alone would still catch. `plain.md` carries no
    // frontmatter, so remark omits the key entirely and the candidate invents
    // it — the only case where `new Set(Object.keys(reference))` reds.
    const invented = stub('candidate-only-field', (session) => ({
      ...session,
      spansAndKinds: () => ({ ...session.spansAndKinds(), frontmatterSource: 'invented: true' }),
    }));

    const findings = findingsFor(invented, FACTS_DIFFER).filter(
      (finding) => finding.field === 'frontmatterSource',
    );
    const onPlain = findings.find((finding) => finding.document === 'plain.md');
    expect(onPlain).toBeDefined();
    expect(onPlain?.reference).toBe('undefined');
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

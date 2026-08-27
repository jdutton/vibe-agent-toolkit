/**
 * The conformance suite: does a second parser produce the same `ParseFacts`?
 *
 * ## Why this exists before any parser is swapped
 *
 * Without a whole-corpus facts diff you cannot tell **faster** from
 * **differently wrong**, and differently-wrong ships silently. A single
 * implementation behind an interface is a claim nobody has tested; this is the
 * only thing that converts "loosely coupled" from an assertion into a
 * measurement.
 *
 * It answers two questions with one run, which is why it is worth building once
 * rather than twice: *"do these two implementations agree?"* and *"is this
 * parser change faster, or just different?"* are the same comparison.
 *
 * ## ⛔ There is no `CONFORMANCE_VERSION`, and there must never be one
 *
 * A report is only meaningful against the fact shape it was taken over, and the
 * temptation is to stamp it with an integer somebody remembers to bump. VAT
 * already derives that answer: {@link ConformanceReport.factsShape} carries
 * `parseFactsShapeSource()` — the schema's own structure, prose stripped — so a
 * report **declares the shape it was taken against** and two reports can be
 * compared without either side knowing a magic number. Adding, renaming or
 * reordering a `ParseFacts` field moves the string with zero human action.
 *
 * ## What a finding means
 *
 * The three kinds are deliberately not collapsed into one, because they call for
 * different responses:
 *
 * | Finding | Means | Response |
 * |---|---|---|
 * | `missing-capability` | the parser cannot answer at all | it is not a candidate for that capability |
 * | `span-fidelity` | its offsets cannot be spliced at | it fails `faithful-edit`, whatever else it does |
 * | `facts-differ` | it answered, differently | a judgement call about which answer is right |
 *
 * A `facts-differ` finding is **not** automatically a defect in the candidate.
 * The reference implementation is remark, not the CommonMark spec.
 */

import { parseMarkdownContent } from './link-parser.js';
import { dehydrate } from './parse-cache.js';
import {
  type MarkdownParser,
  MissingCapabilityError,
  type SourceSpan,
  type SpanKind,
} from './parse-capabilities.js';
import { remarkParser } from './remark-parser.js';
import { type ParseFacts, parseFactsShapeSource } from './schemas/parse-facts.js';

/** One document to compare the two implementations over. */
export interface ConformanceDocument {
  /** How the document is named in findings — a path, or a fixture's label. */
  name: string;
  content: string;
}

/** A capability the candidate does not serve, so it produced nothing to compare. */
export interface MissingCapabilityFinding {
  kind: 'missing-capability';
  document: string;
  capability: string;
}

/**
 * A span whose offsets cannot be spliced at — the `faithful-edit` failure.
 *
 * `reason` separates the two ways it goes wrong, because they have different
 * causes: `opener-mismatch` is an implementation reporting the wrong *unit*
 * (line numbers where character offsets were asked for, most often), while
 * `partial-overlap` is one reporting extents that straddle each other, which
 * breaks the containment test every mask in this package relies on.
 */
export interface SpanFidelityFinding {
  kind: 'span-fidelity';
  document: string;
  reason: 'out-of-range' | 'opener-mismatch' | 'partial-overlap';
  span: SourceSpan;
  /** What the source actually holds at those offsets, clipped for legibility. */
  found: string;
}

/** A `ParseFacts` field the two implementations disagree about. */
export interface FactsDifferFinding {
  kind: 'facts-differ';
  document: string;
  field: keyof ParseFacts;
  /** Canonical JSON of each side's value, clipped for legibility. */
  reference: string;
  candidate: string;
}

/** The candidate threw where the reference did not. */
export interface ThrewFinding {
  kind: 'threw';
  document: string;
  message: string;
}

/**
 * The candidate emitted `links` in document order rather than bucketed by kind.
 *
 * Its own finding rather than a `facts-differ` on `links`, because it is the one
 * divergence that passes every schema check in this repo and fails every
 * parse-fact golden: the goldens pin `links` **by ordinal**, and a document-order
 * implementation is wrong in a way a shape validator cannot see. Left to the
 * goldens to discover, it reads as dozens of unrelated failures.
 */
export interface LinkOrderFinding {
  kind: 'link-order';
  document: string;
  /** The `nodeType` sequence as emitted, which is what makes the break legible. */
  emitted: string[];
}

export type ConformanceFinding =
  | FactsDifferFinding
  | LinkOrderFinding
  | MissingCapabilityFinding
  | SpanFidelityFinding
  | ThrewFinding;

/** The outcome of comparing one candidate against the reference over a corpus. */
export interface ConformanceReport {
  /** Name of the implementation treated as correct. */
  reference: string;
  /** Name of the implementation under test. */
  candidate: string;
  documentsCompared: number;
  /**
   * `parseFactsShapeSource()` at the time of the run — the report's own
   * statement of which fact shape it is about. See this module's docstring for
   * why this is a derived string and not a version integer.
   */
  factsShape: string;
  findings: ConformanceFinding[];
}

/**
 * The first character a span of each kind must begin with in the source.
 *
 * The discriminating check, and the cheapest one that catches the failure mode
 * an implementation is most likely to have while looking complete: reporting
 * **line ranges** where character offsets were asked for. A line range that
 * happens to start at a line boundary lands on whatever the line begins with,
 * so it fails this for every kind that does not start a line.
 *
 * An indented code block is the reason `code-block` admits a space: it opens
 * with indentation rather than a fence.
 */
const SPAN_OPENERS: Readonly<Record<SpanKind, readonly string[]>> = {
  'code-block': ['`', '~', ' ', '\t'],
  'code-span': ['`'],
  'raw-html': ['<'],
  frontmatter: ['-'],
  'inline-link': ['[', '<'],
  image: ['!'],
  'reference-link': ['['],
  'link-definition': ['['],
};

/** How much of a mismatching slice a finding carries. */
const FINDING_EXCERPT_LIMIT = 120;

/** The order `SpanFacts.links` must be bucketed in. */
const LINK_KIND_RANK: Readonly<Record<string, number>> = {
  link: 0,
  linkReference: 1,
  definition: 2,
};

/**
 * Compare a candidate parser against the reference over a corpus.
 *
 * Runs the whole composer for each implementation — not just the capability —
 * because `ParseFacts` is what the parse cache round-trips and what every
 * consumer downstream reads, so agreement anywhere short of it is not
 * agreement. A candidate that cannot serve a capability yields one
 * `missing-capability` finding per document rather than aborting: the run's
 * value is the full picture, and the first document is not a fair sample.
 *
 * @param candidate - The implementation under test
 * @param documents - The corpus to compare over
 * @param reference - The implementation treated as correct; remark by default
 * @returns Every disagreement found, with the fact shape it was found against
 */
export function runParseConformance(
  candidate: MarkdownParser,
  documents: readonly ConformanceDocument[],
  reference: MarkdownParser = remarkParser,
): ConformanceReport {
  const findings: ConformanceFinding[] = [];

  for (const document of documents) {
    const referenceFacts = dehydrate(parseMarkdownContent(document.content, 0, reference));
    const candidateFacts = factsOrFinding(candidate, document, findings);
    if (candidateFacts !== undefined) {
      collectFactDifferences(document.name, referenceFacts, candidateFacts, findings);
    }
    collectSpanFindings(candidate, document, findings);
  }

  return {
    reference: reference.name,
    candidate: candidate.name,
    documentsCompared: documents.length,
    factsShape: parseFactsShapeSource(),
    findings,
  };
}

/**
 * The candidate's facts, or `undefined` after recording why there are none.
 *
 * @param candidate - The implementation under test
 * @param document - The document being compared
 * @param findings - Accumulator, appended to when the parse does not complete
 */
function factsOrFinding(
  candidate: MarkdownParser,
  document: ConformanceDocument,
  findings: ConformanceFinding[],
): ParseFacts | undefined {
  try {
    return dehydrate(parseMarkdownContent(document.content, 0, candidate));
  } catch (error) {
    if (error instanceof MissingCapabilityError) {
      findings.push({ kind: 'missing-capability', document: document.name, capability: error.capability });
    } else {
      findings.push({
        kind: 'threw',
        document: document.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  }
}

/**
 * Record every `ParseFacts` field the two sides disagree about.
 *
 * Field by field rather than whole-object, because "the facts differ" over a
 * 400-link document is not a finding anyone can act on. The `links` field gets
 * its own bucketing check first, so the one divergence a schema cannot see is
 * named as itself rather than buried in an ordinal diff.
 *
 * @param name - The document's name, for the findings
 * @param reference - Facts from the reference implementation
 * @param candidate - Facts from the implementation under test
 * @param findings - Accumulator
 */
function collectFactDifferences(
  name: string,
  reference: ParseFacts,
  candidate: ParseFacts,
  findings: ConformanceFinding[],
): void {
  const emitted = candidate.links.map((link) => link.nodeType ?? 'unknown');
  if (!isBucketedByKind(emitted)) {
    findings.push({ kind: 'link-order', document: name, emitted });
  }

  // Union of both sides' keys: a field only ONE side populates is a
  // disagreement, and iterating one side's keys alone cannot see it.
  const fields = new Set<keyof ParseFacts>([
    ...(Object.keys(reference) as (keyof ParseFacts)[]),
    ...(Object.keys(candidate) as (keyof ParseFacts)[]),
  ]);

  for (const field of fields) {
    const left = canonicalize(reference[field]);
    const right = canonicalize(candidate[field]);
    if (left !== right) {
      findings.push({ kind: 'facts-differ', document: name, field, reference: clip(left), candidate: clip(right) });
    }
  }
}

/**
 * Whether a `nodeType` sequence is bucketed by kind rather than interleaved.
 *
 * Non-decreasing rank is the whole test: `link`s, then `linkReference`s, then
 * `definition`s. An unrecognised kind sorts last rather than failing, so a
 * candidate that invents a kind is reported by the field diff instead of here.
 *
 * @param emitted - Each link's `nodeType`, in emission order
 */
function isBucketedByKind(emitted: readonly string[]): boolean {
  let highest = -1;
  for (const nodeType of emitted) {
    const rank = LINK_KIND_RANK[nodeType] ?? Number.MAX_SAFE_INTEGER;
    if (rank < highest) return false;
    highest = Math.max(highest, rank);
  }
  return true;
}

/**
 * Record every way the candidate's spans could not be spliced at.
 *
 * This is the `faithful-edit` capability's only test, and it runs whether or not
 * the candidate claims that capability — a claim is what conformance falsifies,
 * so declining to check an unclaimed one would leave the claim unfalsifiable in
 * the other direction too.
 *
 * @param candidate - The implementation under test
 * @param document - The document being compared
 * @param findings - Accumulator
 */
function collectSpanFindings(
  candidate: MarkdownParser,
  document: ConformanceDocument,
  findings: ConformanceFinding[],
): void {
  // Its own session, and guarded on its own: the composer owns the session it
  // opens, so reading spans out of that one would mean testing a hand-composed
  // path instead of the shipped one. A candidate that throws has already been
  // recorded by `factsOrFinding`; swallowing it here keeps one broken document
  // from ending the run before the rest of the corpus is seen.
  let spans: readonly SourceSpan[] | undefined;
  try {
    spans = candidate.open(document.content).spansAndKinds?.().spans;
  } catch {
    return;
  }
  if (spans === undefined) return;

  for (const span of spans) {
    const reason = spanDefect(span, document.content);
    if (reason !== undefined) {
      findings.push({
        kind: 'span-fidelity',
        document: document.name,
        reason,
        span,
        found: clip(document.content.slice(span.startOffset, span.endOffset)),
      });
    }
  }
  collectOverlapFindings(spans, document, findings);
}

/**
 * How one span fails on its own, if it does.
 *
 * @returns The defect, or `undefined` when the span is well-formed
 */
function spanDefect(span: SourceSpan, content: string): SpanFidelityFinding['reason'] | undefined {
  if (span.startOffset < 0 || span.endOffset > content.length || span.startOffset >= span.endOffset) {
    return 'out-of-range';
  }
  const opener = content[span.startOffset] ?? '';
  return SPAN_OPENERS[span.kind].includes(opener) ? undefined : 'opener-mismatch';
}

/**
 * Record spans that straddle rather than nest.
 *
 * Markdown constructs nest; they never partially overlap. Every mask in this
 * package tests **containment** rather than intersection — `isRangeFullyMasked`
 * is the load-bearing one — so a straddling pair silently changes which
 * candidates get suppressed rather than producing an obvious failure.
 *
 * Compares each span against the previous one in start order, which is
 * sufficient: a straddle is always visible between two spans that are adjacent
 * once sorted, because a span straddling a non-adjacent one also straddles or
 * contains everything between.
 *
 * @param spans - The candidate's spans for one document
 * @param document - The document being compared
 * @param findings - Accumulator
 */
function collectOverlapFindings(
  spans: readonly SourceSpan[],
  document: ConformanceDocument,
  findings: ConformanceFinding[],
): void {
  const sorted = [...spans].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const [index, span] of sorted.entries()) {
    const previous = sorted[index - 1];
    if (previous === undefined) continue;
    const straddles = span.startOffset < previous.endOffset && span.endOffset > previous.endOffset;
    if (straddles) {
      findings.push({
        kind: 'span-fidelity',
        document: document.name,
        reason: 'partial-overlap',
        span,
        found: clip(document.content.slice(previous.startOffset, span.endOffset)),
      });
    }
  }
}

/**
 * A value as canonical JSON — object keys sorted, so two producers that build
 * the same record in a different key order compare equal.
 *
 * `undefined` becomes the literal `'undefined'` rather than JSON's `undefined`
 * return, so an absent field compares unequal to a present one instead of two
 * absences comparing equal to two different values.
 *
 * @param value - Any JSON-representable value
 * @returns A string that is equal exactly when the values are structurally equal
 */
function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map((element) => canonicalize(element)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Clip a value for a finding — a report is read, not machine-diffed. */
function clip(value: string): string {
  return value.length <= FINDING_EXCERPT_LIMIT ? value : `${value.slice(0, FINDING_EXCERPT_LIMIT)}…`;
}

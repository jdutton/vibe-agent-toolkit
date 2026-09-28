/**
 * Turn one finished run into a verdict: the exit code plus the multiset of
 * findings the command reported, however it reported them.
 *
 * "Multiset" is deliberate — duplicates are kept, never deduplicated. Two
 * findings that read identically (same code, severity, location and scope) are
 * two things a comparison must be able to tell from one: a command that used to
 * report a broken link once and now reports it twice has a real regression a
 * deduplicated set would erase.
 *
 * A `Report<T>` envelope's `findings[]` is already a flat, typed array — reading
 * it is a direct map. A legacy document has no such array: each command invented
 * its own nesting (`vat audit`'s per-file `issues[]` under `files[]`, plus a
 * run-level `issues[]` sitting beside them; `agent-skills`' per-skill
 * `allErrors[]` beside an `ignoredErrors[]` that must NOT be read as findings).
 * Rather than one hand-written reader per legacy command — which is exactly the
 * kind of two-contracts-for-one-thing drift this repo tracks — this module reads
 * every legacy shape with ONE structural rule: any plain object anywhere in the
 * document that carries a string `code` and a `severity` in
 * `{error, warning, info}` IS a finding. `ignoredErrors` entries (`AllowRecord`:
 * `code`, `location`, `reason`, `expires` — no `severity`) fail that test and are
 * silently skipped, which is what "drops ignore-severity entries" means: they
 * are not filtered by name, they simply never look like a finding.
 */

import { z } from 'zod';

import { parseDocument, type ParsedDocument } from '../../harness/document-shape.js';
import type { RunOutcome } from '../../harness/outcome.js';

/** The severities a published finding can carry — never `ignore`; see this module's docstring. */
const FINDING_SEVERITIES = ['error', 'warning', 'info'] as const;

type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** One finding, reduced to the fields that identify it for a comparison. */
export interface FindingKey {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly location: string | null;
  readonly scope: string | null;
}

/**
 * Runtime schema for {@link FindingKey} — what a stored verdict and a committed
 * `verdict-deltas.yaml` entry are read back through.
 *
 * `.strict()`: a key carrying a field this build does not know is a key this
 * build cannot compare, and silently stripping it would make two different
 * findings compare equal.
 */
export const FindingKeySchema: z.ZodType<FindingKey> = z
  .object({
    code: z.string(),
    severity: z.enum(FINDING_SEVERITIES),
    location: z.string().nullable(),
    scope: z.string().nullable(),
  })
  .strict();

/** A run's verdict: what it exited with, what shape its output was, and what it found. */
export interface Verdict {
  readonly exitCode: number;
  readonly shape: ParsedDocument['shape'];
  /** Sorted by code, then severity, then location. Duplicates are KEPT — see this module's docstring. */
  readonly findings: readonly FindingKey[];
}

/**
 * The one identity of a finding for every comparison — a row's finding layer
 * and a deltas-file declaration alike. Fixed field order, so two keys built
 * from differently-ordered objects are equal.
 *
 * @param finding - A finding
 * @returns Its identity fields, in order
 */
export function findingIdentity(finding: FindingKey): readonly [string, FindingSeverity, string | null, string | null] {
  return [finding.code, finding.severity, finding.location, finding.scope];
}

/** Runtime schema for {@link Verdict}, for reading a stored envelope back. */
export const VerdictSchema: z.ZodType<Verdict> = z
  .object({
    exitCode: z.number().int(),
    shape: z.enum(['report', 'legacy', 'unparsed']),
    findings: z.array(FindingKeySchema),
  })
  .strict();

/**
 * Extract the verdict a finished run reported.
 *
 * @param outcome - A run that exited (never `not-run`; a spawn failure has no
 *   document to read a verdict from)
 * @returns The exit code, the output's shape, and its findings — an empty list,
 *   never a guess, when the output was not readable at all
 */
export function extractVerdict(outcome: Extract<RunOutcome, { kind: 'exited' }>): Verdict {
  const parsed = parseDocument(outcome.stdout);
  return { exitCode: outcome.exitCode, shape: parsed.shape, findings: findingsOf(parsed) };
}

/**
 * @param parsed - A parsed document, of any shape
 * @returns Its findings, sorted; empty (never a guess) when unparsed
 */
function findingsOf(parsed: ParsedDocument): readonly FindingKey[] {
  if (parsed.shape === 'unparsed') return [];
  const raw = parsed.shape === 'report' ? reportFindings(parsed.document) : legacyFindings(parsed.document);
  return sortFindings(raw);
}

/**
 * Read a `Report<T>` envelope's own `findings[]` array.
 *
 * Each element is read structurally (`unknown[]`), never against the schema's
 * `Finding` type: this reader has to keep recognising a document an older or
 * newer vat build printed, and a build that adds a field to `Finding` (this
 * module's own trigger for existing: `scope`, carried by a gate-aware report but
 * absent from today's shipped `Finding`) must not become unreadable here.
 *
 * @param document - The envelope root, already confirmed to carry `findings`
 * @returns One key per element of `findings`, in array order
 */
function reportFindings(document: Record<string, unknown>): FindingKey[] {
  const findings = document['findings'];
  if (!Array.isArray(findings)) return [];
  return findings.filter(isPlainObject).map(reportFindingKey);
}

/**
 * @param finding - One element of a report's `findings[]`
 * @returns Its key, `location` and `scope` each `null` when the field is absent
 */
function reportFindingKey(finding: Record<string, unknown>): FindingKey {
  return {
    code: typeof finding['code'] === 'string' ? finding['code'] : '',
    severity: isFindingSeverity(finding['severity']) ? finding['severity'] : 'info',
    location: typeof finding['location'] === 'string' ? finding['location'] : null,
    scope: 'scope' in finding ? JSON.stringify(finding['scope']) : null,
  };
}

/**
 * Walk a legacy document structurally and collect every finding-shaped object.
 *
 * @param document - The legacy document's root
 * @returns Every match, in the order the walk visits them (pre-order, depth-first)
 */
function legacyFindings(document: Record<string, unknown>): FindingKey[] {
  const out: FindingKey[] = [];
  walk(document, null, out);
  return out;
}

/**
 * Visit one node, recording it as a finding when it qualifies, then recurse.
 *
 * `ancestorPath` is the nearest enclosing object's own `path` field, inherited
 * downward and overridden only when a node carries its own `path` — the rule
 * `verdict-extract.test.ts` fixtures on `vat audit`'s `files[].issues[]`, whose
 * elements carry no `location` of their own and must fall back to the `path` of
 * the `files[]` row that holds them.
 *
 * @param node - Any value reachable from the document root
 * @param ancestorPath - The nearest ancestor's `path`, or `null` above the root
 * @param out - Accumulator, appended to in visiting order
 */
function walk(node: unknown, ancestorPath: string | null, out: FindingKey[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, ancestorPath, out);
    return;
  }
  if (!isPlainObject(node)) return;

  const path = typeof node['path'] === 'string' ? node['path'] : ancestorPath;
  if (isLegacyFinding(node)) out.push(legacyFindingKey(node, ancestorPath));
  for (const value of Object.values(node)) walk(value, path, out);
}

/**
 * @param value - Any value
 * @returns True iff `value` is a non-null, non-array object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param value - A candidate severity value
 * @returns True iff it is one of the three published severities
 */
function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

/**
 * The one structural rule that stands in for every legacy command's finding
 * shape — see this module's docstring.
 *
 * @param node - A candidate object
 * @returns True iff it carries a string `code` and a finding-shaped `severity`
 */
function isLegacyFinding(node: Record<string, unknown>): boolean {
  return typeof node['code'] === 'string' && isFindingSeverity(node['severity']);
}

/**
 * @param node - A node that passed {@link isLegacyFinding}
 * @param ancestorPath - The nearest ancestor's `path`, used when `node` names
 *   neither its own `location` nor `file`
 * @returns Its key; legacy documents carry no `scope`, so that field is always `null`
 */
function legacyFindingKey(node: Record<string, unknown>, ancestorPath: string | null): FindingKey {
  return {
    code: node['code'] as string,
    severity: node['severity'] as FindingSeverity,
    location: legacyLocation(node, ancestorPath),
    scope: null,
  };
}

/**
 * @param node - A node that passed {@link isLegacyFinding}
 * @param ancestorPath - The nearest ancestor's `path`
 * @returns The node's own `location`, else its own `file`, else `ancestorPath`
 */
function legacyLocation(node: Record<string, unknown>, ancestorPath: string | null): string | null {
  if (typeof node['location'] === 'string') return node['location'];
  if (typeof node['file'] === 'string') return node['file'];
  return ancestorPath;
}

/**
 * Order findings by code, then severity, then location — a total, stable order
 * so two extractions of the same multiset always render identically.
 *
 * `null` locations sort before any string: a run-level finding (no file to
 * anchor it) reads first rather than interleaved among file-anchored ones.
 *
 * @param findings - Findings in whatever order they were collected
 * @returns The same findings, sorted; duplicates kept
 */
function sortFindings(findings: readonly FindingKey[]): FindingKey[] {
  return [...findings].sort(
    (a, b) => compareStrings(a.code, b.code)
      || compareStrings(a.severity, b.severity)
      || compareNullableStrings(a.location, b.location),
  );
}

/**
 * Order two strings by UTF-16 code unit — never `localeCompare`, whose order
 * can differ between machines and would make a stored verdict stop matching
 * itself on a different locale.
 *
 * @param a - One string
 * @param b - Another
 * @returns Negative, zero, or positive, as a comparator wants
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * {@link compareStrings}, with `null` sorting before every string.
 *
 * @param a - One value
 * @param b - Another
 * @returns Negative, zero, or positive, as a comparator wants
 */
function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareStrings(a, b);
}

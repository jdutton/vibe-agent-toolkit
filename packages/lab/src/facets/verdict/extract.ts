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

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { parseDocument, type ParsedDocument } from '../../harness/document-shape.js';
import type { RunOutcome } from '../../harness/outcome.js';

import type { VerdictRow } from './types.js';

/** The severities a published finding can carry — never `ignore`; see this module's docstring. */
export const FINDING_SEVERITIES = ['error', 'warning', 'info'] as const;

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
 * A captured row's verdict, derived from its stored document by THIS build's extractor.
 *
 * @param row - One captured invocation
 * @returns Its verdict, or `null` when it produced no exit code
 */
export function rowVerdict(row: VerdictRow): Verdict | null {
  if (row.outcome === 'not-run' || row.exitCode === null) return null;
  return extractVerdict({ kind: 'exited', exitCode: row.exitCode, stdout: row.document, stderr: '' });
}

/**
 * The digest a deltas file may declare a finding's location by, instead of the
 * location: a location is a path inside the subject, and can spell what a
 * committed file must never hold. The digest pins the same identity.
 *
 * @param location - A finding's location, as the extractor read it
 * @returns Its SHA-256, lowercase hex
 */
export function locationDigest(location: string): string {
  return createHash('sha256').update(location, 'utf8').digest('hex');
}

/** How a refusal that carries a sentence and no code is named — never a string a real code could be. */
export const UNCODED_REFUSAL = '(uncoded)';

/**
 * The refusal codes a run PUBLISHED, in document order: the run's own
 * (`error.code` at the root), then each named owner's as `<name>:<code>` — a
 * phase that did not finish carries its own `error` beside its `name`.
 *
 * Read on a row that measured nothing, where the exit code and this are the
 * only data: a build that turns a user's mistake into `INTERNAL_ERROR` (or the
 * reverse) changes neither the exit code nor "unmeasured". The message is NOT
 * read — it names temp directories that differ run to run. An older build's
 * refusal is a sentence (`error: "Phase 'claude' exited…"`), not a code: it IS
 * a refusal, so it is named, as {@link UNCODED_REFUSAL}.
 *
 * An empty list therefore means the run published NO refusal the lab can read
 * — nothing on stdout, unparseable stdout, or a document that refuses nothing —
 * which is a different thing from refusing, whatever the exit code.
 *
 * @param row - One captured invocation
 * @returns Its refusal codes; empty when it published no refusal or was unreadable
 */
export function refusalCodes(row: VerdictRow): string[] {
  if (row.outcome === 'not-run' || row.exitCode === null) return [];
  const parsed = parseDocument(row.document);
  return parsed.shape === 'unparsed' ? [] : collectRefusalCodes(parsed.document);
}

/**
 * @param node - Any value reachable from a document root
 * @param out - Accumulator, appended to in visiting order
 * @returns `out`
 */
function collectRefusalCodes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefusalCodes(item, out);
    return out;
  }
  if (!isPlainObject(node)) return out;
  const code = refusalCodeOf(node['error']);
  if (code !== null) out.push(typeof node['name'] === 'string' ? `${node['name']}:${code}` : code);
  for (const value of Object.values(node)) collectRefusalCodes(value, out);
  return out;
}

/**
 * @param error - An object's `error` value
 * @returns Its code; {@link UNCODED_REFUSAL} for a non-empty sentence; `null` when it is no refusal
 */
function refusalCodeOf(error: unknown): string | null {
  if (isPlainObject(error) && typeof error['code'] === 'string') return error['code'];
  return typeof error === 'string' && error.trim() !== '' ? UNCODED_REFUSAL : null;
}

/** A count per severity. */
export type SeverityCounts = Readonly<Record<FindingSeverity, number>>;

/**
 * A phase of a composite document: an element, carrying a string `name`, of an
 * array under a key `phases` — at the root of an older build's document, under
 * `data` in a report.
 *
 * @param node - Any value reachable from a document root
 * @param out - Accumulator
 * @returns Every phase, in document order
 */
function collectPhases(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const item of node) collectPhases(item, out);
    return out;
  }
  if (!isPlainObject(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'phases' && Array.isArray(value)) {
      out.push(...value.filter(isPlainObject).filter((phase) => typeof phase['name'] === 'string'));
    }
    collectPhases(value, out);
  }
  return out;
}

/**
 * @param value - A candidate `{ errors, warnings, info }` object
 * @returns Its counts by severity, or `null` when it is not one
 */
function asSeverityCounts(value: unknown): SeverityCounts | null {
  if (!isPlainObject(value)) return null;
  const counts: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const [field, severity] of TALLY_SEVERITY_FIELDS) {
    const count = value[field];
    if (!isCount(count)) return null;
    counts[severity] = count;
  }
  return counts;
}

/**
 * The severity counts each PHASE of a composite document published: a report
 * phase's `summary`, an older build's `issueCounts` (on the phase, or on its
 * `report`). Both generations publish them, so they are a margin a compare can
 * hold two differently-shaped documents to.
 *
 * @param row - One captured invocation
 * @returns Phase name → counts; no entry for a phase that published none
 */
export function phaseSeverityCounts(row: VerdictRow): Map<string, SeverityCounts> {
  const counts = new Map<string, SeverityCounts>();
  if (row.outcome === 'not-run' || row.exitCode === null) return counts;
  const parsed = parseDocument(row.document);
  if (parsed.shape === 'unparsed') return counts;
  for (const phase of collectPhases(parsed.document)) {
    const report = phase['report'];
    const published =
      asSeverityCounts(phase['summary']) ??
      asSeverityCounts(phase['issueCounts']) ??
      (isPlainObject(report) ? asSeverityCounts(report['issueCounts']) : null);
    if (published !== null) counts.set(phase['name'] as string, published);
  }
  return counts;
}

/** A tally key: a finding code, as every vat build spells one. */
const TALLY_CODE = /^[A-Z][A-Z0-9_]*$/u;

/** The severity counts a tally's owner carries, and the severity each one counts. */
const TALLY_SEVERITY_FIELDS = [
  ['errors', 'error'],
  ['warnings', 'warning'],
  ['info', 'info'],
] as const satisfies ReadonlyArray<readonly [string, FindingSeverity]>;

/** The findings a document published only as counts — never as findings. */
export interface PublishedTallies {
  /** Per code, how many. Never holds a zero. */
  readonly byCode: ReadonlyMap<string, number>;
  /** The same findings, per severity. */
  readonly bySeverity: SeverityCounts;
  /** How many in all — the sum of either margin. */
  readonly total: number;
  /** The phases that hold a tally, by name — see {@link phaseSeverityCounts}. */
  readonly phases: readonly string[];
}

/**
 * The findings a run published ONLY AS COUNTS, per code and per severity.
 *
 * An older build's composite document (rc.11 `vat verify`) itemizes some
 * findings and publishes the rest only as per-owner tallies — under each skill
 * or file, `{ info: 10, warnings: 2, codes: { LINK_DROPPED_BY_DEPTH: 12 } }`.
 * The finding layer cannot see a tally, so a build that itemizes the same
 * findings reads as thousands of added ones. These counts are what lets a
 * compare tell "the same findings, now itemized" from "new findings".
 *
 * One structural rule, like {@link isLegacyFinding}'s: an object is a tally
 * owner when its `codes` maps finding codes to non-negative integers AND its
 * own `errors` / `warnings` / `info` counts (absent reads as zero) sum to the
 * same total. An owner whose two counts disagree is not read at all — half a
 * tally would let a compare vouch for a severity nobody published.
 *
 * A tally's code and severity counts are two separate margins — not a count
 * per (code, severity) pair. Its owner does name a skill or a file (`skillName`,
 * `file`, `location`), which this reader does not use: a report's flat
 * `findings[]` names no owner to match it against.
 *
 * @param row - One captured invocation
 * @returns Its tallies (all zero when it tallied nothing), or `null` when it
 *   produced no readable document
 */
export function publishedTallies(row: VerdictRow): PublishedTallies | null {
  if (row.outcome === 'not-run' || row.exitCode === null) return null;
  const parsed = parseDocument(row.document);
  if (parsed.shape === 'unparsed') return null;
  const byCode = new Map<string, number>();
  const bySeverity: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  let total = 0;
  for (const tally of collectTallies(parsed.document)) {
    for (const [code, count] of tally.codes) byCode.set(code, (byCode.get(code) ?? 0) + count);
    for (const severity of FINDING_SEVERITIES) bySeverity[severity] += tally.severities[severity];
    total += tally.total;
  }
  const phases = collectPhases(parsed.document)
    .filter((phase) => collectTallies(phase).length > 0)
    .map((phase) => phase['name'] as string);
  return { byCode, bySeverity, total, phases };
}

/** One owner's tally, already checked: `codes` and `severities` both sum to `total`. */
interface Tally {
  /** Non-zero entries only: a zero count publishes nothing. */
  readonly codes: ReadonlyArray<readonly [string, number]>;
  readonly severities: Readonly<Record<FindingSeverity, number>>;
  readonly total: number;
}

/**
 * @param node - Any value reachable from a document root
 * @param out - Accumulator: every tally found
 * @returns `out`
 */
function collectTallies(node: unknown, out: Tally[] = []): Tally[] {
  if (Array.isArray(node)) {
    for (const item of node) collectTallies(item, out);
    return out;
  }
  if (!isPlainObject(node)) return out;
  const tally = asTally(node);
  if (tally !== null) out.push(tally);
  for (const value of Object.values(node)) collectTallies(value, out);
  return out;
}

/**
 * @param owner - A candidate tally owner
 * @returns Its tally when it is one (see {@link publishedTallies}) and counts anything, else `null`
 */
function asTally(owner: Record<string, unknown>): Tally | null {
  const codes = owner['codes'];
  if (!isPlainObject(codes)) return null;
  const counted: Array<readonly [string, number]> = [];
  for (const [code, count] of Object.entries(codes)) {
    if (!TALLY_CODE.test(code) || !isCount(count)) return null;
    if (count > 0) counted.push([code, count]);
  }
  const severities: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const [field, severity] of TALLY_SEVERITY_FIELDS) {
    const count = owner[field] ?? 0;
    if (!isCount(count)) return null;
    severities[severity] = count;
  }
  const total = counted.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0 || total !== severities.error + severities.warning + severities.info) return null;
  return { codes: counted, severities, total };
}

/**
 * @param value - A candidate count
 * @returns True iff it is a non-negative integer
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
 * `ancestorPath` is the nearest enclosing object's {@link namedLocation},
 * inherited downward: `vat audit`'s `files[].issues[]` (rows keyed `path`) and
 * rc.11 `resources validate --verbose`'s `issues[].issues[]` (keyed `file`).
 *
 * @param node - Any value reachable from the document root
 * @param ancestorPath - The nearest ancestor's named location, or `null` above the root
 * @param out - Accumulator, appended to in visiting order
 */
function walk(node: unknown, ancestorPath: string | null, out: FindingKey[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, ancestorPath, out);
    return;
  }
  if (!isPlainObject(node)) return;

  if (isLegacyFinding(node)) out.push(legacyFindingKey(node, ancestorPath));
  const inherited = namedLocation(node) ?? ancestorPath;
  for (const value of Object.values(node)) walk(value, inherited, out);
}

/** The location an object names: its `path`, else its `file`, else `null`. */
function namedLocation(node: Record<string, unknown>): string | null {
  if (typeof node['path'] === 'string') return node['path'];
  return typeof node['file'] === 'string' ? node['file'] : null;
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
 * @param ancestorPath - The nearest ancestor's named location, used when
 *   `node` names none of its own
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
 * A finding's OWN location first, then the enclosing object's: an rc.11 `claude
 * context` answer's `file` is the QUESTION's file; each condition names its own `path`.
 *
 * @param node - A node that passed {@link isLegacyFinding}
 * @param ancestorPath - The nearest ancestor's named location
 * @returns The node's own `location`, else its own `path`/`file`, else `ancestorPath`
 */
function legacyLocation(node: Record<string, unknown>, ancestorPath: string | null): string | null {
  if (typeof node['location'] === 'string') return node['location'];
  return namedLocation(node) ?? ancestorPath;
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

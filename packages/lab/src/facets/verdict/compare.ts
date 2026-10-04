/**
 * Compare two arms' verdict captures, subject by subject, verb by verb, and
 * reconcile what moved against the committed deltas file — both ways.
 *
 * ## Two layers
 *
 * 1. **Verdict** — exit code plus the multiset of findings. Stays failable
 *    while wave-A reshapes every document, because it reads findings through
 *    the extractor rather than by document equality.
 * 2. **Document** — the normalized full stdout, string-compared, with a short
 *    diff excerpt for the render.
 *
 * ## What may be compared
 *
 * Exactly one axis may move, and it must be the instrument: a moved subject or
 * subject version is REFUSED (re-capture the baseline immediately before the
 * candidate). Two captures of one instrument are a control whether or not the
 * caller said so, so `movedAxes = []` without `--control` is refused, and two
 * arms that are indistinguishable (same instrument, same arm environment) are
 * refused without `--control` in the words `vat-lab <facet> ab` uses.
 *
 * ## Unmeasured rows
 *
 * A row is UNMEASURED when, in either arm, the verb did not run, exited 2, or
 * printed stdout the lab could not parse. Two unmeasured arms trivially agree,
 * so an unmeasured row is an observed delta of its own (see `deltas.ts`) and is
 * never reported as "no change". Its findings and document are not evidence;
 * its exit code and the refusal codes its document published still are, and
 * both are compared.
 *
 * ## Excluded verbs
 *
 * A subjects file may say a subject cannot complete a build verb. The verb runs
 * anyway, its row is compared like any other, and the exclusion accounts for
 * exactly one thing: the UNMEASURED delta of a row that, IN BOTH ARMS, exited 2
 * AND published a refusal the lab could read. A crash, a hang, a differing exit
 * code, a differing refusal code, or an exit 2 with empty or unparseable output
 * in either arm is observed as on any row, and must be declared in the
 * committed deltas file or it fails the compare — a control included.
 */

import { readdir } from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { type InstrumentVersion, movedAxes, sameInstrument } from '../../envelope/coordinate.js';
import type { ReportEnvelope } from '../../envelope/envelope.js';
import { sameArmEnvironment } from '../../harness/arm-env.js';
import { indistinguishableArms } from '../../harness/closure.js';
import { messageOf } from '../../harness/dumps.js';
import { compareByCodeUnit } from '../../harness/fingerprint.js';
import { instrumentLabel } from '../../harness/render.js';
import { readReport } from '../../store.js';

import {
  changelogRefusals,
  type DeclaredDelta,
  type ObservedDelta,
  reconcileDeltas,
  type VerdictDeltas,
} from './deltas.js';
import {
  FINDING_SEVERITIES,
  type FindingKey,
  findingIdentity,
  phaseSeverityCounts,
  publishedTallies,
  refusalCodes,
  rowVerdict,
  type SeverityCounts,
} from './extract.js';
import { multisetDifference } from './multiset.js';
import { VERDICT_FACET, type VerdictBody, VerdictBodySchema, type VerdictRow } from './types.js';
import type { Validated } from './yaml-file.js';

/** Longest diff excerpt a document delta carries, in lines. */
const EXCERPT_MAX_LINES = 80;

/** Exit code vat's own contract reserves for "could not do its job". */
const VAT_SYSTEM_ERROR_EXIT = 2;

/** What a compare is judged against. */
export interface VerdictCompareOptions {
  /** `--control`: both arms are the same instrument on purpose. */
  readonly control: boolean;
  readonly deltas: VerdictDeltas;
  /** Changelog file (as a deltas entry cites it) → its markdown text; see `changelogRefusals`. */
  readonly changelog: ReadonlyMap<string, string>;
}

/** One (alias, verb) row compared. */
export interface VerdictRowComparison {
  readonly subject: string;
  readonly verb: string;
  readonly baselineExit: number | null;
  readonly candidateExit: number | null;
  readonly observed: readonly ObservedDelta[];
}

/**
 * A verb the subjects file says one subject cannot complete, as both arms found
 * it. The verb ran in both; `detail` is what each arm did with it.
 */
export interface VerdictExcludedRow {
  readonly subject: string;
  readonly verb: string;
  /** The subjects file's reason the verb cannot be measured. */
  readonly reason: string;
  /** Per arm: its exit code and the refusal codes its document published. */
  readonly detail: readonly string[];
}

/** A completed comparison. */
export interface VerdictComparison {
  readonly ok: true;
  readonly baseline: InstrumentVersion;
  readonly candidate: InstrumentVersion;
  readonly control: boolean;
  readonly rows: readonly VerdictRowComparison[];
  /**
   * Excluded verbs that REFUSED AT EXIT 2 IN BOTH ARMS, as the subjects file said they
   * would. That is all an exclusion accounts for: the row's UNMEASURED delta.
   * The row is still in `rows`, and its exit code and refusal codes are still
   * compared and reconciled like any other row's. Never a pass.
   */
  readonly excluded: readonly VerdictExcludedRow[];
  /**
   * Excluded verbs BOTH arms measured: the exclusion excludes nothing. Fails the
   * compare, and no deltas entry can declare it — remove it from the subjects file.
   */
  readonly staleExclusions: readonly VerdictExcludedRow[];
  /** Observed and declared — accepted. */
  readonly accepted: readonly ObservedDelta[];
  readonly undeclared: readonly ObservedDelta[];
  readonly unused: readonly DeclaredDelta[];
  /** The deltas file could not be judged against this run. */
  readonly refusals: readonly string[];
  /** `ERROR` on any refusal, `FINDINGS` on any undeclared or unused delta, else `OK`. */
  readonly exitCode: number;
}

/** A comparison, or why the two captures cannot be compared at all. */
export type VerdictComparisonResult = VerdictComparison | { readonly ok: false; readonly refusal: string };


/**
 * Compare two arms' envelopes — see this module's docstring.
 *
 * @param baseline - The baseline arm's envelopes, one per alias
 * @param candidate - The candidate arm's envelopes, one per alias
 * @param options - Control flag, the deltas file, the changelog text
 * @returns The comparison, or a refusal
 */
export function compareVerdict(
  baseline: readonly ReportEnvelope<VerdictBody>[],
  candidate: readonly ReportEnvelope<VerdictBody>[],
  options: VerdictCompareOptions,
): VerdictComparisonResult {
  const mixed = mixedArmRefusal(baseline, 'baseline') ?? mixedArmRefusal(candidate, 'candidate');
  if (mixed !== null) return { ok: false, refusal: mixed };
  const pairs = pairByAlias(baseline, candidate);
  if (!pairs.ok) return pairs;
  const rows: VerdictRowComparison[] = [];
  const excluded: VerdictExcludedRow[] = [];
  const staleExclusions: VerdictExcludedRow[] = [];
  for (const [alias, [before, after]] of pairs.value) {
    const refusal = axisRefusal(before, after, options.control) ?? exclusionRefusal(alias, before.body, after.body);
    if (refusal !== null) return { ok: false, refusal };
    const reasons = new Map(before.body.excluded.map((exclusion) => [exclusion.name, exclusion.reason]));
    const compared = compareRows(alias, before.body, after.body, reasons);
    if (!compared.ok) return compared;
    rows.push(...compared.value.rows);
    excluded.push(...compared.value.held);
    staleExclusions.push(...compared.value.stale);
  }

  const [first] = pairs.value.values();
  /* c8 ignore next -- pairByAlias refuses an empty side; guards noUncheckedIndexedAccess */
  if (first === undefined) return { ok: false, refusal: 'REFUSED: nothing to compare.' };
  const observed = rows.flatMap((row) => row.observed);
  const reconciled = reconcileDeltas(observed, options.deltas, {
    baseline: first[0].coordinate.instrument.version,
    aliases: new Set(pairs.value.keys()),
    verbsByAlias: verbsByAlias(rows),
  });
  const refusals = [...reconciled.refusals, ...changelogRefusals(options.deltas, options.changelog)];
  const undeclared = new Set(reconciled.undeclared);
  return {
    ok: true,
    baseline: first[0].coordinate.instrument,
    candidate: first[1].coordinate.instrument,
    control: options.control,
    rows,
    excluded,
    staleExclusions,
    accepted: observed.filter((delta) => !undeclared.has(delta)),
    undeclared: reconciled.undeclared,
    unused: reconciled.unused,
    refusals,
    exitCode: exitCodeOf(refusals, [...reconciled.undeclared, ...reconciled.unused, ...staleExclusions]),
  };
}

/**
 * What an exclusion says of a row: vat REFUSED — it exited 2, its own "the
 * command could not do its job", and published a refusal the lab could read
 * (`refusalCodes`: a code, or an older build's sentence). Exit 2 alone is not
 * this: a command line the binary rejects exits 2 and prints nothing, and that
 * is a different failure. Nor is a crash, a hang, or any other exit code.
 *
 * @param row - One arm's row
 * @returns True iff the row is what an exclusion expects
 */
function refusedAtTwo(row: VerdictRow): boolean {
  return row.outcome === 'exited' && row.exitCode === VAT_SYSTEM_ERROR_EXIT && refusalCodes(row).length > 0;
}

/**
 * Judge one exclusion against what both arms did — see `subjects.ts`.
 *
 * - **held**: both arms refused at exit 2 ({@link refusedAtTwo}). The exclusion
 *   accounts for the row's UNMEASURED delta and nothing else ({@link rowDeltas}).
 * - **stale**: both arms measured the verb. The exclusion excludes nothing.
 * - **neither**: the arms disagree, or are unmeasured some other way. Nothing is
 *   accounted for; the row's deltas are observed exactly as on any other row.
 *
 * @param subject - The subject
 * @param exclusion - The excluded verb and the subjects file's reason
 * @param before - The baseline's row for it
 * @param after - The candidate's
 * @returns Which list the exclusion belongs on, with the row to list
 */
function judgeExclusion(
  subject: string,
  exclusion: { readonly verb: string; readonly reason: string },
  before: VerdictRow,
  after: VerdictRow,
): { readonly kind: 'held' | 'stale'; readonly row: VerdictExcludedRow } | null {
  const sides = [
    ['baseline', before],
    ['candidate', after],
  ] as const;
  const listed = (detail: string[]): VerdictExcludedRow => ({ subject, ...exclusion, detail });
  if (refusedAtTwo(before) && refusedAtTwo(after)) {
    const detail = sides.map(([side, row]) => `${side}: exit ${String(row.exitCode)}, refusal ${refusalCodes(row).join(', ')}`);
    return { kind: 'held', row: listed(detail) };
  }
  if (sides.every(([side, row]) => unmeasuredReasons(side, row).length === 0)) {
    return { kind: 'stale', row: listed(sides.map(([side, row]) => `${side} MEASURED it: exit ${String(row.exitCode)}`)) };
  }
  return null;
}

/**
 * One side of a compare is one arm: every envelope in it must carry the same
 * instrument. Otherwise the deltas file's `baseline` — read off that side —
 * would be judged against whichever alias happened to come first.
 *
 * @param envelopes - One side's envelopes
 * @param side - Which side, for the refusal
 * @returns A refusal naming the two instruments, or `null`
 */
function mixedArmRefusal(envelopes: readonly ReportEnvelope<VerdictBody>[], side: string): string | null {
  const [first] = envelopes;
  if (first === undefined) return null;
  const other = envelopes.find((envelope) => !sameInstrument(envelope.coordinate.instrument, first.coordinate.instrument));
  if (other === undefined) return null;
  return (
    `REFUSED: the ${side} mixes two arms — '${first.coordinate.subject.id}' ran ` +
    `${instrumentLabel(first.coordinate.instrument)}, '${other.coordinate.subject.id}' ran ` +
    `${instrumentLabel(other.coordinate.instrument)}. One directory per arm and capture.`
  );
}

/**
 * @param refusals - Deltas-file refusals
 * @param failures - Everything that fails a compare: undeclared deltas, unused declarations, stale exclusions
 * @returns The compare's exit code
 */
function exitCodeOf(refusals: readonly string[], failures: readonly unknown[]): number {
  if (refusals.length > 0) return ExitCode.ERROR;
  return failures.length > 0 ? ExitCode.FINDINGS : ExitCode.OK;
}

/**
 * @param rows - Every compared row
 * @returns Row names per alias, for validating deltas entries
 */
function verbsByAlias(rows: readonly VerdictRowComparison[]): Map<string, Set<string>> {
  const byAlias = new Map<string, Set<string>>();
  for (const row of rows) byAlias.set(row.subject, (byAlias.get(row.subject) ?? new Set()).add(row.verb));
  return byAlias;
}

/**
 * Pair the two sides' envelopes by alias, refusing anything unpaired.
 *
 * @param baseline - Baseline envelopes
 * @param candidate - Candidate envelopes
 * @returns Alias → [baseline, candidate], in baseline order, or a refusal
 */
function pairByAlias(
  baseline: readonly ReportEnvelope<VerdictBody>[],
  candidate: readonly ReportEnvelope<VerdictBody>[],
): Validated<Map<string, readonly [ReportEnvelope<VerdictBody>, ReportEnvelope<VerdictBody>]>> {
  const before = byAlias(baseline, 'baseline');
  if (!before.ok) return before;
  const after = byAlias(candidate, 'candidate');
  if (!after.ok) return after;
  const missing = [
    ...[...before.value.keys()].filter((alias) => !after.value.has(alias)).map((alias) => `'${alias}' (candidate)`),
    ...[...after.value.keys()].filter((alias) => !before.value.has(alias)).map((alias) => `'${alias}' (baseline)`),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: `REFUSED: subject ${missing.join(', ')} has no report on that side. Capture both arms from one subjects file.`,
    };
  }
  const pairs = new Map<string, readonly [ReportEnvelope<VerdictBody>, ReportEnvelope<VerdictBody>]>();
  for (const [alias, envelope] of before.value) {
    const other = after.value.get(alias);
    if (other !== undefined) pairs.set(alias, [envelope, other]);
  }
  return { ok: true, value: pairs };
}

/**
 * @param envelopes - One side's envelopes
 * @param side - Which side, for the refusal
 * @returns Alias → envelope, or a refusal on an empty side or a repeated alias
 */
function byAlias(
  envelopes: readonly ReportEnvelope<VerdictBody>[],
  side: string,
): Validated<Map<string, ReportEnvelope<VerdictBody>>> {
  if (envelopes.length === 0) return { ok: false, refusal: `REFUSED: the ${side} holds no verdict reports.` };
  const map = new Map<string, ReportEnvelope<VerdictBody>>();
  for (const envelope of envelopes) {
    const alias = envelope.coordinate.subject.id;
    if (map.has(alias)) {
      return {
        ok: false,
        refusal: `REFUSED: the ${side} holds two reports for subject '${alias}' — one directory per arm and capture.`,
      };
    }
    map.set(alias, envelope);
  }
  return { ok: true, value: map };
}

/**
 * Why this pair may not be compared along its axes, if it may not.
 *
 * @param before - The baseline envelope
 * @param after - The candidate envelope
 * @param control - Whether `--control` was passed
 * @returns A refusal, or `null`
 */
function axisRefusal(
  before: ReportEnvelope<VerdictBody>,
  after: ReportEnvelope<VerdictBody>,
  control: boolean,
): string | null {
  const alias = before.coordinate.subject.id;
  const moved = movedAxes(before.coordinate, after.coordinate);
  if (moved.includes('subject') || moved.includes('subjectVersion')) {
    return (
      `REFUSED: subject '${alias}' moved between the captures (movedAxes: ${moved.join(', ')}). A verdict ` +
      'delta must be the build, not the tree — re-capture the baseline immediately before the candidate.'
    );
  }
  const label = instrumentLabel(before.coordinate.instrument);
  if (control) return controlRefusal(before, after, label);
  if (indistinguishableArms(armOf(before), armOf(after))) {
    return (
      `REFUSED: the two arms are indistinguishable — same instrument (${label}) and same environment. ` +
      'Pass --control to measure the noise floor, or change one arm.'
    );
  }
  if (moved.length === 0) {
    return (
      `REFUSED: no axis moved — both captures ran one instrument (${label}), so this is a control ` +
      'whether or not it was meant as one. Pass --control, or capture a different build.'
    );
  }
  return null;
}

/**
 * @param before - The baseline envelope
 * @param after - The candidate envelope
 * @param label - The baseline instrument's label
 * @returns Why this is not a control, or `null`
 */
function controlRefusal(
  before: ReportEnvelope<VerdictBody>,
  after: ReportEnvelope<VerdictBody>,
  label: string,
): string | null {
  if (movedAxes(before.coordinate, after.coordinate).length > 0) {
    return (
      `REFUSED: --control compares one instrument with itself, but the candidate is ` +
      `${instrumentLabel(after.coordinate.instrument)}, not ${label}. Drop --control to compare two builds.`
    );
  }
  if (!sameArmEnvironment(before.body.arm, after.body.arm)) {
    return (
      'REFUSED: --control measures a difference that does not exist, so both arms must be configured ' +
      'identically — their --env/--unset differ. Make them match, or drop --control.'
    );
  }
  return null;
}

/**
 * @param envelope - One side
 * @returns Its arm identity
 */
function armOf(envelope: ReportEnvelope<VerdictBody>): Parameters<typeof indistinguishableArms>[0] {
  return { instrument: envelope.coordinate.instrument, env: envelope.body.arm };
}

/**
 * Both arms must exclude the same verbs for the same reasons: an exclusion is
 * the subjects file's, and two captures that disagree on it came from two files.
 *
 * @param alias - The subject
 * @param before - The baseline body
 * @param after - The candidate body
 * @returns A refusal, or `null`
 */
function exclusionRefusal(alias: string, before: VerdictBody, after: VerdictBody): string | null {
  const key = (body: VerdictBody): string =>
    body.excluded
      .map((exclusion) => JSON.stringify([exclusion.name, exclusion.reason]))
      .sort(compareByCodeUnit)
      .join('\n');
  if (key(before) === key(after)) return null;
  return (
    `REFUSED: subject '${alias}' excludes different verbs in the two captures ` +
    `(baseline: ${namesOf(before)}; candidate: ${namesOf(after)}). Capture both arms from one subjects file.`
  );
}

/**
 * @param body - One arm's body
 * @returns Its excluded verb names, or `none`
 */
function namesOf(body: VerdictBody): string {
  return body.excluded.length === 0 ? 'none' : body.excluded.map((exclusion) => exclusion.name).join(', ');
}

/** One subject's compared rows, and what became of each of its exclusions. */
interface SubjectComparison {
  readonly rows: VerdictRowComparison[];
  readonly held: VerdictExcludedRow[];
  readonly stale: VerdictExcludedRow[];
}

/**
 * Pair one subject's rows by name and diff each pair. An excluded verb's row is
 * a row like any other; its exclusion is judged beside it ({@link judgeExclusion}).
 *
 * @param alias - The subject
 * @param before - The baseline body
 * @param after - The candidate body
 * @param reasons - Excluded verb → the subjects file's reason (the same in both bodies)
 * @returns The compared rows and judged exclusions, or a refusal on a one-sided
 *   row or an exclusion that names no row
 */
function compareRows(
  alias: string,
  before: VerdictBody,
  after: VerdictBody,
  reasons: ReadonlyMap<string, string>,
): Validated<SubjectComparison> {
  const afterByName = new Map(after.rows.map((row) => [row.name, row]));
  const oneSided = [
    ...before.rows.filter((row) => !afterByName.has(row.name)),
    ...after.rows.filter((row) => !before.rows.some((other) => other.name === row.name)),
  ];
  if (oneSided.length > 0) {
    return {
      ok: false,
      refusal:
        `REFUSED: subject '${alias}' ran different verbs in the two captures ` +
        `(${oneSided.map((row) => row.name).join(', ')}). Capture both arms from one subjects file.`,
    };
  }
  const unrun = [...reasons.keys()].find((verb) => !afterByName.has(verb));
  if (unrun !== undefined) {
    return {
      ok: false,
      refusal:
        `REFUSED: subject '${alias}' excludes '${unrun}', and a capture holds no row for it. An excluded ` +
        'verb still runs in every arm; re-capture both arms with this lab build.',
    };
  }
  const comparison: SubjectComparison = { rows: [], held: [], stale: [] };
  for (const row of before.rows) {
    const other = afterByName.get(row.name) ?? row;
    const reason = reasons.get(row.name);
    comparison.rows.push({
      subject: alias,
      verb: row.name,
      baselineExit: row.exitCode,
      candidateExit: other.exitCode,
      observed: rowDeltas(alias, row, other, reason !== undefined),
    });
    const judged = reason === undefined ? null : judgeExclusion(alias, { verb: row.name, reason }, row, other);
    if (judged !== null) comparison[judged.kind].push(judged.row);
  }
  return { ok: true, value: comparison };
}

/**
 * The deltas one row shows, both layers.
 *
 * An unmeasured row has no findings and no document worth comparing, but two
 * things about it are still data and are compared on every row, excluded or
 * not: its exit code, and the refusal codes its document published.
 *
 * @param alias - The subject
 * @param before - The baseline row
 * @param after - The candidate row
 * @param excluded - Whether the subjects file excludes this verb for the subject
 * @returns Every observed delta on the row
 */
function rowDeltas(alias: string, before: VerdictRow, after: VerdictRow, excluded: boolean): ObservedDelta[] {
  const at = { subject: alias, verb: before.name };
  const deltas: ObservedDelta[] = [];
  if (before.exitCode !== null && after.exitCode !== null && before.exitCode !== after.exitCode) {
    deltas.push({ ...at, change: { kind: 'exit', from: before.exitCode, to: after.exitCode }, detail: [] });
  }
  const unmeasured = [...unmeasuredReasons('baseline', before), ...unmeasuredReasons('candidate', after)];
  if (unmeasured.length > 0) {
    const from = refusalCodes(before);
    const to = refusalCodes(after);
    if (JSON.stringify(from) !== JSON.stringify(to)) deltas.push({ ...at, change: { kind: 'refusal', from, to }, detail: [] });
    // The ONE thing an exclusion accounts for: a row that refused at exit 2 in both arms.
    if (excluded && refusedAtTwo(before) && refusedAtTwo(after)) return deltas;
    const broken = excluded
      ? ['the subjects file excludes this verb as refusing at exit 2 in every arm — that is not what happened']
      : [];
    return [...deltas, { ...at, change: { kind: 'unmeasured' }, detail: [...unmeasured, ...broken] }];
  }
  const { onlyLeft: removed, onlyRight: added } = multisetDifference(
    rowVerdict(before)?.findings ?? [],
    rowVerdict(after)?.findings ?? [],
    (finding) => JSON.stringify(findingIdentity(finding)),
  );
  const itemized = itemizedTallies(before, after, added, removed);
  if (itemized !== null) deltas.push({ ...at, change: { kind: 'findings-itemized' }, detail: itemized.detail });
  deltas.push(
    ...(itemized?.rest ?? added).map((finding): ObservedDelta => ({ ...at, change: { kind: 'finding-added', finding }, detail: [] })),
    ...removed.map((finding): ObservedDelta => ({ ...at, change: { kind: 'finding-removed', finding }, detail: [] })),
  );
  if (before.document !== after.document) {
    deltas.push({ ...at, change: { kind: 'document' }, detail: diffExcerpt(before.document, after.document) });
  }
  return deltas;
}

/**
 * Whether some of a row's added findings are exactly the baseline's tallies
 * being itemized (see `findings-itemized` in `deltas.ts`).
 *
 * It is, only when ALL of these hold — and then exactly the added findings
 * whose code the baseline tallied are covered, and nothing else is:
 *
 * - the baseline tallied something and the candidate tallies nothing;
 * - no finding with a tallied code was REMOVED (the baseline's own itemized
 *   findings are compared by identity, as on any row);
 * - per code, the candidate adds exactly as many findings as the baseline tallied;
 * - per severity, likewise — a severity that moved in aggregate breaks this one;
 * - every PHASE that tallied publishes the same severity counts in both arms —
 *   a finding that moved to another phase keeps its code and severity, and
 *   only this margin sees it.
 *
 * One tallied finding gained, lost, re-coded, re-graded or moved between phases
 * breaks an equality, and then every added finding is observed one by one. A
 * finding whose code the baseline never tallied is ALWAYS observed one by one,
 * covered or not — a new code is not an itemization.
 *
 * What a match does NOT establish, because the baseline did not publish it in a
 * form the candidate's flat `findings[]` can be checked against: the count per
 * (code, severity) pair — the baseline published the two margins — and which
 * skill or file each finding belongs to. A tally's owner names one (`file`,
 * `location`, `skillName`), but the candidate merges every phase into one list
 * with no owner, so an owner-by-owner match is not defined.
 *
 * @param before - The baseline row
 * @param after - The candidate row
 * @param added - Findings only the candidate has
 * @param removed - Findings only the baseline has
 * @returns The evidence lines and the added findings NOT covered, or `null` when nothing is
 */
function itemizedTallies(
  before: VerdictRow,
  after: VerdictRow,
  added: readonly FindingKey[],
  removed: readonly FindingKey[],
): { readonly detail: string[]; readonly rest: FindingKey[] } | null {
  const tallied = publishedTallies(before);
  if (tallied === null || tallied.total === 0 || publishedTallies(after)?.total !== 0) return null;
  if (removed.some((finding) => tallied.byCode.has(finding.code))) return null;
  const covered = added.filter((finding) => tallied.byCode.has(finding.code));
  const sameCodes = sameCounts(countBy(covered, (finding) => finding.code), tallied.byCode);
  const severities = new Map(Object.entries(tallied.bySeverity).filter(([, count]) => count > 0));
  if (!sameCodes || !sameCounts(countBy(covered, (finding) => finding.severity), severities)) return null;
  if (!samePhaseCounts(tallied.phases, phaseSeverityCounts(before), phaseSeverityCounts(after))) return null;
  const { error, warning, info } = tallied.bySeverity;
  return {
    detail: [
      `baseline published ${String(tallied.total)} finding(s) only as tallies — ${String(tallied.byCode.size)} code(s); ` +
        `${String(error)} error(s), ${String(warning)} warning(s), ${String(info)} info — and the candidate itemizes ` +
        'exactly those: the same count for every code and every severity, none removed, and the same severity ' +
        `counts in each of the ${String(tallied.phases.length)} phase(s) that tallied`,
    ],
    rest: added.filter((finding) => !tallied.byCode.has(finding.code)),
  };
}

/**
 * @param phases - The phases the baseline tallied in, by name
 * @param before - Phase → severity counts, as the baseline published them
 * @param after - The same, for the candidate
 * @returns Whether each of those phases publishes counts in BOTH arms, and the same ones
 */
function samePhaseCounts(
  phases: readonly string[],
  before: ReadonlyMap<string, SeverityCounts>,
  after: ReadonlyMap<string, SeverityCounts>,
): boolean {
  return phases.every((phase) => {
    const baseline = before.get(phase);
    const candidate = after.get(phase);
    // A phase that tallied and publishes no counts cannot be checked — not a match.
    if (baseline === undefined || candidate === undefined) return false;
    return FINDING_SEVERITIES.every((severity) => baseline[severity] === candidate[severity]);
  });
}

/**
 * @param items - Anything
 * @param keyOf - What to count by
 * @returns Key → how many items carry it
 */
function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return counts;
}

/**
 * @param a - Counts by key
 * @param b - Counts by key
 * @returns Whether both name the same keys with the same counts
 */
function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([code, count]) => b.get(code) === count);
}

/**
 * @param side - Which arm, for the reason text
 * @param row - That arm's row
 * @returns Why the row measured nothing on this side — empty when it measured
 */
function unmeasuredReasons(side: string, row: VerdictRow): string[] {
  if (row.outcome === 'not-run') return [`${side} did not run: ${row.spawnError ?? 'no exit code'}`];
  if (row.exitCode === VAT_SYSTEM_ERROR_EXIT) return [`${side} exited 2 (the command could not do its job)`];
  if (rowVerdict(row)?.shape === 'unparsed') return [`${side} printed stdout the lab could not parse`];
  return [];
}

/**
 * A unified-style excerpt of where two documents differ: the common prefix and
 * suffix trimmed, the differing middle shown as `-`/`+` lines, capped at
 * {@link EXCERPT_MAX_LINES}. An excerpt, not a minimal diff — enough to read
 * what moved without printing a 1.8 MB document.
 *
 * @param before - Baseline document
 * @param after - Candidate document
 * @returns The excerpt's lines
 */
export function diffExcerpt(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) {
    suffix += 1;
  }
  const lines = [
    `@@ line ${String(prefix + 1)} @@`,
    ...a.slice(prefix, a.length - suffix).map((line) => `-${line}`),
    ...b.slice(prefix, b.length - suffix).map((line) => `+${line}`),
  ];
  if (lines.length <= EXCERPT_MAX_LINES) return lines;
  return [...lines.slice(0, EXCERPT_MAX_LINES - 1), `… ${String(lines.length - EXCERPT_MAX_LINES + 1)} more lines`];
}

/**
 * Read every verdict envelope in a capture directory.
 *
 * @param dir - A `vat-lab verdict run --out` directory
 * @returns Its envelopes, or a refusal on anything unreadable or not a verdict report
 */
export async function readVerdictDirectory(dir: string): Promise<Validated<ReportEnvelope<VerdictBody>[]>> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort(compareByCodeUnit);
  } catch (error) {
    return { ok: false, refusal: `REFUSED: cannot read '${dir}': ${messageOf(error)}` };
  }
  const envelopes: ReportEnvelope<VerdictBody>[] = [];
  for (const name of names) {
    const file = safePath.join(dir, name);
    const read = await readReport(file);
    if (!read.ok) return read;
    if (read.envelope.facet !== VERDICT_FACET) {
      return { ok: false, refusal: `REFUSED: '${file}' is a '${read.envelope.facet}' report, not a verdict report.` };
    }
    const body = VerdictBodySchema.safeParse(read.envelope.body);
    if (!body.success) {
      return { ok: false, refusal: `REFUSED: '${file}' has a malformed verdict body: ${body.error.issues[0]?.message ?? ''}` };
    }
    envelopes.push({ ...read.envelope, body: body.data });
  }
  return { ok: true, value: envelopes };
}

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
 * never reported as "no change".
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
import { findingIdentity } from './extract.js';
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

/** A completed comparison. */
export interface VerdictComparison {
  readonly ok: true;
  readonly baseline: InstrumentVersion;
  readonly candidate: InstrumentVersion;
  readonly control: boolean;
  readonly rows: readonly VerdictRowComparison[];
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
  for (const [alias, [before, after]] of pairs.value) {
    const refusal = axisRefusal(before, after, options.control);
    if (refusal !== null) return { ok: false, refusal };
    const compared = compareRows(alias, before.body.rows, after.body.rows);
    if (!compared.ok) return compared;
    rows.push(...compared.value);
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
    accepted: observed.filter((delta) => !undeclared.has(delta)),
    undeclared: reconciled.undeclared,
    unused: reconciled.unused,
    refusals,
    exitCode: exitCodeOf(refusals, reconciled.undeclared, reconciled.unused),
  };
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
 * @param undeclared - Observed, undeclared
 * @param unused - Declared, not observed
 * @returns The compare's exit code
 */
function exitCodeOf(refusals: readonly string[], undeclared: readonly unknown[], unused: readonly unknown[]): number {
  if (refusals.length > 0) return ExitCode.ERROR;
  return undeclared.length > 0 || unused.length > 0 ? ExitCode.FINDINGS : ExitCode.OK;
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
 * Pair one subject's rows by name and diff each pair.
 *
 * @param alias - The subject
 * @param before - Baseline rows
 * @param after - Candidate rows
 * @returns One comparison per row, or a refusal on a one-sided row
 */
function compareRows(alias: string, before: readonly VerdictRow[], after: readonly VerdictRow[]): Validated<VerdictRowComparison[]> {
  const afterByName = new Map(after.map((row) => [row.name, row]));
  const oneSided = [
    ...before.filter((row) => !afterByName.has(row.name)),
    ...after.filter((row) => !before.some((other) => other.name === row.name)),
  ];
  if (oneSided.length > 0) {
    return {
      ok: false,
      refusal:
        `REFUSED: subject '${alias}' ran different verbs in the two captures ` +
        `(${oneSided.map((row) => row.name).join(', ')}). Capture both arms from one subjects file.`,
    };
  }
  return {
    ok: true,
    value: before.map((row) => {
      const other = afterByName.get(row.name) ?? row;
      return {
        subject: alias,
        verb: row.name,
        baselineExit: row.exitCode,
        candidateExit: other.exitCode,
        observed: rowDeltas(alias, row, other),
      };
    }),
  };
}

/**
 * The deltas one row shows, both layers.
 *
 * @param alias - The subject
 * @param before - The baseline row
 * @param after - The candidate row
 * @returns Every observed delta on the row
 */
function rowDeltas(alias: string, before: VerdictRow, after: VerdictRow): ObservedDelta[] {
  const at = { subject: alias, verb: before.name };
  const deltas: ObservedDelta[] = [];
  if (before.exitCode !== null && after.exitCode !== null && before.exitCode !== after.exitCode) {
    deltas.push({ ...at, change: { kind: 'exit', from: before.exitCode, to: after.exitCode }, detail: [] });
  }
  const unmeasured = [...unmeasuredReasons('baseline', before), ...unmeasuredReasons('candidate', after)];
  if (unmeasured.length > 0) {
    // Findings and documents of an unmeasured row are not evidence of anything;
    // the exit move above still is, because the exit code is data.
    return [...deltas, { ...at, change: { kind: 'unmeasured' }, detail: unmeasured }];
  }
  const { onlyLeft: removed, onlyRight: added } = multisetDifference(
    before.verdict?.findings ?? [],
    after.verdict?.findings ?? [],
    (finding) => JSON.stringify(findingIdentity(finding)),
  );
  deltas.push(
    ...added.map((finding): ObservedDelta => ({ ...at, change: { kind: 'finding-added', finding }, detail: [] })),
    ...removed.map((finding): ObservedDelta => ({ ...at, change: { kind: 'finding-removed', finding }, detail: [] })),
  );
  if (before.document !== after.document) {
    deltas.push({ ...at, change: { kind: 'document' }, detail: diffExcerpt(before.document, after.document) });
  }
  return deltas;
}

/**
 * @param side - Which arm, for the reason text
 * @param row - That arm's row
 * @returns Why the row measured nothing on this side — empty when it measured
 */
function unmeasuredReasons(side: string, row: VerdictRow): string[] {
  if (row.outcome === 'not-run') return [`${side} did not run: ${row.spawnError ?? 'no exit code'}`];
  if (row.exitCode === VAT_SYSTEM_ERROR_EXIT) return [`${side} exited 2 (the command could not do its job)`];
  if (row.verdict?.shape === 'unparsed') return [`${side} printed stdout the lab could not parse`];
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

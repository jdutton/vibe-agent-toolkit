/**
 * Comparing two `io` reports.
 *
 * Two gates run before any number is subtracted, and both can refuse:
 *
 * 1. **Schema** — same facet, same body version. Differences across a schema
 *    change belong to the schema, not to the subject.
 * 2. **Coordinate** — at most one axis moved. A delta across two simultaneous
 *    changes cannot be attributed to either of them.
 *
 * ## Exact equality, and why there is no tolerance knob
 *
 * `perf` needs significance thresholds because wall time is a continuous, noisy
 * observable that always varies. Call counts are not. Measured on `vat resources
 * scan docs/`: **436 user calls and 6,371 loader calls on three consecutive warm
 * runs**, and **568 user calls and 6,371 loader calls on three consecutive cold
 * runs** — the same integers every time.
 *
 * So the comparator uses exact equality, and that makes it a *sharper*
 * instrument than any tolerance gate: a delta of one call is real. There is
 * deliberately no `below-resolution` verdict here (nothing is below the
 * resolution of counting) and deliberately no tolerance option ported over from
 * `perf` "for symmetry". A threshold on a deterministic observable does not
 * suppress noise, because there is none; it only suppresses findings.
 *
 * ## What exact equality needs in return: a warrant
 *
 * Determinism is a property of the measured code, not a promise this package can
 * make on its behalf. {@link IoCommandStats.stable} is the row's own answer to
 * "did my repeats agree with each other?", and it has three states, only one of
 * which entitles anyone to subtract:
 *
 * - **`true`** — the compared repeats produced identical buckets. Subtract.
 * - **`false`** — they disagreed. Something in this command's I/O is not
 *   deterministic (a timestamped path, a directory order, a race), so a
 *   difference against another report may belong to the run rather than to the
 *   change. The numbers are still real; the entitlement to read a difference as
 *   a change is what is missing.
 * - **`null`** — fewer than two repeats were compared, so nothing *could* have
 *   disagreed. Determinism was never tested. Reading this as `true` is the exact
 *   mistake the field's nullability exists to prevent.
 *
 * Both non-`true` states therefore produce {@link IoCommandVerdict} `unwarranted`
 * rather than `changed` or `unchanged` — **including when the two sides happen to
 * match**, because a matching draw from a distribution known to move is not
 * evidence of stability, and rendering it green would be the most reassuring
 * possible way to be wrong. `unwarranted` is kept apart from `unmeasurable` on
 * purpose: "we could not measure this" and "we measured it, but this difference
 * cannot be attributed" are different facts, and the row's numbers survive on the
 * verdict either way so a reader can still see what moved.
 *
 * ## What may and may not be subtracted
 *
 * `count`, `userCalls`, `loaderCalls` and `processes` are plain sums and subtract
 * exactly. {@link IoSite.distinctArgs} does not: merged across processes it is an
 * UPPER BOUND (two processes reading one file each count it), and when
 * `argsCapped` is set it is instead a FLOOR (the counter stopped tracking). A
 * bound minus a floor, or a floor minus a floor, is a number with no direction,
 * and reporting it as an N+1 appearing or disappearing would be a fabricated
 * finding. And where the field is `null` there is no reading at all — a spawn, a
 * two-path `fs` call — so the only honest subtraction is none: treating that as a
 * zero would turn "we did not look" into "we looked and found nothing". So the
 * delta is withheld — and *counted*, with every distinct reason named, so the
 * renderer can say how many sites went unchecked and why instead of implying they
 * were clean.
 */

import {
  type Axis,
  type Coordinate,
  decideComparison,
  type DecideComparisonOptions,
} from '../../envelope/coordinate.js';
import { refuseIncomparableSchemas, type ReportEnvelope } from '../../envelope/envelope.js';
import { bothSides, pairByKey, type Pairing } from '../../harness/diff.js';

import {
  IO_FACET,
  IO_FACET_VERSION,
  type IoBody,
  IoBodySchema,
  type IoCommandStats,
  type IoSite,
} from './types.js';

/** A before/after pair of counts with the difference already taken. */
export interface IoCountDelta {
  readonly before: number;
  readonly after: number;
  /** `after - before`. Exact — counts are deterministic, so any non-zero is real. */
  readonly delta: number;
}

/** The three aggregates every command row carries. */
export interface IoTotalsDelta {
  /** Calls attributed to vat's own code and its dependencies. */
  readonly userCalls: IoCountDelta;
  /**
   * Calls attributed to Node's own ESM module loader.
   *
   * Diffed like any other total, and never dropped: it is 6,371 of 6,411 on a
   * real run, so a comparison that omitted it would call a report "unchanged"
   * while 99% of its calls went unexamined.
   */
  readonly loaderCalls: IoCountDelta;
  /**
   * How many processes produced a dump.
   *
   * A movement here is rarely about the subject — it usually means the counter
   * stopped propagating, and every other number on the side that dropped is then
   * describing vat's launcher alone.
   */
  readonly processes: IoCountDelta;
}

/** Whether a site is new, gone, or present on both sides. */
export type IoSiteMovementKind = 'added' | 'removed' | 'changed';

/** What happened at one call site between two reports. */
export interface IoSiteMovement {
  /** The Node API called — `fs.readFile`, `child_process.spawnSync`. Not a syscall name. */
  readonly method: string;
  /** The normalized call site. */
  readonly site: string;
  readonly kind: IoSiteMovementKind;
  /** Exact: a missing side contributes zero, which is what "no calls from here" means. */
  readonly count: IoCountDelta;
  /**
   * Movement in distinct first arguments, or `null` when it could not be read.
   *
   * See {@link IoMovement.distinctArgsCaveat} for the two reasons it is withheld.
   */
  readonly distinctArgs: IoCountDelta | null;
}

/** Everything that moved for one command, whatever verdict was drawn from it. */
export interface IoMovement {
  readonly totals: IoTotalsDelta;
  /** Only the sites that actually moved; a site identical on both sides is absent. */
  readonly sites: readonly IoSiteMovement[];
  /**
   * How many sites had a `distinctArgs` comparison that could not be read.
   *
   * Reported rather than silently skipped. A comparison that quietly dropped the
   * N+1 half of its job would look exactly like one that found nothing.
   */
  readonly unreadableDistinctArgs: number;
  /** Why they could not be read, or `null` when every site was readable. */
  readonly distinctArgsCaveat: string | null;
}

/** What happened to one command between two reports. */
export type IoCommandVerdict =
  | { readonly kind: 'changed'; readonly movement: IoMovement }
  | { readonly kind: 'unchanged'; readonly movement: IoMovement }
  | {
      /**
       * A difference may exist, but this row is not entitled to call it a change.
       *
       * Raised when either side reported `stable: false` (its own repeats
       * disagreed) or `stable: null` (fewer than two repeats, so determinism was
       * never tested). Kept apart from `unmeasurable`: there IS a measurement
       * here, and {@link IoMovement} carries it, but an exact-equality delta off
       * a row whose determinism is unproven has no warrant behind it.
       */
      readonly kind: 'unwarranted';
      readonly reason: string;
      readonly movement: IoMovement;
    }
  | {
      /**
       * One or both sides did not produce a usable measurement.
       *
       * Kept as its own verdict rather than folded into `unchanged`: "we could
       * not measure this" and "this did not move" are different facts, and a
       * report that renders them identically hides broken commands behind a
       * reassuring green.
       */
      readonly kind: 'unmeasurable';
      readonly reason: string;
    }
  | { readonly kind: 'added' }
  | { readonly kind: 'removed' };

/** One command's row in a comparison. */
export interface IoCommandDiff {
  readonly name: string;
  readonly verdict: IoCommandVerdict;
  /** The baseline row, absent when the command is new. */
  readonly before: IoCommandStats | null;
  /** The compared row, absent when the command was dropped. */
  readonly after: IoCommandStats | null;
}

/** A refusal to compare at all. */
export interface IoComparisonRefused {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/** A completed comparison. */
export interface IoComparisonResult {
  readonly ok: true;
  /** Which axis varies, or `null` when the two reports share a coordinate. */
  readonly axis: Axis | null;
  readonly commands: readonly IoCommandDiff[];
  /**
   * True when either side was measured on a contaminated machine.
   *
   * Call counts do not move with machine load, so this does not invalidate a
   * delta the way it does in `perf`. It is carried because it is evidence about
   * the *run*: a capture fighting for CPU may also have been fighting for the
   * filesystem, and a reader holding this next to a `perf` report from the same
   * session needs the same tell on both.
   */
  readonly contaminated: boolean;
}

/** The outcome of comparing two io reports. */
export type IoComparison = IoComparisonResult | IoComparisonRefused;

/** Options for {@link compareIo}. */
export interface CompareIoOptions extends DecideComparisonOptions {}

/** Why a `distinctArgs` subtraction was withheld because the counter gave up tracking. */
const CAPPED_CAVEAT =
  'at least one side capped its argument tracking at this site, so its distinctArgs is a floor ' +
  'rather than an exact count — subtracting it would report an N+1 that may not exist';

/**
 * Why a `distinctArgs` subtraction was withheld because no reading exists.
 *
 * The counter keeps no distinct set where argument 0 is not the work — every
 * `child_process` method, the two-path `fs` operations, `mkdtemp`. There is
 * nothing to subtract, and a `null ?? 0` here would manufacture a delta out of
 * two absences.
 */
const NO_READING_CAVEAT =
  'at least one side took no distinct-argument reading at this site, because the first argument ' +
  'of that call does not identify the work (a spawn names the binary, a copy or rename names only ' +
  'its source) — there is nothing to subtract';

/**
 * Read an envelope's body as an `io` body.
 *
 * @param envelope - A report whose header already says it is `io`
 * @param side - Which side of the comparison this is, for the message
 * @returns The validated body, or a refusal string
 */
function readIoBody(
  envelope: ReportEnvelope<unknown>,
  side: string,
): { body: IoBody } | { refusal: string } {
  // Checked against THIS BUILD, not only between the two sides. The envelope's
  // gate asks whether the reports agree with each other, and two reports
  // captured before a schema move agree perfectly — while every row in them
  // means what the older build meant. A pair of pre-nullable reports would put
  // `distinctArgs: 1` on every spawn row and this build would render it as a
  // redundancy ratio. Same rule the dump reader applies to `dumpVersion`.
  if (envelope.facetVersion !== IO_FACET_VERSION) {
    return {
      refusal:
        `REFUSED: the ${side} report is an '${IO_FACET}' body at facetVersion ` +
        `${String(envelope.facetVersion)}, and this build reads ` +
        `${String(IO_FACET_VERSION)}. Re-capture it; reading rows whose meaning has moved ` +
        'would produce numbers nobody can state.',
    };
  }

  const parsed = IoBodySchema.safeParse(envelope.body);
  if (parsed.success) return { body: parsed.data as IoBody };
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return {
    refusal:
      `REFUSED: the ${side} report's header claims facet '${IO_FACET}', but its body is not an ` +
      `'${IO_FACET}' body and re-capturing that side is the only fix — ${problems}`,
  };
}

/**
 * Take one difference.
 *
 * @param before - The baseline value
 * @param after - The compared value
 * @returns Both sides and the signed difference
 */
function difference(before: number, after: number): IoCountDelta {
  return { before, after, delta: after - before };
}

/**
 * What one side's failure costs the comparison, or `null` when it did not fail.
 *
 * @param row - That side's row
 * @param side - How to name it in the reason
 * @returns A clause, or `null`
 */
function failureCaveat(row: IoCommandStats, side: string): string | null {
  return row.failed ? `the ${side} row failed: ${row.failure ?? 'unknown'}` : null;
}

/**
 * Why a pair of rows yields no measurement at all, or `null` when it does.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns A reason, or `null`
 */
function unmeasurableReason(before: IoCommandStats, after: IoCommandStats): string | null {
  const failures = bothSides(before, after, failureCaveat);
  if (failures !== null) return failures;
  if (before.cache !== after.cache) {
    // A warm run and a cold run are not two measurements of one thing: the same
    // command records 436 user calls warm and 568 cold, and that 132-call gap is
    // the cache mode rather than anything about the subject.
    return `cache mode differs (${before.cache} vs ${after.cache})`;
  }
  return null;
}

/**
 * What one side's `stable` flag costs the comparison, or `null` when nothing.
 *
 * @param row - That side's row
 * @param side - How to name it in the reason
 * @returns A clause for the refusal reason, or `null`
 */
function stabilityCaveat(row: IoCommandStats, side: string): string | null {
  if (row.stable === false) return `the ${side} row's own repeats disagreed with each other`;
  if (row.stable === null) {
    return (
      `the ${side} row's determinism was never tested ` +
      `(${String(row.comparedRuns)} compared repeats, so nothing could disagree)`
    );
  }
  return null;
}

/**
 * Why an exact delta between these two rows has no warrant, or `null` when it has.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns A reason naming every side at fault, or `null`
 */
function unwarrantedReason(before: IoCommandStats, after: IoCommandStats): string | null {
  return bothSides(before, after, stabilityCaveat);
}

/**
 * The identity a site is paired on across two reports.
 *
 * Length-prefixed rather than delimiter-joined, for the reason the dump reader
 * gives: a method name is arbitrary and a path may contain any character a
 * filesystem allows, so any printable separator could be produced by the data
 * itself and silently pair two different sites.
 *
 * @param site - The site row
 * @returns A key equal for two rows exactly when both parts are
 */
function siteKey(site: IoSite): string {
  return `${String(site.method.length)}:${site.method}:${site.site}`;
}

/** A site pairing, described whether or not it moved. */
interface DescribedSite extends IoSiteMovement {
  /** True when this row belongs in the reported movement. */
  readonly moved: boolean;
  /**
   * Why this site's `distinctArgs` could not be subtracted, or `null`.
   *
   * Carried per site rather than decided once per command: a command can have
   * one site with no reading and another that capped, and a caveat naming only
   * the first sends a reader looking for the wrong thing at the second.
   */
  readonly withheld: string | null;
}

/**
 * Is this site new, gone, or present on both sides?
 *
 * @param pair - The site as it appears on each side
 * @returns Which of the three it is
 */
function siteKindOf(pair: Pairing<IoSite>): IoSiteMovementKind {
  if (pair.before === null) return 'added';
  if (pair.after === null) return 'removed';
  return 'changed';
}

/**
 * One side's distinct-argument reading, with an absent side contributing zero.
 *
 * Only ever reached once {@link withholdingReason} has ruled out a `null`
 * reading, so the zero here means "this site made no calls on that side" and
 * never "no reading was taken".
 *
 * @param site - The site as it appears on one side, or `null` when absent
 * @returns The reading
 */
function readingOf(site: IoSite | null): number {
  return site?.distinctArgs ?? 0;
}

/**
 * Why this site's `distinctArgs` may not be subtracted, or `null` when it may.
 *
 * Ordered most-structural first: an absent reading is a property of the method
 * itself and will never become readable, where a cap is a property of the run.
 *
 * @param pair - The site as it appears on each side
 * @param blocked - A command-wide reason, or `null`
 * @returns The reason, or `null`
 */
function withholdingReason(pair: Pairing<IoSite>, blocked: string | null): string | null {
  if (pair.before?.distinctArgs === null || pair.after?.distinctArgs === null) {
    return NO_READING_CAVEAT;
  }
  if ((pair.before?.argsCapped ?? false) || (pair.after?.argsCapped ?? false)) {
    return CAPPED_CAVEAT;
  }
  return blocked;
}

/**
 * Describe one site pairing.
 *
 * @param pair - The site as it appears on each side
 * @param blocked - A command-wide reason `distinctArgs` cannot be subtracted, or `null`
 * @returns The described movement, flagged with whether it actually moved
 * @throws When neither side is present, which the pairing cannot produce
 */
function describeSite(pair: Pairing<IoSite>, blocked: string | null): DescribedSite {
  const identity = pair.after ?? pair.before;
  if (identity === null) throw new Error(`site pairing ${pair.key} has no side`);
  const count = difference(pair.before?.count ?? 0, pair.after?.count ?? 0);
  const withheld = withholdingReason(pair, blocked);
  const distinctArgs =
    withheld === null ? difference(readingOf(pair.before), readingOf(pair.after)) : null;
  const present = pair.before !== null && pair.after !== null;
  return {
    method: identity.method,
    site: identity.site,
    kind: siteKindOf(pair),
    count,
    distinctArgs,
    withheld,
    moved: !present || count.delta !== 0 || (distinctArgs?.delta ?? 0) !== 0,
  };
}

/**
 * Everything that moved between two rows of one command.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The totals, the moved sites, and what could not be compared
 */
function buildMovement(before: IoCommandStats, after: IoCommandStats): IoMovement {
  // A different number of merged processes inflates distinctArgs differently on
  // the two sides, so the difference may be entirely the merge. The count totals
  // are unaffected: those are plain sums however many processes contributed.
  const blocked =
    before.processes === after.processes
      ? null
      : `the two sides merged a different number of processes ` +
        `(${String(before.processes)} vs ${String(after.processes)}), and distinctArgs is summed ` +
        'per process, so the difference may be the merge rather than the subject';

  const described = pairByKey(before.sites, after.sites, siteKey).map((pair) =>
    describeSite(pair, blocked),
  );
  const unreadable = described.filter((site) => site.withheld !== null);
  // Every distinct reason, not the first one found: the sites can be unreadable
  // for different reasons, and a caveat that named one of them would send a
  // reader to check the wrong thing at the others.
  const reasons = [...new Set(unreadable.map((site) => site.withheld))];

  return {
    totals: {
      userCalls: difference(before.userCalls, after.userCalls),
      loaderCalls: difference(before.loaderCalls, after.loaderCalls),
      processes: difference(before.processes, after.processes),
    },
    sites: described.filter((site) => site.moved),
    unreadableDistinctArgs: unreadable.length,
    distinctArgsCaveat: reasons.length === 0 ? null : reasons.join('; and '),
  };
}

/**
 * Did anything at all move?
 *
 * Site movement is checked as well as the totals, because work migrating between
 * two sites leaves `userCalls` untouched — and a comparator that only subtracted
 * the totals would call a rewritten hot path unchanged.
 *
 * @param movement - The movement for one command
 * @returns `true` when any total or any site moved
 */
function movedAtAll(movement: IoMovement): boolean {
  const { userCalls, loaderCalls, processes } = movement.totals;
  return (
    userCalls.delta !== 0 ||
    loaderCalls.delta !== 0 ||
    processes.delta !== 0 ||
    movement.sites.length > 0
  );
}

/**
 * Diff one command that appears on both sides.
 *
 * The order is deliberate: no measurement outranks no warrant, which outranks
 * any reading of the numbers themselves.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The verdict for this command
 */
function verdictFor(before: IoCommandStats, after: IoCommandStats): IoCommandVerdict {
  const unmeasurable = unmeasurableReason(before, after);
  if (unmeasurable !== null) return { kind: 'unmeasurable', reason: unmeasurable };

  const movement = buildMovement(before, after);
  const unwarranted = unwarrantedReason(before, after);
  if (unwarranted !== null) return { kind: 'unwarranted', reason: unwarranted, movement };

  return movedAtAll(movement) ? { kind: 'changed', movement } : { kind: 'unchanged', movement };
}

/**
 * Turn one command pairing into its diff row.
 *
 * @param pair - The command as it appears on each side
 * @returns The row, including the one-sided cases
 */
function diffCommand(pair: Pairing<IoCommandStats>): IoCommandDiff {
  const { before, after } = pair;
  if (before === null && after !== null) {
    return { name: after.name, verdict: { kind: 'added' }, before: null, after };
  }
  if (before !== null && after === null) {
    return { name: before.name, verdict: { kind: 'removed' }, before, after: null };
  }
  if (before === null || after === null) {
    // Unreachable: a pairing key came from one of the two sides.
    return {
      name: pair.key,
      verdict: { kind: 'unmeasurable', reason: 'row missing on both sides' },
      before,
      after,
    };
  }
  return { name: before.name, verdict: verdictFor(before, after), before, after };
}

/**
 * Compare two `io` reports.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param options - Axis options; there is deliberately no tolerance option
 * @returns A comparison, or a refusal explaining why the two cannot be compared
 */
export function compareIo(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  options: CompareIoOptions = {},
): IoComparison {
  const schemaRefusal = refuseIncomparableSchemas(before, after);
  if (schemaRefusal !== null) return { ok: false, refusal: schemaRefusal };

  if (before.facet !== IO_FACET) {
    return {
      ok: false,
      refusal: `REFUSED: compareIo was given '${before.facet}' reports, not '${IO_FACET}'.`,
    };
  }

  const decision = decideComparison(
    before.coordinate satisfies Coordinate,
    after.coordinate,
    options,
  );
  if (!decision.ok) return { ok: false, refusal: decision.refusal };

  const beforeBody = readIoBody(before, 'baseline');
  if ('refusal' in beforeBody) return { ok: false, refusal: beforeBody.refusal };
  const afterBody = readIoBody(after, 'compared');
  if ('refusal' in afterBody) return { ok: false, refusal: afterBody.refusal };

  return {
    ok: true,
    axis: decision.axis,
    commands: pairByKey(
      beforeBody.body.commands,
      afterBody.body.commands,
      (command) => command.name,
    ).map((pair) => diffCommand(pair)),
    contaminated: beforeBody.body.load.contaminated || afterBody.body.load.contaminated,
  };
}

/**
 * The gates every facet's comparator runs *before* it is entitled to subtract
 * anything, and the one-sided cases it must handle afterwards.
 *
 * None of this is about what is being measured. "Are these two reports the same
 * facet?", "is this build's schema the one that wrote them?", "did more than one
 * axis move?", "did one side fail?" and "does a command appear on only one side?"
 * are properties of a comparison. Two facets writing their own copies would each
 * be free to answer differently — one checking the build's own body version and
 * another only checking the two sides against each other, one refusing a
 * one-sided command and another silently dropping it — and each divergence
 * produces a well-formed comparison whose refusals mean something different from
 * its sibling's for no reason a reader can find.
 *
 * What stays in a facet: which numbers it subtracts, what a movement in them
 * means, and how to say why a row of its own has no breakdown.
 */

import {
  type Axis,
  type Coordinate,
  decideComparison,
  type DecideComparisonOptions,
} from '../envelope/coordinate.js';
import { refuseIncomparableSchemas, type ReportEnvelope } from '../envelope/envelope.js';

import { bothSides, pairByKey, type Pairing } from './diff.js';
import { describeIssues } from './dumps.js';

// One door for a facet's comparator. The subtraction primitives and the
// two-sided caveat helper live in their own modules — they are useful without a
// comparison — but a facet needs them together with the gates below, and three
// import statements per facet is three chances for one of them to reach for a
// private copy instead.
export {
  type CountDelta,
  countDelta,
  type DeltaThresholds,
  type LabelledRow,
  labelledMovements,
  type MsDelta,
  msDelta,
  type RowMovement,
  type RowMovementKind,
} from './delta.js';
export { bothSides } from './diff.js';

/** The least a facet's body schema has to expose to be validated here. */
export interface BodyParser<TBody> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false; readonly error: Parameters<typeof describeIssues>[0] };
  /** Narrowing marker; never read. Keeps `TBody` load-bearing in the signature. */
  readonly _body?: TBody;
}

/** Everything identifying one facet's body contract. */
export interface FacetContract<TBody> {
  /** The facet name in the envelope header. */
  readonly facet: string;
  /** The body version THIS build reads. */
  readonly version: number;
  readonly schema: BodyParser<TBody>;
}

/** A comparison that cleared every gate. */
export interface ComparisonOpened<TBody> {
  readonly ok: true;
  /** Which axis varies, or `null` when the two reports share a coordinate. */
  readonly axis: Axis | null;
  readonly before: TBody;
  readonly after: TBody;
}

/** A comparison that did not clear a gate. */
export interface ComparisonRefusal {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/** The outcome of the shared gates. */
export type ComparisonOpening<TBody> = ComparisonOpened<TBody> | ComparisonRefusal;

/**
 * Read an envelope's body as one facet's body.
 *
 * The build's OWN version is checked as well as the two sides against each
 * other, and that second check is the one that is easy to forget: two reports
 * captured before a schema move agree with each other perfectly while every row
 * in them means what the older build meant.
 *
 * @param envelope - A report whose header already names this facet
 * @param side - Which side of the comparison this is, for the message
 * @param contract - See {@link FacetContract}
 * @returns The validated body, or a refusal string
 */
function readBody<TBody>(
  envelope: ReportEnvelope<unknown>,
  side: string,
  contract: FacetContract<TBody>,
): { body: TBody } | { refusal: string } {
  if (envelope.facetVersion !== contract.version) {
    return {
      refusal:
        `REFUSED: the ${side} report is a '${contract.facet}' body at facetVersion ` +
        `${String(envelope.facetVersion)}, and this build reads ` +
        `${String(contract.version)}. Re-capture it; reading rows whose meaning has moved ` +
        'would produce numbers nobody can state.',
    };
  }

  const parsed = contract.schema.safeParse(envelope.body);
  if (parsed.success) return { body: parsed.data as TBody };
  return {
    refusal:
      `REFUSED: the ${side} report's header claims facet '${contract.facet}', but its body is ` +
      `not a '${contract.facet}' body and re-capturing that side is the only fix — ` +
      describeIssues(parsed.error),
  };
}

/**
 * Run every gate a comparison must clear before any number is subtracted.
 *
 * In order: the envelope schemas must agree, the reports must be this facet's,
 * at most one axis may have moved, and both bodies must validate against this
 * build's schema.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param contract - See {@link FacetContract}
 * @param options - Axis options
 * @returns Both validated bodies and the varying axis, or the first refusal
 */
export function openComparison<TBody>(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  contract: FacetContract<TBody>,
  options: DecideComparisonOptions,
): ComparisonOpening<TBody> {
  const schemaRefusal = refuseIncomparableSchemas(before, after);
  if (schemaRefusal !== null) return { ok: false, refusal: schemaRefusal };

  if (before.facet !== contract.facet) {
    return {
      ok: false,
      refusal:
        `REFUSED: a '${contract.facet}' comparison was given '${before.facet}' reports.`,
    };
  }

  const decision = decideComparison(
    before.coordinate satisfies Coordinate,
    after.coordinate,
    options,
  );
  if (!decision.ok) return { ok: false, refusal: decision.refusal };

  const beforeBody = readBody(before, 'baseline', contract);
  if ('refusal' in beforeBody) return { ok: false, refusal: beforeBody.refusal };
  const afterBody = readBody(after, 'compared', contract);
  if ('refusal' in afterBody) return { ok: false, refusal: afterBody.refusal };

  return { ok: true, axis: decision.axis, before: beforeBody.body, after: afterBody.body };
}

/** The one-sided verdicts, which no facet decides for itself. */
export type OneSidedVerdict = { readonly kind: 'added' } | { readonly kind: 'removed' };

/** One command's diff row, whatever verdict shape the facet uses. */
export interface CommandDiff<TRow, TVerdict> {
  readonly name: string;
  readonly verdict: TVerdict;
  /** The baseline row, absent when the command is new. */
  readonly before: TRow | null;
  /** The compared row, absent when the command was dropped. */
  readonly after: TRow | null;
}

/**
 * Turn one command pairing into its diff row, handling the one-sided cases.
 *
 * A command present on only one side is `added` or `removed` and is never handed
 * to the facet's own verdict function: there is no second row to subtract from,
 * and a facet that reached for a zeroed default would report the whole
 * measurement as the delta.
 *
 * @param pair - The command as it appears on each side
 * @param verdictFor - The facet's verdict, called only when both sides exist
 * @returns The row
 */
export function diffPairedCommand<TRow, TVerdict>(
  pair: Pairing<TRow>,
  verdictFor: (before: TRow, after: TRow) => TVerdict,
): CommandDiff<TRow, TVerdict | OneSidedVerdict> {
  const { key, before, after } = pair;
  if (before === null || after === null) {
    // A pairing key came from one of the two sides, so exactly one of these is
    // null here; which one it is names the verdict.
    const kind = before === null ? 'added' : 'removed';
    return { name: key, verdict: { kind }, before, after };
  }
  return { name: key, verdict: verdictFor(before, after), before, after };
}

/** The least a facet's body has to look like for the shared comparator to walk it. */
export interface CommandBody<TRow> {
  readonly commands: readonly TRow[];
  readonly load: { readonly contaminated: boolean };
}

/** A completed command-by-command comparison. */
export interface CommandsCompared<TRow, TVerdict> {
  readonly ok: true;
  /** Which axis varies, or `null` when the two reports share a coordinate. */
  readonly axis: Axis | null;
  readonly commands: readonly CommandDiff<TRow, TVerdict | OneSidedVerdict>[];
  /** True when either side was measured on a contaminated machine. */
  readonly contaminated: boolean;
}

/**
 * Gate two reports, pair their commands, and hand each pair to the facet.
 *
 * The whole comparator except the subtraction. Every measurement facet does
 * exactly this — gate, pair by name, verdict each pair, propagate contamination —
 * and the facet's genuine contribution is `verdictFor`, which is the only
 * argument that knows what is being measured.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param contract - See {@link FacetContract}
 * @param options - Axis options
 * @param verdictFor - The facet's verdict for one pair of rows
 * @returns The comparison, or the first refusal
 */
export function compareCommandRows<TRow extends { readonly name: string }, TVerdict>(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  contract: FacetContract<CommandBody<TRow>>,
  options: DecideComparisonOptions,
  verdictFor: (before: TRow, after: TRow) => TVerdict,
): CommandsCompared<TRow, TVerdict> | ComparisonRefusal {
  const opened = openComparison<CommandBody<TRow>>(before, after, contract, options);
  if (!opened.ok) return { ok: false, refusal: opened.refusal };

  const named = (command: TRow): string => command.name;
  return {
    ok: true,
    axis: opened.axis,
    commands: pairByKey(opened.before.commands, opened.after.commands, named).map((pair) =>
      diffPairedCommand(pair, verdictFor),
    ),
    contaminated: opened.before.load.contaminated || opened.after.load.contaminated,
  };
}

/** The shared fields every measurement facet's row carries into this cascade. */
export interface ComparableRow<TAttribution extends string> {
  readonly failed: boolean;
  readonly failure: string | null;
  readonly attribution: TAttribution;
  readonly cache: string;
}

/**
 * Why a pair of rows yields no comparable breakdown, or `null` when it does.
 *
 * **The order is the content**, and it is the same in every facet: a failure
 * outranks an empty measurement, which outranks a cache-mode mismatch the
 * operator can simply re-run. Each step asks BOTH sides and names every side at
 * fault, because a reason that stopped at the baseline sends a reader to
 * re-capture one report and leaves them puzzled when the second refuses
 * identically.
 *
 * A factory, because the empty states are the facet's own vocabulary — a warm
 * parse cache has no analogue in a crawl — while the rule that none of them may
 * be subtracted from is universal. That rule is the one this file exists to keep:
 * zeros from a row that measured nothing, subtracted from a real measurement, is
 * a fabricated "everything got faster" and the most convincing wrong finding a
 * measurement facet can produce.
 *
 * @param reasons - How each of this facet's states reads, `null` for the measured one
 * @returns A function naming why two rows cannot be compared
 */
export function unmeasurableReasonFor<TAttribution extends string>(
  reasons: Readonly<Record<TAttribution, string | null>>,
): (before: ComparableRow<TAttribution>, after: ComparableRow<TAttribution>) => string | null {
  const attributionCaveat = (row: ComparableRow<TAttribution>, side: string): string | null => {
    const reason = reasons[row.attribution];
    return reason === null ? null : `the ${side} row has no breakdown — ${reason}`;
  };
  return (before, after) =>
    bothSides(before, after, failureCaveat) ??
    bothSides(before, after, attributionCaveat) ??
    cacheModeCaveat(before, after);
}

/**
 * What one side's failure costs the comparison, or `null` when it did not fail.
 *
 * Every measurement facet keeps a failed row so the report says what happened,
 * and every one of them must refuse to read a delta from it.
 *
 * @param row - That side's row
 * @param side - How to name it in the reason
 * @returns A clause, or `null`
 */
export function failureCaveat(
  row: { readonly failed: boolean; readonly failure: string | null },
  side: string,
): string | null {
  return row.failed ? `the ${side} row failed: ${row.failure ?? 'unknown'}` : null;
}

/**
 * Why two rows captured under different cache modes are not two measurements of
 * one thing, or `null` when they agree.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns A reason, or `null`
 */
export function cacheModeCaveat(
  before: { readonly cache: string },
  after: { readonly cache: string },
): string | null {
  return before.cache === after.cache
    ? null
    : `cache mode differs (${before.cache} vs ${after.cache})`;
}

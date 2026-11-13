/**
 * Absence causes: a pair or extent VAT could not compute, observed in a
 * projection's own rows.
 *
 * A cause is named by one structured {@link AbsenceSignature}, never by a
 * string prefix, so the enumeration that lists the causes (the CLI's I0 census)
 * and every test that plants one (`expectAbsenceCause`) match rows by the same
 * rule. It lives here because the tests that plant a cause sit in more than one
 * package, and this is the one module each of them can import.
 *
 * Framework-free like the rest of `./testing`: a missing cause is a thrown
 * `Error`, not a vitest assertion.
 */

/**
 * How one absence cause shows in a projection's rows.
 *
 * - A code signature matches a `blob_conditions` or `realization_conditions`
 *   row of that code. `extentKind`, when given, holds a realization condition
 *   to its own extent's `resolution_contexts.kind`; `resourceIdPresent`, when
 *   given, to whether the row names a resource (a non-null `resourceId`). Both
 *   are row shapes: what a shape means for one extent is the caller's to say.
 * - A state signature matches a `resource_realizations` row in that
 *   `contentState`.
 */
export type AbsenceSignature =
  | { readonly code: string; readonly extentKind?: string; readonly resourceIdPresent?: boolean }
  | { readonly contentState: string };

/**
 * The rows an absence cause is observed in, under a projection's own field
 * names, so a `Projection` is one as it stands. Every table is required: a
 * caller that left out the contexts would see every kind-qualified cause as
 * absent, and one that left out a condition table would see none of its causes.
 */
export interface AbsenceRows {
  readonly blobConditions: readonly { readonly code: string }[];
  readonly resourceRealizations: readonly { readonly contentState: string }[];
  readonly realizationConditions: readonly { readonly code: string; readonly extentId: string; readonly resourceId: string | null }[];
  readonly resolutionContexts: readonly { readonly contextId: string; readonly kind: string }[];
}

/** One row as a cause is matched against it. */
export type AbsenceObservation =
  | { readonly table: 'blob_conditions'; readonly code: string }
  | { readonly table: 'resource_realizations'; readonly contentState: string }
  | {
    readonly table: 'realization_conditions';
    readonly code: string;
    readonly extentId: string;
    /** The extent's `resolution_contexts.kind`, or null when the rows carry no such context. */
    readonly extentKind: string | null;
    /** Whether the row's `resourceId` is non-null. */
    readonly resourceIdPresent: boolean;
  };

/**
 * Every row an absence cause can be observed in, one observation each, in table order.
 *
 * @param rows - A projection, or the same four tables from a dump
 * @returns The observations
 */
export function absenceObservations(rows: AbsenceRows): AbsenceObservation[] {
  const kinds = new Map(rows.resolutionContexts.map((context) => [context.contextId, context.kind]));
  return [
    ...rows.blobConditions.map((row): AbsenceObservation => ({ table: 'blob_conditions', code: row.code })),
    ...rows.resourceRealizations.map((row): AbsenceObservation => ({ table: 'resource_realizations', contentState: row.contentState })),
    ...rows.realizationConditions.map((row): AbsenceObservation => ({
      table: 'realization_conditions',
      code: row.code,
      extentId: row.extentId,
      extentKind: kinds.get(row.extentId) ?? null,
      resourceIdPresent: row.resourceId !== null,
    })),
  ];
}

/**
 * Whether one observed row carries a cause.
 *
 * @param observation - The row
 * @param signature - The cause
 * @returns True when every field the signature states holds of the row
 */
export function matchesAbsenceCause(observation: AbsenceObservation, signature: AbsenceSignature): boolean {
  if ('contentState' in signature) {
    return observation.table === 'resource_realizations' && observation.contentState === signature.contentState;
  }
  if (observation.table === 'resource_realizations' || observation.code !== signature.code) return false;
  if (signature.extentKind === undefined && signature.resourceIdPresent === undefined) return true;
  if (observation.table !== 'realization_conditions') return false;
  if (signature.extentKind !== undefined && observation.extentKind !== signature.extentKind) return false;
  return signature.resourceIdPresent === undefined || observation.resourceIdPresent === signature.resourceIdPresent;
}

/**
 * The rows carrying a cause, or a throw when none does: a test that planted the
 * cause proves its plant reached the rows. Return value for the caller's own
 * assertion, so the helper is never the only check.
 *
 * @param rows - A projection, or the same four tables from a dump
 * @param signature - The cause planted
 * @returns The observations that carry it, never empty
 * @throws When no row carries the cause
 */
export function expectAbsenceCause(rows: AbsenceRows, signature: AbsenceSignature): AbsenceObservation[] {
  const matched = absenceObservations(rows).filter((observation) => matchesAbsenceCause(observation, signature));
  if (matched.length === 0) {
    throw new Error(`no row carries the absence cause ${JSON.stringify(signature)}`);
  }
  return matched;
}

/**
 * What a measurement facet is pointed at: the commands to run, and the default
 * set to run when the caller does not name their own.
 *
 * This lives in the harness rather than in a facet for the same reason
 * `schemas.ts` does. `perf` and `io` do not merely happen to measure the same
 * three vat commands — they have to, or their reports describe different work
 * and holding one beside the other is meaningless. Two per-facet copies would be
 * free to drift the moment one of them gained a fourth command or changed an
 * argument, and the drift would be invisible: both reports would still be
 * well-formed, still name their commands, and still disagree about what was
 * measured.
 *
 * It is also the only way `io` can have defaults at all without importing
 * `perf`, which the facet contract forbids — see
 * [Facets](../../docs/facets.md).
 */

/** What one vat command was asked to do. */
export interface MeasuredCommandSpec {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments after the vat binary, with `{subject}` substituted at capture time. */
  readonly args: readonly string[];
}

/**
 * The vat commands measured when the caller does not name their own.
 *
 * These three are the corpus-enumerating verbs — the ones whose cost scales
 * with the size of the project rather than with the size of their arguments,
 * and therefore the ones where a regression actually hurts. They deliberately
 * mirror the set vat's own QA instrument spawns, so a perf report, an io report
 * and a correctness snapshot are all talking about the same commands.
 *
 * Not a closed set. A caller measuring something else passes its own specs;
 * this is the default, not the definition.
 */
export const DEFAULT_MEASURED_COMMANDS: readonly MeasuredCommandSpec[] = Object.freeze([
  Object.freeze({
    name: 'resources-scan',
    args: Object.freeze(['resources', 'scan', '{subject}']),
  }),
  Object.freeze({
    name: 'resources-validate',
    args: Object.freeze(['resources', 'validate', '{subject}', '--format', 'json']),
  }),
  Object.freeze({
    name: 'audit',
    args: Object.freeze(['audit', '{subject}']),
  }),
]);

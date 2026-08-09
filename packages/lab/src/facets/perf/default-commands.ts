/**
 * The vat commands measured when the caller does not name their own.
 *
 * These three are the corpus-enumerating verbs — the ones whose cost scales
 * with the size of the project rather than with the size of their arguments,
 * and therefore the ones where a regression actually hurts. They deliberately
 * mirror the set vat's own QA instrument spawns, so a perf report and a
 * correctness snapshot are talking about the same commands.
 *
 * Not a closed set. A caller measuring something else passes its own specs;
 * this is the default, not the definition.
 */

import type { PerfCommandSpec } from './types.js';

export const DEFAULT_PERF_COMMANDS: readonly PerfCommandSpec[] = Object.freeze([
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

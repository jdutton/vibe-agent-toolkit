/**
 * The ONE severity vocabulary a VAT finding carries.
 *
 * 🔑 There were seven. `error|warning|info` was declared three separate times
 * (`OkfSeverity`, `ConsistencyIssueSeverity`, `ProjectionConditionSeveritySchema`),
 * two lanes used the two-member prefix, `vat claude context` spelled the middle
 * level `warn` and kept a translation function as "the one place the two meet",
 * and three producers typed the field `string`. Every renderer and every CI
 * adapter was written per vocabulary. This module is the definition every one of
 * them now imports; a lane that wants a fourth level, or a different spelling,
 * has to change it here where every other lane will see the diff.
 *
 * Its own module, and a leaf one, on purpose: `validation-codes.ts` derives
 * `IssueSeverity` (this plus `ignore`) from it and `report.ts` builds the finding
 * envelope on it, so it must import neither.
 */

import { z } from 'zod';

/**
 * The three levels, strongest first. The ORDER is the definition of "stronger":
 * {@link strongerSeverity} and {@link compareSeverity} read it and nothing else
 * does, so a level added here in the wrong position is a wrong comparison
 * everywhere at once — which is the only place a mistake like that can be
 * caught.
 */
export const SEVERITIES = ['error', 'warning', 'info'] as const;

export const SeveritySchema = z.enum(SEVERITIES);

/** A finding's severity: `error` fails a gate, `warning` asks for a look, `info` reports. */
export type Severity = z.infer<typeof SeveritySchema>;

const RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

/**
 * Sort order for severities — strongest first, so `findings.sort(compareSeverity)`
 * puts the errors at the top.
 *
 * @param a - One severity
 * @param b - Another
 * @returns Negative when `a` is stronger than `b`, positive when weaker, zero when equal
 */
export function compareSeverity(a: Severity, b: Severity): number {
  return RANK[a] - RANK[b];
}

/**
 * The stronger of two severities.
 *
 * The one operation a lane that raises a stored severity needs. ⛔ It grades
 * UPWARD only, by construction: the result is never weaker than either input,
 * so a caller cannot use it to demote a finding — a defect this repo shipped
 * once, when `vat claude context` re-derived a severity from the code alone and
 * silently reported an `error` condition as `info`.
 *
 * @param a - One severity
 * @param b - Another
 * @returns Whichever of the two is stronger
 */
export function strongerSeverity(a: Severity, b: Severity): Severity {
  return compareSeverity(a, b) <= 0 ? a : b;
}

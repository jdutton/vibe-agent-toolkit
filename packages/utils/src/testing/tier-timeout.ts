/**
 * One rule for a test that needs longer than its tier allows.
 *
 * A test runner's tier config scales its default per-test timeout to the
 * platform (this repo: 60 s on Unix, 15 min on Windows, in the integration
 * tier). Two ways of asking for more both failed:
 *
 * - a literal (`60_000`) replaces that default with one number for every
 *   machine, so a budget that was generous on Unix was the failure on Windows;
 * - a multiple of the default (`tier * 60`) scales an hour-sized Unix budget by
 *   the Windows factor too — 15 hours — so a hang burned the CI job's whole
 *   allowance and named no test.
 *
 * So the default is the FLOOR and the budget is a CEILING over it: the result
 * is never below this machine's default and never above the budget the author
 * measured, unless the default itself is larger.
 */

/**
 * The timeout a test that needs `budgetMs` should pass: `max(tierTimeout, budgetMs)`.
 *
 * Pass the tier's own default as the first argument — under vitest,
 * `inject('tierTestTimeout')` or `inject('tierHookTimeout')`, which this repo's
 * configs provide. (enforced by: `local/no-literal-test-timeout`, which accepts a
 * literal only as this function's budget.)
 *
 * @param tierTimeout - The tier's platform-scaled default, in ms
 * @param budgetMs - The most this test is allowed, in ms, as measured on the platform it was sized on
 * @returns The larger of the two
 * @throws When either is not a finite positive number — `Math.max` with `NaN`
 *   is `NaN`, which a runner reads as no timeout at all, and an `undefined` tier
 *   means the config provided nothing
 */
export function atLeastTierTimeout(tierTimeout: number, budgetMs: number): number {
  if (!isPositiveFinite(tierTimeout)) {
    throw new TypeError(`atLeastTierTimeout: the tier timeout must be a finite positive number, got ${String(tierTimeout)}`);
  }
  if (!isPositiveFinite(budgetMs)) {
    throw new TypeError(`atLeastTierTimeout: the budget must be a finite positive number, got ${String(budgetMs)}`);
  }
  return Math.max(tierTimeout, budgetMs);
}

function isPositiveFinite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

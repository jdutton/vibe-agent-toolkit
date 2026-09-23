/**
 * Whether one accounted row's bytes are paid when a session STARTS — the fact
 * `claude_context_loads.launchCharge` stores.
 *
 * Pure: no I/O, no config, no threshold, no verdict. VAT publishes what loads at
 * launch and what it costs; what counts as "too much" is the adopter's call, made
 * in their own `resources.checks` or their own tooling. A built-in byte limit
 * invites byte-shaving without the guidance that makes trimming a CLAUDE.md
 * worthwhile, so none ships.
 *
 * ## Why the value is stored rather than left to SQL
 *
 * The fact is a fold of two columns a reader already has — `loadClass` and
 * `sizeCliff` — but the obvious filter on either one alone is wrong, and was
 * shipped wrong: `sizeCliff = 'loaded'` also holds every on-demand rule, and
 * `loadClass = 'always'` also holds a `CLAUDE.md` the 4 MiB cliff skipped. One
 * named column with one value to select (`'charged'`) is what makes the correct
 * sum the easy one to write.
 *
 * ## The sum is `vat claude context`'s `alwaysTokens`, exactly
 *
 * `SUM(tokens) WHERE launchCharge = 'charged'` over one chain is the same
 * arithmetic `account()`'s `totalsOf` performs for `alwaysTokens`, and
 * `projection-claude-context-chains-oracle.test.ts` holds the two equal for every
 * working location. ⛔ That equality is the contract. An import is charged at
 * EVERY hop the closure admits, and an import VAT could not attribute to an
 * importer is charged too — its load class comes from its closure root, which is
 * known, so the harness loads it at launch whatever its depth. An earlier version
 * of this module charged only one hop, because a since-deleted token threshold
 * had been calibrated there; that was a property of the threshold, never of what
 * the harness loads.
 */

import type { AccountedRow } from './claude-context-accounting.js';
import type { Admission } from './claude-context-query.js';

/**
 * Every value `launchCharge` can take.
 *
 * A closed union HERE, where the decision is made, and an open string in
 * `ClaudeContextLaunchChargeSchema`, where it is STORED — the asymmetry
 * `ZoneKindSchema` carries, for the same reason: a new member must be a compile
 * error at the one site that decides, and must NOT be a schema migration for a
 * stored row.
 *
 * ⛔ No value may be spelled like a `SizeCliffState`: both ride on one
 * `claude_context_loads` row. Pinned by a disjointness test.
 */
export const LAUNCH_CHARGES = [
  'charged',
  'unknown-size',
  'oversize',
  'not-always',
] as const;

/** One member of {@link LAUNCH_CHARGES}. Not exported: the vocabulary crosses the
 * package boundary as `LAUNCH_CHARGES` and as the schema built from it. */
type LaunchCharge = (typeof LAUNCH_CHARGES)[number];

/**
 * How one accounted row reaches — or fails to reach — what loads at launch.
 *
 * ⛔ The order is a PRIORITY: the cliff outranks an unknown size, because a file
 * the harness skipped is knowledge, not ignorance.
 *
 * @param row - One accounted row
 * @returns Its launch charge — see `ClaudeContextLaunchChargeSchema` for what
 *   each value means to a reader of the relation
 */
export function launchCharge(row: AccountedRow): LaunchCharge {
  // An `on-demand` row is part of the answer and not of the launch cost. The
  // relation says so with a value of its own rather than by omitting the row —
  // a row missing from the relation and a row that costs nothing at launch are
  // different facts.
  if (row.loadClass !== 'always') return 'not-always';
  if (row.sizeCliff === 'oversize-skipped' || row.sizeCliff === 'pruned-by-oversize') return 'oversize';
  if (row.sizeCliff === 'unmeasured' || row.tokens === null) return 'unknown-size';
  return 'charged';
}

/**
 * Could THIS one admission be the reason a row loads at launch?
 *
 * Used by `claude-context-relations.ts` to name the DECIDING admission — the one
 * whose kind and pattern `claude_context_loads` stores — so a charged row names a
 * launch-time kind rather than whichever admission happened to be listed first.
 *
 * `ancestry`, `root-rule` and `nested-rule` are launch-time on their own: the
 * launch walk reads `.claude/rules` in every directory from the root down to
 * the working directory, and a `nested-rule` admission names exactly such a
 * directory (`claude-context-walk.ts`). An `import` is launch-time exactly when
 * the walk reached it, which the query has already decided into the row's
 * `loadClass`; the admission alone cannot say, so every import is a candidate
 * and the row's class settles it.
 *
 * ⛔ No other rule kind is, at any depth or in any combination: `glob-rule`,
 * `glob-rule-may-fire` and `glob-rule-covers-dir` load when the agent touches a
 * matching file. The test enumerates what admits, so a rule kind added to the
 * union later is excluded by default.
 *
 * @param admission - One admission
 * @returns True when it can charge the row at launch
 */
export function admissionLoadsAtLaunch(admission: Admission): boolean {
  return admission.kind === 'ancestry'
    || admission.kind === 'root-rule'
    || admission.kind === 'nested-rule'
    || admission.kind === 'import';
}

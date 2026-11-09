/**
 * The document `vat resources check` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 */

import { LIMIT_DIRECTIONS, POPULATION_ORIGINS } from '@vibe-agent-toolkit/resources';
import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import { LENS_POPULATIONS } from '../../utils/lens-population.js';
import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What one rule cost, as the document publishes it. */
const PublishedCheckCostSchema = z.object({
  name: z.string(),
  /** Three significant figures, so a 0.4 ms rule serializes as 0.0004 rather than a zero that reads as "not measured". */
  durationSecs: z.number().nonnegative(),
  /** Rows the statement returned. Present exactly when the statement completed — ABSENT, never 0, when it did not. */
  rows: z.number().int().nonnegative().optional(),
  /**
   * The check reported nothing it selected. Without `rows`: the statement failed. With `rows`: it
   * completed, and then its declared `examined` statement failed, or its rows could not be
   * interpreted (or the run stopped while running the one or converting the other).
   */
  broken: z.literal(true).optional(),
  /** Present and `true` only for a rule VAT supplied — see `CheckCost.builtin` in `check.ts`. */
  builtin: z.literal(true).optional(),
  /**
   * Rows the check's declared `examined` statement selected — what it ranged over. Present exactly
   * when the check declares `examined` AND that statement completed: ABSENT on a check that
   * declares none, and absent (never 0) when it did not complete. 0 without `allowEmpty` comes
   * with a `RESOURCE_CHECK_EXAMINED_NOTHING` finding naming the check.
   */
  examined: z.number().int().nonnegative().optional(),
  /** Present and `true` only when the check declares that an `examined` count of 0 is legitimate. */
  allowEmpty: z.literal(true).optional(),
}).strict();

/**
 * A signed bound on what the derived rows settle, as `@vibe-agent-toolkit/resources`
 * states it.
 *
 * ⛔ The direction vocabulary is IMPORTED, never respelled: `LIMIT_DIRECTIONS`
 * is the one list, tied to `StatedLimit['direction']` by `satisfies`, so a
 * fifth direction cannot leave this schema quietly rejecting it.
 */
export const StatedLimitSchema = z.object({
  id: z.string(),
  direction: z.enum(LIMIT_DIRECTIONS),
  statement: z.string(),
}).strict();

/**
 * What the check run reports beyond its findings.
 *
 * The envelope's `examined` is `membersEnumerated` — what the rules ran
 * AGAINST. `checksRun` is the other denominator, the number of RULES, and both
 * are needed: zero findings is the pass condition and either number at zero
 * makes that pass vacuous.
 */
const CheckDataSchema = z.object({
  root: z.string(),
  /**
   * Whether the projection was derived this run or read from the store.
   *
   * 🔑 `null` — together with `populationSecs`, `lensSecs` and
   * `lensesEvaluated` — exactly when the run was interrupted before its
   * population completed. There was no projection, so there is no origin, cost
   * or lens set to report, and a `RESOURCE_CHECK_BROKEN` finding says why.
   */
  population: z.enum(POPULATION_ORIGINS).nullable(),
  /** What the population cost — charged to no check, see `CheckCost`. Null as `population` is. */
  populationSecs: z.number().nonnegative().nullable(),
  /** What evaluating the lenses cost, paid before the first statement ran. Null as `population` is. */
  lensSecs: z.number().nonnegative().nullable(),
  /**
   * Which lenses that covers — the derived relations this run's checks could
   * actually read. 🔑 An empty list says "no check asked for a derived relation"
   * rather than "a lens stopped running"; without it `lensSecs: 0` is the same
   * document either way, and a gate whose rules silently read empty relations is
   * a gate that cannot fail. Null as `population` is — `[]` would claim "no
   * check asked", about a run that never got far enough to ask.
   */
  lensesEvaluated: z.array(z.string()).nullable(),
  /**
   * Where the lenses' own populations came from: `none` when no evaluated lens
   * populated anything (no statement named a claude-context relation), `store`
   * when every one that did was served from the store, otherwise `derived`.
   * Null as `population` is — no population happened at all.
   */
  lensPopulation: z.enum(LENS_POPULATIONS).nullable(),
  /**
   * The prose frame {@link CheckDataSchema.limits} is read under. Present
   * exactly when a lens with stated bounds was evaluated.
   */
  boundsStatement: z.string().optional(),
  /**
   * What the derived rows this run could read do NOT settle — signed and
   * directional, the same list `vat claude context` publishes beside its own
   * answer. Absent when no bounded lens ran: an empty list would claim nothing
   * bounds the answer, which is stronger than "the answer holds no such row".
   */
  limits: z.array(StatedLimitSchema).optional(),
  /** The number of rules that EXECUTED. Derived from `checks`, never carried beside it. */
  checksRun: z.number().int().nonnegative(),
  /** What each rule cost, directly under the denominator it is the breakdown of. */
  checks: z.array(PublishedCheckCostSchema),
}).strict();

export type CheckData = z.infer<typeof CheckDataSchema>;

/** The document this command publishes. */
export const CHECK_REPORT_SCHEMA = reportSchema(CheckDataSchema, FindingSchema);

export type CheckReport = Report<CheckData>;

/**
 * What `examined` counts for `vat resources check`, and the remedy when it is zero. One
 * declaration for the verb's own writer (the published-shape registry) and for the `checks`
 * phase `vat validate` runs, so a run that examined nothing is refused the same way in both.
 */
export const RESOURCES_CHECK_EXAMINED: ExaminedDeclaration = {
  unit: 'resources in the population',
  whenZero: 'The projection holds no resource under the project root: check that the project root this run resolved is the one you meant, and that its files are not all gitignored.',
};

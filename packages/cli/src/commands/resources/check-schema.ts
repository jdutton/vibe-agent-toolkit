/**
 * The document `vat resources check` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 */

import {
  CHECK_EVIDENCE_VALUE_SCHEMA,
  CHECK_REFUSAL_REASON_SCHEMA,
  LIMIT_DIRECTIONS,
  POPULATION_ORIGINS,
} from '@vibe-agent-toolkit/resources';
import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import { LENS_POPULATIONS } from '../../utils/lens-population.js';
import { RUN_INTEGRITY_CODE, type ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What one rule cost, as the document publishes it. */
const PublishedCheckCostSchema = z.object({
  name: z.string(),
  /** Three significant figures, so a 0.4 ms rule serializes as 0.0004 rather than a zero that reads as "not measured". */
  durationSecs: z.number().nonnegative(),
  /** Rows the statement returned. ABSENT, never 0, when the statement did not complete. */
  rows: z.number().int().nonnegative().optional(),
  /** Nothing reported. Without `rows`: the statement failed; with: `examined` or conversion failed, or the run was killed mid-check. */
  broken: z.literal(true).optional(),
  /** Present and `true` only for a rule VAT supplied — see `CheckCost.builtin` in `check.ts`. */
  builtin: z.literal(true).optional(),
  /** The one count the declared `examined` statement returned (`EXAMINED_ALLOWED`). ABSENT, never 0, unless it completed. */
  examined: z.number().int().nonnegative().optional(),
  /** The check declares an `examined` count of 0 legitimate. */
  allowEmpty: z.literal(true).optional(),
  /** Selected columns matching a reserved name only in another case, as spelled — the stderr warning's. */
  nearMisses: z.array(z.string()).min(1).optional(),
  /** Exactly when this check produced a `RESOURCE_CHECK_EXAMINED_NOTHING` finding. */
  examinedNothing: z.literal(true).optional(),
}).strict();

/**
 * A finding of `vat resources check`'s document, also used by the `vat validate` envelope.
 * `check` is absent on a whole-run finding; `evidence` is the row minus reserved columns (plus
 * `path` when its text is no location — see `CheckIssue.evidence`). The evidence value and the
 * `reason` shapes are `@vibe-agent-toolkit/resources`' own schemas, never respelled here.
 *
 * Two cross-field rules, in ONE `superRefine` (a second `.refine` would nest the effects and hide
 * the object's `shape`): `evidence` names its `check`, and only a `RESOURCE_CHECK_BROKEN` finding
 * carries a `reason`. Every document is re-parsed against this schema at publish, so both hold at
 * run time; `zod-to-json-schema` drops a refinement, so the generator emits
 * {@link CHECK_FINDING_JSON_RULES} into the committed JSON Schemas.
 *
 * ⚠️ One object extended plus a refinement, NOT a union: a union emits every inherited key once
 * per branch.
 */
export const CHECK_FINDING_SCHEMA = FindingSchema.extend({
  check: z.string().min(1).optional(),
  evidence: z.record(z.string(), CHECK_EVIDENCE_VALUE_SCHEMA).optional(),
  /** Only on `RESOURCE_CHECK_BROKEN`: output it could not read (what, and what is allowed), or a relation's refusal code. */
  reason: CHECK_REFUSAL_REASON_SCHEMA.optional(),
}).strict().superRefine((finding, context) => {
  if (finding.evidence !== undefined && finding.check === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'evidence is a check\'s row, so a finding carrying it must name the check',
      path: ['evidence'],
    });
  }
  if (finding.reason !== undefined && finding.code !== RUN_INTEGRITY_CODE) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `reason explains a broken check, so only a ${RUN_INTEGRITY_CODE} finding carries it`,
      path: ['reason'],
    });
  }
});

/**
 * {@link CHECK_FINDING_SCHEMA}'s two refinements as JSON Schema, for the generator to emit on every
 * published finding node that carries `evidence` and `reason` — the same two rules, so the
 * artifact refuses what the runtime refuses.
 */
export const CHECK_FINDING_JSON_RULES: readonly Record<string, unknown>[] = [
  { if: { required: ['evidence'] }, then: { required: ['check'] } },
  { if: { required: ['reason'] }, then: { required: ['code'], properties: { code: { const: RUN_INTEGRITY_CODE } } } },
];

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
export const CHECK_REPORT_SCHEMA = reportSchema(CheckDataSchema, CHECK_FINDING_SCHEMA);

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

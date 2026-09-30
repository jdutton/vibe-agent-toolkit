/**
 * The document `vat build`, `vat validate` and `vat verify` publish, apart from
 * the commands.
 *
 * A sibling module because the published-shape registry imports it and the
 * commands import the writer that imports the registry: a schema declared in a
 * command module itself would be an import cycle, read before it is initialised.
 *
 * 🔑 **One envelope over every phase.** `findings` is every phase's findings,
 * flat and with their `location` unchanged; `examined` is the sum of the
 * phases' own `examined`; `data.phases` carries each phase's status, count,
 * summary and its own `data` — which that phase's registered schema describes,
 * so this schema holds it as `unknown` rather than keeping a second copy of
 * five shapes. `runPhase` holds each phase's report to that schema before the
 * fold. A phase that did not finish carries its own `error`, and the
 * orchestrator's envelope is then `error` / `RUN_INCOMPLETE` over the phases
 * that did.
 *
 * `vat verify`'s `packaged-content` phase is no verb of its own, so its report
 * schema — the published contract for its `data` — is declared here.
 */

import {
  FindingSchema,
  RefusalCodeSchema,
  ReportStatusSchema,
  reportSchema,
  SeverityCountsSchema,
} from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../utils/run-integrity.js';

/**
 * What `examined` counts for an orchestrator, and the remedy when it is zero.
 *
 * The sum of the phases' own denominators — files, skills, bundles, plugins —
 * so the unit is "whatever each phase examined". Zero is refused ONCE, on the
 * sum: a project that configures one surface and not another must not fail
 * because the other examined nothing.
 */
export const ORCHESTRATOR_EXAMINED: ExaminedDeclaration = {
  unit: 'items across every phase',
  whenZero: 'No phase examined anything, so the run is not a verdict: vibe-agent-toolkit.config.yaml'
    + ' declares no surface this command runs (`vat build` runs `skills:` and `claude.marketplaces:`;'
    + ' `vat validate` runs `resources:` and `skills:`; `vat verify` runs all three), or every'
    + ' configured surface matched nothing — usually a typo in a glob or a config key. Each phase'
    + ' entry under `data.phases` shows what it examined.',
};

/** One phase of the run, as the orchestrator folds it. */
const PhaseEntrySchema = z.object({
  /** The phase's name, e.g. `skills`, `marketplace:<name>`, `packaged-content`. */
  name: z.string(),
  /** The phase's own envelope status. */
  status: ReportStatusSchema,
  /** What the phase examined, in its own unit. */
  examined: z.number().int().nonnegative(),
  /** The phase's findings, by severity — the findings themselves are on the envelope. */
  summary: SeverityCountsSchema,
  /** Why the phase did not finish, when it did not. */
  error: z.object({ code: RefusalCodeSchema, message: z.string() }).strict().optional(),
  /** The phase's own `data`, as its own registered schema describes it. */
  data: z.unknown(),
}).strict();

const OrchestratorDataSchema = z.object({
  /** Every phase that ran, finished or not, in execution order. */
  phases: z.array(PhaseEntrySchema),
}).strict();

export type OrchestratorPhaseEntry = z.infer<typeof PhaseEntrySchema>;

export type OrchestratorData = z.infer<typeof OrchestratorDataSchema>;

/** The document the three orchestrators publish. */
export const ORCHESTRATOR_REPORT_SCHEMA = reportSchema(OrchestratorDataSchema, FindingSchema);

/**
 * `vat verify`'s `packaged-content` phase `data`: what the crawl should have
 * found. What it DID crawl is the phase's own `examined` (the built bundles on
 * disk), so it is not repeated here.
 */
const PackagedContentDataSchema = z.object({
  /** Bundles `vat build` produces for the skills this run discovered. */
  bundlesExpected: z.number().int().nonnegative(),
  /** Discovered skills that are in place (`publish: false`, not plugin-local): no bundle is expected. */
  bundlesInPlace: z.number().int().nonnegative(),
  /** Expected bundles absent from `dist/`, project-relative. Non-empty means the phase is not a verdict. */
  bundlesMissing: z.array(z.string()),
}).strict();

export type PackagedContentData = z.infer<typeof PackagedContentDataSchema>;

/** The report `vat verify`'s `packaged-content` phase hands back. */
export const PACKAGED_CONTENT_REPORT_SCHEMA = reportSchema(PackagedContentDataSchema, FindingSchema);

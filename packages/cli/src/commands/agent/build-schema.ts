/**
 * The document `vat agent build` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * One agent per run: `examined` is 1 when it was built. A build that could not
 * finish — a `--target` VAT does not build, a manifest that is not there or does
 * not validate — is the envelope's error branch, never a finding, so a build
 * publishes `ok` or `error` and nothing between.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat agent build`, and the remedy when it is zero. */
export const AGENT_BUILD_EXAMINED: ExaminedDeclaration = {
  unit: 'agents built',
  whenZero: 'No agent was built — point the command at an agent directory holding agent.yaml, the manifest file itself, or an agent name vat agent list shows.',
};

const AgentBuildDataSchema = z.object({
  /** The agent's `metadata.name`. */
  agent: z.string(),
  /** The deployment target built — `skill` is the one VAT builds. */
  target: z.literal('skill'),
  /** The directory the build wrote. */
  output: z.string(),
  /** Every file the build wrote or bundled. */
  files: z.array(z.string()),
}).strict();

export type AgentBuildData = z.infer<typeof AgentBuildDataSchema>;

/** The document this command publishes. */
export const AGENT_BUILD_REPORT_SCHEMA = reportSchema(AgentBuildDataSchema, FindingSchema);

export type AgentBuildReport = Report<AgentBuildData>;

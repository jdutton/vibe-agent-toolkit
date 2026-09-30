/**
 * The document `vat agent install` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * One agent per run: `examined` is 1, the agent named. An install that could
 * not finish is the envelope's error branch, never a finding, so an install
 * publishes `ok` or `error`.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat agent install`, and the remedy when it is zero. */
export const AGENT_INSTALL_EXAMINED: ExaminedDeclaration = {
  unit: 'agents named',
  whenZero: 'No agent was installed — name one built agent: vat agent install <agentName>.',
};

const AgentInstallDataSchema = z.object({
  /** The agent name as given. */
  agent: z.string(),
  /** Where the agent is now installed. */
  installPath: z.string(),
  /** `true` for a `--dev` symlink to the built bundle, `false` for a copy. */
  symlink: z.boolean(),
}).strict();

export type AgentInstallData = z.infer<typeof AgentInstallDataSchema>;

/** The document this command publishes. */
export const AGENT_INSTALL_REPORT_SCHEMA = reportSchema(AgentInstallDataSchema, FindingSchema);

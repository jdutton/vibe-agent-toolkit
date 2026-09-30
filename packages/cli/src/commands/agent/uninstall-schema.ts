/**
 * The document `vat agent uninstall` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * One agent per run: `examined` is 1, the agent named. An agent that is not
 * installed, and a removal that could not finish, are the envelope's error
 * branch, never a finding, so an uninstall publishes `ok` or `error`.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat agent uninstall`, and the remedy when it is zero. */
export const AGENT_UNINSTALL_EXAMINED: ExaminedDeclaration = {
  unit: 'agents named',
  whenZero: 'No agent was uninstalled — name one installed agent: vat agent uninstall <agentName>.',
};

const AgentUninstallDataSchema = z.object({
  /** The agent name as given. */
  agent: z.string(),
  /** The install that was removed. */
  installPath: z.string(),
  /** `true` when the install was a `--dev` symlink (only the link was removed). */
  wasSymlink: z.boolean(),
}).strict();

export type AgentUninstallData = z.infer<typeof AgentUninstallDataSchema>;

/** The document this command publishes. */
export const AGENT_UNINSTALL_REPORT_SCHEMA = reportSchema(AgentUninstallDataSchema, FindingSchema);

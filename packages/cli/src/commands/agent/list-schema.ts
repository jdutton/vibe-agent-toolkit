/**
 * The document `vat agent list` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the search paths scanned. An absent search path is scanned
 * and empty; one the OS will not list, and an agent manifest it will not read,
 * is a `SCAN_PATH_UNREADABLE` warning finding — the listing is then a floor —
 * and every readable search path is still listed.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat agent list`, and the remedy when it is zero. */
export const AGENT_LIST_EXAMINED: ExaminedDeclaration = {
  unit: 'search paths scanned',
  whenZero: 'No agent search path was scanned, which is a defect in VAT — report it with the output of vat agent list --debug.',
};

const AgentListDataSchema = z.object({
  /** The directory the search paths resolve against (the working directory): the only absolute path. */
  root: z.string(),
  agents: z.array(z.object({
    /** `metadata.name` from the agent's manifest. */
    name: z.string(),
    /** `metadata.version` from the agent's manifest. */
    version: z.string().nullable(),
    /** The agent directory, relative to `root`. */
    path: z.string(),
  }).strict()),
}).strict();

export type AgentListData = z.infer<typeof AgentListDataSchema>;

/** The document this command publishes. */
export const AGENT_LIST_REPORT_SCHEMA = reportSchema(AgentListDataSchema, FindingSchema);

export type AgentListReport = Report<AgentListData>;

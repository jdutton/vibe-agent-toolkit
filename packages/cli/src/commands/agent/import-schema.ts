/**
 * The document `vat agent import` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * One skill per run: `examined` is 1 when it was imported. An import that could
 * not finish is the envelope's error branch — the refusal `importSkillToAgent`
 * names at its cause — never a finding, so an import publishes `ok` or `error`.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat agent import`, and the remedy when it is zero. */
export const AGENT_IMPORT_EXAMINED: ExaminedDeclaration = {
  unit: 'skills imported',
  whenZero: 'No skill was imported — point the command at a SKILL.md file.',
};

const AgentImportDataSchema = z.object({
  /** The agent.yaml the import wrote. */
  agentPath: z.string(),
}).strict();

export type AgentImportData = z.infer<typeof AgentImportDataSchema>;

/** The document this command publishes. */
export const AGENT_IMPORT_REPORT_SCHEMA = reportSchema(AgentImportDataSchema, FindingSchema);

export type AgentImportReport = Report<AgentImportData>;

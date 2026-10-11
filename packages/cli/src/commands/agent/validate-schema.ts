/**
 * The document `vat agent validate` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 *
 * One manifest per run: `examined` is 1 when it was read, and a manifest that
 * could not be read at all is the envelope's error branch, never a finding.
 * `data.root` is the working directory the argument was resolved against; the
 * manifest's `path` and every finding's `location` are relative to it.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat agent validate`, and the remedy when it is zero. */
export const AGENT_VALIDATE_EXAMINED: ExaminedDeclaration = {
  unit: 'manifests',
  whenZero: 'No agent manifest was read — point the command at an agent directory holding agent.yaml, the manifest file itself, or an agent name vat agent list shows.',
};

const AgentValidateDataSchema = z.object({
  /** The working directory — the ONE base the manifest `path` and every finding `location` are relative to. */
  root: z.string(),
  manifest: z.object({
    /** `metadata.name`; `null` when the manifest does not validate far enough to say. */
    name: z.string().nullable(),
    /** `metadata.version`; `null` when the manifest declares none or does not validate. */
    version: z.string().nullable(),
    /** The manifest file, relative to `root`. */
    path: z.string(),
  }).strict(),
}).strict();

export type AgentValidateData = z.infer<typeof AgentValidateDataSchema>;

/** The document this command publishes. */
export const AGENT_VALIDATE_REPORT_SCHEMA = reportSchema(AgentValidateDataSchema, FindingSchema);

export type AgentValidateReport = Report<AgentValidateData>;

/**
 * The document `vat skill test configure` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` is the one config file the run updated. `--print` publishes no
 * report: its stdout is the updated config text itself (the
 * `skill-test-config` stdout artifact), so it can be redirected over the file.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat skill test configure`, and the remedy when it is zero. */
export const SKILL_TEST_CONFIGURE_EXAMINED: ExaminedDeclaration = {
  unit: 'config files',
  whenZero: 'Run the command from inside a project holding vibe-agent-toolkit.config.yaml.',
};

const SkillTestConfigureDataSchema = z.object({
  /** The config file written, relative to the working directory. */
  configPath: z.string(),
  /** The key under `skills.config` whose `test` block was upserted. */
  skill: z.string(),
}).strict();

/** The document this command publishes. */
export const SKILL_TEST_CONFIGURE_REPORT_SCHEMA = reportSchema(SkillTestConfigureDataSchema, FindingSchema);

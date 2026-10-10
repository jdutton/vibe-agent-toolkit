/**
 * The document `vat ard emit --format json` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

/**
 * What the run reports beyond its findings.
 *
 * 🪤 `entryCount: 0` is the empty manifest. A run that wrote `{"entries":[]}`
 * and one that wrote a full catalogue both used to end at exit 0 with a
 * cheerful line on stdout, and nothing a machine could read told them apart —
 * so a CI step that emits and publishes was green over a discovery document
 * advertising nothing. The envelope's `examined` is every configured surface
 * the run considered, so "nothing declared" (`examined: 0`) and "everything
 * declared was skipped" (`examined: N`, `entryCount: 0`) read differently too.
 */
const ArdEmitDataSchema = z.object({
  /** Where the manifest was written — `null` when the project produced none. */
  outputPath: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  /**
   * Counts BESIDE the findings. The count is what a CI step gates on without
   * a JSON path into an array; the finding is what the human it pages then
   * acts on. Publishing only one of them answers "how many" or "which", never
   * both.
   */
  skippedCount: z.number().int().nonnegative(),
  shadowedCount: z.number().int().nonnegative(),
}).strict();

export type ArdEmitData = z.infer<typeof ArdEmitDataSchema>;

/** The document `--format json` publishes. */
export const ARD_EMIT_REPORT_SCHEMA = reportSchema(ArdEmitDataSchema, FindingSchema);

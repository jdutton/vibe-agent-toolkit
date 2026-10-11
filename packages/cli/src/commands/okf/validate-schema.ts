/**
 * The document `vat okf validate` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

/** One checked bundle's `data` row: what was read, never the findings (those are the envelope's). */
const OkfBundleSummarySchema = z.object({
  /** The `okf.bundles.<name>` key. */
  bundle: z.string(),
  /** The root as the config file wrote it — never the resolved absolute path. */
  root: z.string(),
  /** Every non-reserved `.md` beneath the root, bundle-relative and sorted. */
  conceptDocuments: z.array(z.string()),
  /** Every `index.md` / `log.md` beneath the root, bundle-relative and sorted. */
  reservedDocuments: z.array(z.string()),
  /** What the root `index.md` declares, when it declares a well-formed one. Reported, never obeyed. */
  declaredOkfVersion: z.string().optional(),
}).strict();

const OkfValidateDataSchema = z.object({
  bundles: z.array(OkfBundleSummarySchema),
  /**
   * Present only when there was nothing to check, and says what to declare or
   * which root to look at.
   *
   * 🪤 The command used to print `status: passed`, `bundles: []`, exit 0 when a
   * project declared no `okf.bundles` at all — a report indistinguishable from
   * a bundle read in full and found conformant, so a mistyped key
   * (`okf.bundle:`, `okf.Bundles:`) read as a clean bill of health. The
   * envelope's REQUIRED `examined` now says `0` in that case, this sentence
   * says why, and the run is refused (`RESOURCE_CHECK_BROKEN`, exit 1): a gate
   * that examined nothing must not read as a pass to a consumer gating on the
   * status or the exit code. A project that declares no bundles has no reason
   * to run this verb.
   */
  notice: z.string().optional(),
}).strict();

export type OkfValidateData = z.infer<typeof OkfValidateDataSchema>;

/** The document this command publishes. */
export const OKF_VALIDATE_REPORT_SCHEMA = reportSchema(OkfValidateDataSchema, FindingSchema);

export type OkfValidateReport = Report<OkfValidateData>;

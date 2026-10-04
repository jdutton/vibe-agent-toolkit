/**
 * The document `vat corpus scan` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the seed entries the scan ran over. The per-plugin audit
 * documents and the run index are file artifacts beside it (`corpus-audit`,
 * `corpus-summary`); this document is the run's own outcome, one row per entry.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat corpus scan`, and the remedy when it is zero. */
export const CORPUS_SCAN_EXAMINED: ExaminedDeclaration = {
  unit: 'seed entries',
  whenZero: 'The seed lists no plugins — add at least one entry under plugins: in the seed file.',
};

const CorpusScanDataSchema = z.object({
  outDir: z.string(),
  entries: z.array(z.object({
    name: z.string(),
    audit: z.enum(['ok', 'findings', 'unloadable']),
    review: z.enum(['ok', 'skipped', 'error']),
    // The entry's `<name>-audit.yaml`, relative to `outDir` (`<run dir>/<name>-audit.yaml`); `null` when unloadable.
    outputPath: z.string().nullable(),
  }).strict()),
}).strict();

export type CorpusScanData = z.infer<typeof CorpusScanDataSchema>;

/** The document this command publishes. */
export const CORPUS_SCAN_REPORT_SCHEMA = reportSchema(CorpusScanDataSchema, FindingSchema);

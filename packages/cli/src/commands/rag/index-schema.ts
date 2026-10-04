/**
 * The document `vat rag index` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes) — and because the registry loads at startup,
 * so this file must not import `@vibe-agent-toolkit/rag` or `rag-lancedb` (the
 * optional backend) at runtime.
 *
 * `examined` counts the resources submitted: every markdown file the crawl
 * enumerated, read or not. Each one the index does not hold — a file the crawl
 * could not read, or one the provider failed to chunk or embed — is a
 * `RAG_DOCUMENT_INDEX_FAILED` finding (error, exit 1) located at its path; the
 * counters still report everything that did land.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat rag index`, and the remedy when it is zero. */
export const RAG_INDEX_EXAMINED: ExaminedDeclaration = {
  unit: 'resources submitted',
  whenZero: 'No markdown file was found to index: check the path argument, or the resources include/exclude patterns in vibe-agent-toolkit.config.yaml.',
};

const count = z.number().int().nonnegative();

const RagIndexDataSchema = z.object({
  resourcesIndexed: count,
  resourcesSkipped: count,
  resourcesEmpty: count,
  resourcesUpdated: count,
  chunksCreated: count,
  chunksDeleted: count,
}).strict();

export type RagIndexData = z.infer<typeof RagIndexDataSchema>;

/** The document this command publishes. */
export const RAG_INDEX_REPORT_SCHEMA = reportSchema(RagIndexDataSchema, FindingSchema);

export type RagIndexReport = Report<RagIndexData>;

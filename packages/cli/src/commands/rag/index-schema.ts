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
 * enumerated, admitted or not. One the provider failed to chunk or embed is a
 * `RAG_DOCUMENT_INDEX_FAILED` finding located at its path; one the crawl could
 * not read or refused to parse is its `RESOURCE_*` not-admitted finding, as in
 * every crawling verb (an error by default, exit 1). The counters still report
 * everything that did land.
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

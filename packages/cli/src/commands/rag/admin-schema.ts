/**
 * The documents `vat rag stats` and `vat rag clear` publish, apart from the
 * commands (see `index-schema.ts` for why a sibling, and why no runtime import
 * of the RAG packages). One module for both: each opens one database and
 * reports on it, and neither can reach `findings`.
 *
 * `examined` counts the databases opened — always one, the `--db` path or the
 * project's `.rag-db`.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat rag stats` and `vat rag clear`, and the remedy when it is zero. */
export const RAG_DATABASE_EXAMINED: ExaminedDeclaration = {
  unit: 'databases opened',
  whenZero: 'No RAG database was opened, which is a defect in VAT — report it with the output of the command run with --debug.',
};

const count = z.number().int().nonnegative();

const RagStatsDataSchema = z.object({
  totalChunks: count,
  totalResources: count,
  dbSizeBytes: count,
  embeddingModel: z.string(),
  /** ISO 8601: when the database was last indexed. */
  lastIndexed: z.string(),
}).strict();

export type RagStatsData = z.infer<typeof RagStatsDataSchema>;

/** The document `vat rag stats` publishes. */
export const RAG_STATS_REPORT_SCHEMA = reportSchema(RagStatsDataSchema, FindingSchema);

export type RagStatsReport = Report<RagStatsData>;

const RagClearDataSchema = z.object({ cleared: z.literal(true) }).strict();

export type RagClearData = z.infer<typeof RagClearDataSchema>;

/** The document `vat rag clear` publishes. */
export const RAG_CLEAR_REPORT_SCHEMA = reportSchema(RagClearDataSchema, FindingSchema);

export type RagClearReport = Report<RagClearData>;

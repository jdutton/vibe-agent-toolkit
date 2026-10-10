/**
 * RAG stats command - show database statistics
 */

import { buildReport } from '@vibe-agent-toolkit/schema';

import { endWithReport } from '../../utils/document-writer.js';

import type { RagStatsReport } from './admin-schema.js';
import { executeRagOperation, RAG_GATE } from './command-helpers.js';

interface StatsOptions {
  db?: string;
  debug?: boolean;
}

/** One database is opened and reported on. */
const DATABASES_OPENED = 1;

export async function statsCommand(options: StatsOptions): Promise<void> {
  const startTime = Date.now();

  const stats = await executeRagOperation('rag stats', options, (ragProvider) => ragProvider.getStats());

  const report: RagStatsReport = buildReport({
    examined: DATABASES_OPENED,
    findings: [],
    data: {
      totalChunks: stats.totalChunks,
      totalResources: stats.totalResources,
      dbSizeBytes: stats.dbSizeBytes,
      embeddingModel: stats.embeddingModel,
      lastIndexed: stats.lastIndexed.toISOString(),
    },
    gate: RAG_GATE,
    durationMs: Date.now() - startTime,
  });
  endWithReport('rag stats', report, 'yaml');
}

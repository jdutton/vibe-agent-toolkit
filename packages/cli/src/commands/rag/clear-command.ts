/**
 * RAG clear command - remove all indexed data from database
 */

import type { RAGAdminProvider } from '@vibe-agent-toolkit/rag';
import { buildReport } from '@vibe-agent-toolkit/schema';

import { endWithReport } from '../../utils/document-writer.js';

import type { RagClearReport } from './admin-schema.js';
import { executeRagOperation, RAG_GATE } from './command-helpers.js';

interface ClearOptions {
  db?: string;
  debug?: boolean;
}

/** One database is opened and cleared. */
const DATABASES_OPENED = 1;

export async function clearCommand(options: ClearOptions): Promise<void> {
  const startTime = Date.now();

  await executeRagOperation(
    'rag clear',
    { ...options, readonly: false }, // Admin mode for write operations
    async (ragProvider) => {
      // Clear database (cast to RAGAdminProvider since readonly: false)
      await (ragProvider as RAGAdminProvider).clear();
    },
  );

  const report: RagClearReport = buildReport({
    examined: DATABASES_OPENED,
    findings: [],
    data: { cleared: true },
    gate: RAG_GATE,
    durationMs: Date.now() - startTime,
  });
  endWithReport('rag clear', report, 'yaml');
}

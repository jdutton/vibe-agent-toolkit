/**
 * RAG clear command - remove all indexed data from database
 */

import { removeRagDatabase } from '@vibe-agent-toolkit/rag-lancedb';
import { buildReport } from '@vibe-agent-toolkit/schema';

import { endWithReport } from '../../utils/document-writer.js';

import type { RagClearReport } from './admin-schema.js';
import { onRagDatabase, RAG_GATE } from './command-helpers.js';

interface ClearOptions {
  db?: string;
  debug?: boolean;
}

/** One database is recognised and removed. */
const DATABASES_CLEARED = 1;

export async function clearCommand(options: ClearOptions): Promise<void> {
  const startTime = Date.now();

  // Removed WITHOUT opening it: a database whose files are damaged cannot be
  // opened, and clearing it is the documented way out. `onRagDatabase` has
  // already refused any path that is not a RAG database.
  await onRagDatabase('rag clear', options, (dbPath) => {
    removeRagDatabase(dbPath);
  });

  const report: RagClearReport = buildReport({
    examined: DATABASES_CLEARED,
    findings: [],
    data: { cleared: true },
    gate: RAG_GATE,
    durationMs: Date.now() - startTime,
  });
  endWithReport('rag clear', report, 'yaml');
}

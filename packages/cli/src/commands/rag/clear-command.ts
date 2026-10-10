/**
 * RAG clear command - remove all indexed data from database
 */

import { removeRagDatabase } from '@vibe-agent-toolkit/rag-lancedb';
import { buildReport, toFindings } from '@vibe-agent-toolkit/schema';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, leftoverIssueOf } from '../../utils/document-writer.js';
import { notRemovableRefusal } from '../../utils/rag-database.js';

import type { RagClearReport } from './admin-schema.js';
import { onRagDatabase, RAG_GATE } from './command-helpers.js';

interface ClearOptions {
  db?: string;
  debug?: boolean;
}

/** One database is recognised and removed. */
const DATABASES_CLEARED = 1;

/** What a clear that finished publishes as `data`. */
const CLEARED = { cleared: true } as const;

export async function clearCommand(options: ClearOptions): Promise<void> {
  const startTime = Date.now();
  const explicit = options.db !== undefined && options.db !== '';

  // Removed WITHOUT opening it: a database whose files are damaged cannot be
  // opened, and clearing it is the documented way out. `onRagDatabase` has
  // already refused any path that is not a RAG database; the removal's own plan
  // refuses a link to one (removing the link would leave the database in place).
  const { leftover } = await onRagDatabase('rag clear', 'destination', options, (dbPath) =>
    removeRagDatabase(dbPath).catch((error: unknown) => {
      throw notRemovableRefusal(error, dbPath, explicit);
    }),
  );
  // Off its path the database is cleared; a deletion the OS then stopped is still the run not
  // finishing, published beside the clear it finished and a warning naming where the rest is.
  if (leftover !== undefined) {
    endWithRefusal('rag clear', refusalCodeOf(leftover), leftover, 'yaml', RAG_GATE, { examined: DATABASES_CLEARED, findings: toFindings([leftoverIssueOf(leftover)]), data: CLEARED });
  }

  const report: RagClearReport = buildReport({
    examined: DATABASES_CLEARED,
    findings: [],
    data: CLEARED,
    gate: RAG_GATE,
    durationMs: Date.now() - startTime,
  });
  endWithReport('rag clear', report, 'yaml');
}

/**
 * RAG clear command - remove all indexed data from database
 */

import type { RAGAdminProvider } from '@vibe-agent-toolkit/rag';

import { writeYamlOutput } from '../../utils/output.js';

import { executeRagOperation, formatDuration } from './command-helpers.js';

interface ClearOptions {
  db?: string;
  debug?: boolean;
}

export async function clearCommand(options: ClearOptions): Promise<void> {
  const startTime = Date.now();

  await executeRagOperation(
    { ...options, readonly: false }, // Admin mode for write operations
    async (ragProvider) => {
      // Clear database (cast to RAGAdminProvider since readonly: false)
      await (ragProvider as RAGAdminProvider).clear();
    },
    'Clear'
  );

  const duration = Date.now() - startTime;

  // Output success
  writeYamlOutput({
    status: 'success',
    message: 'Database cleared',
    duration: formatDuration(duration),
  });

  process.exit(0);
}

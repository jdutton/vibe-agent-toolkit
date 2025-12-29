/**
 * RAG stats command - show database statistics
 */

import { writeYamlOutput } from '../../utils/output.js';

import { executeRagOperation, formatDuration } from './command-helpers.js';

interface StatsOptions {
  db?: string;
  debug?: boolean;
}

export async function statsCommand(options: StatsOptions): Promise<void> {
  const startTime = Date.now();

  const stats = await executeRagOperation(
    options,
    async (ragProvider) => {
      // Get stats
      return await ragProvider.getStats();
    },
    'Stats'
  );

  const duration = Date.now() - startTime;

  // Output stats as YAML
  writeYamlOutput({
    status: 'success',
    totalChunks: stats.totalChunks,
    totalResources: stats.totalResources,
    embeddingModel: stats.embeddingModel,
    duration: formatDuration(duration),
  });

  process.exit(0);
}

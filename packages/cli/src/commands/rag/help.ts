/**
 * Verbose help for RAG commands
 */

import { loadVerboseHelp } from '../../utils/help-loader.js';

export function showRagVerboseHelp(): void {
  const helpContent = loadVerboseHelp('rag'); // Loads from docs/rag.md
  process.stdout.write(helpContent);
  process.stdout.write('\n');
}

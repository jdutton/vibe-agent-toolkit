/**
 * Verbose help for RAG commands
 */

import { loadVerboseHelp, writeHelpSync } from '../../utils/help-loader.js';

export function showRagVerboseHelp(): void {
  writeHelpSync(loadVerboseHelp('rag')); // Loads from docs/rag.md
}

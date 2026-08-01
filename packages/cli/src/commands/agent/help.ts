/**
 * Verbose help for agent commands
 */

import { loadVerboseHelp, writeHelpSync } from '../../utils/help-loader.js';

export function showAgentVerboseHelp(): void {
  writeHelpSync(loadVerboseHelp('agent')); // Loads from docs/agent.md
}

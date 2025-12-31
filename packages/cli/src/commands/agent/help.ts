/**
 * Verbose help for agent commands
 */

import { loadVerboseHelp } from '../../utils/help-loader.js';

export function showAgentVerboseHelp(): void {
  const helpContent = loadVerboseHelp('agent'); // Loads from docs/agent.md
  process.stdout.write(helpContent);
  process.stdout.write('\n');
}

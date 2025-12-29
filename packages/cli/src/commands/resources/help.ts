/**
 * Verbose help for resources commands
 */

import { loadVerboseHelp } from '../../utils/help-loader.js';

export function showResourcesVerboseHelp(): void {
  const helpContent = loadVerboseHelp('resources'); // Loads from docs/cli/resources.md
  process.stdout.write(helpContent);
  process.stdout.write('\n');
}

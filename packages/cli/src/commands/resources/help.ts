/**
 * Verbose help for resources commands
 */

import { loadVerboseHelp, writeHelpSync } from '../../utils/help-loader.js';

export function showResourcesVerboseHelp(): void {
  writeHelpSync(loadVerboseHelp('resources')); // Loads from docs/cli/resources.md
}

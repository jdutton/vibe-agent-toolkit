import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const binPath = safePath.resolve(__dirname, '../dist/bin.js');

/**
 * Execute a CLI command using the built bin.js
 * Safe for use in tests - binPath is resolved at module load time
 */
export function runCliCommand(command: string, ...args: string[]): SpawnSyncReturns<string> {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
  return spawnSync('node', [binPath, command, ...args], {
    encoding: 'utf-8',
  });
}

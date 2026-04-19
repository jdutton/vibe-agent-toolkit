import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { AuditCommandOptions } from '../src/commands/audit.js';
import { getValidationResults } from '../src/commands/audit.js';

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

/**
 * Silent logger for use in integration tests — suppresses all output.
 */
export const silentAuditLogger = {
  info: (_msg: string): void => {},
  error: (_msg: string): void => {},
  debug: (_msg: string): void => {},
};

/**
 * Run `vat audit` validation directly against a target path (no CLI subprocess).
 * options.recursive defaults to true (recursive by default); set to false to disable.
 */
export async function runAudit(
  targetPath: string,
  options: AuditCommandOptions = {}
): ReturnType<typeof getValidationResults> {
  return getValidationResults(targetPath, options.recursive !== false, options, silentAuditLogger);
}

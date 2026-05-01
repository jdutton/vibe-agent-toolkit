import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { AuditCommandOptions } from '../src/commands/audit.js';
import { getValidationResults, resetAuditCaches } from '../src/commands/audit.js';

import { type CliResult, executeCli } from './system/test-helpers/cli-runner.js';

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
  // Mirror auditCommand's cache reset so sibling tests sharing a vitest
  // worker (e.g. Windows fork pool with maxForks: 2) don't observe stale
  // GitTrackers / governing-config / skill-discovery caches.
  resetAuditCaches();
  return getValidationResults(targetPath, options.recursive !== false, options, silentAuditLogger);
}

/**
 * Run `vat audit <target>` via the CLI subprocess and return exit code +
 * stdout + stderr. Use this for integration tests that assert on CLI
 * output (provenance headers, formatted YAML, process exit behavior).
 * For tests that only need validation results, use {@link runAudit}
 * (direct in-process call).
 */
export function runAuditCli(
  target: string,
  extraArgs: string[] = [],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): CliResult {
  return executeCli(binPath, ['audit', target, ...extraArgs], options);
}

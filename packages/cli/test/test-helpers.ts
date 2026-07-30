import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { AuditCommandOptions } from '../src/commands/audit.js';
import { deriveScanRoot, getValidationResults, resetAuditCaches } from '../src/commands/audit.js';

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
  warn: (_msg: string): void => {},
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
  return getValidationResults(
    targetPath,
    options.recursive !== false,
    options,
    silentAuditLogger,
    deriveScanRoot(targetPath),
  );
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

/**
 * Initialize a throwaway git repo (main branch, quiet) with a committable
 * identity, so integration fixtures that rely on a real git root / `git
 * ls-files` behave deterministically. Shared to keep this boilerplate in one
 * place across fixture-based integration tests.
 */
export function initTestGitRepo(dir: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
  spawnSync('git', ['init', '-b', 'main', '--quiet', dir], { stdio: 'ignore' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo config in tests
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo config in tests
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
}

/** Stage every file under a fixture git repo (so `git ls-files` walkers see them). */
export function gitAddAll(dir: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for staging files in tests
  spawnSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
}

/**
 * CLI-boundary policy helpers for projectRoot resolution.
 *
 * Root discovery belongs at the CLI boundary, not inside libraries. Each command
 * picks exactly one of these to fulfill its declared policy:
 *
 *  - `required`     → {@link requireProjectRoot}     — fails fast with a clear message.
 *  - `loud-cwd`     → {@link projectRootOrLoudCwd}   — falls back to cwd with a stderr warning.
 *  - `tolerate null`→ {@link projectRootOrNull}      — returns null; caller handles it.
 *
 * These helpers MUST be invoked at the CLI dispatch boundary (top-level command
 * `.action(...)` callbacks). Inner library functions should take the resolved
 * root as a parameter — never call `findProjectRoot` themselves.
 */

import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';

import type { Logger } from './logger.js';

/**
 * `required` policy — refuse to run if no projectRoot can be discovered.
 *
 * @throws Error with a clear "command requires a config or git ancestor" message.
 */
export function requireProjectRoot(startDir: string, commandName: string): string {
  const root = findProjectRoot(startDir);
  if (root === null) {
    throw new Error(
      `${commandName} requires a vibe-agent-toolkit.config.yaml or .git/ ancestor. ` +
        `Run from inside a VAT project or initialize one.`,
    );
  }
  return root;
}

/**
 * `loud-cwd` policy — fall back to cwd with an explicit stderr log message.
 *
 * The message format is documented in spec §7 and asserted by integration tests:
 *   `no vibe-agent-toolkit.config.yaml or .git/ ancestor found; using <cwd> as projectRoot`
 */
export function projectRootOrLoudCwd(startDir: string, logger: Logger): string {
  const root = findProjectRoot(startDir);
  if (root !== null) return root;
  const cwd = safePath.resolve(startDir);
  logger.warn(
    `no vibe-agent-toolkit.config.yaml or .git/ ancestor found; using ${cwd} as projectRoot`,
  );
  return cwd;
}

/**
 * `tolerate null` policy — return `string | null`; caller handles either case.
 */
export function projectRootOrNull(startDir: string): string | null {
  return findProjectRoot(startDir);
}

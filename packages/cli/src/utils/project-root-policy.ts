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

import { existsSync, statSync } from 'node:fs';

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

/**
 * Fail loudly on a `[path]` argument that names no directory.
 *
 * Every `resources` verb takes an optional `[path]`, and two things can be
 * meant by it: a SCOPE (`scan`, `validate` — crawl this subtree) or a LOCATOR
 * (`query`, `check` — find the project from here; the projection is always the
 * whole tree). Both start by resolving the argument, and both must refuse one
 * that resolves to nothing — the scoping verbs would otherwise degrade into a
 * glob matching nothing (`filesScanned: 0`, green), and the locating verbs
 * walked UP from the missing path to whatever project the cwd is in and
 * answered about THAT tree at exit 0, byte-identical to a correct run.
 *
 * One function so the two families refuse with one message; a reader who saw
 * `validate` say "Path does not exist" should get the same words from `query`.
 *
 * @param pathArg - The argument as typed, relative to cwd or absolute
 * @returns The resolved absolute path
 * @throws When it does not exist or is not a directory
 */
export function assertDirectoryArgument(pathArg: string): string {
  const resolved = safePath.resolve(pathArg);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI path argument, resolved above
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI path argument, existence checked above
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

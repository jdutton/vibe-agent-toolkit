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

import { accessSync, constants, lstatSync, readFileSync, statSync, type Stats } from 'node:fs';

import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { findProjectRoot, isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';
import type { Logger } from './logger.js';

/**
 * `required` policy — refuse to run if no projectRoot can be discovered.
 *
 * @throws Error with a clear "command requires a config or git ancestor" message.
 */
export function requireProjectRoot(startDir: string, commandName: string): string {
  const root = findProjectRoot(startDir);
  if (root === null) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
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
 * @throws {CommandRefusalError} `USAGE_INVALID` when it does not exist or is not a directory;
 *   `INPUT_UNREADABLE` when the OS refuses the `stat` (e.g. an `EACCES` parent)
 */
export function assertDirectoryArgument(pathArg: string): string {
  const resolved = safePath.resolve(pathArg);
  const refusal = directoryRefusal(resolved);
  if (refusal !== undefined) throw refusal;
  return resolved;
}

/**
 * The refusal for a path argument whose `stat` (or `lstat`) threw — the ONE
 * absent-vs-unreadable predicate every path verb classifies with.
 *
 * Only an ABSENCE is the invocation's mistake (`USAGE_INVALID`). Any other
 * error — an `EACCES` parent the process may not traverse, an `ELOOP` — means
 * whether the path exists is unknown: the INPUT's refusal (`INPUT_UNREADABLE`),
 * never "does not exist" and never a scan that starts anyway. Never classify
 * with `existsSync`: it answers `false` for both.
 *
 * @param resolved - The resolved path that was stat'ed
 * @param error - What the `stat` threw
 * @returns The refusal to throw or return
 */
export function unstatablePathRefusal(resolved: string, error: unknown): CommandRefusalError {
  if (isPathAbsentError(error)) return new CommandRefusalError('USAGE_INVALID', `Path does not exist: ${resolved}`, { cause: error });
  const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
  return new CommandRefusalError('INPUT_UNREADABLE', `Path cannot be read (${code}): ${resolved}`, { cause: error });
}

/**
 * Whether something is at `path`, asked the way the caller will USE it — so the
 * mode is required, never defaulted:
 *
 * - `'entry'` (`lstat`): is there a directory entry at all, a dangling link
 *   included? Right before writing there — `existsSync` calls a dangling link
 *   absent, and the copy then trips over it.
 * - `'follow'` (`stat`): does it resolve to something that can be read? Right
 *   before reading or staging from it — a dangling link is absent, so the caller
 *   refuses it by its own "not there" message instead of failing later.
 *
 * A `stat`/`lstat` the OS refuses is the input's refusal
 * ({@link unstatablePathRefusal}), never "absent".
 *
 * @throws {CommandRefusalError} `INPUT_UNREADABLE` when the OS refuses the probe
 */
export function pathPresent(path: string, mode: 'entry' | 'follow'): boolean {
  try {
    if (mode === 'entry') lstatSync(path);
    else statSync(path);
    return true;
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw unstatablePathRefusal(path, error);
  }
}

/** What an absent input means at its call site: which refusal, and the sentence naming the remedy. */
interface AbsentInput {
  readonly code: RefusalCode;
  readonly message: string;
}

/**
 * The refusal for an input the CONFIG or an earlier step names — not a
 * command-line argument — whose `stat` or read threw.
 *
 * The same absent-vs-unreadable split as {@link unstatablePathRefusal}, but an
 * absence is the caller's to name: a `files[].source` nothing built, a
 * `publish.changelog` naming no file. Anything else is `INPUT_UNREADABLE`.
 */
function inputRefusal(resolved: string, error: unknown, absent: AbsentInput): CommandRefusalError {
  if (isPathAbsentError(error)) return new CommandRefusalError(absent.code, absent.message, { cause: error });
  return unstatablePathRefusal(resolved, error);
}

/** A config key naming a file that is not there: the config's mistake. */
export function configNamedFileAbsent(key: string, named: string): AbsentInput {
  return { code: 'CONFIG_INVALID', message: `${key} names ${named}, which does not exist.` };
}

/**
 * Refuse unless `resolved` can be stat'ed.
 *
 * @throws {CommandRefusalError} `absent` when nothing is there; `INPUT_UNREADABLE` when the OS refuses the `stat`
 */
export function requireInputPath(resolved: string, absent: AbsentInput): void {
  try {
    statSync(resolved);
  } catch (error) {
    throw inputRefusal(resolved, error, absent);
  }
}

/**
 * Read a UTF-8 input file, refusing like {@link requireInputPath}.
 *
 * @throws {CommandRefusalError} `absent` when nothing is there; `INPUT_UNREADABLE` when it cannot be read
 */
export function readInputFile(resolved: string, absent: AbsentInput): string {
  try {
    return readFileSync(resolved, 'utf-8');
  } catch (error) {
    throw inputRefusal(resolved, error, absent);
  }
}

/**
 * Why `resolved` is not a usable directory, or `undefined` when it is one.
 * A `stat` that throws is classified by {@link unstatablePathRefusal}.
 */
function directoryRefusal(resolved: string): CommandRefusalError | undefined {
  let stats: Stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    return unstatablePathRefusal(resolved, error);
  }
  if (!stats.isDirectory()) return new CommandRefusalError('USAGE_INVALID', `Path is not a directory: ${resolved}`);
  return undefined;
}

/**
 * Why a DIRECTORY argument cannot be read, or `undefined` when it can be.
 *
 * A probe, not a listing: the verb's own walk owns enumeration; this only asks
 * whether it can start. A directory the OS will not let the process list or
 * enter is an input that exists and cannot be read — `INPUT_UNREADABLE`, never
 * "not found" and never a finding about a tree nothing was read from.
 *
 * @param dir - The resolved argument, known to be a directory
 * @returns The `INPUT_UNREADABLE` refusal, or `undefined`
 */
export function unlistableDirectoryRefusal(dir: string): CommandRefusalError | undefined {
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    return new CommandRefusalError('INPUT_UNREADABLE', `Path cannot be read (${code}): ${dir}`, { cause: error });
  }
}

/**
 * {@link assertDirectoryArgument}, plus the one more way a directory argument
 * can leave nothing to examine: the OS will not let the process read it.
 *
 * @param pathArg - The argument as typed, relative to cwd or absolute
 * @returns The resolved absolute path
 * @throws {CommandRefusalError} `USAGE_INVALID` when it does not exist or is not a
 *   directory; `INPUT_UNREADABLE` when it cannot be listed
 */
export function assertReadableDirectoryArgument(pathArg: string): string {
  const resolved = safePath.resolve(pathArg);
  const refusal = readableDirectoryRefusal(resolved);
  if (refusal !== undefined) throw refusal;
  return resolved;
}

/**
 * Why `resolved` cannot be read as a directory — absent or not a directory
 * (`USAGE_INVALID`), or refused by the OS (`INPUT_UNREADABLE`) — or
 * `undefined`. The one judgement behind {@link assertReadableDirectoryArgument}
 * and the skills scope guard.
 *
 * @param resolved - The resolved argument
 */
export function readableDirectoryRefusal(resolved: string): CommandRefusalError | undefined {
  return directoryRefusal(resolved) ?? unlistableDirectoryRefusal(resolved);
}

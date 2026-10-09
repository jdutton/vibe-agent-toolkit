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

import { accessSync, constants, readFileSync, statSync, type Stats } from 'node:fs';

import { fsFaultRefusal } from '@vibe-agent-toolkit/schema';
import { classifyFsFault, findProjectRoot, type FsFaultContext, isFsFaultError, safePath, type SourceOrigin } from '@vibe-agent-toolkit/utils';

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
 * @throws {CommandRefusalError} `USAGE_INVALID` when it is not a directory
 * @throws {FsFaultError} a `source` fault named by an argument when the `stat` throws:
 *   absent is the table's `USAGE_INVALID`, a refusal (an `EACCES` parent) `INPUT_UNREADABLE`
 */
export function assertDirectoryArgument(pathArg: string): string {
  const resolved = safePath.resolve(pathArg);
  const refusal = directoryRefusal(resolved);
  if (refusal !== undefined) throw refusal;
  return resolved;
}

/**
 * How a `stat`, `lstat` or read of a path the command line named is classified: a
 * `source` fault of origin `argument`. Only an ABSENCE is the invocation's mistake (the
 * table's `USAGE_INVALID`); any other error — an `EACCES` parent the process may not
 * traverse, an `ELOOP` — means whether the path exists is unknown: the INPUT's refusal,
 * never "does not exist" and never a scan that starts anyway. Never classify with
 * `existsSync`: it answers `false` for both.
 *
 * @param path - The resolved path that was examined
 */
function argumentPath(path: string): FsFaultContext {
  return { side: 'source', origin: 'argument', action: 'read the path', path };
}

/**
 * What an absent input means at its call site: who named it — the refusal table decides
 * the code from that — and the sentence naming the remedy.
 */
interface AbsentInput {
  readonly origin: SourceOrigin;
  readonly message: string;
}

/**
 * The refusal for an input the CONFIG, an earlier step or the command line names whose
 * `stat` or read threw: classified as a `source` fault of the input's origin. An absence
 * keeps the caller's sentence — a `files[].source` nothing built, a `publish.changelog`
 * naming no file — under the refusal the table owes that origin, carrying the classified
 * fault as its cause; anything else is the classified fault itself.
 */
export function classifyInputFault(resolved: string, error: unknown, absent: AbsentInput): unknown {
  const fault = classifyFsFault(error, { side: 'source', origin: absent.origin, action: 'read the input', path: resolved });
  if (!isFsFaultError(fault) || fault.faultClass !== 'absent') return fault;
  return new CommandRefusalError(fsFaultRefusal('source', 'absent', absent.origin).refusal, absent.message, { cause: fault });
}

/** A config key naming a file that is not there: the config's mistake. */
export function configNamedFileAbsent(key: string, named: string): AbsentInput {
  return { origin: 'config', message: `${key} names ${named}, which does not exist.` };
}

/**
 * Refuse unless `resolved` can be stat'ed.
 *
 * @returns What the `stat` found
 * @throws {CommandRefusalError} `absent` when nothing is there (the refusal its origin owes)
 * @throws {FsFaultError} when the OS refuses the `stat`
 */
export function requireInputPath(resolved: string, absent: AbsentInput): Stats {
  try {
    return statSync(resolved);
  } catch (error) {
    throw classifyInputFault(resolved, error, absent);
  }
}

/**
 * Read a UTF-8 input file, refusing like {@link requireInputPath}.
 *
 * @throws {CommandRefusalError} `absent` when nothing is there (the refusal its origin owes)
 * @throws {FsFaultError} when it cannot be read
 */
export function readInputFile(resolved: string, absent: AbsentInput): string {
  try {
    return readFileSync(resolved, 'utf-8');
  } catch (error) {
    throw classifyInputFault(resolved, error, absent);
  }
}

/**
 * Why `resolved` is not a usable directory, or `undefined` when it is one.
 * A `stat` that throws is classified as the argument's fault ({@link classifyInputFault}):
 * absent says so in the invocation's words.
 */
function directoryRefusal(resolved: string): unknown {
  let stats: Stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    return classifyInputFault(resolved, error, { origin: 'argument', message: `Path does not exist: ${resolved}` });
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
 * @returns The classified `source` fault (origin `argument`), or `undefined`
 */
export function unlistableDirectoryRefusal(dir: string): unknown {
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
    return undefined;
  } catch (error) {
    return classifyFsFault(error, argumentPath(dir));
  }
}

/**
 * {@link assertDirectoryArgument}, plus the one more way a directory argument
 * can leave nothing to examine: the OS will not let the process read it.
 *
 * @param pathArg - The argument as typed, relative to cwd or absolute
 * @returns The resolved absolute path
 * @throws {CommandRefusalError} `USAGE_INVALID` when it is not a directory
 * @throws {FsFaultError} when it does not exist (`USAGE_INVALID`) or cannot be listed
 */
export function assertReadableDirectoryArgument(pathArg: string): string {
  const resolved = safePath.resolve(pathArg);
  const refusal = readableDirectoryRefusal(resolved);
  if (refusal !== undefined) throw refusal;
  return resolved;
}

/**
 * Why `resolved` cannot be read as a directory — absent (a classified argument fault,
 * `USAGE_INVALID`) or not a directory (`USAGE_INVALID`), or refused by the OS (a
 * classified fault, `INPUT_UNREADABLE`) — or `undefined`. The one judgement behind
 * {@link assertReadableDirectoryArgument} and the skills scope guard.
 *
 * @param resolved - The resolved argument
 */
export function readableDirectoryRefusal(resolved: string): unknown {
  return directoryRefusal(resolved) ?? unlistableDirectoryRefusal(resolved);
}

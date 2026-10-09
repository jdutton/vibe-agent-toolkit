/**
 * The staging copy an install (`vat claude plugin install`, `vat skills install`)
 * extracts an archive into before anything under `~/.claude` changes — and which
 * failure is whose, decided by the one classifier (`fsBoundary`) from the path the
 * OS named: the staging directory is VAT's own scratch (`environment`, the run not
 * finishing), the archive is the input (`source`), and a layout fault the archive
 * decided while it was being written into staging — a file `a` beside a file `a/b`,
 * an entry landing on a directory — is the archive's (`shapeFromSource`). Bytes that
 * are no archive at all are the archive's (`INPUT_UNREADABLE`).
 */

import * as nodeFs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';

import { classifyFsFault, fsBoundary, fsFaultOf, isCapacityFault, normalizedTmpdir, relativeEscapesRoot, safePath, withFsFault } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import * as tar from 'tar';

import { CommandRefusalError } from './command-refusal.js';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A fresh staging directory under the OS temp dir; one the OS will not create is an `environment` fault. */
export function makeStagingDir(prefix: string): Promise<string> {
  const template = safePath.join(normalizedTmpdir(), prefix);
  return withFsFault({ side: 'environment', action: 'create a staging directory', path: template }, () => mkdtemp(template));
}

/**
 * Why `archive` could not be read or extracted into staging, nothing outside the
 * staging directory having changed: a filesystem
 * fault classified by the path it names (see the module docstring), or — for
 * anything that is not a filesystem errno, an entry that does not inflate, bytes
 * that are no archive — the archive's `INPUT_UNREADABLE`.
 *
 * @param archive - The archive file the operator named
 * @param staging - The staging directories it was being extracted into; none for a read before any
 * @param error - What the read or the extraction threw
 * @returns The refusal to throw
 */
export function archiveFailure(archive: string, staging: readonly string[], error: unknown): unknown {
  const facts = fsFaultOf(error);
  if (facts === undefined) {
    return new CommandRefusalError('INPUT_UNREADABLE', `${archive} could not be extracted, nothing was changed: ${messageOf(error)}`, { cause: error });
  }
  const [stagingRoot] = staging;
  if (facts.path === undefined && facts.dest === undefined && stagingRoot !== undefined) {
    // An errno that names no path (node-tar's full disk mid-entry) happened while extracting into
    // staging: the refusal still says where — VAT's own scratch — with the errno's classified cause.
    return classifyFsFault(error, { side: 'environment', action: `extract ${archive}`, path: stagingRoot });
  }
  // An archive VAT downloaded into its own staging (an npm package) is the environment's to read.
  const staged = fsBoundary({ environment: staging }).sideOf(archive) === 'environment';
  // Only an entry the archive put strictly INSIDE staging is a layout it decided. The staging root and
  // what is above it (adm-zip makes the root's parents itself) are VAT's scratch, whatever the errno.
  const decidedByArchive = [facts.path, facts.dest].some((path) => path !== undefined && staging.some((root) => strictlyInside(root, path)));
  return fsBoundary({ source: staged ? [] : [archive], environment: staging }, { shapeFromSource: decidedByArchive })
    .classify(error, `extract ${archive}`, staging.length === 0 ? 'source' : 'environment');
}

/** Whether `path` lies under `root` and is not `root` itself. */
function strictlyInside(root: string, path: string): boolean {
  const below = safePath.relative(root, path);
  return below !== '' && !relativeEscapesRoot(below);
}

/**
 * node-tar's extract options that keep every entry failure. Out of `strict`
 * mode node-tar reports a failed entry — `ENOSPC` mid-write included — as a
 * WARNING and resolves, leaving a truncated file; `strict` instead rejects at
 * the first one while later entries are still being written, racing the
 * staging directory's removal. So extraction runs to its end and the failures
 * are kept, the machine's first. `TAR_ENTRY_INFO` (an absolute path made relative)
 * is not a failure.
 */
function keepingEntryFailures(file: string, cwd: string): { options: tar.TarOptionsWithAliasesFile; firstFailure: () => Error | undefined } {
  const failures: Error[] = [];
  const onwarn = (code: string, message: string, data: unknown): void => {
    if (code === 'TAR_ENTRY_INFO') return;
    failures.push(data instanceof Error ? data : Object.assign(new Error(`${code}: ${message}`), { code }));
  };
  // The machine's failure first: a full disk explains the entries that failed after it.
  const capacity = (failure: Error): boolean => {
    const fault = fsFaultOf(failure);
    return fault !== undefined && isCapacityFault(fault);
  };
  return { options: { file, cwd, onwarn }, firstFailure: () => failures.find(capacity) ?? failures[0] };
}

/**
 * Extract the tarball `archive` into the staging directory `cwd`, every entry or none.
 *
 * @throws {@link archiveFailure}
 */
export async function extractTarball(archive: string, cwd: string): Promise<void> {
  const { options, firstFailure } = keepingEntryFailures(archive, cwd);
  try {
    await tar.extract(options);
  } catch (error) {
    throw archiveFailure(archive, [cwd], error);
  }
  const failure = firstFailure();
  if (failure !== undefined) throw archiveFailure(archive, [cwd], failure);
}

/** {@link extractTarball}, synchronously. */
export function extractTarballSync(archive: string, cwd: string): void {
  const { options, firstFailure } = keepingEntryFailures(archive, cwd);
  try {
    tar.extract({ ...options, sync: true });
  } catch (error) {
    throw archiveFailure(archive, [cwd], error);
  }
  const failure = firstFailure();
  if (failure !== undefined) throw archiveFailure(archive, [cwd], failure);
}

/**
 * A ZIP archive opened through a filesystem that remembers why a file could not
 * be OPENED for writing. adm-zip answers a failed `open` by `chmod`ing the path
 * and trying again — and on a file that does not exist yet that `chmod` throws
 * `ENOENT`, which replaces the real errno (`EMFILE`, `EROFS`, `EDQUOT`, ...)
 * and would blame the archive for the run's own failure.
 */
export interface StagedZip {
  readonly zip: AdmZip;
  /** Extract every entry into the staging directory `extracted`. @throws {@link archiveFailure} */
  extractTo(archive: string, extracted: string): void;
}

/**
 * What really stopped an extraction: the failed `open` adm-zip's `chmod` retry hid, when the
 * error is that `chmod` of a path whose `open` was recorded failing; otherwise the error itself.
 *
 * @param error - What `extractAllTo` threw
 * @param openFailures - Each path whose `open` failed, with what it failed with
 */
function openFailureBehind(error: unknown, openFailures: ReadonlyMap<string, unknown>): unknown {
  const { syscall, path } = error as NodeJS.ErrnoException;
  return syscall === 'chmod' && path !== undefined && openFailures.has(path) ? openFailures.get(path) : error;
}

/**
 * Open `archive` (its central directory only; entry data inflates lazily).
 *
 * @param fs - The filesystem adm-zip reads and writes through; node's own by default
 */
export function openZip(archive: string, fs: typeof nodeFs = nodeFs): StagedZip {
  const openFailures = new Map<string, unknown>();
  const recording = {
    ...fs,
    openSync: (...args: Parameters<typeof nodeFs.openSync>): number => {
      try {
        return fs.openSync(...args);
      } catch (error) {
        openFailures.set(String(args[0]), error);
        throw error;
      }
    },
  };
  const zip = new AdmZip(archive, { fs: recording });
  return {
    zip,
    extractTo(source, extracted) {
      try {
        zip.extractAllTo(extracted, /* overwrite */ true);
      } catch (error) {
        throw archiveFailure(source, [extracted], openFailureBehind(error, openFailures));
      }
    },
  };
}

/** Test-facing seam: the pure decisions of this module, reached by its unit tests. */
export const __internal = { keepingEntryFailures, openFailureBehind };

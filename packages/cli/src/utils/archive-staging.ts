/**
 * The staging copy an install (`vat claude plugin install`, `vat skills install`)
 * extracts an archive into before
 * anything under `~/.claude` changes — and which failure is whose: the disk VAT
 * stages on giving out is the run not finishing (`RUN_INCOMPLETE`); an archive
 * that cannot be extracted is the input's (`INPUT_UNREADABLE`).
 */

import * as nodeFs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import * as tar from 'tar';

import { CommandRefusalError } from './command-refusal.js';

/**
 * Errnos that mean the disk VAT writes its staging copy to gave out — full, over
 * quota, read-only, out of descriptors, or failing — whatever archive it was writing.
 */
const STAGING_EXHAUSTED_ERRNOS: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO']);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** VAT could not write its own staging copy at `path`: the run did not finish (`RUN_INCOMPLETE`), nothing was changed. */
export function stagingRefusal(path: string, error: unknown): CommandRefusalError {
  return new CommandRefusalError(
    'RUN_INCOMPLETE',
    `Could not write the staging copy at ${path}, nothing was changed: ${messageOf(error)}. ` +
      'Free space in, or make writable, the temp directory ($TMPDIR), then re-run.',
    { cause: error },
  );
}

/** A fresh staging directory under the OS temp dir; one the OS will not create is {@link stagingRefusal}. */
export async function makeStagingDir(prefix: string): Promise<string> {
  const template = safePath.join(normalizedTmpdir(), prefix);
  try {
    return await mkdtemp(template);
  } catch (error) {
    throw stagingRefusal(template, error);
  }
}

/**
 * Why `archive` could not be extracted into the staging directory `extracted`:
 * the disk giving out is the run not finishing (`RUN_INCOMPLETE`); anything
 * else — an entry that does not inflate, a file `a` beside a file `a/b`, bytes
 * that are no archive — is the archive's (`INPUT_UNREADABLE`). Nothing outside
 * the staging directory changed.
 */
export function archiveExtractionRefusal(archive: string, extracted: string, error: unknown): CommandRefusalError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined && STAGING_EXHAUSTED_ERRNOS.has(code)) return stagingRefusal(extracted, error);
  return new CommandRefusalError('INPUT_UNREADABLE', `${archive} could not be extracted, nothing was changed: ${messageOf(error)}`, { cause: error });
}

/**
 * node-tar's extract options that keep every entry failure. Out of `strict`
 * mode node-tar reports a failed entry — `ENOSPC` mid-write included — as a
 * WARNING and resolves, leaving a truncated file; `strict` instead rejects at
 * the first one while later entries are still being written, racing the
 * staging directory's removal. So extraction runs to its end and the failures
 * are kept, the disk's first. `TAR_ENTRY_INFO` (an absolute path made relative)
 * is not a failure.
 */
function keepingEntryFailures(file: string, cwd: string): { options: tar.TarOptionsWithAliasesFile; firstFailure: () => Error | undefined } {
  const failures: Error[] = [];
  const onwarn = (code: string, message: string, data: unknown): void => {
    if (code === 'TAR_ENTRY_INFO') return;
    failures.push(data instanceof Error ? data : Object.assign(new Error(`${code}: ${message}`), { code }));
  };
  const exhausted = (failure: Error): boolean => STAGING_EXHAUSTED_ERRNOS.has((failure as NodeJS.ErrnoException).code ?? '');
  return { options: { file, cwd, onwarn }, firstFailure: () => failures.find(exhausted) ?? failures[0] };
}

/**
 * Extract the tarball `archive` into the staging directory `cwd`, every entry or none.
 *
 * @throws {@link archiveExtractionRefusal}
 */
export async function extractTarball(archive: string, cwd: string): Promise<void> {
  const { options, firstFailure } = keepingEntryFailures(archive, cwd);
  try {
    await tar.extract(options);
  } catch (error) {
    throw archiveExtractionRefusal(archive, cwd, error);
  }
  const failure = firstFailure();
  if (failure !== undefined) throw archiveExtractionRefusal(archive, cwd, failure);
}

/** {@link extractTarball}, synchronously. */
export function extractTarballSync(archive: string, cwd: string): void {
  const { options, firstFailure } = keepingEntryFailures(archive, cwd);
  try {
    tar.extract({ ...options, sync: true });
  } catch (error) {
    throw archiveExtractionRefusal(archive, cwd, error);
  }
  const failure = firstFailure();
  if (failure !== undefined) throw archiveExtractionRefusal(archive, cwd, failure);
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
  /** Extract every entry into the staging directory `extracted`. @throws {@link archiveExtractionRefusal} */
  extractTo(archive: string, extracted: string): void;
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
        const { syscall, path } = error as NodeJS.ErrnoException;
        const cause = syscall === 'chmod' && path !== undefined && openFailures.has(path) ? openFailures.get(path) : error;
        throw archiveExtractionRefusal(source, extracted, cause);
      }
    },
  };
}

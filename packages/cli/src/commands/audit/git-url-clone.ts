/**
 * Shallow-clone-and-cleanup helper for `vat audit <git-url>`.
 *
 * Pipeline:
 *  1. makeStagingDir('vat-audit-')
 *  2. guard every terminating signal: dispose of the tempdir, then die of it — held until the
 *     tempdir's one disposal (step 6, or the signal's own) has settled
 *  3. git clone --depth 1 --single-branch [--branch <ref>]
 *  4. git rev-parse HEAD → resolved commit SHA
 *  5. yield (tempdir, targetDir, provenance) to caller
 *  6. dispose of the tempdir, success or failure, unless `keepTempForDebug`
 */



import { cloneGitSource } from '@vibe-agent-toolkit/agent-skills';
import { ExitCode } from '@vibe-agent-toolkit/schema';
import { disposeTempDir, disposeTempDirAfterFailure } from '@vibe-agent-toolkit/utils';
import { type ParsedGitUrl } from '@vibe-agent-toolkit/utils/git';
import { handleTerminatingSignals } from '@vibe-agent-toolkit/utils/process';

import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../utils/command-refusal.js';
import { makeStagingDir } from '../../utils/staging-dir.js';

import type { Provenance } from './provenance.js';

export interface CloneAndAuditContext {
  tempdir: string;
  targetDir: string;
  provenance: Provenance;
}

export interface CloneOptions {
  /**
   * If true, skip the tempdir cleanup at the end and print the path to
   * stderr. Wired to the existing `--debug` flag in `auditCommand`.
   */
  keepTempForDebug: boolean;
}

/**
 * Clone the source, or refuse. A subpath the clone does not hold, or one that
 * escapes it, arrives coded (`GIT_SUBPATH_INVALID`) and keeps its own refusal —
 * `USAGE_INVALID`, the argument's mistake. Anything else the clone step throws
 * (a clone that fails, a ref it does not have) means the source the operator
 * named could not be read: `INPUT_UNREADABLE`. Only the clone step is coded; a
 * failure inside the audit that follows is the audit's own.
 */
function cloneSource(parsed: ParsedGitUrl, tempdir: string): ReturnType<typeof cloneGitSource> {
  try {
    return cloneGitSource(parsed, tempdir);
  } catch (error) {
    if (refusalCodeOf(error) !== 'INTERNAL_ERROR') throw error;
    throw new CommandRefusalError('INPUT_UNREADABLE', errorMessageOf(error), { cause: error });
  }
}

/**
 * Dispose of the clone's tempdir once the work on it is DONE — or, under `keepTempForDebug`,
 * keep it and say where.
 *
 * @returns `undefined`, or the leftover: the classified fault naming a tempdir the OS would not
 *   remove, for the caller to publish as a warning beside the work it finished
 */
async function disposeClone(tempdir: string, options: CloneOptions): Promise<unknown> {
  if (options.keepTempForDebug) {
    process.stderr.write(`[vat: debug — temp dir preserved: ${tempdir}]\n`);
    return undefined;
  }
  return await disposeTempDir(tempdir);
}

/**
 * Run `body` against a freshly shallow-cloned repo, then dispose of the clone (unless
 * `options.keepTempForDebug`). `body` must not end the process itself: a caller that exits
 * does so once this has settled.
 *
 * A failure of the clone or of `body` is rethrown unchanged, a clone that will not go recorded
 * beside it (`suppressedFaultsOf`). Once `body` succeeded, a clone the OS would not remove is
 * returned as `leftover` beside its value — the work is done, so it is never the refusal.
 */
export async function withClonedRepo<T>(
  parsed: ParsedGitUrl,
  options: CloneOptions,
  body: (ctx: CloneAndAuditContext) => Promise<T>
): Promise<{ readonly value: T; readonly leftover: unknown }> {
  // Through the one classified creation: a temp directory the OS will not make is the environment's fault.
  const tempdir = await makeStagingDir('vat-audit-');
  // ONE disposal, whoever starts it: the work's own end (after success or failure) or a signal. It
  // settles on what it left behind, whichever path started it, so the signal path can name it. The
  // guard is held until that disposal has SETTLED — a Ctrl-C that also kills `git` fails the clone
  // step, and a guard released before the failure path's disposal let the pending signal kill the
  // process half-way through it, the clone left behind.
  let disposal: Promise<unknown> | undefined;
  const dispose = (start: () => Promise<unknown>): Promise<unknown> => (disposal ??= start());
  // Interrupted: dispose of the clone first, then die of the signal. No report follows a signal, so a
  // clone that will not go is named on stderr. A repeat (a terminal Ctrl-C under the `vat` wrapper
  // arrives twice) is swallowed — see `handleTerminatingSignals`.
  const signalGuard = handleTerminatingSignals({
    fallbackExitCode: ExitCode.ERROR,
    cleanup: () => dispose(() => disposeClone(tempdir, options)).then(
      (leftover) => {
        if (leftover !== undefined) process.stderr.write(`[vat: interrupted — temp dir left behind: ${errorMessageOf(leftover)}]\n`);
      },
      // A rejection is a refusal to dispose at all (nothing was touched): say that, not "left behind".
      (error_: unknown) => {
        process.stderr.write(`[vat: interrupted — temp dir not disposed of: ${errorMessageOf(error_)}]\n`);
      },
    ),
  });
  // The work's own disposal, then the guard's release — released even when the disposal REJECTS
  // (a refusal to dispose at all), so a guard never outlives the work it guarded.
  const disposeThenRelease = async (start: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await dispose(start);
    } finally {
      // A signal that arrived meanwhile ends the process once this same disposal has settled.
      await signalGuard.releaseOrAwaitEnding();
    }
  };
  let value: T;
  try {
    const { ref, commit, targetDir } = cloneSource(parsed, tempdir);
    const { subpath } = parsed;
    const provenance: Provenance = {
      url: parsed.cloneUrl,
      ref,
      commit,
      ...(subpath ? { subpath } : {}),
    };
    value = await body({ tempdir, targetDir, provenance });
  } catch (error) {
    await disposeThenRelease(() => (options.keepTempForDebug ? disposeClone(tempdir, options) : disposeTempDirAfterFailure(tempdir, error)));
    throw error;
  }
  const leftover = await disposeThenRelease(() => disposeClone(tempdir, options));
  return { value, leftover };
}

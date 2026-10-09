/**
 * Shallow-clone-and-cleanup helper for `vat audit <git-url>`.
 *
 * Pipeline:
 *  1. mkdtempSync('vat-audit-')
 *  2. install SIGINT handler that disposes of the tempdir
 *  3. git clone --depth 1 --single-branch [--branch <ref>]
 *  4. git rev-parse HEAD → resolved commit SHA
 *  5. yield (tempdir, targetDir, provenance) to caller
 *  6. cleanup in finally — always dispose of the tempdir unless `keepTempForDebug`
 */

import { mkdtempSync } from 'node:fs';

import { cloneGitSource } from '@vibe-agent-toolkit/agent-skills';
import { disposeTempDir, disposeTempDirAfterFailure, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { type ParsedGitUrl } from '@vibe-agent-toolkit/utils/git';

import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../utils/command-refusal.js';

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
  const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-'));
  // Interrupted: dispose of the clone first, then let the signal end the process as it would have.
  // No report follows a signal, so a clone that will not go is named on stderr.
  const sigintListener = (): void => {
    process.removeListener('SIGINT', sigintListener);
    const resend = (): void => {
      process.kill(process.pid, 'SIGINT');
    };
    disposeClone(tempdir, options).then(
      (leftover) => {
        if (leftover !== undefined) process.stderr.write(`[vat: interrupted — temp dir left behind: ${errorMessageOf(leftover)}]\n`);
        resend();
      },
      // A rejection is a refusal to dispose at all (nothing was touched): say that, not "left behind".
      (refused: unknown) => {
        process.stderr.write(`[vat: interrupted — temp dir not disposed of: ${errorMessageOf(refused)}]\n`);
        resend();
      },
    );
  };
  process.on('SIGINT', sigintListener);

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
    process.removeListener('SIGINT', sigintListener);
    if (options.keepTempForDebug) await disposeClone(tempdir, options);
    else await disposeTempDirAfterFailure(tempdir, error);
    throw error;
  }
  process.removeListener('SIGINT', sigintListener);
  return { value, leftover: await disposeClone(tempdir, options) };
}

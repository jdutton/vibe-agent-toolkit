/**
 * Shallow-clone-and-cleanup helper for `vat audit <git-url>`.
 *
 * Pipeline:
 *  1. mkdtempSync('vat-audit-')
 *  2. install SIGINT handler that removes the tempdir
 *  3. git clone --depth 1 --single-branch [--branch <ref>]
 *  4. git rev-parse HEAD → resolved commit SHA
 *  5. yield (tempdir, targetDir, provenance) to caller
 *  6. cleanup in finally — always rm tempdir unless `keepTempForDebug`
 */

import { mkdtempSync, rmSync } from 'node:fs';

import { cloneGitSource } from '@vibe-agent-toolkit/agent-skills';
import { normalizedTmpdir, safePath, type ParsedGitUrl } from '@vibe-agent-toolkit/utils';

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
 * Run `body` against a freshly shallow-cloned repo. Always cleans up the
 * tempdir unless `options.keepTempForDebug` is true. Re-raises any error
 * from the clone or from `body`.
 */
export async function withClonedRepo<T>(
  parsed: ParsedGitUrl,
  options: CloneOptions,
  body: (ctx: CloneAndAuditContext) => Promise<T>
): Promise<T> {
  const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-'));
  const sigintListener = (): void => {
    try {
      rmSync(tempdir, { recursive: true, force: true });
    } finally {
      process.removeListener('SIGINT', sigintListener);
      process.kill(process.pid, 'SIGINT');
    }
  };
  process.on('SIGINT', sigintListener);

  // The audit pipeline calls `process.exit()` on completion
  // (`handleAuditResults` in audit.ts), which would skip any `finally`
  // block here. Register an `'exit'` listener so cleanup runs even when
  // the process is ending — this is Node's documented escape hatch for
  // "always run this sync cleanup". We still keep the `finally` below so
  // thrown errors and the non-exit path behave the same.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (options.keepTempForDebug) {
      process.stderr.write(`[vat: debug — temp dir preserved: ${tempdir}]\n`);
    } else {
      rmSync(tempdir, { recursive: true, force: true });
    }
  };
  const exitListener = (): void => {
    cleanup();
  };
  process.on('exit', exitListener);

  try {
    const { ref, commit, targetDir } = cloneGitSource(parsed, tempdir);
    const { subpath } = parsed;
    const provenance: Provenance = {
      url: parsed.cloneUrl,
      ref,
      commit,
      ...(subpath ? { subpath } : {}),
    };
    return await body({ tempdir, targetDir, provenance });
  } finally {
    process.removeListener('SIGINT', sigintListener);
    process.removeListener('exit', exitListener);
    cleanup();
  }
}



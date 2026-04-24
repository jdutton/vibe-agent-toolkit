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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import type { ParsedGitUrl } from '../../utils/git-url.js';

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
    const ref = cloneShallow(parsed, tempdir);
    const commit = revParseHead(tempdir);
    const { subpath } = parsed;
    const targetDir = subpath ? safePath.join(tempdir, subpath) : tempdir;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetDir is composed from our own tempdir + validated subpath
    if (!existsSync(targetDir)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempdir is our own mkdtempSync-created directory
      const topLevel = readdirSync(tempdir).join(', ');
      throw new Error(
        `Subpath not found in cloned repo: ${subpath ?? '(none)'}. ` +
          `Repo root contains: ${topLevel}.`
      );
    }

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

function cloneShallow(parsed: ParsedGitUrl, tempdir: string): string {
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (parsed.ref !== undefined) {
    args.push('--branch', parsed.ref);
  }
  args.push(parsed.cloneUrl, tempdir);

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    if (parsed.ref !== undefined && /not found|did not match/i.test(stderr)) {
      throw new Error(
        `Reference not found in ${parsed.cloneUrl}: ${parsed.ref}. ` +
          `Hint: --depth 1 cloning cannot resolve arbitrary deep commit SHAs; ` +
          `try a branch or tag name.`
      );
    }
    throw new Error(`Clone failed:\n${stderr}`);
  }

  // The actual ref is what we asked for (--branch <ref>) or `HEAD` of the
  // default branch. We cannot ask git for "what is the default branch
  // name?" reliably from a shallow single-branch clone, so for the
  // no-ref case we record 'HEAD' as the ref and rely on the commit SHA
  // for precise reproduction.
  return parsed.ref ?? 'HEAD';
}

function revParseHead(tempdir: string): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: tempdir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(
      `Failed to resolve HEAD commit in cloned repo: ${(result.stderr ?? '').trim()}`
    );
  }
  return (result.stdout ?? '').trim().slice(0, 8);
}

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

import { safePath, type ParsedGitUrl } from '@vibe-agent-toolkit/utils';

/** Result of a shallow git clone: the resolved ref, short commit SHA, and target dir. */
export interface GitCloneResult {
  /** The ref cloned (the requested `--branch <ref>`, or 'HEAD' for the default branch). */
  ref: string;
  /** 8-char resolved HEAD commit SHA. */
  commit: string;
  /** The (subpath-resolved) directory the caller should consume. */
  targetDir: string;
}

/**
 * Shallow-clone `parsed` into the caller-provided `targetTempdir`, validate any
 * subpath, and return the resolved ref/commit/targetDir.
 *
 * Neutral domain primitive: it does NOT create or clean the tempdir, and carries
 * no audit/provenance coupling. Callers (audit's withClonedRepo, the url skill
 * source) own tempdir lifecycle. Extracted verbatim from the original audit helper
 * so audit behavior is unchanged (spec §11c regression requirement).
 */
export function cloneGitSource(parsed: ParsedGitUrl, targetTempdir: string): GitCloneResult {
  const ref = cloneShallow(parsed, targetTempdir);
  const commit = revParseHead(targetTempdir);
  const { subpath } = parsed;
  const targetDir = subpath ? safePath.join(targetTempdir, subpath) : targetTempdir;

  if (subpath !== undefined) {
    const resolvedTarget = safePath.resolve(targetDir);
    const resolvedTemp = safePath.resolve(targetTempdir);
    const inside =
      resolvedTarget === resolvedTemp || resolvedTarget.startsWith(`${resolvedTemp}/`);
    if (!inside) {
      throw new Error(
        `Subpath escapes the cloned repository: ${subpath}. ` +
          `Subpaths must be relative paths inside the repo (no \`..\` traversal).`,
      );
    }
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetDir = our tempdir + validated subpath
  if (!existsSync(targetDir)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tempdir
    const topLevel = readdirSync(targetTempdir).join(', ');
    throw new Error(
      `Subpath not found in cloned repo: ${subpath ?? '(none)'}. Repo root contains: ${topLevel}.`,
    );
  }

  return { ref, commit, targetDir };
}

function cloneShallow(parsed: ParsedGitUrl, tempdir: string): string {
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (parsed.ref !== undefined) args.push('--branch', parsed.ref);
  args.push(parsed.cloneUrl, tempdir);

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const result = spawnSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  const status = result.status ?? 1;
  if (status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    if (parsed.ref !== undefined && /not found|did not match/i.test(stderr)) {
      throw new Error(
        `Reference not found in ${parsed.cloneUrl}: ${parsed.ref}. ` +
          `Hint: --depth 1 cloning cannot resolve arbitrary deep commit SHAs; try a branch or tag name.`,
      );
    }
    throw new Error(`Clone failed:\n${stderr}`);
  }
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
    throw new Error(`Failed to resolve HEAD commit in cloned repo: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim().slice(0, 8);
}

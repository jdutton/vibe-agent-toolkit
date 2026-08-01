/**
 * Git operations for marketplace publish.
 *
 * Handles: fetch/create orphan branch, stage tree, squash commit, push.
 * Uses child_process.spawnSync for git commands (no external dependencies).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import type { Logger } from '../../../utils/logger.js';
import { redactUrlCredentials } from '../../../utils/url-redact.js';

export interface CommitMetadata {
  sourceRepo?: string;
  commitRange?: string;
}

export interface PublishGitOptions {
  publishDir: string;
  branch: string;
  remote: string;
  commitMessage: string;
  force: boolean;
  dryRun: boolean;
  noPush: boolean;
  logger: Logger;
}

/**
 * Format a commit message for marketplace publish.
 *
 * `headline` is the literal first line of the commit message — the caller owns
 * how to render it (e.g. `publish v1.2.0` for a single-plugin marketplace, or
 * `publish my-marketplace` when there is no aggregate version to display).
 */
export function createCommitMessage(
  headline: string,
  changelogDelta: string,
  metadata?: CommitMetadata
): string {
  const lines = [headline];

  if (changelogDelta) {
    lines.push('', changelogDelta);
  }

  if (metadata?.sourceRepo) {
    lines.push('', `Source: ${metadata.sourceRepo}`);
    if (metadata.commitRange) {
      lines.push(`Commits: ${metadata.commitRange}`);
    }
  }

  return lines.join('\n');
}

/**
 * Execute a git command and return the result.
 * Throws on non-zero exit code unless allowFailure is true.
 */
function git(
  args: string[],
  options: { cwd: string; allowFailure?: boolean; timeout?: number; input?: string }
): { stdout: string; stderr: string; status: number } {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout,
    ...(options.input === undefined ? {} : { input: options.input }),
  });

  // Name the subcommand only. The full argv is not safe to interpolate here: a
  // commit message can be hundreds of KB, and dumping it made the real error
  // unreadable in CI logs.
  const label = args[0] ?? '<no args>';

  // `spawnSync` reports a process that never ran (E2BIG, ENOENT, timeout kill) as
  // `status: null` with the cause in `result.error`. Coercing that to an exit code
  // invents a failure git never reported and discards the only diagnostic there is —
  // the symptom is a confident "exit 1" with empty stderr. Report it as what it is.
  if (result.error && !options.allowFailure) {
    throw new Error(`git ${label} could not run: ${result.error.message}`);
  }

  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`git ${label} failed (exit ${status}):\n${result.stderr ?? ''}`);
  }

  return {
    stdout: (result.stdout ?? '').trim(),
    // Surface a spawn-level failure to `allowFailure` callers too, which would
    // otherwise see an empty stderr beside a fabricated non-zero status.
    stderr: (result.stderr ?? result.error?.message ?? '').trim(),
    status,
  };
}

/**
 * Resolve a remote name (e.g., "origin") to a URL.
 * If the value already looks like a URL, returns it as-is.
 * In CI, injects GITHUB_TOKEN into HTTPS URLs for push authentication.
 */
function resolveRemoteUrl(remote: string, cwd: string): string {
  let url: string;
  if (remote.includes('/') || remote.includes(':')) {
    url = remote;
  } else {
    const urlResult = git(['remote', 'get-url', remote], { cwd, allowFailure: true });
    if (urlResult.status !== 0) {
      throw new Error(`Git remote "${remote}" not found. Configure it or use a full URL.`);
    }
    url = urlResult.stdout;
  }

  // In CI, inject token into HTTPS URLs for push authentication.
  // The temp repo doesn't inherit the credential helper from actions/checkout.
  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  if (token && url.startsWith('https://github.com/')) {
    return url.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
  }
  return url;
}

/**
 * Deliver the commit: dry-run (show info), no-push (local branch), or push to remote.
 */
function deliverCommit(
  tmpRepo: string,
  cwd: string,
  options: Pick<
    PublishGitOptions,
    'branch' | 'remote' | 'force' | 'dryRun' | 'noPush' | 'logger'
  >,
  remoteUrl: string,
): void {
  const { branch, remote, force, dryRun, noPush, logger } = options;

  if (dryRun) {
    logger.info('   [dry-run] Would push to remote. Commit staged at:');
    logger.info(`   ${tmpRepo}`);
    const diffStat = git(['diff', '--stat', 'HEAD~1..HEAD'], { cwd: tmpRepo, allowFailure: true });
    if (diffStat.status === 0) {
      logger.info(`   Changes:\n${diffStat.stdout}`);
    }
    return;
  }

  if (noPush) {
    const fetchSpec = force
      ? `+refs/heads/${branch}:refs/heads/${branch}`
      : `refs/heads/${branch}:refs/heads/${branch}`;
    git(['fetch', tmpRepo, fetchSpec], { cwd });
    logger.info(`   Created local branch "${branch}" (not pushed)`);
    logger.info(`   To push later: git push ${remote} ${branch}`);
    return;
  }

  const pushArgs = ['push', remoteUrl, `${branch}:${branch}`];
  if (force) {
    pushArgs.splice(1, 0, '--force');
  }
  git(pushArgs, { cwd: tmpRepo });
  logger.info(`   Pushed to ${redactUrlCredentials(remoteUrl)} branch ${branch}`);
}

/**
 * Publish the composed tree to a git branch.
 *
 * Strategy:
 * 1. Create a temp repo
 * 2. Init it and add the publish tree content
 * 3. Fetch the existing branch (if any) from the remote
 * 4. Create a new commit on top of the branch history
 * 5. Deliver: dry-run (preview), no-push (local branch), or push to remote
 */
export async function publishToGitBranch(options: PublishGitOptions): Promise<void> {
  const { publishDir, branch, commitMessage, force, dryRun, logger } = options;

  const cwd = process.cwd();
  const remoteUrl = resolveRemoteUrl(options.remote, cwd);

  logger.info(`   Remote: ${redactUrlCredentials(remoteUrl)}`);
  logger.info(`   Branch: ${branch}`);

  const tmpRepo = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-marketplace-publish-'));
  logger.debug(`   Staging repo: ${tmpRepo}`);

  try {
    git(['init'], { cwd: tmpRepo });
    git(['config', 'user.email', 'vat-publish@localhost'], { cwd: tmpRepo });
    git(['config', 'user.name', 'vat marketplace publish'], { cwd: tmpRepo });
    git(['checkout', '-b', branch], { cwd: tmpRepo });

    // Try to fetch existing branch history (skip for dry-run — commit parent doesn't matter)
    if (!dryRun) {
      const fetchResult = git(
        ['fetch', remoteUrl, `refs/heads/${branch}`],
        { cwd: tmpRepo, allowFailure: true, timeout: 30_000 }
      );
      if (fetchResult.status === 0 && !force) {
        // Reset to fetched branch tip so our commit builds on top of it
        git(['reset', '--soft', 'FETCH_HEAD'], { cwd: tmpRepo });
      }
    }

    // Copy publish tree content into temp repo
    cpSync(publishDir, tmpRepo, { recursive: true });

    // Log what cpSync placed in the temp repo (filesystem truth before git touches it)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tmpRepo is a controlled temp directory
    const tmpRepoFiles = readdirSync(tmpRepo, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.parentPath.includes('.git'))
      .map(entry => safePath.join(entry.parentPath, entry.name))
      .map(p => safePath.relative(tmpRepo, p));
    logger.debug(`   Files in tmpRepo after cpSync (${tmpRepoFiles.length}):\n${tmpRepoFiles.join('\n')}`);

    git(['add', '-A'], { cwd: tmpRepo });

    // Log what git is tracking vs what's on disk but untracked/ignored
    const tracked = git(['ls-files'], { cwd: tmpRepo });
    logger.debug(`   Git tracked files:\n${tracked.stdout}`);

    const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard'], {
      cwd: tmpRepo,
      allowFailure: true,
    });
    if (ignored.stdout) {
      logger.info(`   ⚠ Git IGNORED files (on disk but not tracked):\n${ignored.stdout}`);
    }

    // Check if there are changes to commit
    const diffResult = git(['diff', '--cached', '--quiet'], { cwd: tmpRepo, allowFailure: true });
    if (diffResult.status === 0) {
      logger.info('   No changes to publish (tree is identical to current branch)');
      const currentTree = git(['ls-files'], { cwd: tmpRepo });
      logger.debug(`   Current tree (${currentTree.stdout.split('\n').filter(Boolean).length} files):\n${currentTree.stdout}`);
      return;
    }

    // `-F -` (message on stdin), never `-m`. The message embeds the release's whole
    // changelog section, and Linux caps a SINGLE argv entry at MAX_ARG_STRLEN (131,072
    // bytes) independently of the much larger ARG_MAX — so a long enough release note
    // made `git commit` fail to spawn at all. stdin has no such ceiling.
    git(['commit', '-F', '-'], { cwd: tmpRepo, input: commitMessage });

    const log = git(['log', '--oneline', '-1'], { cwd: tmpRepo });
    logger.info(`   Commit: ${log.stdout}`);

    deliverCommit(tmpRepo, cwd, options, remoteUrl);
  } finally {
    // Keep temp repo for dry-run so user can inspect
    if (!dryRun) {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  }
}

/**
 * Git operations for marketplace publish.
 *
 * Handles: fetch/create orphan branch, stage tree, squash commit, push.
 * Uses child_process.spawnSync for git commands (no external dependencies).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';

import type { Logger } from '../../../utils/logger.js';

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
 */
export function createCommitMessage(
  version: string,
  changelogDelta: string,
  metadata?: CommitMetadata
): string {
  const lines = [`publish v${version}`];

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
  options: { cwd: string; allowFailure?: boolean; timeout?: number }
): { stdout: string; stderr: string; status: number } {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout,
  });

  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${status}):\n${result.stderr ?? ''}`
    );
  }

  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
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
  options: Pick<PublishGitOptions, 'branch' | 'remote' | 'force' | 'dryRun' | 'noPush' | 'logger'>,
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
  logger.info(`   Pushed to ${remoteUrl} branch ${branch}`);
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

  logger.info(`   Remote: ${remoteUrl}`);
  logger.info(`   Branch: ${branch}`);

  const tmpRepo = mkdtempSync(join(normalizedTmpdir(), 'vat-marketplace-publish-'));
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
    git(['add', '-A'], { cwd: tmpRepo });

    // Check if there are changes to commit
    const diffResult = git(['diff', '--cached', '--quiet'], { cwd: tmpRepo, allowFailure: true });
    if (diffResult.status === 0) {
      logger.info('   No changes to publish (tree is identical to current branch)');
      return;
    }

    git(['commit', '-m', commitMessage], { cwd: tmpRepo });

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

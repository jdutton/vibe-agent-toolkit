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
  options: { cwd: string; allowFailure?: boolean }
): { stdout: string; stderr: string; status: number } {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
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
 * Publish the composed tree to a git branch.
 *
 * Strategy:
 * 1. Create a temp repo
 * 2. Init it and add the publish tree content
 * 3. Fetch the existing branch (if any) from the remote
 * 4. Create a new commit on top of the branch history
 * 5. Push to the remote
 */
export async function publishToGitBranch(options: PublishGitOptions): Promise<void> {
  const { publishDir, branch, remote, commitMessage, force, dryRun, logger } = options;

  // Resolve the remote URL if it's a name (e.g., "origin")
  const cwd = process.cwd();
  let remoteUrl = remote;
  if (!remote.includes('/') && !remote.includes(':')) {
    // It's a remote name — resolve to URL
    const urlResult = git(['remote', 'get-url', remote], { cwd, allowFailure: true });
    if (urlResult.status === 0) {
      remoteUrl = urlResult.stdout;
    } else {
      throw new Error(`Git remote "${remote}" not found. Configure it or use a full URL.`);
    }
  }

  logger.info(`   Remote: ${remoteUrl}`);
  logger.info(`   Branch: ${branch}`);

  // Create a temporary git repo for staging
  const tmpRepo = mkdtempSync(join(normalizedTmpdir(), 'vat-marketplace-publish-'));
  logger.debug(`   Staging repo: ${tmpRepo}`);

  try {
    // Init temp repo
    git(['init'], { cwd: tmpRepo });
    git(['checkout', '-b', branch], { cwd: tmpRepo });

    // Try to fetch existing branch history
    const fetchResult = git(
      ['fetch', remoteUrl, `${branch}:${branch}`],
      { cwd: tmpRepo, allowFailure: true }
    );

    const branchExists = fetchResult.status === 0;
    if (branchExists && !force) {
      // Reset to the fetched branch to build on top of existing history
      git(['reset', '--soft', branch], { cwd: tmpRepo });
    }

    // Copy publish tree content into temp repo
    cpSync(publishDir, tmpRepo, { recursive: true });

    // Stage all files
    git(['add', '-A'], { cwd: tmpRepo });

    // Check if there are changes to commit
    const diffResult = git(['diff', '--cached', '--quiet'], { cwd: tmpRepo, allowFailure: true });
    if (diffResult.status === 0) {
      logger.info('   No changes to publish (tree is identical to current branch)');
      return;
    }

    // Create commit
    git(['commit', '-m', commitMessage], { cwd: tmpRepo });

    if (dryRun) {
      logger.info('   [dry-run] Would push to remote. Commit created locally at:');
      logger.info(`   ${tmpRepo}`);

      // Show what would be pushed
      const log = git(['log', '--oneline', '-1'], { cwd: tmpRepo });
      logger.info(`   Commit: ${log.stdout}`);

      const diffStat = git(['diff', '--stat', 'HEAD~1..HEAD'], { cwd: tmpRepo, allowFailure: true });
      if (diffStat.status === 0) {
        logger.info(`   Changes:\n${diffStat.stdout}`);
      }
      return;
    }

    // Push
    const pushArgs = ['push', remoteUrl, `${branch}:${branch}`];
    if (force) {
      pushArgs.splice(1, 0, '--force');
    }
    git(pushArgs, { cwd: tmpRepo });
    logger.info(`   Pushed to ${remoteUrl} branch ${branch}`);
  } finally {
    // Cleanup temp repo (unless dry-run, where user might want to inspect)
    if (!dryRun) {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  }
}

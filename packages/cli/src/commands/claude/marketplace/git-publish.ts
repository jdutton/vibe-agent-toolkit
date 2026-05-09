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

import { pluginTagName } from './tag-utils.js';

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
  /**
   * Plugins (with resolved versions) extracted from the published
   * marketplace.json. After a successful branch push, each entry is tagged
   * `<name>-v<version>` on the SOURCE repo (the cwd from which vat was
   * invoked) and pushed to the remote. Tag-push failures are logged as
   * warnings — they do NOT roll back the publish.
   */
  publishedPlugins: { name: string; version: string }[];
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
 * Push per-plugin source-repo tags for each entry in `publishedPlugins`.
 *
 * Runs against the SOURCE repo (cwd), not the temp publish repo, because the
 * source commit is the artifact users want to identify. Tag failures are
 * logged as warnings — the publish itself already succeeded, so we never
 * throw from this helper.
 *
 * Republish-without-bump safety: we never use `git tag -f`. If the tag
 * already exists locally at HEAD, that's fine — skip the local create and
 * still attempt the push (a no-op if the remote already has it). If the
 * tag exists locally pointing at a different SHA than HEAD, the user is
 * republishing the same `<plugin>@<version>` on new commits without bumping
 * — emit a clear warning and do NOT move the local tag or push it. This
 * preserves the user's existing reference to the originally released commit.
 */
function pushPluginTags(
  cwd: string,
  remoteUrl: string,
  publishedPlugins: { name: string; version: string }[],
  logger: Logger,
): void {
  if (publishedPlugins.length === 0) return;

  for (const plugin of publishedPlugins) {
    const tag = pluginTagName(plugin.name, plugin.version);

    // 1. Reconcile local tag state. If the tag exists at a different SHA than
    //    HEAD, this is the republish-without-bump case — bail with guidance.
    const headSha = git(['rev-parse', 'HEAD'], { cwd }).stdout.trim();
    const existingTagSha = git(['rev-list', '-n', '1', tag], {
      cwd,
      allowFailure: true,
    }).stdout.trim();

    let skipPush = false;
    if (existingTagSha === '') {
      // Tag does not exist locally — create it (without -f).
      try {
        git(['tag', tag], { cwd });
      } catch (err) {
        logger.info(
          `   warning: failed to create local tag ${tag}: ${(err as Error).message}. ` +
            `Skipping tag push.`,
        );
        skipPush = true;
      }
    } else if (existingTagSha === headSha) {
      // Tag is already correct locally — skip create, still try the push so
      // the remote catches up if it was missing this tag.
      logger.debug(`   Tag ${tag} already exists locally at HEAD — skipping local tag create.`);
    } else {
      // Republish-without-bump: tag exists locally at a different SHA. Do
      // NOT move the local tag, do NOT push.
      logger.info(
        `   warning: tag ${tag} already exists locally at ${existingTagSha} but HEAD is ${headSha}. ` +
          `This usually means the plugin was republished at the same version on new ` +
          `commits. Either bump the plugin's version, or (if intentional) delete the ` +
          `existing tag with \`git tag -d ${tag}\` and force-push, accepting that ` +
          `consumers may have already cached the old commit at this version.`,
      );
      continue;
    }

    if (skipPush) continue;

    // 2. Push the tag to the remote (non-force). If the remote already has the
    //    tag at a different commit, this push will fail — surface that as a
    //    warning explaining the most likely cause.
    try {
      git(['push', remoteUrl, tag], { cwd });
      logger.info(`   Tagged source repo: ${tag}`);
    } catch (err) {
      logger.info(
        `   warning: failed to push tag ${tag}: ${(err as Error).message}. The most likely cause ` +
          `is that ${tag} already exists on the remote at a different commit. The publish ` +
          `itself succeeded; if you intended to republish at the same version, the version ` +
          `should be bumped.`,
      );
    }
  }
}

/**
 * Deliver the commit: dry-run (show info), no-push (local branch), or push to remote.
 */
function deliverCommit(
  tmpRepo: string,
  cwd: string,
  options: Pick<
    PublishGitOptions,
    'branch' | 'remote' | 'force' | 'dryRun' | 'noPush' | 'publishedPlugins' | 'logger'
  >,
  remoteUrl: string,
): void {
  const { branch, remote, force, dryRun, noPush, publishedPlugins, logger } = options;

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

  // Tag the source repo with per-plugin tags (`<name>-v<version>`) and push
  // them to the remote. Failures are logged as warnings, never thrown — the
  // publish already succeeded above.
  pushPluginTags(cwd, remoteUrl, publishedPlugins, logger);
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

/**
 * Git operations for marketplace publish.
 *
 * Handles: fetch/create orphan branch, stage tree, squash commit, push.
 * Uses child_process.spawnSync for git commands (no external dependencies).
 */

import { readdirSync } from 'node:fs';

import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { copyTree, disposeTempDir, disposeTempDirAfterFailure, isTimedOutError, safePath, withFsFault } from '@vibe-agent-toolkit/utils';
import { runGit } from '@vibe-agent-toolkit/utils/git';

import { CommandRefusalError } from '../../../utils/command-refusal.js';
import type { Logger } from '../../../utils/logger.js';
import { makeStagingDir } from '../../../utils/staging-dir.js';
import { redactUrlCredentials, redactUrlCredentialsInText } from '../../../utils/url-redact.js';

export interface CommitMetadata {
  sourceRepo?: string;
  commitRange?: string;
}

export interface PublishGitOptions {
  publishDir: string;
  branch: string;
  remote: string;
  /** Whether `remote` came from `publish.remote` (true) or is the default (false) — named when it is not found. */
  remoteFromConfig: boolean;
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
 * Refuses on non-zero exit code unless allowFailure is true: `refusal` (default
 * `RUN_INCOMPLETE` — a publish step stopped) names what the failure means, so
 * the one step that talks to the remote (the push) says `EXTERNAL_API_FAILED`.
 *
 * 🔴 Running through `runGit` is a data-loss guard, not a style choice. Every
 * call here targets the private staging repo under the temp directory — a
 * caller-supplied path — and an inherited `GIT_DIR` overrides `cwd` outright.
 * Measured against a bystander repository: the `checkout -b`, `add -A` and
 * `commit` below ran against *it* instead, switching its branch, rewriting its
 * index and landing a commit, with `push` next in line. `runGit` scrubs by
 * default, so no call site here has to remember.
 */
function git(args: string[], options: GitStepOptions): GitStepResult {
  return gitStep(args, options, NO_REMOTE_ENV);
}

/**
 * Run a git command that talks to `remote`: `<before> -- <url> <after>`, with the remote's auth
 * environment applied after `runGit`'s scrub. The one route to the network, so a call that reaches
 * the remote cannot leave its authentication behind, and the URL always follows `--`.
 */
function gitAtRemote(remote: PublishRemote, before: string[], after: string[], options: GitStepOptions): GitStepResult {
  return gitStep([...before, '--', remote.url, ...after], options, remote.authEnv);
}

interface GitStepOptions { cwd: string; allowFailure?: boolean; timeout?: number; input?: string; trim?: boolean; refusal?: RefusalCode }

/** The environment of a git call that does not talk to the remote: nothing beyond `runGit`'s scrubbed base. */
const NO_REMOTE_ENV: Readonly<Record<string, string>> = {};

function gitStep(args: string[], options: GitStepOptions, env: Readonly<Record<string, string>>): GitStepResult {
  const result = runGit(args, {
    cwd: options.cwd,
    env: { ...env },
    ...(options.trim === undefined ? {} : { trim: options.trim }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.input === undefined ? {} : { input: options.input }),
  });

  // Name the subcommand only. The full argv is not safe to interpolate here: a
  // commit message can be hundreds of KB, and dumping it made the real error
  // unreadable in CI logs.
  const label = args[0] ?? '<no args>';

  // `runGit` separates "never ran" (E2BIG, ENOENT, timeout kill, ENOBUFS) from
  // "ran and exited non-zero". Collapsing the first into an exit code invents a
  // failure git never reported and discards the only diagnostic there is — the
  // symptom is a confident "exit 1" with empty stderr.
  const refusal = options.refusal ?? 'RUN_INCOMPLETE';
  if (result.error && !options.allowFailure) {
    throw new CommandRefusalError(refusal, `git ${label} could not run: ${redactUrlCredentialsInText(result.error.message)}`, { cause: result.error });
  }

  const status = result.status === -1 ? 1 : result.status;
  if (status !== 0 && !options.allowFailure) {
    // git's stderr echoes the remote URL as given — credentials written into publish.remote included.
    throw new CommandRefusalError(refusal, `git ${label} failed (exit ${status}):\n${redactUrlCredentialsInText(result.stderr)}`);
  }

  return { stdout: result.stdout, stderr: result.stderr, status, ...(result.error === undefined ? {} : { error: result.error }) };
}

/** What {@link git} reports: `error` is the spawn-level failure (never ran, killed by its timeout), present only on one. */
interface GitStepResult {
  stdout: string;
  stderr: string;
  status: number;
  error?: Error;
}

/**
 * `git ls-files -z <args>` as real paths.
 *
 * `-z` because without it git QUOTES any name holding a backslash, a quote or a
 * non-ASCII byte (`"caf\303\251.md"`), so the log named files that do not
 * exist. Untrimmed, because a leading space is a filename character.
 */
function listedPaths(cwd: string, args: string[], allowFailure = false): string[] {
  const result = git(['ls-files', '-z', ...args], { cwd, allowFailure, trim: false });
  return result.stdout.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Refuse a remote git would parse as an option (`--upload-pack=<command>` runs that command).
 * Every call that takes the remote also puts `--` before it; this names the mistake before git runs.
 */
function refuseOptionShaped(value: string, subject: string): void {
  if (value.startsWith('-')) {
    throw new CommandRefusalError(
      'CONFIG_INVALID',
      `${subject} starts with "-", which git would read as an option. Set publish.remote to a remote name or a full URL.`,
    );
  }
}

/** The remote a publish talks to: its URL, and the environment that authenticates to it. */
interface PublishRemote {
  readonly url: string;
  /** `GIT_CONFIG_*` variables applied after `runGit`'s scrub — `{}` when there is nothing to authenticate with, never absent. */
  readonly authEnv: Readonly<Record<string, string>>;
}

const GITHUB_HTTPS = 'https://github.com/';

/**
 * Resolve `publish.remote` — a remote name (e.g. "origin") or a URL, used as-is — to the remote
 * the publish talks to.
 */
function resolveRemote(remote: string, remoteFromConfig: boolean, cwd: string): PublishRemote {
  const url = resolveRemoteUrl(remote, remoteFromConfig, cwd);
  return { url, authEnv: githubTokenEnv(url) };
}

/**
 * In CI, authenticate to an `https://github.com/` remote with `GH_TOKEN` (or `GITHUB_TOKEN`): the
 * staging repo does not inherit the credential helper `actions/checkout` set up.
 *
 * 🔴 The token travels as an `http.<url>.extraheader` on git's env-only configuration channel
 * (`GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n`, what `actions/checkout` does), never in the URL: a
 * URL is git's argv, which any local user reads with `ps`; a process's environment only its owner.
 * Appended after whatever numbered entries the operator already exports, which `runGit`'s scrub
 * deliberately keeps — overwriting entry 0 would drop their configuration.
 */
function githubTokenEnv(url: string): Record<string, string> {
  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  if (!token || !url.startsWith(GITHUB_HTTPS)) {
    return {};
  }
  const index = inheritedConfigCount();
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${GITHUB_HTTPS}.extraheader`,
    [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${basic}`,
  };
}

/** The operator's own `GIT_CONFIG_COUNT`, read as git reads it (unset or empty is 0). */
function inheritedConfigCount(): number {
  const raw = process.env['GIT_CONFIG_COUNT'] ?? '';
  if (raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new CommandRefusalError('CONFIG_INVALID', `GIT_CONFIG_COUNT is "${raw}", which git rejects as a bogus count. Unset it or set it to a whole number.`);
  }
  return Number(raw);
}

/** `publish.remote` as a URL: a remote name is asked of the repository, a URL is taken as-is. */
function resolveRemoteUrl(remote: string, remoteFromConfig: boolean, cwd: string): string {
  refuseOptionShaped(remote, `publish.remote "${redactUrlCredentials(remote)}"`);
  let url: string;
  if (remote.includes('/') || remote.includes(':')) {
    url = remote;
  } else {
    const urlResult = git(['remote', 'get-url', remote], { cwd, allowFailure: true });
    if (urlResult.status !== 0) {
      const origin = remoteFromConfig ? 'from publish.remote' : 'the default — publish.remote is not set';
      throw new CommandRefusalError(
        'CONFIG_INVALID',
        `Git remote "${remote}" (${origin}) not found. Add it with git remote add, or set publish.remote to a remote name or a full URL.`,
      );
    }
    url = urlResult.stdout;
    refuseOptionShaped(url, `Git remote "${remote}" names the URL "${redactUrlCredentials(url)}", which`);
  }
  return url;
}

/**
 * Deliver the commit: dry-run (show info), no-push (local branch), or push to remote.
 */
export function deliverCommit(
  tmpRepo: string,
  cwd: string,
  options: Pick<
    PublishGitOptions,
    'branch' | 'remote' | 'force' | 'dryRun' | 'noPush' | 'logger'
  >,
  target: PublishRemote,
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
    git(['fetch', '--', tmpRepo, fetchSpec], { cwd });
    logger.info(`   Created local branch "${branch}" (not pushed)`);
    logger.info(`   To push later: git push ${remote} ${branch}`);
    return;
  }

  gitAtRemote(target, force ? ['push', '--force'] : ['push'], [`${branch}:${branch}`], { cwd: tmpRepo, refusal: 'EXTERNAL_API_FAILED' });
  logger.info(`   Pushed to ${redactUrlCredentials(target.url)} branch ${branch}`);
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
 *
 * The temp repo is kept on a dry run, for the user to inspect, and disposed of otherwise. A
 * failure is rethrown unchanged, a repo that will not go recorded beside it
 * (`suppressedFaultsOf`).
 *
 * @returns `undefined`, or the leftover: the classified fault naming a temp repo the OS would
 *   not remove once the publish was DONE — for the caller to report as a warning beside it
 */
export async function publishToGitBranch(options: PublishGitOptions): Promise<unknown> {
  const { branch, dryRun, logger } = options;

  const cwd = process.cwd();
  const target = resolveRemote(options.remote, options.remoteFromConfig, cwd);

  logger.info(`   Remote: ${redactUrlCredentials(target.url)}`);
  logger.info(`   Branch: ${branch}`);

  // Through the one classified creation: a temp directory the OS will not make is the environment's fault.
  const tmpRepo = await makeStagingDir('vat-marketplace-publish-');
  logger.debug(`   Staging repo: ${tmpRepo}`);

  try {
    await commitAndDeliver(tmpRepo, cwd, target, options);
  } catch (error) {
    if (!dryRun) await disposeTempDirAfterFailure(tmpRepo, error);
    throw error;
  }
  return dryRun ? undefined : disposeTempDir(tmpRepo);
}

/**
 * Why the ls-remote probe failed, as the tail of its refusal: killed by its timeout, never run,
 * or git's exit status with its (redacted) stderr. A killed child reports `status` 1 — an exit
 * git never made — so the spawn failure is asked first.
 */
function probeFailure(probe: GitStepResult): string {
  if (probe.error !== undefined) {
    return isTimedOutError(probe.error) ? '(timed out)' : `(could not run: ${redactUrlCredentialsInText(probe.error.message)})`;
  }
  return `(exit ${probe.status}):\n${redactUrlCredentialsInText(probe.stderr)}`;
}

/** `git ls-remote --exit-code` exits 2 when the remote holds no matching ref. */
const LS_REMOTE_NO_MATCH = 2;

/**
 * Point the staging repo's branch at the remote branch's tip, so the publish commit builds on it.
 *
 * Whether the branch exists is ASKED of the remote, never inferred from a fetch: a fetch that
 * failed (a full-history fetch outliving its timeout on a large marketplace) once fell through to
 * an orphan commit, and the plain push of that commit was rejected as non-fast-forward. Now only
 * the remote's own "no such branch" makes the first commit an orphan; any other failure refuses.
 *
 * The tip alone is fetched (`--depth=1`): the push needs only the parent the remote already has.
 * `--no-push` fetches the whole history, because it copies the staging repo into the caller's.
 *
 * The commit builds on the sha the probe reported, never on whatever the fetch happened to bring:
 * a fetch source is matched by git's abbreviation rules too, so with `refs/heads/b` gone by the
 * time the fetch runs, `refs/heads/refs/heads/b` would answer for it. A fetched tip that is not the
 * probed sha refuses rather than building on it.
 */
function buildOnRemoteTip(tmpRepo: string, remote: PublishRemote, options: Pick<PublishGitOptions, 'branch' | 'noPush' | 'logger'>): void {
  const ref = `refs/heads/${options.branch}`;
  const tip = remoteTipOf(tmpRepo, remote, ref);
  if (tip === undefined) {
    options.logger.info(`   Branch ${options.branch} does not exist on the remote; the first commit has no parent`);
    return;
  }
  const depth = options.noPush ? [] : ['--depth=1'];
  gitAtRemote(remote, ['fetch', ...depth], [ref], { cwd: tmpRepo, refusal: 'EXTERNAL_API_FAILED' });
  const fetched = git(['rev-parse', '--verify', 'FETCH_HEAD'], { cwd: tmpRepo }).stdout;
  if (fetched !== tip) {
    throw new CommandRefusalError(
      'EXTERNAL_API_FAILED',
      `Branch ${options.branch} on ${redactUrlCredentials(remote.url)} was at ${tip} when asked, but the fetch brought ${fetched}. Run the publish again.`,
    );
  }
  git(['reset', '--soft', tip], { cwd: tmpRepo });
}

/**
 * The sha `remote` holds at exactly `ref`, or `undefined` when it holds no such branch.
 *
 * `git ls-remote <url> <pattern>` matches the pattern against the TAIL of each ref, so a remote
 * with no `main` but a `x/refs/heads/main` exits 0 for `refs/heads/main`. Existence is therefore
 * read from the listing — a line naming `ref` exactly — and not from the exit status.
 */
function remoteTipOf(tmpRepo: string, remote: PublishRemote, ref: string): string | undefined {
  const probe = gitAtRemote(remote, ['ls-remote', '--exit-code', '--heads'], [ref], { cwd: tmpRepo, allowFailure: true });
  if (probe.status === LS_REMOTE_NO_MATCH) {
    return undefined;
  }
  if (probe.status !== 0) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `git ls-remote could not read ${redactUrlCredentials(remote.url)} ${probeFailure(probe)}`);
  }
  for (const line of probe.stdout.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha !== undefined && isObjectId(sha)) {
      return sha;
    }
  }
  return undefined;
}

/** A full SHA-1 or SHA-256 object id, as `ls-remote` prints one. */
function isObjectId(text: string): boolean {
  return (text.length === 40 || text.length === 64) && /^[\da-f]+$/.test(text);
}

/** {@link publishToGitBranch}'s work in the temp repo: stage the tree, commit it, deliver it. */
async function commitAndDeliver(tmpRepo: string, cwd: string, remote: PublishRemote, options: PublishGitOptions): Promise<void> {
  const { publishDir, branch, commitMessage, force, dryRun, logger } = options;
  git(['init'], { cwd: tmpRepo });
  git(['config', 'user.email', 'vat-publish@localhost'], { cwd: tmpRepo });
  git(['config', 'user.name', 'vat marketplace publish'], { cwd: tmpRepo });
  git(['checkout', '-b', branch], { cwd: tmpRepo });

  // Build on the branch's tip. Skipped for a dry run (the parent does not matter) and under
  // --force (the push replaces the branch).
  if (!dryRun && !force) {
    buildOnRemoteTip(tmpRepo, remote, options);
  }

  // Copy publish tree content into temp repo. Both trees are VAT's own staging: a fault
  // reading or writing either is the environment's. Links are copied as links.
  await withFsFault({ side: 'environment', action: 'copy the publish tree into the staging repo', path: tmpRepo }, () =>
    copyTree(publishDir, tmpRepo, '', { links: 'preserve', side: 'environment', onto: 'fresh' }));

  // Log what the copy placed in the temp repo (filesystem truth before git touches it)
  // A link is an entry the copy placed and git will add, so it is listed as
  // one — this is a record of the tree, not a walk into it.
  const tmpRepoFiles = readdirSync(tmpRepo, { recursive: true, withFileTypes: true })
    .filter(entry => (entry.isSymbolicLink() || entry.isFile()) && !entry.parentPath.includes('.git'))
    .map(entry => safePath.join(entry.parentPath, entry.name))
    .map(p => safePath.relative(tmpRepo, p));
  logger.debug(`   Files in tmpRepo after the copy (${tmpRepoFiles.length}):\n${tmpRepoFiles.join('\n')}`);

  git(['add', '-A'], { cwd: tmpRepo });

  // Log what git is tracking vs what's on disk but untracked/ignored
  const tracked = listedPaths(tmpRepo, []);
  logger.debug(`   Git tracked files:\n${tracked.join('\n')}`);

  const ignored = listedPaths(tmpRepo, ['--others', '--ignored', '--exclude-standard'], true);
  if (ignored.length > 0) {
    logger.info(`   ⚠ Git IGNORED files (on disk but not tracked):\n${ignored.join('\n')}`);
  }

  // Check if there are changes to commit
  const diffResult = git(['diff', '--cached', '--quiet'], { cwd: tmpRepo, allowFailure: true });
  if (diffResult.status === 0) {
    logger.info('   No changes to publish (tree is identical to current branch)');
    const currentTree = listedPaths(tmpRepo, []);
    logger.debug(`   Current tree (${currentTree.length} files):\n${currentTree.join('\n')}`);
    return;
  }

  // `-F -` (message on stdin), never `-m`. The message embeds the release's whole
  // changelog section, and Linux caps a SINGLE argv entry at MAX_ARG_STRLEN (131,072
  // bytes) independently of the much larger ARG_MAX — so a long enough release note
  // made `git commit` fail to spawn at all. stdin has no such ceiling.
  git(['commit', '-F', '-'], { cwd: tmpRepo, input: commitMessage });

  const log = git(['log', '--oneline', '-1'], { cwd: tmpRepo });
  logger.info(`   Commit: ${log.stdout}`);

  deliverCommit(tmpRepo, cwd, options, remote);
}

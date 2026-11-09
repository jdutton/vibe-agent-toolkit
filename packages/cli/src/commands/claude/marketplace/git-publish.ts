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
 * Execute a git command that does not talk to a remote, and return the result.
 * Refuses on non-zero exit code unless allowFailure is true: `refusal` (default
 * `RUN_INCOMPLETE` — a publish step stopped) names what the failure means, so
 * the steps that talk to the remote (ls-remote, fetch, push) say `EXTERNAL_API_FAILED`.
 *
 * Only the local commands in {@link LOCAL_COMMANDS} run here; anything else — `ls-remote`, `fetch`,
 * `push`, `clone`, a leading `-c k=v` — is refused as a programming error. A command that talks to
 * a remote goes through {@link gitAtRemote}, the one route that carries the remote's authentication.
 *
 * 🔴 Running through `runGit` is a data-loss guard, not a style choice. Every
 * call here targets the private staging repo under the temp directory — a
 * caller-supplied path — and an inherited `GIT_DIR` overrides `cwd` outright.
 * Measured against a bystander repository: the `checkout -b`, `add -A` and
 * `commit` below ran against *it* instead, switching its branch, rewriting its
 * index and landing a commit, with `push` next in line. `runGit` scrubs by
 * default, so no call site here has to remember.
 */
export function git(args: string[], options: GitStepOptions): GitStepResult {
  if (!LOCAL_COMMANDS.some((command) => command.every((word, index) => args[index] === word))) {
    throw new Error(`git ${JSON.stringify(args.slice(0, 2))} is not a local git command this module runs: a remote goes through gitAtRemote, and git() runs only ${LOCAL_COMMANDS.map((command) => command.join(' ')).join(', ')}`);
  }
  return gitStep(args, options, NO_REMOTE_ENV);
}

/**
 * The leading words of every git command {@link git} may run: the local commands this module's
 * call sites use, and nothing that reaches a remote. An allow list, because a deny list on args[0]
 * let `-c k=v push`, `clone`, `pull` and `remote update` through. No entry starts with `-`, so a
 * leading global option (`-c`, `--git-dir`) is refused with the rest.
 */
const LOCAL_COMMANDS: readonly (readonly string[])[] = [
  ['init'], ['config'], ['checkout'], ['add'], ['ls-files'], ['diff'], ['commit'], ['log'], ['rev-parse'], ['reset'],
  ['remote', 'get-url'], ['version'],
];

/**
 * Run a git command that talks to `remote`: `<before> -- <url> <after>`, with the remote's auth
 * environment applied after `runGit`'s scrub. The one route to the network, so a call that reaches
 * the remote cannot leave its authentication behind, and the URL always follows `--`.
 */
function gitAtRemote(remote: PublishRemote, before: string[], after: string[], options: GitStepOptions): GitStepResult {
  return gitStep([...before, '--', remote.url, ...after], options, remote.authEnv());
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
  /**
   * `GIT_CONFIG_*` variables applied after `runGit`'s scrub — `{}` when there is nothing to
   * authenticate with. Asked only by {@link gitAtRemote}, as a network call is about to run, so a
   * publish that contacts no remote (`--dry-run`) never builds it or refuses over it.
   */
  readonly authEnv: () => Readonly<Record<string, string>>;
}

const GITHUB_HTTPS = 'https://github.com/';

/**
 * Resolve `publish.remote` — a remote name (e.g. "origin") or a URL, used as-is — to the remote
 * the publish talks to. Its auth environment is built on first use, once.
 */
function resolveRemote(remote: string, remoteFromConfig: boolean, cwd: string): PublishRemote {
  const url = resolveRemoteUrl(remote, remoteFromConfig, cwd);
  let authEnv: Readonly<Record<string, string>> | undefined;
  return { url, authEnv: () => (authEnv ??= remoteAuthEnv(url, cwd)) };
}

/**
 * {@link githubTokenEnv} for `url`, refused on a git that would ignore it: git reads
 * `GIT_CONFIG_COUNT` only from 2.31, and an older one would send no auth header at all.
 */
function remoteAuthEnv(url: string, cwd: string): Readonly<Record<string, string>> {
  const env = githubTokenEnv(url, GITHUB_HTTPS);
  if (Object.keys(env).length > 0) {
    refuseGitWithoutEnvConfig(git(['version'], { cwd }).stdout);
  }
  return env;
}

/** The first git that reads configuration from `GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n`. */
const ENV_CONFIG_GIT = { major: 2, minor: 31 } as const;

/**
 * Refuse a `git version` answer older than {@link ENV_CONFIG_GIT}. An answer that does not parse
 * (`git version X.Y…` has been git's format throughout) is let through: this names a requirement,
 * and refusing a git VAT cannot read would block a likely-working setup on a guess.
 */
function refuseGitWithoutEnvConfig(versionText: string): void {
  const match = /^git version (\d+)\.(\d+)/.exec(versionText);
  if (match === null) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > ENV_CONFIG_GIT.major || (major === ENV_CONFIG_GIT.major && minor >= ENV_CONFIG_GIT.minor)) return;
  throw new CommandRefusalError(
    'BACKEND_UNAVAILABLE',
    `Publishing with GH_TOKEN/GITHUB_TOKEN needs git 2.31 or newer, which reads the auth header from the environment; this is ${versionText}. Upgrade git.`,
  );
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
 *
 * Two entries, not one. `http.extraheader` is multi-valued: every value that applies is sent, so
 * an operator's own `http.https://github.com/.extraheader` (global or system config, or their own
 * `GIT_CONFIG_*` entry) plus ours made two AUTHORIZATION headers, which GitHub answers with 400. An
 * EMPTY value resets the list (git-config(1), `http.extraHeader`: "an empty value will reset the
 * extra headers to the empty list"; http.c `http_options()`: `else if (!*value)
 * string_list_clear(&extra_http_headers, 0)`), and env entries are read after every config file,
 * so the reset and then the token header leave ours the only one. That reset also drops any other
 * extraheader the operator set for github.com. An extraheader the operator set under a key git's
 * urlmatch ranks MORE specific than `https://github.com/` (a per-repository key) outranks both of
 * ours, and git skips ours for it: the publish then sends the operator's header and NOT the token,
 * so it is unauthenticated as far as VAT's token goes.
 *
 * An empty `GH_TOKEN` counts as unset, so `GITHUB_TOKEN` still applies. `prefix` is the URL prefix
 * the header is keyed to — `https://github.com/` in production; a test points it at a local server.
 */
export function githubTokenEnv(url: string, prefix: string): Record<string, string> {
  const token = nonEmpty(process.env['GH_TOKEN']) ?? nonEmpty(process.env['GITHUB_TOKEN']);
  if (token === undefined || !url.startsWith(prefix)) {
    return {};
  }
  const reset = inheritedConfigCount();
  const header = reset + 1;
  const key = `http.${prefix}.extraheader`;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: String(header + 1),
    [`GIT_CONFIG_KEY_${reset}`]: key,
    [`GIT_CONFIG_VALUE_${reset}`]: '',
    [`GIT_CONFIG_KEY_${header}`]: key,
    [`GIT_CONFIG_VALUE_${header}`]: `AUTHORIZATION: basic ${basic}`,
  };
}

/** `value`, or `undefined` when it is unset or empty. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * The operator's own `GIT_CONFIG_COUNT`: unset or empty is 0 (an empty count git itself would
 * refuse, but ours replaces it). git parses the count with `git_parse_ulong` — base 0 plus unit
 * suffixes, so `0x2`, `010` and `1k` are counts to git — and VAT does not reimplement that parser:
 * anything but plain decimal is refused rather than guessed at.
 */
function inheritedConfigCount(): number {
  const raw = process.env['GIT_CONFIG_COUNT'] ?? '';
  if (raw === '') return 0;
  const count = /^(?:0|[1-9]\d*)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(count)) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `GIT_CONFIG_COUNT is "${raw}": VAT cannot place its GitHub auth entries after a GIT_CONFIG_COUNT it does not read as plain decimal. Set it as plain decimal (e.g. 2), or unset it.`,
    );
  }
  return count;
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

  // Both sides fully qualified: git expands an unqualified destination by its prefix rules, so a
  // remote TAG of the branch's name would be the ref pushed to (overwritten under --force), and a
  // branch and tag of one name would make every push ambiguous.
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;

  if (noPush) {
    // The staging repo is this fetch's remote: a local path, with nothing to authenticate.
    gitAtRemote({ url: tmpRepo, authEnv: () => NO_REMOTE_ENV }, ['fetch'], [force ? `+${refspec}` : refspec], { cwd });
    logger.info(`   Created local branch "${branch}" (not pushed)`);
    logger.info(`   To push later: git push ${redactUrlCredentials(remote)} ${refspec}`);
    return;
  }

  gitAtRemote(target, force ? ['push', '--force'] : ['push'], [refspec], { cwd: tmpRepo, refusal: 'EXTERNAL_API_FAILED' });
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
 *
 * Under `--force` the remote is still asked — the push replaces the branch, so nothing is built
 * on, but a ref the push would hit in its place is refused all the same ({@link remoteTipOf}).
 */
function buildOnRemoteTip(tmpRepo: string, remote: PublishRemote, options: Pick<PublishGitOptions, 'branch' | 'force' | 'noPush' | 'logger'>): void {
  const ref = `refs/heads/${options.branch}`;
  const tip = remoteTipOf(tmpRepo, remote, ref);
  if (options.force) {
    return;
  }
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
 *
 * 🔴 A remote holding a ref that `git push` would match for the destination `ref` refuses: git
 * matches a push destination by its abbreviation rules, so `refs/heads/b` names
 * `refs/heads/refs/heads/b` when there is no `refs/heads/b` (a plain push is rejected against it,
 * a `--force` push overwrites it), and both together make every push ambiguous. No refspec spells
 * "exactly this ref" to git push.
 */
function remoteTipOf(tmpRepo: string, remote: PublishRemote, ref: string): string | undefined {
  const probe = gitAtRemote(remote, ['ls-remote', '--exit-code'], [ref, `${ref}/HEAD`], { cwd: tmpRepo, allowFailure: true });
  if (probe.status === LS_REMOTE_NO_MATCH) {
    return undefined;
  }
  if (probe.status !== 0) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `git ls-remote could not read ${redactUrlCredentials(remote.url)} ${probeFailure(probe)}`);
  }
  const listed = new Map<string, string>();
  for (const line of probe.stdout.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name !== undefined && sha !== undefined && isObjectId(sha)) {
      listed.set(name, sha);
    }
  }
  const clashes = pushDestinationAliases(ref).filter((name) => listed.has(name));
  if (clashes.length > 0) {
    throw new CommandRefusalError(
      'CONFIG_INVALID',
      `${redactUrlCredentials(remote.url)} holds ${clashes.join(', ')}, which git push would update in place of ${ref}. Delete or rename it on the remote, or publish to another branch.`,
    );
  }
  return listed.get(ref);
}

/**
 * The refs other than `ref` that `git push` matches for the destination `ref`: git's rev-parse
 * rules (`ref_rev_parse_rules`, applied by `refname_match`) each prefix it.
 */
function pushDestinationAliases(ref: string): string[] {
  return [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`];
}

/** A full SHA-1 or SHA-256 object id, as `ls-remote` prints one. */
function isObjectId(text: string): boolean {
  return (text.length === 40 || text.length === 64) && /^[\da-f]+$/.test(text);
}

/** {@link publishToGitBranch}'s work in the temp repo: stage the tree, commit it, deliver it. */
async function commitAndDeliver(tmpRepo: string, cwd: string, remote: PublishRemote, options: PublishGitOptions): Promise<void> {
  const { publishDir, branch, commitMessage, dryRun, logger } = options;
  git(['init'], { cwd: tmpRepo });
  git(['config', 'user.email', 'vat-publish@localhost'], { cwd: tmpRepo });
  git(['config', 'user.name', 'vat marketplace publish'], { cwd: tmpRepo });
  git(['checkout', '-b', branch], { cwd: tmpRepo });

  // Build on the branch's tip — under --force (the push replaces the branch) only the probe runs.
  // Skipped for a dry run, which contacts no remote.
  if (!dryRun) {
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

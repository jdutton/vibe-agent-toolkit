import { safePath } from '@vibe-agent-toolkit/utils';
import { runGit } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __internal,
  createCommitMessage,
  publishToGitBranch,
} from '../../../../src/commands/claude/marketplace/git-publish.js';
import { refusalCodeOf } from '../../../../src/utils/command-refusal.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { errno, thrownBy } from '../../../helpers/refusal-doubles.js';
import { useScratchTmpdir } from '../../../helpers/scratch-tmpdir.js';
import { createTempDirTracker, fs } from '../../../system/test-common.js';

vi.mock('@vibe-agent-toolkit/utils/git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runGit: vi.fn(),
}));

/** Every git call exits `status` with `stderr`, and nothing else happens. */
function gitExits(status: number, stderr = ''): void {
  vi.mocked(runGit).mockReturnValue({ stdout: '', stderr, status } as ReturnType<typeof runGit>);
}

/** The tip the remote reports for branch `b`, and what a clean exit of each subcommand prints by default. */
const TIP = 'a'.repeat(40);
const CLEAN_STDOUT: Record<string, string> = { 'ls-remote': `${TIP}\trefs/heads/b`, 'rev-parse': TIP };

/** Each git subcommand exits as `exits` says (default 0), printing `stdout[subcommand]` on a clean exit; `diff` exits 0 so the publish stops at "no changes". */
function gitBy(exits: Record<string, number>, stdout: Record<string, string> = CLEAN_STDOUT): void {
  vi.mocked(runGit).mockImplementation((args: readonly string[]) => {
    const subcommand = args[0] ?? '';
    const status = exits[subcommand] ?? 0;
    const printed = status === 0 ? stdout[subcommand] ?? '' : '';
    return { stdout: printed, stderr: status === 0 ? '' : `${subcommand} failed`, status } as ReturnType<typeof runGit>;
  });
}

/** Each subcommand returns `results[subcommand]` over a clean exit 0. */
function gitReturns(results: Record<string, Partial<ReturnType<typeof runGit>>>): void {
  vi.mocked(runGit).mockImplementation((args: readonly string[]) =>
    ({ stdout: '', stderr: '', status: 0, ...results[args[0] ?? ''] }) as ReturnType<typeof runGit>);
}

const logger = createLogger({});
const DELIVERY = { branch: 'claude-marketplace', remote: 'origin', force: false, dryRun: false, noPush: false, logger };
const { deliverCommit, git, resolveRemote } = __internal;
/** A remote by URL, through the resolver — the only maker of one. */
const at = (url: string): ReturnType<typeof resolveRemote> => resolveRemote(url, true, '/project');

const HEADLINE_V1 = 'publish v1.0.0';

describe('git-publish', () => {
  describe('createCommitMessage', () => {
    it('should format commit message with headline and changelog delta', () => {
      const msg = createCommitMessage(HEADLINE_V1, '### Added\n- Feature A\n- Feature B');
      expect(msg).toContain(HEADLINE_V1);
      expect(msg).toContain('### Added');
      expect(msg).toContain('Feature A');
    });

    it('should include source repo metadata when provided', () => {
      const msg = createCommitMessage(HEADLINE_V1, '### Added\n- Feature', {
        sourceRepo: 'https://github.com/org/repo',
        commitRange: 'abc123..def456',
      });
      expect(msg).toContain('Source: https://github.com/org/repo');
      expect(msg).toContain('abc123..def456');
    });

    it('should work without changelog delta', () => {
      const msg = createCommitMessage(HEADLINE_V1, '');
      expect(msg).toContain(HEADLINE_V1);
    });

    it('should accept a headline without a version (multi-plugin marketplace)', () => {
      const msg = createCommitMessage('publish my-marketplace', '### Added\n- Bumped plugin-a');
      expect(msg.startsWith('publish my-marketplace')).toBe(true);
      expect(msg).not.toContain('publish v');
      expect(msg).toContain('Bumped plugin-a');
    });
  });

  describe('refusal codes', () => {
    afterEach(() => { vi.mocked(runGit).mockReset(); vi.unstubAllEnvs(); });

    const publish = (remote: string, remoteFromConfig: boolean): Promise<unknown> => publishToGitBranch({
      publishDir: '/never-read', branch: 'b', remote, remoteFromConfig, commitMessage: 'm', force: false, dryRun: true, noPush: false, logger,
    });

    it('refuses the default remote it cannot find as CONFIG_INVALID, saying it was the default', async () => {
      gitExits(2);
      const error = await publish('origin', false).then(() => undefined, (rejected: unknown) => rejected);
      expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
      expect((error as Error).message).toBe(
        'Git remote "origin" (the default — publish.remote is not set) not found. Add it with git remote add, or set publish.remote to a remote name or a full URL.',
      );
    });

    it('refuses a config-named remote it cannot find as CONFIG_INVALID, naming publish.remote', async () => {
      gitExits(2);
      const error = await publish('upstream', true).then(() => undefined, (rejected: unknown) => rejected);
      expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
      expect((error as Error).message).toBe(
        'Git remote "upstream" (from publish.remote) not found. Add it with git remote add, or set publish.remote to a remote name or a full URL.',
      );
    });

    it('refuses a rejected push as EXTERNAL_API_FAILED', () => {
      gitExits(1, 'rejected');
      expect(refusalCodeOf(thrownBy(() => deliverCommit('/staging', '/project', DELIVERY, at('https://example.invalid/r.git'))))).toBe('EXTERNAL_API_FAILED');
    });

    it('redacts credentials in the --no-push "push later" hint', () => {
      gitBy({});
      const said: string[] = [];
      const capture = { ...logger, info: (message: string): void => { said.push(message); } };
      const remote = 'https://x-access-token:ghp_HINT_SECRET@github.com/o/r.git';
      deliverCommit('/staging', '/project', { ...DELIVERY, remote, noPush: true, logger: capture }, at(remote));
      const hint = said.find((line) => line.includes('To push later'));
      expect(hint).toContain('github.com/o/r.git refs/heads/claude-marketplace');
      expect(hint).not.toContain('ghp_HINT_SECRET');
    });

    it('tells a --no-push caller to push the fully qualified branch ref', () => {
      gitBy({});
      const said: string[] = [];
      const capture = { ...logger, info: (message: string): void => { said.push(message); } };
      deliverCommit('/staging', '/project', { ...DELIVERY, noPush: true, logger: capture }, at('https://example.invalid/r.git'));
      expect(said).toContain('   To push later: git push origin refs/heads/claude-marketplace:refs/heads/claude-marketplace');
    });

    it('fetches a --no-push commit from the staging repo with no auth environment, even when a token applies to the remote', () => {
      vi.stubEnv('GH_TOKEN', 'ghp_NOT_FOR_STAGING');
      gitBy({});
      deliverCommit('/staging', '/project', { ...DELIVERY, noPush: true }, at('https://github.com/o/r.git'));
      expect(vi.mocked(runGit).mock.calls.map(([args, options]) => [args, options?.env])).toEqual([
        [['fetch', '--', '/staging', 'refs/heads/claude-marketplace:refs/heads/claude-marketplace'], {}],
      ]);
    });

    it('refuses any other failed git step as RUN_INCOMPLETE', () => {
      gitExits(1, 'fetch failed');
      expect(refusalCodeOf(thrownBy(() => deliverCommit('/staging', '/project', { ...DELIVERY, noPush: true }, at('https://example.invalid/r.git'))))).toBe('RUN_INCOMPLETE');
    });
  });

  // Only the remote-aware route may reach the network, so no network call can leave its auth behind.
  // The guard is an allow list: a deny list on args[0] let `-c k=v push`, `clone`, `pull` and
  // `remote update` through.
  describe('network guard', () => {
    afterEach(() => { vi.mocked(runGit).mockReset(); });

    it.each([
      [['ls-remote', '--', 'https://example.invalid/r.git']],
      [['fetch', '--', 'https://example.invalid/r.git']],
      [['push', '--', 'https://example.invalid/r.git']],
      [['-c', 'k=v', 'push']],
      [['--git-dir=/elsewhere', 'init']],
      [['clone', 'https://example.invalid/r.git']],
      [['pull']],
      [['remote', 'update']],
      [['submodule', 'update']],
      [['archive', '--remote=https://example.invalid/r.git', 'HEAD']],
      [[]],
    ])('refuses `git %j` through the local-only helper, running nothing', (args: string[]) => {
      gitBy({});
      expect(() => git(args, { cwd: '/staging' })).toThrow(/not a local git command/);
      expect(vi.mocked(runGit)).not.toHaveBeenCalled();
    });

    it.each([
      [['init']], [['config', 'user.name', 'n']], [['checkout', '-b', 'b']], [['add', '-A']], [['ls-files', '-z']],
      [['diff', '--cached', '--quiet']], [['commit', '-F', '-']], [['log', '--oneline', '-1']],
      [['rev-parse', '--verify', 'FETCH_HEAD']], [['reset', '--soft', 'HEAD']], [['remote', 'get-url', 'origin']], [['version']],
    ])('runs the local command `git %j`', (args: string[]) => {
      gitBy({});
      git(args, { cwd: '/staging' });
      expect(vi.mocked(runGit)).toHaveBeenCalledTimes(1);
    });
  });

  // The parent of the publish commit is decided by asking the remote, never by whether a fetch
  // happened to finish: a fetch that timed out once built an orphan commit the push then rejected.
  describe('branch history', () => {
    const REMOTE = 'https://example.invalid/marketplace.git';
    const tracker = createTempDirTracker('vat-git-publish-unit-');
    useScratchTmpdir('vat-scratch-git-publish-');
    afterEach(() => { vi.mocked(runGit).mockReset(); tracker.cleanupTempDirs(); });

    const calls = (subcommand: string): (readonly string[])[] =>
      vi.mocked(runGit).mock.calls.map(([args]) => args).filter((args) => args[0] === subcommand);
    const publish = (overrides: { force?: boolean; noPush?: boolean; remote?: string } = {}): Promise<unknown> => {
      const publishDir = tracker.createTempDir();
      fs.writeFileSync(safePath.join(publishDir, 'marketplace.json'), '{}');
      return publishToGitBranch({
        publishDir, branch: 'b', remote: overrides.remote ?? REMOTE, remoteFromConfig: true, commitMessage: 'm',
        force: overrides.force ?? false, dryRun: false, noPush: overrides.noPush ?? false, logger,
      });
    };

    it('builds on the tip of a branch the remote has: a shallow fetch, then a soft reset to the sha the remote reported', async () => {
      gitBy({});
      await publish();
      expect(calls('ls-remote')).toEqual([['ls-remote', '--exit-code', '--', REMOTE, 'refs/heads/b', 'refs/heads/b/HEAD']]);
      expect(calls('fetch')).toEqual([['fetch', '--depth=1', '--', REMOTE, 'refs/heads/b']]);
      expect(calls('reset')).toEqual([['reset', '--soft', TIP]]);
    });

    // `ls-remote <url> refs/heads/b` matches its pattern against the TAIL of each ref: a remote
    // with no `b` but a `x/refs/heads/b` answers exit 0. Only an exact `refs/heads/b` line counts.
    it('makes the first commit an orphan when ls-remote matched only a ref ending in refs/heads/<branch>', async () => {
      gitBy({}, { 'ls-remote': `${TIP}\trefs/heads/x/refs/heads/b` });
      await publish();
      expect(calls('fetch')).toEqual([]);
      expect(calls('reset')).toEqual([]);
    });

    it('refuses as RUN_INCOMPLETE when the fetched tip is not the sha the remote reported, and commits nothing', async () => {
      gitBy({}, { ...CLEAN_STDOUT, 'rev-parse': 'b'.repeat(40) });
      const error = await publish().then(() => undefined, (rejected: unknown) => rejected);
      expect(refusalCodeOf(error)).toBe('RUN_INCOMPLETE');
      expect(calls('reset')).toEqual([]);
      expect(calls('commit')).toEqual([]);
    });

    it('makes the first commit an orphan only when the remote says the branch is absent (exit 2)', async () => {
      gitBy({ 'ls-remote': 2 });
      await publish();
      expect(calls('fetch')).toEqual([]);
      expect(calls('reset')).toEqual([]);
    });

    it('refuses as EXTERNAL_API_FAILED when the remote cannot be asked, and commits nothing', async () => {
      gitBy({ 'ls-remote': 128 });
      const error = await publish().then(() => undefined, (rejected: unknown) => rejected);
      expect(refusalCodeOf(error)).toBe('EXTERNAL_API_FAILED');
      expect(calls('commit')).toEqual([]);
    });

    it('refuses as EXTERNAL_API_FAILED when the branch exists but its tip cannot be fetched, and commits nothing', async () => {
      gitBy({ fetch: 128 });
      const error = await publish().then(() => undefined, (rejected: unknown) => rejected);
      expect(refusalCodeOf(error)).toBe('EXTERNAL_API_FAILED');
      expect(calls('reset')).toEqual([]);
      expect(calls('commit')).toEqual([]);
    });

    it('fetches the full history under --no-push, which copies the staging repo into the caller\'s', async () => {
      gitBy({});
      await publish({ noPush: true });
      expect(calls('fetch')).toEqual([['fetch', '--', REMOTE, 'refs/heads/b']]);
    });

    it('only probes the remote under --force, whose push replaces the branch: no fetch, no reset', async () => {
      gitBy({});
      await publish({ force: true });
      expect(calls('ls-remote')).toHaveLength(1);
      expect(calls('fetch')).toEqual([]);
      expect(calls('reset')).toEqual([]);
    });

    // git push matches its destination by abbreviation rules (remote.c count_refspec_match): a
    // strong alias is taken in place of refs/heads/b, or makes the push ambiguous beside it; a weak
    // (refs/remotes/) one is taken only when refs/heads/b is absent.
    const STRONG = ['refs/refs/heads/b', 'refs/tags/refs/heads/b', 'refs/heads/refs/heads/b'];
    const WEAK = ['refs/remotes/refs/heads/b', 'refs/remotes/refs/heads/b/HEAD'];
    const OTHER = 'c'.repeat(40);
    const EXACT_LINE = `${TIP}\trefs/heads/b\n`;
    const refusalBy = async (listing: string, force: boolean): Promise<unknown> => {
      gitBy({}, { ...CLEAN_STDOUT, 'ls-remote': listing });
      return publish({ force }).then(() => undefined, (rejected: unknown) => rejected);
    };
    describe.each([false, true])('a ref git push would take for the branch (--force: %s)', (force) => {
      it.each([
        ...STRONG.map((alias) => [alias, true] as const),
        ...[...STRONG, ...WEAK].map((alias) => [alias, false] as const),
      ])('refuses %s (refs/heads/b listed: %s) as INPUT_UNREADABLE, naming it, and commits nothing', async (alias, exact) => {
        const exactLine = exact ? EXACT_LINE : '';
        const listing = `${exactLine}${OTHER}\t${alias}`;
        const error = await refusalBy(listing, force);
        expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
        expect((error as Error).message).toContain(alias);
        expect(calls('fetch')).toEqual([]);
        expect(calls('commit')).toEqual([]);
      });

      it.each(WEAK)('publishes beside %s when refs/heads/b is listed: the exact branch outranks a weak match', async (alias) => {
        expect(await refusalBy(`${EXACT_LINE}${OTHER}\t${alias}`, force)).toBeUndefined();
        expect(calls('ls-remote')).toHaveLength(1);
      });
    });

    // --no-push pushes nothing, so a ref the push would take for the branch is no reason to refuse.
    it.each([
      ...STRONG.map((alias) => [alias, true] as const),
      ...[...STRONG, ...WEAK].map((alias) => [alias, false] as const),
    ])('publishes under --no-push beside %s (refs/heads/b listed: %s), building on the exact branch only', async (alias, exact) => {
      gitBy({}, { ...CLEAN_STDOUT, 'ls-remote': `${exact ? EXACT_LINE : ''}${OTHER}\t${alias}` });
      expect(await publish({ noPush: true }).then(() => undefined, (rejected: unknown) => rejected)).toBeUndefined();
      expect(calls('fetch')).toEqual(exact ? [['fetch', '--', REMOTE, 'refs/heads/b']] : []);
    });

    // --force --no-push builds on nothing and pushes nothing: it works offline, as it did before the probe.
    it('contacts no remote under --force --no-push: no ls-remote, no version, no auth environment', async () => {
      vi.stubEnv('GH_TOKEN', 'ghp_OFFLINE');
      vi.stubEnv('GIT_CONFIG_COUNT', 'two');
      gitBy({ diff: 1 }, { ...CLEAN_STDOUT, version: 'git version 2.25.1' });
      try {
        await publish({ force: true, noPush: true, remote: 'https://github.com/o/r.git' });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(calls('ls-remote')).toEqual([]);
      expect(calls('version')).toEqual([]);
      expect(calls('commit')).toHaveLength(1);
      expect(calls('fetch').map((args) => args[2])).toEqual([expect.stringContaining('vat-marketplace-publish-')]);
    });

    // `publish.remote` is config text that lands in git's argv: it must never be read as an
    // option, and git's stderr — which echoes the remote URL, token and all — is redacted.
    describe('remote hardening', () => {
      const SECRET = 'ghp_SECRET_TOKEN_VALUE';
      const TOKENED = `https://x-access-token:${SECRET}@github.com/o/r.git`;
      const rejectionOf = (run: Promise<unknown>): Promise<unknown> => run.then(() => undefined, (rejected: unknown) => rejected);
      it('ends git option parsing before the remote URL in push, with and without --force', () => {
        gitBy({});
        deliverCommit('/staging', '/project', DELIVERY, at(REMOTE));
        deliverCommit('/staging', '/project', { ...DELIVERY, force: true }, at(REMOTE));
        // Both sides fully qualified: an unqualified destination is matched by git's prefix rules,
        // so a remote tag of the branch's name would be the one pushed to (or make the push ambiguous).
        const refspec = 'refs/heads/claude-marketplace:refs/heads/claude-marketplace';
        expect(calls('push')).toEqual([['push', '--', REMOTE, refspec], ['push', '--force', '--', REMOTE, refspec]]);
      });

      it('refuses a publish.remote starting with "-" as CONFIG_INVALID before running any git', async () => {
        gitBy({});
        const error = await rejectionOf(publish({ remote: '--upload-pack=touch /tmp/pwned' }));
        expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
        expect((error as Error).message).toContain('starts with "-"');
        expect(vi.mocked(runGit)).not.toHaveBeenCalled();
      });

      it('refuses a remote name whose URL starts with "-" as CONFIG_INVALID, asking the remote nothing', async () => {
        gitReturns({ remote: { stdout: '--upload-pack=touch /tmp/pwned' } });
        const error = await rejectionOf(publish({ remote: 'origin' }));
        expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
        expect((error as Error).message).toContain('starts with "-"');
        expect(calls('ls-remote')).toEqual([]);
      });

      it('redacts credentials from the stderr of a failed ls-remote probe', async () => {
        gitReturns({ 'ls-remote': { status: 128, stderr: `fatal: unable to access '${TOKENED}/': 403` } });
        const error = await rejectionOf(publish({ remote: TOKENED }));
        expect(refusalCodeOf(error)).toBe('EXTERNAL_API_FAILED');
        expect((error as Error).message).toContain('unable to access');
        expect((error as Error).message).not.toContain(SECRET);
      });

      it('redacts credentials from the stderr of a failed push', () => {
        gitExits(1, `error: failed to push some refs to '${TOKENED}'`);
        const error = thrownBy(() => deliverCommit('/staging', '/project', DELIVERY, at(TOKENED)));
        expect((error as Error).message).toContain('failed to push');
        expect((error as Error).message).not.toContain(SECRET);
      });

      // The token goes to git through its env-only configuration channel, never in a URL: an
      // argv is readable by every local user (`ps`), a process's environment only by its owner.
      describe('CI token', () => {
        const GITHUB_REMOTE = 'https://github.com/o/r.git';
        const EXTRAHEADER = 'http.https://github.com/.extraheader';
        const BASIC = Buffer.from('x-access-token:' + SECRET).toString('base64');
        const HEADER = `AUTHORIZATION: basic ${BASIC}`;
        afterEach(() => { vi.unstubAllEnvs(); });
        const envOf = (subcommand: string): unknown[] =>
          vi.mocked(runGit).mock.calls.filter(([args]) => args[0] === subcommand).map(([, options]) => options?.env);

        it('never puts GH_TOKEN in any git argv, and hands ls-remote, fetch and push the auth header through the environment', async () => {
          vi.stubEnv('GH_TOKEN', SECRET);
          vi.stubEnv('GIT_CONFIG_COUNT', '');
          gitBy({ diff: 1 });
          await publish({ remote: GITHUB_REMOTE });
          expect(calls('push')).toHaveLength(1);
          for (const [args] of vi.mocked(runGit).mock.calls) {
            expect(args.join(' ')).not.toContain(SECRET);
          }
          // Entry 0 resets the extraheader list, so a header configured elsewhere is not sent twice.
          const auth = {
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: EXTRAHEADER, GIT_CONFIG_VALUE_0: '',
            GIT_CONFIG_KEY_1: EXTRAHEADER, GIT_CONFIG_VALUE_1: HEADER,
          };
          for (const subcommand of ['ls-remote', 'fetch', 'push']) {
            expect(envOf(subcommand)).toEqual([auth]);
          }
          // Only the calls that talk to the remote carry it.
          for (const subcommand of ['init', 'add', 'commit']) {
            expect(JSON.stringify(envOf(subcommand))).not.toContain('extraheader');
          }
        });

        it('appends the header after configuration the operator already passes through GIT_CONFIG_COUNT', async () => {
          vi.stubEnv('GH_TOKEN', undefined);
          vi.stubEnv('GITHUB_TOKEN', SECRET);
          vi.stubEnv('GIT_CONFIG_COUNT', '2');
          gitBy({});
          await publish({ remote: GITHUB_REMOTE });
          expect(envOf('ls-remote')).toEqual([{
            GIT_CONFIG_COUNT: '4',
            GIT_CONFIG_KEY_2: EXTRAHEADER, GIT_CONFIG_VALUE_2: '',
            GIT_CONFIG_KEY_3: EXTRAHEADER, GIT_CONFIG_VALUE_3: HEADER,
          }]);
        });

        // git reads the count with strtoumax base 0 plus unit suffixes; VAT does not reimplement that
        // parser, so every spelling but plain decimal is refused rather than guessed at.
        it.each(['two', '0x2', '010', '1k', ' 2', '2 ', '+2', '-1', '99999999999999999999'])(
          'refuses a GIT_CONFIG_COUNT of %j it does not read as plain decimal as INPUT_UNREADABLE, asking the remote nothing',
          async (count) => {
            vi.stubEnv('GH_TOKEN', SECRET);
            vi.stubEnv('GIT_CONFIG_COUNT', count);
            gitBy({});
            const error = await rejectionOf(publish({ remote: GITHUB_REMOTE }));
            expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
            expect((error as Error).message).toContain('plain decimal');
            expect(calls('ls-remote')).toEqual([]);
          },
        );

        it('treats an empty GH_TOKEN as unset and authenticates with GITHUB_TOKEN', async () => {
          vi.stubEnv('GH_TOKEN', '');
          vi.stubEnv('GITHUB_TOKEN', SECRET);
          vi.stubEnv('GIT_CONFIG_COUNT', '');
          gitBy({});
          await publish({ remote: GITHUB_REMOTE });
          expect(JSON.stringify(envOf('ls-remote'))).toContain(HEADER);
        });

        // git before 2.31 ignores GIT_CONFIG_COUNT outright: the header would never be sent, and the
        // publish would fail as an unexplained authentication error.
        describe('git version', () => {
          const withGit = (version: string): void => { gitBy({}, { ...CLEAN_STDOUT, version }); };
          beforeEach(() => {
            vi.stubEnv('GH_TOKEN', SECRET);
            vi.stubEnv('GIT_CONFIG_COUNT', '');
          });

          it.each(['git version 2.30.2', 'git version 2.25.1', 'git version 1.9.5', 'git version 2.30.1.windows.1'])(
            'refuses %j as BACKEND_UNAVAILABLE, naming git 2.31, before asking the remote anything',
            async (version) => {
              withGit(version);
              const error = await rejectionOf(publish({ remote: GITHUB_REMOTE }));
              expect(refusalCodeOf(error)).toBe('BACKEND_UNAVAILABLE');
              expect((error as Error).message).toContain('git 2.31 or newer');
              expect((error as Error).message).toContain(version);
              expect(calls('ls-remote')).toEqual([]);
            },
          );

          // An unparseable answer is let through: the check names a requirement, and refusing a git
          // whose version string VAT cannot read would block a working setup on a guess.
          it.each(['git version 2.31.0', 'git version 2.39.2', 'git version 2.50.1 (Apple Git-155)', 'git version 2.45.1.windows.1', 'git version 3.0', 'not a version', ''])(
            'asks the remote with %j',
            async (version) => {
              withGit(version);
              await publish({ remote: GITHUB_REMOTE });
              expect(calls('ls-remote')).toHaveLength(1);
              expect(calls('version')).toHaveLength(1);
            },
          );

          it('asks git its version only once across ls-remote, fetch and push', async () => {
            gitBy({ diff: 1 }, { ...CLEAN_STDOUT, version: 'git version 2.39.2' });
            await publish({ remote: GITHUB_REMOTE });
            expect(calls('push')).toHaveLength(1);
            expect(calls('version')).toHaveLength(1);
          });

          it('never asks the version when no token applies', async () => {
            vi.stubEnv('GH_TOKEN', undefined);
            vi.stubEnv('GITHUB_TOKEN', undefined);
            withGit('git version 2.25.1');
            await publish({ remote: GITHUB_REMOTE });
            expect(calls('ls-remote')).toHaveLength(1);
            expect(calls('version')).toEqual([]);
          });
        });

        // --dry-run contacts no remote, so neither the auth environment nor the version is read.
        it('builds no auth environment under --dry-run: a bad GIT_CONFIG_COUNT is not refused and git is not asked its version', async () => {
          vi.stubEnv('GH_TOKEN', SECRET);
          vi.stubEnv('GIT_CONFIG_COUNT', 'two');
          gitBy({ diff: 1 }, { ...CLEAN_STDOUT, version: 'git version 2.25.1' });
          const publishDir = tracker.createTempDir();
          fs.writeFileSync(safePath.join(publishDir, 'marketplace.json'), '{}');
          await publishToGitBranch({
            publishDir, branch: 'b', remote: GITHUB_REMOTE, remoteFromConfig: true, commitMessage: 'm',
            force: false, dryRun: true, noPush: false, logger,
          });
          expect(calls('commit')).toHaveLength(1);
          expect(calls('version')).toEqual([]);
        });

        it('sends no auth header to a remote that is not https://github.com/', async () => {
          vi.stubEnv('GH_TOKEN', SECRET);
          gitBy({});
          await publish();
          expect(envOf('ls-remote')).toEqual([{}]);
        });
      });

      it('says a timed-out ls-remote probe timed out, not that it exited', async () => {
        const killed = errno('ETIMEDOUT', 'spawnSync git ETIMEDOUT');
        gitReturns({ 'ls-remote': { status: 1, stderr: killed.message, error: killed } });
        const error = await rejectionOf(publish());
        expect(refusalCodeOf(error)).toBe('EXTERNAL_API_FAILED');
        expect((error as Error).message).toContain('timed out');
        expect((error as Error).message).not.toContain('exit');
      });
    });
  });
});

/**
 * The publish commit's parent, against a real bare remote.
 *
 * A publish once built an orphan commit whenever its fetch of the branch failed (a full-history
 * fetch outliving its timeout on a large marketplace), and the plain push of that orphan was
 * rejected as non-fast-forward. The parent is now decided by asking the remote: an existing branch
 * is built on (a shallow fetch of the tip, so the push fast-forwards with no `--force`), an absent
 * one starts with an orphan, and a remote that cannot be asked refuses.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterEach, describe, expect, it } from 'vitest';

import { publishToGitBranch } from '../../src/commands/claude/marketplace/git-publish.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { bareRemoteAndPublishDir } from '../helpers/marketplace-publish-remote.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { createTempDirTracker, fs } from '../system/test-common.js';

// ⛔ Disposal paths: TMPDIR / TEMP / TMP point at a scratch tree for every test.
useScratchTmpdir('vat-scratch-cli-mp-history-');

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-mp-history-');

const BRANCH = 'claude-marketplace';
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function setUp(): { root: string; bareRemote: string; publishDir: string } {
  const root = createTempDir();
  return { root, ...bareRemoteAndPublishDir(root) };
}

function publish(publishDir: string, remote: string, version: string): Promise<unknown> {
  fs.writeFileSync(safePath.join(publishDir, 'marketplace.json'), JSON.stringify({ name: 'm', version }));
  return publishToGitBranch({
    publishDir, branch: BRANCH, remote, remoteFromConfig: true, commitMessage: `publish v${version}`,
    force: false, dryRun: false, noPush: false, logger: silentLogger,
  });
}

/** The branch's commits on the remote, newest first, as `<subject>` lines. */
function history(bareRemote: string): string[] {
  return String(runGitOrThrow(['log', '--format=%s', BRANCH], { cwd: bareRemote })).trim().split('\n');
}

describe('marketplace publish builds on the remote branch', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('starts an absent branch with an orphan, then fast-forwards each later publish onto its tip', async () => {
    const { bareRemote, publishDir } = setUp();

    await publish(publishDir, bareRemote, '1.0.0');
    expect(history(bareRemote)).toEqual(['publish v1.0.0']);

    await publish(publishDir, bareRemote, '1.0.1');
    await publish(publishDir, bareRemote, '1.0.2');
    // Each publish's parent is the previous tip: the plain (non-force) push fast-forwarded.
    expect(history(bareRemote)).toEqual(['publish v1.0.2', 'publish v1.0.1', 'publish v1.0.0']);
  });

  // `git ls-remote <url> refs/heads/<branch>` matches the pattern against the TAIL of each ref, so
  // a remote with no `claude-marketplace` but a `x/refs/heads/claude-marketplace` answers exit 0.
  it('starts an orphan when the remote holds only a branch whose name ENDS in refs/heads/<branch>', async () => {
    const { bareRemote, publishDir } = setUp();
    const decoy = `refs/heads/x/refs/heads/${BRANCH}`;
    const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' };
    const emptyTree = runGitOrThrow(['mktree'], { cwd: bareRemote, input: '' });
    const seed = runGitOrThrow(['commit-tree', emptyTree, '-m', 'decoy'], { cwd: bareRemote, env: identity });
    runGitOrThrow(['update-ref', decoy, seed], { cwd: bareRemote });

    await publish(publishDir, bareRemote, '1.0.0');
    expect(history(bareRemote)).toEqual(['publish v1.0.0']);
    // The decoy is untouched and is not the new branch's parent.
    expect(runGitOrThrow(['rev-parse', decoy], { cwd: bareRemote })).toBe(seed);
  });

  it('refuses as EXTERNAL_API_FAILED when the remote cannot be asked, and pushes nothing', async () => {
    const { root, publishDir } = setUp();
    const missingRemote = safePath.join(root, 'no-such-remote.git');

    const error = await publish(publishDir, missingRemote, '1.0.0').then(() => undefined, (rejected: unknown) => rejected);
    expect(refusalCodeOf(error)).toBe('EXTERNAL_API_FAILED');
    // Refused at the question, before any commit: not by the push of an orphan it went on to build.
    expect((error as Error).message).toMatch(/^git ls-remote could not read /);
    expect(fs.existsSync(missingRemote)).toBe(false);
  });
});

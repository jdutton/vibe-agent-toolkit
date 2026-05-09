/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file — all file operations are in temp directories; duplicated strings acceptable.
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  publishToGitBranch,
  type PublishGitOptions,
} from '../../src/commands/claude/marketplace/git-publish.js';
import {
  commitAllAndPushMain,
  createTempDirTracker,
  initGitRepoWithRemote,
  listRemoteTagNames,
} from '../system/test-common.js';

interface TestLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
  messages: string[];
}

function createTestLogger(): TestLogger {
  const messages: string[] = [];
  return {
    info: (msg: string) => messages.push(msg),
    error: (msg: string) => messages.push(msg),
    debug: () => { /* swallow debug noise */ },
    messages,
  };
}

interface PublishFixture {
  /** Source repo where vat is "invoked" — tag pushes target this repo. */
  sourceRepo: string;
  /** Bare remote that source/publish branches push to. */
  bareRemote: string;
  /** Directory containing the composed publish tree (publishDir input). */
  publishTree: string;
}

/**
 * Set up a triple of dirs:
 *   - bareRemote: a `git init --bare` remote
 *   - sourceRepo: a working repo with bareRemote as `origin`, plus an initial
 *     commit on `main` so refs exist for tag operations
 *   - publishTree: a hand-built composed-tree dir holding a minimal
 *     marketplace.json — feeds publishToGitBranch.publishDir directly
 */
function setupPublishFixture(createTempDir: () => string): PublishFixture {
  const root = createTempDir();
  const bareRemote = safePath.join(root, 'remote.git');
  const sourceRepo = safePath.join(root, 'src');
  const publishTree = safePath.join(root, 'tree');

  mkdirSyncReal(bareRemote, { recursive: true });
  mkdirSyncReal(sourceRepo, { recursive: true });
  mkdirSyncReal(publishTree, { recursive: true });

  // Bare remote
  safeExecSync('git', ['init', '--bare', '-q'], { cwd: bareRemote });

  // Source repo with bareRemote as origin
  initGitRepoWithRemote(sourceRepo, bareRemote);
  writeFileSync(safePath.join(sourceRepo, 'README.md'), '# src\n');
  commitAllAndPushMain(sourceRepo);

  // Hand-built publish tree (skip composePublishTree — we're testing git-publish only)
  mkdirSyncReal(safePath.join(publishTree, '.claude-plugin'), { recursive: true });
  writeFileSync(
    safePath.join(publishTree, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'test-mp', plugins: [{ name: 'foo', version: '1.0.0' }] }, null, 2),
  );

  return { sourceRepo, bareRemote, publishTree };
}

/**
 * publishToGitBranch reads `process.cwd()` as the source-repo cwd. Tests
 * temporarily chdir into the fixture's source repo so tag pushes target the
 * right repo.
 */
async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

/**
 * Build PublishGitOptions for a fixture. Centralizes the shared "publish foo
 * v1.0.0" shape so individual tests only declare what differs (dryRun, noPush,
 * publishedPlugins).
 */
function buildPublishOptions(
  fx: PublishFixture,
  logger: TestLogger,
  overrides: Partial<PublishGitOptions> = {},
): PublishGitOptions {
  return {
    publishDir: fx.publishTree,
    branch: 'claude-marketplace',
    remote: fx.bareRemote,
    commitMessage: 'publish v1.0.0',
    force: false,
    dryRun: false,
    noPush: false,
    publishedPlugins: [{ name: 'foo', version: '1.0.0' }],
    logger,
    ...overrides,
  };
}

/** Run publishToGitBranch from inside the source repo with the standard option set. */
async function runPublish(
  fx: PublishFixture,
  logger: TestLogger,
  overrides: Partial<PublishGitOptions> = {},
): Promise<void> {
  await withCwd(fx.sourceRepo, () =>
    publishToGitBranch(buildPublishOptions(fx, logger, overrides)),
  );
}

describe('publishToGitBranch — per-plugin tag push', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-publish-tags-');
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDirs();
  });

  it('pushes per-plugin tag on successful publish', async () => {
    const fx = setupPublishFixture(createTempDir);
    const logger = createTestLogger();

    await runPublish(fx, logger);

    const tags = listRemoteTagNames(fx.sourceRepo, fx.bareRemote);
    expect(tags).toContain('foo-v1.0.0');
  });

  it('does not throw when tag push fails — branch publish still succeeds', async () => {
    const fx = setupPublishFixture(createTempDir);
    const logger = createTestLogger();

    // Pre-create the tag on the bare remote pointing to the existing main commit.
    // The publish flow uses non-force `git push <remote> <tag>`, so re-pushing
    // a different commit-id under the same tag will be rejected by the remote.
    safeExecSync('git', ['tag', 'foo-v1.0.0'], { cwd: fx.sourceRepo });
    safeExecSync('git', ['push', fx.bareRemote, 'foo-v1.0.0'], { cwd: fx.sourceRepo });
    safeExecSync('git', ['tag', '-d', 'foo-v1.0.0'], { cwd: fx.sourceRepo });
    // Make a second commit so the local tag will point to a different SHA than
    // the one published to the remote.
    writeFileSync(safePath.join(fx.sourceRepo, 'CHANGED.md'), 'x\n');
    safeExecSync('git', ['add', '-A'], { cwd: fx.sourceRepo });
    safeExecSync('git', ['commit', '-q', '-m', 'change'], { cwd: fx.sourceRepo });

    let threw = false;
    try {
      await runPublish(fx, logger);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);

    // Branch push should have succeeded — verify on the bare remote.
    const remoteBranches = String(
      safeExecSync('git', ['ls-remote', '--heads', fx.bareRemote], {
        cwd: fx.sourceRepo,
        encoding: 'utf-8',
      }),
    );
    expect(remoteBranches).toContain('refs/heads/claude-marketplace');

    // A warning about the failed tag push must be present in logger output.
    const warnLine = logger.messages.find(
      (m) => m.includes('failed to push tag foo-v1.0.0'),
    );
    expect(warnLine).toBeDefined();
  });

  it('republish-without-bump: does not move local tag or push when HEAD differs', async () => {
    const fx = setupPublishFixture(createTempDir);
    const logger1 = createTestLogger();

    // First publish — creates tag locally and pushes it to the remote.
    await runPublish(fx, logger1);

    const tagsAfterFirst = listRemoteTagNames(fx.sourceRepo, fx.bareRemote);
    expect(tagsAfterFirst).toContain('foo-v1.0.0');

    // Capture the SHA the local tag points at after the first publish.
    const originalTagSha = String(
      safeExecSync('git', ['rev-list', '-n', '1', 'foo-v1.0.0'], {
        cwd: fx.sourceRepo,
        encoding: 'utf-8',
      }),
    ).trim();

    // Add a NEW commit to the source repo without bumping the plugin version.
    // HEAD now differs from the existing tag's commit.
    writeFileSync(safePath.join(fx.sourceRepo, 'CHANGED.md'), 'docs tweak\n');
    safeExecSync('git', ['add', '-A'], { cwd: fx.sourceRepo });
    safeExecSync('git', ['commit', '-q', '-m', 'docs tweak'], { cwd: fx.sourceRepo });

    // Make the publish tree differ from the previous publish so the second
    // publishToGitBranch run actually creates a new commit on the publish
    // branch (and thus reaches the tag step). In a real docs-tweak scenario
    // the marketplace.json may differ even at the same plugin version (e.g.
    // marketplace-level metadata changed); we simulate that here.
    writeFileSync(
      safePath.join(fx.publishTree, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(
        { name: 'test-mp', plugins: [{ name: 'foo', version: '1.0.0' }], note: 'rev2' },
        null,
        2,
      ),
    );

    const newHeadSha = String(
      safeExecSync('git', ['rev-parse', 'HEAD'], {
        cwd: fx.sourceRepo,
        encoding: 'utf-8',
      }),
    ).trim();
    expect(newHeadSha).not.toBe(originalTagSha);

    // Republish at the same version. The publish itself should succeed (a new
    // commit on the publish branch), but the tag-handling step must:
    //   - Leave the local tag pointing at the original commit (not move it)
    //   - Not attempt to push the tag (since SHA differs)
    //   - Log a warning explaining the republish-without-bump case
    const logger2 = createTestLogger();
    await runPublish(fx, logger2);

    // Local tag must still point at the original commit.
    const tagShaAfterRepublish = String(
      safeExecSync('git', ['rev-list', '-n', '1', 'foo-v1.0.0'], {
        cwd: fx.sourceRepo,
        encoding: 'utf-8',
      }),
    ).trim();
    expect(tagShaAfterRepublish).toBe(originalTagSha);

    // Remote tag must still point at the original commit.
    const remoteTagSha = String(
      safeExecSync('git', ['ls-remote', fx.bareRemote, 'refs/tags/foo-v1.0.0'], {
        cwd: fx.sourceRepo,
        encoding: 'utf-8',
      }),
    ).trim().split(/\s+/)[0];
    expect(remoteTagSha).toBe(originalTagSha);

    // Warning must explain the republish-without-bump case.
    const warnLine = logger2.messages.find(
      (m) =>
        m.includes('foo-v1.0.0') &&
        m.includes('already exists locally') &&
        m.includes('republished'),
    );
    expect(warnLine).toBeDefined();

    // Branch publish itself must have succeeded — verify on the bare remote.
    const remoteBranches = String(
      safeExecSync('git', ['ls-remote', '--heads', fx.bareRemote], {
        cwd: fx.sourceRepo,
        encoding: 'utf-8',
      }),
    );
    expect(remoteBranches).toContain('refs/heads/claude-marketplace');
  });

  it('does not push tags in dry-run mode', async () => {
    const fx = setupPublishFixture(createTempDir);
    const logger = createTestLogger();

    await runPublish(fx, logger, { dryRun: true });

    const tags = listRemoteTagNames(fx.sourceRepo, fx.bareRemote);
    expect(tags).not.toContain('foo-v1.0.0');
  });

  it('does not push tags in no-push mode', async () => {
    const fx = setupPublishFixture(createTempDir);
    const logger = createTestLogger();

    await runPublish(fx, logger, { noPush: true });

    const tags = listRemoteTagNames(fx.sourceRepo, fx.bareRemote);
    expect(tags).not.toContain('foo-v1.0.0');
  });

  it('is a no-op when publishedPlugins is empty', async () => {
    const fx = setupPublishFixture(createTempDir);
    const logger = createTestLogger();

    await runPublish(fx, logger, { publishedPlugins: [] });

    const tags = listRemoteTagNames(fx.sourceRepo, fx.bareRemote);
    expect(tags.length).toBe(0);
  });
});

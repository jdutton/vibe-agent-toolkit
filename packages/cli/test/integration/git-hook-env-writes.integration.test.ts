/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
/**
 * The two VAT code paths that **write** with git must not write to whichever
 * repository happens to be named in the ambient environment.
 *
 * `packages/utils/test/integration/git-hook-env.integration.test.ts` pins the
 * *reading* helpers. This file pins the writing ones, where the failure is not a
 * wrong answer but a modified bystander: measured 2026-08-16 under a real
 * worktree pre-commit hook, `publishToGitBranch` switched an unrelated
 * repository's branch, rewrote its index and landed a commit in it, and
 * `materializeTrapCorpus({ initGit: true })` returned `true` having created no
 * repository at all — `git init` merely re-initialized the inherited `GIT_DIR`
 * (exit 0, `warning: re-init`) and the `add`/`commit` went there too.
 *
 * The fixture is a **bystander repository the code under test is never told
 * about**. That is what makes the test able to fail: an assertion that the
 * corpus looks right would pass in both worlds, because the damage lands
 * somewhere the subject never names.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { detachGitEnv, mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publishToGitBranch } from '../../src/commands/claude/marketplace/git-publish.js';
import { materializeTrapCorpus } from '../../src/pipeline-oracles/trap-corpus.js';
import { createLogger } from '../../src/utils/logger.js';

/** Config pinned inline so a developer's global git config cannot alter the fixture. */
const GIT_CONFIG = [
  '-c',
  'user.email=bystander@example.invalid',
  '-c',
  'user.name=Bystander',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

/**
 * Run one git command in the fixture, failing loudly rather than silently.
 *
 * @param cwd - Directory to run in
 * @param args - Arguments after `git`
 * @returns Trimmed stdout
 */
function fixtureGit(cwd: string, args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  const result = spawnSync('git', [...GIT_CONFIG, ...args], { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

/** A repository nobody under test is told about, plus how to describe its state. */
interface Bystander {
  /** Absolute path to the repository. */
  readonly dir: string;
  /** HEAD commit and current branch, as one comparable string. */
  state(): string;
}

/**
 * Create the bystander repository and point the environment at it, exactly as a
 * worktree's pre-commit hook does.
 *
 * @returns The repository and a reader for its state
 */
function enterBystanderHook(): Bystander {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-bystander-'));
  fixtureGit(dir, ['init', '--quiet']);
  writeFileSync(safePath.join(dir, 'BYSTANDER.md'), 'bystander\n');
  fixtureGit(dir, ['add', '-A']);
  fixtureGit(dir, ['commit', '--quiet', '-m', 'bystander']);

  const gitDir = safePath.join(dir, '.git');
  process.env.GIT_DIR = gitDir;
  process.env.GIT_WORK_TREE = dir;
  process.env.GIT_INDEX_FILE = safePath.join(gitDir, 'index');
  process.env.GIT_PREFIX = '';

  return {
    dir,
    state: () =>
      `${fixtureGit(dir, ['rev-parse', 'HEAD'])} ${fixtureGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])}`,
  };
}

describe('git writes under a worktree hook environment', () => {
  let restoreGitEnv: () => void;
  let bystander: Bystander;
  let scratch: string;

  beforeEach(() => {
    restoreGitEnv = detachGitEnv();
    scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hookwrite-'));
    bystander = enterBystanderHook();
  });

  afterEach(() => {
    restoreGitEnv();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(bystander.dir, { recursive: true, force: true });
  });

  it('materializeTrapCorpus initializes the corpus, not the inherited GIT_DIR', () => {
    const before = bystander.state();
    const root = safePath.join(scratch, 'corpus');

    const built = materializeTrapCorpus(root, { initGit: true, skipSymlinks: true });

    // Without the scrub every step still reported success, so `gitInitialized`
    // alone cannot tell the two worlds apart — the repository's existence can.
    expect(built.gitInitialized).toBe(true);
    expect(existsSync(safePath.join(root, '.git'))).toBe(true);
    expect(bystander.state()).toBe(before);
  });

  it('publishToGitBranch stages in its own temp repo, leaving the ambient one alone', async () => {
    const before = bystander.state();
    const publishDir = safePath.join(scratch, 'publish');
    mkdirSyncReal(publishDir, { recursive: true });
    writeFileSync(safePath.join(publishDir, 'marketplace.json'), '{"plugins":[]}\n');

    await publishToGitBranch({
      publishDir,
      branch: 'test-branch',
      // Looks like a URL, so it is used verbatim and no remote lookup happens.
      remote: 'https://example.invalid/marketplace.git',
      commitMessage: 'publish test',
      force: false,
      dryRun: true,
      noPush: false,
      logger: createLogger(),
    });

    // The branch name above is deliberately one the bystander does not have:
    // unscrubbed, `checkout -b test-branch` ran against the bystander and moved
    // it off `main`, which is what this comparison detects.
    expect(bystander.state()).toBe(before);
  });
});

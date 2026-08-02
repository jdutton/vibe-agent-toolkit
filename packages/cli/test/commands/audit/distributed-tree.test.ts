/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir the test owns */
/**
 * The provenance classifier behind `PACKAGED_AGENT_INSTRUCTION_FILE`'s audit lane.
 *
 * Every fixture that asserts anything about tracked-ness `git init`s and commits
 * for real. A `mkdtemp` directory with no repo has NO gitignore semantics at all,
 * so a fixture that skips `git init` cannot tell "source" from "distributed" — it
 * would agree with any implementation, including a no-op.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyScannedSkillTree,
  resetGitTrackerCache,
} from '../../../src/commands/audit/distributed-tree.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { commitTestFixture, initTestGitRepo } from '../../test-helpers.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-provenance-');

const SKILL_REL_DIR = 'skills/demo';
const SOURCE: Awaited<ReturnType<typeof classifyScannedSkillTree>> = 'repo-source';
const DISTRIBUTED: Awaited<ReturnType<typeof classifyScannedSkillTree>> = 'distributed';

/** Create `<root>/<relDir>/SKILL.md` and return its absolute path. */
function placeSkill(root: string, relDir: string): string {
  const dir = safePath.join(root, relDir);
  mkdirSyncReal(dir, { recursive: true });
  const skillMd = safePath.join(dir, 'SKILL.md');
  writeFileSync(skillMd, '---\nname: demo\ndescription: x\n---\n', 'utf-8');
  return skillMd;
}

/**
 * Classify `skillMd` with `CLAUDE_CONFIG_DIR` pointed at `claudeDir`, restoring
 * whatever the environment held before. The classifier reads the variable on
 * every call precisely so a fixture can move the install root.
 */
async function classifyWithInstallRoot(
  claudeDir: string,
  skillMd: string,
): ReturnType<typeof classifyScannedSkillTree> {
  const previous = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
  try {
    return await classifyScannedSkillTree(skillMd);
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = previous;
  }
}

describe('classifyScannedSkillTree', () => {
  afterEach(() => {
    // The tracker cache is keyed by git root and each fixture reuses none, but a
    // stale entry would still outlive its temp dir inside one vitest worker.
    resetGitTrackerCache();
    cleanupTempDirs();
  });

  it('calls a committed skill in a repo repo-source', async () => {
    const root = createTempDir();
    const skillMd = placeSkill(root, SKILL_REL_DIR);
    commitTestFixture(root);

    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(SOURCE);
  });

  it('calls an untracked-but-not-ignored skill repo-source', async () => {
    // Authoring in progress. Demanding a commit before a tree counts as source
    // would make the first audit of a brand-new skill the loudest one.
    const root = createTempDir();
    initTestGitRepo(root);
    const skillMd = placeSkill(root, SKILL_REL_DIR);

    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(SOURCE);
  });

  it('calls a gitignored build output distributed', async () => {
    const root = createTempDir();
    writeFileSync(safePath.join(root, '.gitignore'), 'dist/\n', 'utf-8');
    placeSkill(root, SKILL_REL_DIR);
    commitTestFixture(root);
    const bundled = placeSkill(root, `dist/${SKILL_REL_DIR}`);

    await expect(classifyScannedSkillTree(bundled)).resolves.toBe(DISTRIBUTED);
  });

  it('calls a tree outside any git repository distributed', async () => {
    const skillMd = placeSkill(createTempDir(), 'unpacked/demo');

    await expect(classifyScannedSkillTree(skillMd)).resolves.toBe(DISTRIBUTED);
  });

  it('calls an install-root tree distributed even when git tracks it', async () => {
    // Claude Code installs marketplaces by `git clone`, so an installed tree IS
    // tracked source — of somebody else's repo. Location has to outrank git here
    // or every installed finding disappears.
    const claudeDir = createTempDir();
    const skillMd = placeSkill(claudeDir, SKILL_REL_DIR);
    commitTestFixture(claudeDir);

    await expect(classifyWithInstallRoot(claudeDir, skillMd)).resolves.toBe(DISTRIBUTED);
  });

  it('leaves a repo that merely sits NEXT TO the install root alone', async () => {
    // Guards the prefix test itself: `~/.claude-work` must not read as inside
    // `~/.claude`, which a bare startsWith without the separator would do.
    const parent = createTempDir();
    const claudeDir = safePath.join(parent, '.claude');
    const sibling = safePath.join(parent, '.claude-work');
    mkdirSyncReal(claudeDir, { recursive: true });
    const skillMd = placeSkill(sibling, SKILL_REL_DIR);
    commitTestFixture(sibling);

    await expect(classifyWithInstallRoot(claudeDir, skillMd)).resolves.toBe(SOURCE);
  });
});

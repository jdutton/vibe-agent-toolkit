/**
 * The three FOLLOWING walks in this package — the skill-source content hash,
 * the bundled-resource detector, the post-build file walk — each recursed
 * through a link back into their own tree until the stack or the path length
 * gave out. Each now holds a `FollowedWalk` from `@vibe-agent-toolkit/utils`
 * and refuses the revisit by name. One suite, the shared hostile tree's
 * `loop` shape planted in a clean subtree, all three walkers.
 */
import { writeFileSync } from 'node:fs';

import { createSymlink, DirectoryWalkRevisitedError, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { type HostileTree, hostileTreePerTest } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkUnreferencedFiles } from '../../src/post-build-checks.js';
import { hashDirectory } from '../../src/skill-source/content-hash.js';
import { detectBundledResourceWithoutLinks } from '../../src/validators/bundled-resource-link-detection.js';

/** `root/nested/scripts/a.sh` plus a SKILL.md — a skill-shaped subtree under the hostile root. */
function plantSkill(tree: HostileTree, name: string): { skillDir: string; scripts: string } {
  const skillDir = safePath.join(tree.root, 'nested');
  const scripts = safePath.join(skillDir, 'scripts');
  mkdirSyncReal(scripts, { recursive: true });
  writeFileSync(safePath.join(scripts, 'a.sh'), 'echo a\n');
  writeFileSync(safePath.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill for the walker suite.\n---\n`);
  return { skillDir, scripts };
}

/** {@link plantSkill} plus `scripts/back -> skillDir`: one loop. `''` where the host cannot link. */
function plantLoopedSkill(tree: HostileTree): string {
  const cap = symlinkCapability();
  if (cap === null) return '';
  const { skillDir, scripts } = plantSkill(tree, 'looped');
  createSymlink(cap, skillDir, safePath.join(scripts, 'back'), 'dir');
  return skillDir;
}

describe('following walkers on a tree with a link back into itself', () => {
  const hostile = hostileTreePerTest('followed-walkers-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  it('hashDirectory refuses the loop instead of hashing forever', async ({ skip }) => {
    const skillDir = plantLoopedSkill(tree());
    if (skillDir === '') skip('host cannot create symlinks');

    await expect(hashDirectory(skillDir)).rejects.toThrow(DirectoryWalkRevisitedError);
  });

  it('detectBundledResourceWithoutLinks refuses the loop under a bundled subdirectory', ({ skip }) => {
    const skillDir = plantLoopedSkill(tree());
    if (skillDir === '') skip('host cannot create symlinks');

    expect(() => detectBundledResourceWithoutLinks('', skillDir, [], skillDir)).toThrow(DirectoryWalkRevisitedError);
  });

  it('checkUnreferencedFiles refuses the loop in a packaged output tree', async ({ skip }) => {
    const skillDir = plantLoopedSkill(tree());
    if (skillDir === '') skip('host cannot create symlinks');

    await expect(checkUnreferencedFiles(skillDir)).rejects.toThrow(DirectoryWalkRevisitedError);
  });

  it('control: the same subtree without the loop walks cleanly in all three', async () => {
    const { skillDir } = plantSkill(tree(), 'plain');

    expect(await hashDirectory(skillDir)).toMatch(/^[0-9a-f]{64}$/);
    expect(detectBundledResourceWithoutLinks('scripts/a.sh', skillDir, [], skillDir)).toEqual([]);
    expect(Array.isArray(await checkUnreferencedFiles(skillDir))).toBe(true);
  });
});

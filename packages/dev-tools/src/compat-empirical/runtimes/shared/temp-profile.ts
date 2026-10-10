/**
 * Build a temporary HOME-style Claude profile so the harness's driver runs
 * never touch the user's real ~/.claude/.
 */


import { mkdtempSync, writeFileSync } from 'node:fs';

import {
  applyTreePlan,
  copyTree,
  disposeTempDir,
  mkdirSyncReal,
  normalizedTmpdir,
  planTreeChanges,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

import type { StagedSkill } from '../../corpus/fetch-sources.js';

export interface TempProfile {
  /** Absolute path (forward slashes) to the temporary HOME. */
  homeDir: string;
  claudeDir: string;
  skillsDir: string;
}

export function createTempProfile(): TempProfile {
  const home = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-empirical-home-')));
  const claudeDir = safePath.join(home, '.claude');
  const skillsDir = safePath.join(claudeDir, 'skills');
  mkdirSyncReal(skillsDir, { recursive: true });
  mkdirSyncReal(safePath.join(claudeDir, 'plugins'), { recursive: true });
  mkdirSyncReal(safePath.join(claudeDir, 'marketplaces'), { recursive: true });
  writeFileSync(safePath.join(claudeDir, 'settings.json'), '{}\n', 'utf8');
  return { homeDir: home, claudeDir, skillsDir };
}

/**
 * Wipe the skills directory so only the next-installed skill is discoverable.
 *
 * Why: Claude Code routes a trigger prompt against *every* installed skill's
 * description. Leaving prior skills in the profile lets a high-affinity
 * description fire for an unrelated prompt, contaminating per-skill rows in
 * the matrix.
 */
export async function resetSkillsDir(profile: TempProfile): Promise<void> {
  // The profile is this harness's own: whatever the skills dir holds goes, whole.
  await applyTreePlan(await planTreeChanges([{ op: 'remove', dest: profile.skillsDir, ownership: { kind: 'vat-state' }, label: 'profile skills' }]));
  mkdirSyncReal(profile.skillsDir, { recursive: true });
}

export async function installSkillIntoProfile(profile: TempProfile, skill: StagedSkill, skillId: string): Promise<string> {
  await resetSkillsDir(profile);
  const dest = safePath.join(profile.skillsDir, skillId);
  await copyTree(skill.rootDir, dest, { links: 'preserve', side: 'source', onto: 'fresh' });
  return dest;
}

export async function teardownTempProfile(profile: TempProfile): Promise<void> {
  // A profile left in the temp dir would leak into the next attempt's matrix: the run stops on it.
  const leftover = await disposeTempDir(profile.homeDir);
  if (leftover !== undefined) throw leftover;
}

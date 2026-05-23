/**
 * Build a temporary HOME-style Claude profile so the harness's driver runs
 * never touch the user's real ~/.claude/.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- profile paths derive from mkdtemp */

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
export function resetSkillsDir(profile: TempProfile): void {
  if (existsSync(profile.skillsDir)) {
    rmSync(profile.skillsDir, { recursive: true, force: true });
  }
  mkdirSyncReal(profile.skillsDir, { recursive: true });
}

export function installSkillIntoProfile(profile: TempProfile, skill: StagedSkill, skillId: string): string {
  resetSkillsDir(profile);
  const dest = safePath.join(profile.skillsDir, skillId);
  mkdirSyncReal(dest, { recursive: true });
  cpSync(skill.rootDir, dest, { recursive: true });
  return dest;
}

export function teardownTempProfile(profile: TempProfile): void {
  if (existsSync(profile.homeDir)) {
    rmSync(profile.homeDir, { recursive: true, force: true });
  }
}

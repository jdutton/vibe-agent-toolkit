/**
 * Skill target resolution — map (target, scope) to an installation directory.
 *
 * This is a pure lookup table with no vendor-specific logic. Adding new targets
 * is just adding entries to the SKILL_TARGETS constant.
 *
 * Paths use forward slashes on all platforms (see utils/CLAUDE.md).
 */

import { homedir } from 'node:os';

import { safePath } from './path-utils.js';

export const SKILL_TARGET_NAMES = [
  'claude',
  'codex',
  'copilot',
  'gemini',
  'cursor',
  'windsurf',
  'agents',
] as const;

export type SkillTarget = (typeof SKILL_TARGET_NAMES)[number];

export const SKILL_SCOPE_NAMES = ['user', 'project'] as const;

export type SkillScope = (typeof SKILL_SCOPE_NAMES)[number];

interface SkillTargetPaths {
  /** Path relative to the user home directory (without leading ~/) */
  readonly userRel: string;
  /** Path relative to the project root (current working directory) */
  readonly projectRel: string;
}

/** Shared path used by both codex and agents targets (and their user/project scopes). */
const AGENTS_SKILLS_PATH = '.agents/skills';

/**
 * Target → {userRel, projectRel} lookup table.
 *
 * These paths are based on the 2026-04-08 ecosystem analysis. Update this table
 * when platforms change their conventions. See docs/plans/2026-04-08-agent-skills-ecosystem-analysis.md.
 */
export const SKILL_TARGETS: Readonly<Record<SkillTarget, SkillTargetPaths>> = {
  claude: { userRel: '.claude/skills', projectRel: '.claude/skills' },
  codex: { userRel: AGENTS_SKILLS_PATH, projectRel: AGENTS_SKILLS_PATH },
  copilot: { userRel: '.copilot/skills', projectRel: '.github/skills' },
  gemini: { userRel: '.gemini/skills', projectRel: '.gemini/skills' },
  cursor: { userRel: '.cursor/skills', projectRel: '.cursor/skills' },
  windsurf: { userRel: '.codeium/windsurf/skills', projectRel: '.windsurf/skills' },
  agents: { userRel: AGENTS_SKILLS_PATH, projectRel: AGENTS_SKILLS_PATH },
};

function isSkillTarget(value: string): value is SkillTarget {
  return (SKILL_TARGET_NAMES as readonly string[]).includes(value);
}

function isSkillScope(value: string): value is SkillScope {
  return (SKILL_SCOPE_NAMES as readonly string[]).includes(value);
}

/**
 * Resolve a (target, scope, cwd) triple to an absolute skills directory.
 *
 * @param target - Platform target (claude, codex, copilot, gemini, cursor, windsurf, agents)
 * @param scope - user (home dir) or project (cwd)
 * @param cwd - Current working directory for project scope. Pass explicitly for testability.
 * @returns Absolute path to the skills directory using forward slashes
 * @throws Error with a helpful message listing valid values if target or scope is invalid
 */
export function resolveSkillTarget(
  target: SkillTarget,
  scope: SkillScope,
  cwd: string,
): string {
  if (!isSkillTarget(target)) {
    throw new Error(
      `Invalid target "${String(target)}". Valid targets: ${SKILL_TARGET_NAMES.join(', ')}`,
    );
  }
  if (!isSkillScope(scope)) {
    throw new Error(
      `Invalid scope "${String(scope)}". Valid scopes: ${SKILL_SCOPE_NAMES.join(', ')}`,
    );
  }

  const entry = SKILL_TARGETS[target];
  const base = scope === 'user' ? homedir() : cwd;
  const rel = scope === 'user' ? entry.userRel : entry.projectRel;
  return safePath.join(base, rel);
}

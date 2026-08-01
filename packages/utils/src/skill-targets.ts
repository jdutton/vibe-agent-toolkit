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

/**
 * Shared path used by both codex and agents targets (and their user/project scopes).
 *
 * Epistemic status — weaker than the other six rows, deliberately recorded here.
 * `.agents/skills` is a cross-client *convention*, not a specified path. The Agent
 * Skills specification defines only what goes *inside* a skill directory and
 * explicitly declines to say where those directories live. The load-bearing
 * citation is agentskills.io's client-implementation guide, which calls
 * `.agents/skills/` "a widely-adopted convention for cross-client skill sharing"
 * while stating the specification "does not mandate where skill directories live".
 * Note also what is NOT a citation for this: agents.md says nothing about skills at
 * all — no `.agents/skills`, no SKILL.md, no discovery paths — so anyone reaching
 * for it to justify this row is citing a document that does not support it. Every
 * other target below is documented by that target's own vendor for its own client;
 * `agents` is documented convention instead.
 */
const AGENTS_SKILLS_PATH = '.agents/skills';

/**
 * Target → {userRel, projectRel} lookup table.
 *
 * @vendor-claim reviewed=2026-07-30 verify=Each of the seven platforms' own published docs for where it reads skills from (claude, codex, copilot, gemini, cursor, windsurf, agents)
 *
 * Last reviewed against vendor documentation 2026-07-30: all fourteen paths
 * re-read from the first-party sources listed below, all fourteen unchanged.
 * Update this table when platforms change theirs — and re-read those sources when
 * you do, because nothing here is verified at build or test time. A stale entry
 * installs a skill somewhere the target never reads, and every check still passes.
 * The 90-day `@vendor-claim` clock above is the only thing watching these values.
 *
 * What the tests actually do: `packages/utils/test/skill-targets.test.ts` derives
 * its expectations *from* this table and asserts invariants of it — every target
 * present, both scopes non-empty, relative (never absolute, never a leading `~`),
 * forward-slash only — plus that resolveSkillTarget composes base + rel. That
 * verifies the resolver and the table's shape. It cannot verify that any path is
 * where a platform actually looks; no test can. (An earlier version of that file
 * restated all fourteen literals a second time. That pinned the values to a
 * duplicate of this table rather than to vendor reality: a wrong path still
 * passed, and a *corrected* path broke the suite until someone updated the copy —
 * a change-detector masquerading as verification, and friction against exactly the
 * correction the clock above exists to produce.)
 *
 * Sources, one per target, re-read 2026-07-30:
 * - claude   https://code.claude.com/docs/en/skills
 *            (docs.claude.com/en/docs/claude-code/skills now 301s here)
 * - codex    https://developers.openai.com/codex/skills/
 *            (308s to learn.chatgpt.com/docs/build-skills)
 * - copilot  https://docs.github.com/en/copilot/concepts/agents/about-agent-skills
 * - gemini   https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md
 * - cursor   https://cursor.com/docs/skills (skills shipped in Cursor 2.4)
 * - windsurf https://docs.windsurf.com/windsurf/cascade/skills
 *            (307s to docs.devin.ai/desktop/cascade/skills — Devin rebrand)
 * - agents   https://agentskills.io/client-implementation/adding-skills-support
 *            (convention, not specification — see AGENTS_SKILLS_PATH above)
 *
 * Deliberately non-exhaustive: each row is the ONE directory VAT installs into for
 * that (target, scope). Most of these targets *read* several directories, which a
 * 1:1 struct cannot express — so do not read a row as a claim of exclusivity.
 * Notably `.agents/skills` is read by six of the seven targets (every one except
 * `claude`), and both `gemini` and `cursor` rank it at or above the client-native
 * path VAT writes to. Changing where VAT installs is a product decision, not a
 * comment fix.
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

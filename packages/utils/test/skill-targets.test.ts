import { homedir } from 'node:os';

import { describe, it, expect } from 'vitest';

import {
  SKILL_TARGETS,
  SKILL_TARGET_NAMES,
  SKILL_SCOPE_NAMES,
  resolveSkillTarget,
  toForwardSlash,
} from '../src/index.js';

describe('SKILL_TARGETS constant', () => {
  it('contains all 7 expected target names', () => {
    expect(SKILL_TARGET_NAMES).toEqual([
      'claude',
      'codex',
      'copilot',
      'gemini',
      'cursor',
      'windsurf',
      'agents',
    ]);
  });

  it('defines both user and project paths for every target', () => {
    for (const name of SKILL_TARGET_NAMES) {
      const entry = SKILL_TARGETS[name];
      expect(entry).toBeDefined();
      expect(entry.userRel).toBeTruthy();
      expect(entry.projectRel).toBeTruthy();
    }
  });
});

describe('resolveSkillTarget', () => {
  const home = toForwardSlash(homedir());
  // Use a deterministic fake path; homedir is not publicly writable
  const cwd = `${home}/fake-project`;

  const USER_CASES: ReadonlyArray<{ target: string; expected: string }> = [
    { target: 'claude', expected: `${home}/.claude/skills` },
    { target: 'codex', expected: `${home}/.agents/skills` },
    { target: 'copilot', expected: `${home}/.copilot/skills` },
    { target: 'gemini', expected: `${home}/.gemini/skills` },
    { target: 'cursor', expected: `${home}/.cursor/skills` },
    { target: 'windsurf', expected: `${home}/.codeium/windsurf/skills` },
    { target: 'agents', expected: `${home}/.agents/skills` },
  ];

  const PROJECT_CASES: ReadonlyArray<{ target: string; expected: string }> = [
    { target: 'claude', expected: `${cwd}/.claude/skills` },
    { target: 'codex', expected: `${cwd}/.agents/skills` },
    { target: 'copilot', expected: `${cwd}/.github/skills` },
    { target: 'gemini', expected: `${cwd}/.gemini/skills` },
    { target: 'cursor', expected: `${cwd}/.cursor/skills` },
    { target: 'windsurf', expected: `${cwd}/.windsurf/skills` },
    { target: 'agents', expected: `${cwd}/.agents/skills` },
  ];

  for (const { target, expected } of USER_CASES) {
    it(`resolves user scope for ${target} to ${expected}`, () => {
      const result = resolveSkillTarget(target as never, 'user', cwd);
      expect(result).toBe(expected);
    });
  }

  for (const { target, expected } of PROJECT_CASES) {
    it(`resolves project scope for ${target} using provided cwd`, () => {
      const result = resolveSkillTarget(target as never, 'project', cwd);
      expect(result).toBe(expected);
    });
  }

  it('returns forward-slash paths on all platforms', () => {
    const result = resolveSkillTarget('claude', 'project', cwd);
    expect(result).not.toContain('\\');
  });

  it('throws a helpful error for invalid target', () => {
    expect(() =>
      resolveSkillTarget('nope' as never, 'user', cwd)
    ).toThrow(/Invalid target "nope".*claude, codex, copilot, gemini, cursor, windsurf, agents/);
  });

  it('throws a helpful error for invalid scope', () => {
    expect(() =>
      resolveSkillTarget('claude', 'nope' as never, cwd)
    ).toThrow(/Invalid scope "nope".*user, project/);
  });
});

describe('SKILL_SCOPE_NAMES', () => {
  it('contains user and project', () => {
    expect(SKILL_SCOPE_NAMES).toEqual(['user', 'project']);
  });
});

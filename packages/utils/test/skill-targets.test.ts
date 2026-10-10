import type * as NodeOs from 'node:os';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  SKILL_TARGETS,
  SKILL_TARGET_NAMES,
  SKILL_SCOPE_NAMES,
  normalizedTmpdir,
  resolveSkillTarget,
  safePath,
  toForwardSlash,
} from '../src/index.js';

/**
 * Where `os.homedir()` points for the code under test. An environment stub cannot do this: under
 * the threads pool a worker's `process.env` is a copy, and `homedir()` reads the PROCESS's `HOME`.
 */
const homeStub = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => homeStub.dir ?? actual.homedir() };
});

/**
 * These tests deliberately do NOT restate the fourteen literal paths in
 * SKILL_TARGETS. An earlier version did, and that pinned the table to a copy of
 * itself: a wrong path still passed, and a *corrected* path broke the suite until
 * someone updated the copy too — a change-detector masquerading as verification.
 *
 * Whether a path is where a platform actually looks is not testable here at all.
 * That claim is watched by the 90-day `@vendor-claim` review clock on the table
 * itself (packages/utils/src/skill-targets.ts), which is the only mechanism that
 * can watch it.
 *
 * What IS testable, and is asserted below: the table's structural invariants (an
 * entry per declared target; every path relative and forward-slash, so it can be
 * joined onto a home dir or a cwd) and that resolveSkillTarget picks the right
 * base and joins the table's entry onto it.
 */

/** True for POSIX-absolute, UNC, and Windows drive-letter paths alike. */
function looksAbsolute(rel: string): boolean {
  return rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel);
}

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

  it('defines an entry for every declared target and no extras', () => {
    expect(new Set(Object.keys(SKILL_TARGETS))).toEqual(new Set(SKILL_TARGET_NAMES));
  });

  for (const name of SKILL_TARGET_NAMES) {
    it(`holds joinable relative forward-slash paths for ${name}`, () => {
      const entry = SKILL_TARGETS[name];
      for (const rel of [entry.userRel, entry.projectRel]) {
        expect(rel).toBeTruthy();
        expect(rel).not.toContain('\\');
        expect(rel.startsWith('~')).toBe(false);
        expect(looksAbsolute(rel)).toBe(false);
      }
    });
  }
});

describe('resolveSkillTarget', () => {
  // A home under the temp tree — the only kind a test process may resolve a user scope against
  // (`requireTestScratch`). Nothing is created: the resolver only joins.
  const home = safePath.join(toForwardSlash(normalizedTmpdir()), 'vat-skill-targets-home');
  const cwd = `${home}/fake-project`;

  beforeEach(() => {
    homeStub.dir = home;
  });

  afterEach(() => {
    homeStub.dir = undefined;
  });

  describe('in a test process, against a home outside the temp tree', () => {
    const realHome = safePath.resolve(toForwardSlash(normalizedTmpdir()), '..', 'vat-not-the-temp-tree');

    for (const name of SKILL_TARGET_NAMES) {
      it(`refuses the user scope of ${name} — that directory is somebody's`, () => {
        homeStub.dir = realHome;
        expect(() => resolveSkillTarget(name, 'user', cwd)).toThrow(/outside .* refusing to resolve it in a test process/);
      });
    }

    it('still answers the project scope, which never reads the home directory', () => {
      homeStub.dir = realHome;
      expect(resolveSkillTarget('claude', 'project', cwd)).toBe(`${cwd}/${SKILL_TARGETS.claude.projectRel}`);
    });
  });

  for (const name of SKILL_TARGET_NAMES) {
    it(`joins the user-scope entry for ${name} onto the home directory`, () => {
      const result = resolveSkillTarget(name, 'user', cwd);
      expect(result).toBe(`${home}/${SKILL_TARGETS[name].userRel}`);
    });

    it(`joins the project-scope entry for ${name} onto the given cwd`, () => {
      const result = resolveSkillTarget(name, 'project', cwd);
      expect(result).toBe(`${cwd}/${SKILL_TARGETS[name].projectRel}`);
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

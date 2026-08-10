import { mkdtempSync, statSync, writeFileSync, rmSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertSafeHarnessRoot,
  assertSafeWorkdir,
  deriveHarnessKey,
  HarnessLocationError,
  resolveHarnessRoot,
} from '../../src/skill-test/harness-location.js';
import { createSymlinkedDir } from '../test-helpers.js';

describe('deriveHarnessKey', () => {
  it('is deterministic for the same sorted skill set', () => {
    expect(deriveHarnessKey(['b', 'a'])).toBe(deriveHarnessKey(['a', 'b']));
  });

  it('sanitizes names (no path separators leak into the key)', () => {
    const key = deriveHarnessKey(['../evil', 'ok']);
    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
  });

  it('rejects empty skill set with HarnessLocationError', () => {
    expect(() => deriveHarnessKey([])).toThrow(HarnessLocationError);
  });

  it('distinct raw sets that sanitize to the same tokens still differ (hash suffix)', () => {
    // 'a.b' and 'a/b' both sanitize to 'a_b' — only the content hash distinguishes them.
    const first = deriveHarnessKey(['a.b']);
    const second = deriveHarnessKey(['a/b']);
    expect(first).not.toBe(second);
    expect(first.split('-')[0]).toBe(second.split('-')[0]);
  });
});

describe('resolveHarnessRoot', () => {
  it('honors an explicit tmpRoot and includes vat-skill-test + the derived key', () => {
    const tmpRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-harness-root-'));
    try {
      const root = resolveHarnessRoot(['a'], tmpRoot);
      const expected = safePath.join(tmpRoot, 'vat-skill-test', deriveHarnessKey(['a']));
      expect(toForwardSlash(root)).toBe(toForwardSlash(expected));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('assertSafeHarnessRoot', () => {
  let tmpBase: string;
  beforeEach(() => { tmpBase = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-safe-root-')); });
  afterEach(() => { rmSync(tmpBase, { recursive: true, force: true }); });

  /** Real uid of a directory, or 0 on platforms without uids (win32). */
  const dirUid = (dir: string): number => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture, controlled directory
    return statSync(dir).uid ?? 0;
  };

  it('does not throw when the directory does not exist', () => {
    const dir = safePath.join(tmpBase, 'nonexistent');
    expect(() => assertSafeHarnessRoot(dir, dirUid(tmpBase))).not.toThrow();
  });

  it(
    'throws when the harness root is a symlink',
    { skip: process.platform === 'win32' },
    () => {
      const { target, link } = createSymlinkedDir(tmpBase);
      expect(() => assertSafeHarnessRoot(link, dirUid(target))).toThrow(HarnessLocationError);
    },
  );

  it(
    'throws (mentioning 0700) when the directory mode is not 0700',
    { skip: process.platform === 'win32' },
    () => {
      const dir = safePath.join(tmpBase, 'wide');
      mkdirSyncReal(dir, { mode: 0o755 });
      expect(() => assertSafeHarnessRoot(dir, dirUid(dir))).toThrow(/0700/);
    },
  );

  it(
    'throws (mentioning ownership) when the uid does not match',
    { skip: process.platform === 'win32' },
    () => {
      const dir = safePath.join(tmpBase, 'owned');
      mkdirSyncReal(dir, { mode: 0o700 });
      const bogusUid = dirUid(dir) + 99999;
      expect(() => assertSafeHarnessRoot(dir, bogusUid)).toThrow(/owned by the current user/);
    },
  );

  it(
    'throws when an INTERMEDIATE path component (not just the leaf) is a symlink',
    { skip: process.platform === 'win32' },
    () => {
      // link -> target; the real leaf lives under target, reached via the symlink.
      const { target, link } = createSymlinkedDir(tmpBase);
      const realLeaf = safePath.join(target, 'child');
      mkdirSyncReal(realLeaf, { mode: 0o700 });
      // The leaf itself is a real 0700 dir; only the `link` ancestor is a symlink.
      // tmpBase is the trusted boundary so the walk reaches the `link` component.
      const leafViaLink = safePath.join(link, 'child');
      expect(() => assertSafeHarnessRoot(leafViaLink, dirUid(target), tmpBase)).toThrow(HarnessLocationError);
    },
  );
});

describe('assertSafeWorkdir', () => {
  let dir: string;
  // Scope the ancestry walk to the OS tmp dir (the parent of these fixtures).
  // On Windows the OS tmp dir lives under the user's home, whose ambient
  // ~/.claude would otherwise be surfaced by an unbounded walk to the root.
  const tmpBoundary = normalizedTmpdir();
  beforeEach(() => { dir = mkdtempSync(safePath.join(tmpBoundary, 'vat-workdir-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('passes a clean directory', () => {
    expect(() => assertSafeWorkdir(dir, tmpBoundary)).not.toThrow();
  });

  it('refuses a dir with CLAUDE.md in its ancestry (exit 2)', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'CLAUDE.md'), '# ambient', 'utf8');
    const child = safePath.join(dir, 'sub');
    mkdirSyncReal(child);
    expect(() => assertSafeWorkdir(child, tmpBoundary)).toThrow(HarnessLocationError);
  });

  it('refuses a dir with .claude/ in its ancestry (exit 2)', () => {
    mkdirSyncReal(safePath.join(dir, '.claude'));
    const child = safePath.join(dir, 'sub');
    mkdirSyncReal(child);
    expect(() => assertSafeWorkdir(child, tmpBoundary)).toThrow(HarnessLocationError);
  });

  it('HarnessLocationError carries exitCode 2', () => {
    expect.assertions(1);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'CLAUDE.md'), 'x', 'utf8');
    try { assertSafeWorkdir(dir, tmpBoundary); } catch (e) { expect((e as HarnessLocationError).exitCode).toBe(2); }
  });

  /**
   * The Windows profile layout, reproduced on any platform.
   *
   * On Windows the OS temp dir lives INSIDE the user's home
   * (`C:\Users\<name>\AppData\Local\Temp`), so an unbounded ancestry walk out of a
   * temp workdir reaches the ambient `~/.claude` that every Claude Code user has —
   * and `runSkillTestHarness` refuses the run with "Use an OS-tmp location", which
   * is the thing the user just did.
   *
   * Found on a real Windows dev box, not in CI: the GitHub runner's `runneradmin`
   * profile has no `~/.claude`, so the walk finds nothing and the suite is green
   * over the defect. Built here as a directory shape rather than a platform check,
   * so it reproduces everywhere and cannot silently skip.
   */
  describe('home-directory boundary (the Windows ~/.claude hazard)', () => {
    let fakeHome: string;
    let workdir: string;

    beforeEach(() => {
      fakeHome = mkdtempSync(safePath.join(tmpBoundary, 'vat-fakehome-'));
      // The ambient global config every Claude Code user has — NOT a project.
      mkdirSyncReal(safePath.join(fakeHome, '.claude'));
      // …/AppData/Local/Temp/work — the Windows temp location, inside the profile.
      workdir = safePath.join(fakeHome, 'AppData', 'Local', 'Temp', 'work');
      mkdirSyncReal(workdir, { recursive: true });
    });
    afterEach(() => { rmSync(fakeHome, { recursive: true, force: true }); });

    it('accepts a temp workdir nested under a home that carries an ambient .claude', () => {
      expect(() => assertSafeWorkdir(workdir, fakeHome)).not.toThrow();
    });

    it('POSITIVE CONTROL: the same fixture DOES throw unbounded, so the test above cannot pass vacuously', () => {
      // This is the shipped Windows behaviour, and the reason the boundary exists.
      expect(() => assertSafeWorkdir(workdir)).toThrow(HarnessLocationError);
    });

    it('still refuses a real project below the home boundary', () => {
      // The boundary stops AT home, exclusive — anything beneath it is still a project.
      const project = safePath.join(fakeHome, 'dev', 'proj');
      mkdirSyncReal(safePath.join(project, 'sub'), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
      writeFileSync(safePath.join(project, 'CLAUDE.md'), '# real project', 'utf8');
      expect(() => assertSafeWorkdir(safePath.join(project, 'sub'), fakeHome)).toThrow(HarnessLocationError);
    });
  });
});

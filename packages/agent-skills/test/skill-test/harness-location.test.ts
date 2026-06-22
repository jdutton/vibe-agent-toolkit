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
  beforeEach(() => { dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-workdir-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('passes a clean directory', () => {
    expect(() => assertSafeWorkdir(dir)).not.toThrow();
  });

  it('refuses a dir with CLAUDE.md in its ancestry (exit 2)', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'CLAUDE.md'), '# ambient', 'utf8');
    const child = safePath.join(dir, 'sub');
    mkdirSyncReal(child);
    expect(() => assertSafeWorkdir(child)).toThrow(HarnessLocationError);
  });

  it('refuses a dir with .claude/ in its ancestry (exit 2)', () => {
    mkdirSyncReal(safePath.join(dir, '.claude'));
    const child = safePath.join(dir, 'sub');
    mkdirSyncReal(child);
    expect(() => assertSafeWorkdir(child)).toThrow(HarnessLocationError);
  });

  it('HarnessLocationError carries exitCode 2', () => {
    expect.assertions(1);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'CLAUDE.md'), 'x', 'utf8');
    try { assertSafeWorkdir(dir); } catch (e) { expect((e as HarnessLocationError).exitCode).toBe(2); }
  });
});

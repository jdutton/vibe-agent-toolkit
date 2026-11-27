/**
 * Which roots sit below their repository's top level: compared as the directories they ARE, so a
 * top level git spells through a symlink (`/private/var` for `/var` on macOS) is still the root.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { rootsBelowRepositoryTop } from '../../src/projection/data-stage.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The ids of the roots below `top`, for one root at `rootPath`. */
function below(rootPath: string, top: string | null): readonly string[] {
  return [...rootsBelowRepositoryTop({ projection: { roots: [{ id: 'r0', path: rootPath }] }, repositoryTop: () => top })];
}

describe('rootsBelowRepositoryTop', () => {
  it('treats a top level spelled through a symlink as the root itself', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-repo-top-'));
    made.push(dir);
    const real = safePath.join(dir, 'real');
    mkdirSyncReal(real);
    const link = safePath.join(dir, 'link');
    createSymlink(cap, real, link, 'dir');

    expect(below(link, real)).toStrictEqual([]);
    expect(below(real, link)).toStrictEqual([]);
  });

  it('names a root below its top level, and none outside a repository', () => {
    const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-repo-top-'));
    made.push(dir);
    const nested = safePath.join(dir, 'nested');
    mkdirSyncReal(nested);

    expect(below(nested, dir)).toStrictEqual(['r0']);
    expect(below(nested, null)).toStrictEqual([]);
  });

  it('falls back to the spelling when a path cannot be resolved', () => {
    const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-repo-top-'));
    made.push(dir);
    const gone = safePath.join(dir, 'gone');

    expect(below(gone, gone)).toStrictEqual([]);
    expect(below(gone, dir)).toStrictEqual(['r0']);
  });
});

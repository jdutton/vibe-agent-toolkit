/**
 * `removeResolvedTempDirs` — the one cleanup `vat skills install` and
 * `vat skills list` share for an npm/tarball source's extracted package.
 *
 * Both commands used to carry their own bare-catch `rm` (a "best-effort cleanup")
 * in a `finally`. Best-effort was right (the command's answer is already decided);
 * silent was not — a directory that would not go was left behind with nobody
 * told. Each one now comes back as the `TREE_CLEANUP_INCOMPLETE` warning naming
 * it, for the command's report.
 *
 * ⛔ A disposal path: `TMPDIR` / `TEMP` / `TMP` point at this suite's scratch tree, and
 * every directory handed to the helper lives under it.
 */

import { existsSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { createTempDir, installFaultFs, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeResolvedTempDirs } from '../../../src/commands/skills/source-resolvers.js';
import { useScratchTmpdir } from '../../helpers/scratch-tmpdir.js';

/** A sibling of the scratch, made under the real temp directory: NOT under the stubbed one. */
let outside = '';
// Registered BEFORE the scratch, so its afterEach runs after the scratch is left: `outside`
// is removed from under the real temp directory it was made in.
beforeEach(() => {
  outside = createTempDir('vat-remove-resolved-outside-');
});
afterEach(() => {
  removeTempDir(outside);
});

const tmp = useScratchTmpdir('vat-remove-resolved-');

/** A directory the way `makeStagingDir` leaves one: under the temp directory, holding a file. */
function stagingDir(name: string): string {
  const dir = safePath.join(tmp(), name);
  mkdirSyncReal(safePath.join(dir, 'package'), { recursive: true });
  return dir;
}

describe('removeResolvedTempDirs', () => {
  it('removes what is there and returns no warning', async () => {
    const dir = stagingDir('vat-skills-npm-a');

    await expect(removeResolvedTempDirs([dir])).resolves.toEqual([]);

    expect(existsSync(dir)).toBe(false);
  });

  it('tolerates a directory that is already gone, silently', async () => {
    await expect(removeResolvedTempDirs([safePath.join(tmp(), 'never-made')])).resolves.toEqual([]);
  });

  it('returns a directory it could not remove as the TREE_CLEANUP_INCOMPLETE warning naming it', async () => {
    const dir = stagingDir('vat-skills-npm-busy');
    const faults = installFaultFs({ within: dir, faults: [{ op: 'rm', path: (p) => p === dir, errno: 'EBUSY' }] });

    let warnings: Awaited<ReturnType<typeof removeResolvedTempDirs>>;
    try {
      warnings = await removeResolvedTempDirs([dir]);
    } finally {
      faults.restore();
    }

    expect(warnings).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning' })]);
    expect(warnings[0]?.message).toContain(dir);
    expect(warnings[0]?.message).toContain('EBUSY');
    expect(existsSync(dir)).toBe(true);
  });

  // The removal makes a read-only tree writable before it deletes it, so a directory
  // that is not VAT's scratch is named and left alone — never removed.
  it('names, and leaves alone, a directory outside the temp directory', async () => {
    const warnings = await removeResolvedTempDirs([outside]);

    expect(warnings).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', link: outside })]);
    expect(warnings[0]?.message).toContain('not inside the temporary directory');
    expect(existsSync(outside)).toBe(true);
  });
});

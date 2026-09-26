/**
 * `targetPathWithin` must compare the root and the argument in ONE spelling.
 *
 * 🪤 The defect: the corpus root is discovered from `process.cwd()`, which the
 * OS hands back PHYSICAL (macOS `/tmp/x` arrives as `/private/tmp/x`), while an
 * absolute argument is taken as typed — lexical. `vat claude context /tmp/x/sub`
 * run from `/tmp/x` therefore refused its own subdirectory as "outside the
 * corpus root /private/tmp/x". Any root reached through a symlink does the same,
 * so the fixture builds one explicitly rather than relying on the host's `/tmp`.
 *
 * Integration tier: the whole point is what `realpath` says about a real link.
 */

import { writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizePath, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { targetPathWithin } from '../../src/utils/corpus-target.js';
import { createTempDirTracker } from '../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-corpus-target-');
const SYMLINK_CAP = symlinkCapability();

/** A real project dir, its physical spelling, and a link to it — or null link when the host cannot. */
function linkedProject(): { root: string; alias: string | null } {
  const base = createTempDir();
  const real = safePath.join(base, 'real');
  mkdirSyncReal(safePath.join(real, 'sub'), { recursive: true });
  writeFileSync(safePath.join(real, 'sub', 'CLAUDE.md'), '# sub\n', 'utf-8');
  if (SYMLINK_CAP === null) return { root: normalizePath(real), alias: null };
  const alias = safePath.join(base, 'alias');
  createSymlink(SYMLINK_CAP, real, alias, 'dir');
  return { root: normalizePath(real), alias };
}

describe('targetPathWithin', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('answers for a subdirectory spelled through a link to the root', ({ skip }) => {
    const { root, alias } = linkedProject();
    if (alias === null) return skip('host cannot create symlinks');

    expect(targetPathWithin(root, safePath.join(alias, 'sub'), 'vat claude context')).toBe('sub');
  });

  it('answers for a path that does not exist yet, spelled through the link', ({ skip }) => {
    // A path the projection never realized is a legitimate question (answered
    // `kind: unknown`), so it must be canonicalized from its deepest existing
    // ancestor rather than refused for having no realpath of its own.
    const { root, alias } = linkedProject();
    if (alias === null) return skip('host cannot create symlinks');

    expect(targetPathWithin(root, safePath.join(alias, 'sub', 'not-yet'), 'vat claude context')).toBe('sub/not-yet');
  });

  it('answers the root itself through the link as the empty path', ({ skip }) => {
    const { root, alias } = linkedProject();
    if (alias === null) return skip('host cannot create symlinks');

    expect(targetPathWithin(root, alias, 'vat claude context')).toBe('');
  });

  it('still refuses a path genuinely outside the root', () => {
    // The control: canonicalizing both sides must not turn the refusal off.
    const { root } = linkedProject();
    const elsewhere = createTempDir();

    expect(() => targetPathWithin(root, elsewhere, 'vat claude context')).toThrow(/resolves outside the corpus root/);
  });
});

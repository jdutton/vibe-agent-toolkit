import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { refuseAsyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SKILL_SOURCE_UNREADABLE_CODE, stageDirInto } from '../../src/skill-source/stage.js';
import type { ResolveSkillSourceContext } from '../../src/skill-source/types.js';

describe('stageDirInto', () => {
  let root: string;
  let src: string;
  let ctx: ResolveSkillSourceContext;

  beforeEach(() => {
    root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-stage-'));
    src = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-stage-src-'));
    writeFileSync(safePath.join(src, 'SKILL.md'), '# skill');
    ctx = {
      repoRoot: root,
      stagingRoot: safePath.join(root, 'staging'),
      fetchCacheDir: safePath.join(root, 'cache'),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('copies the source into <stagingRoot>/<key> and returns a forward-slash path', async () => {
    const staged = await stageDirInto(src, ctx, 'abc123');
    expect(staged).toBe(safePath.join(ctx.stagingRoot, 'abc123'));
    expect(statSync(safePath.join(staged, 'SKILL.md')).isFile()).toBe(true);
  });

  // The staged copy is VAT's own scratch: a copy the OS refuses to write (a full disk)
  // is the run not finishing, classified on the environment side — never an uncoded errno.
  it('codes a copy the OS refuses to write as an environment fault', async () => {
    const restore = refuseAsyncFs('writeFile', safePath.join(ctx.stagingRoot, 'abc123', 'SKILL.md'), 'ENOSPC');
    try {
      await expect(stageDirInto(src, ctx, 'abc123')).rejects.toMatchObject({ code: 'FS_FAULT', side: 'environment', faultClass: 'exhausted' });
    } finally {
      restore();
    }
  });

  // A copy keeps its source's mode: a script stays executable in the staged tree.
  it.skipIf(process.platform === 'win32')('keeps each staged file\'s source mode', async () => {
    writeFileSync(safePath.join(src, 'run.sh'), '#!/bin/sh\n');
    chmodSync(safePath.join(src, 'run.sh'), 0o751);
    const staged = await stageDirInto(src, ctx, 'abc123');
    expect((statSync(safePath.join(staged, 'run.sh')).mode & 0o777).toString(8)).toBe('751');
  });

  // Windows has no POSIX mode bits — mkdir(mode 0o700) yields 0o666; skip there.
  it.skipIf(process.platform === 'win32')('creates the staging root with 0700 permissions', async () => {
    await stageDirInto(src, ctx, 'abc123');
    const mode = statSync(ctx.stagingRoot).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  // Needs real symlink creation, which requires admin/Developer Mode on Windows.
  // The refusal logic is platform-agnostic and fully covered on POSIX CI, so this
  // probes the real capability rather than gating on raw platform.
  it('refuses to copy through a symlinked entry in the source tree', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    mkdirSyncReal(safePath.join(src, 'sub'));
    createSymlink(cap, '/etc', safePath.join(src, 'sub', 'evil'));
    // Coded as the operator's input (`INPUT_UNREADABLE` in `vat skill test run`), never an uncoded throw.
    await expect(stageDirInto(src, ctx, 'sym')).rejects.toMatchObject({
      code: SKILL_SOURCE_UNREADABLE_CODE,
      message: expect.stringMatching(/symlink.*sub\/evil/i) as unknown,
    });
  });

  it('refuses a pre-existing staged dir not owned by the current uid', async () => {
    // Pre-create the staging root + key dir, then fake a foreign owner via stat override.
    mkdirSyncReal(ctx.stagingRoot, { recursive: true, mode: 0o700 });
    mkdirSyncReal(safePath.join(ctx.stagingRoot, 'abc123'));
    const foreignUid = process.getuid === undefined ? 99999 : process.getuid() + 1;
    await expect(
      stageDirInto(src, { ...ctx }, 'abc123', { uidOverride: foreignUid }),
    ).rejects.toThrow(/ownership|owned/i);
  });

  it('does not reject when the current uid is unknown (no getuid, uid=-1)', async () => {
    await expect(stageDirInto(src, ctx, 'nouid', { uidOverride: -1 })).resolves.toBeDefined();
  });
});

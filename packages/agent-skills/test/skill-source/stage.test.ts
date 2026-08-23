/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stageDirInto } from '../../src/skill-source/stage.js';
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
    await expect(stageDirInto(src, ctx, 'sym')).rejects.toThrow(/symlink/i);
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

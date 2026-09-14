/**
 * `removeResolvedTempDirs` — the one cleanup `vat skills install` and
 * `vat skills list` share for an npm/tarball source's extracted package.
 *
 * Both commands used to carry their own bare-catch `rm` (a "best-effort cleanup")
 * in a `finally`. Best-effort was right (the command's answer is already out);
 * silent was not — a directory that would not go was left behind with nobody
 * told. The helper keeps the first property and drops the second.
 */

import { rm } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { removeResolvedTempDirs } from '../../../src/commands/skills/source-resolvers.js';
import { errno } from '../../helpers/refusal-doubles.js';
import { createTempDirTracker } from '../../system/test-common.js';

// `rm` is a named import in the helper, so the refused-removal case injects at
// the module seam.
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['rm']));

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-remove-resolved-');

afterEach(() => {
  vi.mocked(rm).mockRestore();
  cleanupTempDirs();
});

function recordingLogger(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => { lines.push(message); }, lines };
}

describe('removeResolvedTempDirs', () => {
  it('removes what is there and says nothing', async () => {
    const dir = createTempDir();
    const logger = recordingLogger();

    await removeResolvedTempDirs([dir], logger);

    expect(logger.lines).toEqual([]);
    await expect(rm(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tolerates a directory that is already gone, silently — force covers it', async () => {
    const logger = recordingLogger();

    await removeResolvedTempDirs([safePath.join(createTempDir(), 'never-made')], logger);

    expect(logger.lines).toEqual([]);
  });

  it('names a directory it could not remove instead of leaving it behind in silence', async () => {
    const dir = createTempDir();
    const logger = recordingLogger();
    vi.mocked(rm).mockRejectedValueOnce(errno('EBUSY', 'EBUSY: resource busy'));

    await expect(removeResolvedTempDirs([dir], logger)).resolves.toBeUndefined();

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('Could not remove temp directory');
    expect(logger.lines[0]).toContain('EBUSY');
  });
});

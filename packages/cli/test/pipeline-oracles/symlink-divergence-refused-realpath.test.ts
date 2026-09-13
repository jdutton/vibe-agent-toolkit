/**
 * What the symlink-divergence oracle does with a path it cannot resolve.
 *
 * "Cannot be resolved" is a corpus fact for a dangling link, and the row is
 * kept under the link's own path. It used to cover a REFUSED resolution
 * too — a harness error, reported as a corpus fact, in a report whose whole
 * claim is that it saw the corpus.
 */

import { realpathSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureSymlinkDivergence, laneById } from '../../src/pipeline-oracles/index.js';
import { errno, realBehind, refusingOnly } from '../helpers/refusal-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';

// `realpathSync.native` is reached through a named import in the oracle, so
// the refusal is injected at the module seam. `realpathSync` is a function
// carrying `.native`, so the pass-through keeps the callable and spies the
// property.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual['realpathSync'] as typeof realpathSync;
  const patched = Object.assign((...args: unknown[]) => (real as (...a: unknown[]) => string)(...args), real, {
    native: vi.fn(real.native),
  });
  return { ...actual, realpathSync: patched };
});

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-symlink-refused-');

afterEach(() => {
  vi.mocked(realpathSync.native).mockRestore();
  cleanupTempDirs();
});

/** A corpus of one markdown file. */
function corpusWithOneFile(): string {
  const root = safePath.resolve(createTempDir());
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
  writeFileSync(safePath.join(root, 'docs', 'a.md'), '# a\n');
  return root;
}

describe('a path the divergence oracle cannot resolve', () => {
  it('resolves an ordinary corpus and reports no divergence', async () => {
    const root = corpusWithOneFile();

    const report = await captureSymlinkDivergence(laneById('resources'), { corpusRoot: root, corpus: 'plain' });

    expect(report.rows).toEqual([]);
  });

  it('fails when the OS refuses to resolve a path — that is the harness, not the corpus', async () => {
    const root = corpusWithOneFile();
    vi.mocked(realpathSync.native).mockImplementation(
      refusingOnly(safePath.join(root, 'docs', 'a.md'), errno('EACCES'), realBehind(realpathSync.native)),
    );

    await expect(
      captureSymlinkDivergence(laneById('resources'), { corpusRoot: root, corpus: 'refused' }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});

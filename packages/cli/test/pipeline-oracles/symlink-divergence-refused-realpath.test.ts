/**
 * What the symlink-divergence oracle does with a path it cannot resolve.
 *
 * "Cannot be resolved" is a corpus fact for a dangling link, and the row is
 * kept under the link's own path. A REFUSED or failed resolution is a fact of
 * that one row too — kept, with the errno in `fault` and the `resolution-fault`
 * class, as the enumeration oracle records it — never folded into "dangling",
 * and never the end of the capture.
 */

import fs, { rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureSymlinkDivergence, laneById } from '../../src/pipeline-oracles/index.js';
import { errno, refusingOnly } from '../helpers/refusal-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';

// The oracle resolves through the link-chain resolver, which reaches the kernel through the
// DEFAULT `node:fs` object (`fs.realpathSync.native`), so the refusal is a spy on that property.
const realNative = fs.realpathSync.native;

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-symlink-refused-');

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

/** A corpus of one markdown file. */
function corpusWithOneFile(): string {
  const root = safePath.resolve(createTempDir());
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  writeFileSync(safePath.join(root, 'docs', 'a.md'), '# a\n');
  return root;
}

describe('a path the divergence oracle cannot resolve', () => {
  it('resolves an ordinary corpus and reports no divergence', async () => {
    const root = corpusWithOneFile();

    const report = await captureSymlinkDivergence(laneById('resources'), { corpusRoot: root, corpus: 'plain' });

    expect(report.rows).toEqual([]);
  });

  // One errno-table predicate decides "the link resolves to nothing", for this oracle and every
  // other lane. Everything else — declined, failed, Windows' ambiguous UNKNOWN / EINVAL, an errno no
  // table lists — is a fault, recorded against that one row while the capture goes on.
  it.each(['EACCES', 'EIO', 'UNKNOWN', 'EINVAL', 'EWHATEVER'])('records %s resolving a path as that row\'s fault, and completes the capture', async (code) => {
    const root = corpusWithOneFile();
    const file = safePath.join(root, 'docs', 'a.md');
    // As Node raises it: the syscall and the path it acted on — what makes an unlisted errno a filesystem fault.
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(
      refusingOnly(file, Object.assign(errno(code), { syscall: 'realpath', path: file }), realNative),
    );

    const report = await captureSymlinkDivergence(laneById('resources'), { corpusRoot: root, corpus: 'refused' });

    expect(report.rows).toEqual([{ path: 'docs/a.md', realPath: 'docs/a.md', classes: ['resolution-fault'], fault: code }]);
  });

  it('keeps a path that resolves to nothing (ENOENT) under its own name — a corpus fact', async () => {
    const code = 'ENOENT';
    const root = corpusWithOneFile();
    writeFileSync(safePath.join(root, 'docs', 'b.md'), '# b\n');
    const real = realNative;
    // `a.md` dangles; `b.md` resolves to where `a.md` is spelt. Only if `a.md` keeps its own name do the two meet.
    // A native ENOENT is confirmed by the JS walk (the one native fallback rule), so `a.md` is really gone by then.
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((path: string) => {
      const spelt = String(path);
      if (spelt.endsWith('a.md')) {
        rmSync(spelt, { force: true });
        throw errno(code);
      }
      return spelt.endsWith('b.md') ? `${spelt.slice(0, -'b.md'.length)}a.md` : real(spelt);
    }) as typeof fs.realpathSync.native);

    const report = await captureSymlinkDivergence(laneById('resources'), { corpusRoot: root, corpus: 'dangling' });

    expect(report.rows).toEqual([
      { path: 'docs/a.md', realPath: 'docs/a.md', classes: ['alias'], fault: null },
      { path: 'docs/b.md', realPath: 'docs/a.md', classes: ['alias'], fault: null },
    ]);
  });
});

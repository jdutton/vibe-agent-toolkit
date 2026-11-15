/**
 * The modes a ZIP VAT writes from a directory, whatever the host's `stat` says: a directory `0755`,
 * a file `0644`, or `0755` when it carries an execute bit — every entry made on Unix.
 *
 * On Windows libuv makes `st_mode` up: a directory `0o40666`, a file `0o100666`, never an execute
 * bit. Written as they are under host 3, a Unix reader would make every directory one nobody can
 * enter. So the real folder walk runs over a real tree, with `stat` answering as it does on
 * Windows and the library stamping the host it stamps there, and the central directory is read.
 */
import { chmodSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { zipOfDirectory } from '../../src/archive/zip-reader.js';
import { safePath } from '../../src/path-core.js';
import type { StatRewrite } from '../../src/testing/fault-fs.js';
import { PERMISSIONS_ENFORCED } from '../../src/testing/platform-gates.js';

import { plant, treeChangeSuite } from './tree-change-test-kit.js';

// Only what the library stamps changes: every entry it builds says "made on Windows", as it does there.
vi.mock('adm-zip', async (importOriginal) => (await import('../adm-zip-as-on-windows.js')).admZipAsOnWindows(importOriginal));

const suite = treeChangeSuite('archive-zip-modes-');

const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const TYPE_DIRECTORY = 0o040000;

/** Each central-directory record of `zip`: its name, the host byte of `version made by`, and its Unix mode. */
function centralRecords(zip: Buffer): Map<string, { host: number; mode: number }> {
  const records = new Map<string, { host: number; mode: number }>();
  for (let at = zip.indexOf(CENTRAL_SIGNATURE); at !== -1; at = zip.indexOf(CENTRAL_SIGNATURE, at + 4)) {
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    records.set(name, { host: zip.readUInt8(at + 5), mode: zip.readUInt32LE(at + 38) >>> 16 });
  }
  return records;
}

/** `stat` as libuv answers it on Windows: the type bits kept, the permission bits `0666`, the Stats prototype kept. */
const statAsOnWindows: StatRewrite = {
  op: 'stat',
  path: () => true,
  rewrite: (stats) => {
    const mode = (stats as unknown as { mode: number }).mode;
    const windowsMode = (mode & TYPE_DIRECTORY) === 0 ? 0o100666 : 0o40666;
    return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as typeof stats, stats, { mode: windowsMode });
  },
};

/** A tree holding a directory, a plain file and an executable one. */
function plantedTree(): string {
  const tree = safePath.join(suite.root(), 'bundle');
  plant(tree, { 'SKILL.md': '# skill\n', 'scripts/run.sh': 'echo\n' });
  chmodSync(safePath.join(tree, 'scripts', 'run.sh'), 0o755);
  return tree;
}

describe('the modes zipOfDirectory writes', () => {
  it('are 0755 for a directory and 0644 for a file when stat answers as on Windows, each made on Unix', () => {
    const tree = plantedTree();
    const session = suite.faults(tree, [], [statAsOnWindows]);

    const records = centralRecords(zipOfDirectory(tree));

    expect(session.calls.some((call) => call.op === 'stat' && call.api === 'sync')).toBe(true);
    expect(Object.fromEntries(records)).toEqual({
      'SKILL.md': { host: 3, mode: 0o100644 },
      'scripts/': { host: 3, mode: 0o040755 },
      // No execute bit on Windows, so none in the archive.
      'scripts/run.sh': { host: 3, mode: 0o100644 },
    });
  });

  // An execute bit exists only where the host has one.
  it.skipIf(!PERMISSIONS_ENFORCED)('keep 0755 for a file the host marks executable, and nothing else of its mode', () => {
    const tree = plantedTree();
    chmodSync(safePath.join(tree, 'SKILL.md'), 0o600);

    const records = centralRecords(zipOfDirectory(tree));

    expect(records.get('SKILL.md')?.mode).toBe(0o100644);
    expect(records.get('scripts/run.sh')?.mode).toBe(0o100755);
  });
});

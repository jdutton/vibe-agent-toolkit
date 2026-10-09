/**
 * A temp directory the OS refuses to remove DEEP inside: the leftover must name the directory
 * itself, not only the entry the errno carries — what is left is all of it, and a report that
 * names only `<dir>/plugins/x` never tells the reader which temp directory to remove.
 *
 * In a file of its own: Node's recursive promise `rm` binds its `fs` functions on its first call
 * in a process, so the per-entry removal the fault aims at is only visible to the injector when
 * this is the first `rm` the process makes.
 *
 * ⛔ A disposal path: `treeChangeSuite` points TMPDIR / TEMP / TMP at a scratch tree first.
 */

import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import { mkdirSyncReal, normalizedTmpdir } from '../../src/path-utils.js';
import { withTempDir } from '../../src/tree-change/files.js';

import { treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-change-dispose-deep-');

/** Whether `text` names `path` as a path of its own — not only as the prefix of an entry inside it. */
function namesPathItself(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    if (!/^[\w/.-]/.test(text.slice(at + path.length, at + path.length + 1))) return true;
  }
  return false;
}

describe('withTempDir — a disposal refused deep inside', () => {
  it('returns a leftover whose message names the temp directory itself', async () => {
    let dir = '';
    let deep = '';
    const session = suite.faults(normalizedTmpdir(), [{ op: 'rmdir', path: (p) => p === deep, errno: 'EBUSY' }]);

    const outcome = await withTempDir('vat-deep-dispose-', (given) => {
      dir = given;
      deep = safePath.join(given, 'plugins', 'fx-plugin');
      mkdirSyncReal(deep, { recursive: true });
      writeFileSync(safePath.join(deep, 'plugin.json'), '{}');
      return Promise.resolve();
    });
    suite.restoreFaults();

    expect(session.fired.map((call) => call.path)).toContain(deep);
    expect(isFsFaultError(outcome.leftover)).toBe(true);
    const message = (outcome.leftover as Error).message;
    expect(message).toContain(deep);
    expect(namesPathItself(message, dir), message).toBe(true);
  });
});

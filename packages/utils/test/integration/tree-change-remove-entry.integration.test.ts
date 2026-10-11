/**
 * `removeEntry`: done is what is not there. `rm` with `force` takes an ENOENT from its own listing
 * of a directory for "already gone" and resolves with the directory still there — the fault matrix
 * caught an uninstall that exited 0 with its parked tree left and nothing naming it. Whether `rm`
 * lists at all depends on the host's code path, so this file makes it resolve without removing, once.
 */

import type * as fsPromises from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import { removeEntry } from '../../src/tree-change/files.js';

import { plant, present, treeChangeSuite } from './tree-change-test-kit.js';

const control = vi.hoisted(() => ({ skipNextRm: false, rmCalls: 0, lstatAbsent: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const rm: typeof real.rm = async (...args) => {
    control.rmCalls += 1;
    if (control.skipNextRm) {
      control.skipNextRm = false;
      return;
    }
    return real.rm(...args);
  };
  const lstat = (async (...args: Parameters<typeof real.lstat>) => {
    if (control.lstatAbsent !== undefined) {
      throw Object.assign(new Error(`${control.lstatAbsent}: injected, lstat`), { code: control.lstatAbsent });
    }
    return real.lstat(...args);
  }) as typeof real.lstat;
  return { ...real, rm, lstat, default: { ...real, rm, lstat } };
});

const suite = treeChangeSuite('tree-change-remove-entry-');
afterEach(() => {
  control.skipNextRm = false;
  control.rmCalls = 0;
  control.lstatAbsent = undefined;
});

describe('removeEntry', () => {
  it('runs the removal again when one resolved with the entry still there', async () => {
    const root = suite.root();
    plant(root, { 'parked/0.9.0/skills/s/SKILL.md': 's' });
    const parked = safePath.join(root, 'parked');
    control.skipNextRm = true;

    await removeEntry(parked);

    expect(control.rmCalls).toBe(2);
    expect(present(parked)).toBe(false);
  });

  // An `lstat` answering ENOTDIR for a parked tree its parent lists read as "already gone": the
  // install or uninstall exited 0 with `.<name>.vat-staged-*.previous` left and nothing naming it.
  it.each(['ENOENT', 'ENOTDIR'])('refuses an entry its parent lists whose lstat answers %s, rather than calling it gone', async (code) => {
    const root = suite.root();
    plant(root, { 'parked/x.md': 'x' });
    const parked = safePath.join(root, 'parked');
    control.lstatAbsent = code;

    const error = await removeEntry(parked).then(() => undefined, (failure: unknown) => failure);
    control.lstatAbsent = undefined;

    expect(isFsFaultError(error) && error.side === 'destination' && error.path === parked, String(error)).toBe(true);
    expect(present(parked)).toBe(true);
  });
});

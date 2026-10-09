/**
 * The Windows rename retry (Review Focus 3): a scanner, indexer or open handle
 * makes a rename of a freshly written tree fail `EBUSY` / `EPERM` / `EACCES` for a
 * moment. Under win32 the swap and `renameFileAtomic` retry, bounded (6 tries,
 * 50·2ⁿ ms); anywhere else, and for any other errno, they do not. The platform is
 * stubbed so the retry runs on every OS; the faults are injected.
 *
 * ⏱ The exhausted-retry case waits out the whole backoff (1.55 s) on purpose: it
 * is the bound being pinned.
 */

import { writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import { snapshotTree } from '../../src/testing/tree-snapshot.js';
import { applyTreePlan } from '../../src/tree-change/apply.js';
import { renameFileAtomic } from '../../src/tree-change/files.js';
import { planTreeChanges } from '../../src/tree-change/plan.js';

import { expectUnchanged, isStaged, plant, present, readText, rejectionOf, replaceWith, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-change-win32-');
const busySwap = { op: 'rename', path: isStaged, errno: 'EBUSY' } as const;

describe('under win32', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', real);
  });

  it('a swap refused EBUSY twice is retried and applied, with no warning', async () => {
    const root = suite.root();
    plant(root, { 'mp/a.txt': 'old' });
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'mp'), { 'a.txt': 'new' })]);
    const session = suite.faults(root, [busySwap, { ...busySwap }]);

    expect(await applyTreePlan(plan)).toEqual({ warnings: [] });

    expect(session.fired).toHaveLength(2);
    suite.restoreFaults();
    expect(readText(safePath.join(root, 'mp', 'a.txt'))).toBe('new');
  });

  it('a swap refused EBUSY six times is rolled back: the old tree is intact', async () => {
    const root = suite.root();
    plant(root, { 'mp/a.txt': 'old' });
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'mp'), { 'a.txt': 'new' })]);
    const session = suite.faults(root, Array.from({ length: 7 }, () => ({ ...busySwap })));

    const error = await rejectionOf(() => applyTreePlan(plan));

    expect(session.fired).toHaveLength(6);
    suite.restoreFaults();
    expect(isFsFaultError(error) && error.faultClass === 'busy' && error.side === 'destination').toBe(true);
    expectUnchanged(root, before);
  });

  it('renameFileAtomic retries EPERM and lands the file', async () => {
    const root = suite.root();
    const from = safePath.join(root, 'tmp.json');
    const to = safePath.join(root, 'final.json');
    writeFileSync(from, '{}');
    const rule = { op: 'rename', path: (p: string) => p === from, errno: 'EPERM' } as const;
    suite.faults(root, [rule, { ...rule }]);

    await renameFileAtomic(from, to);

    suite.restoreFaults();
    expect(readText(to)).toBe('{}');
  });

  it('renameFileAtomic does not retry an errno that is not contention', async () => {
    const root = suite.root();
    const from = safePath.join(root, 'tmp.json');
    writeFileSync(from, '{}');
    const session = suite.faults(root, [{ op: 'rename', path: (p) => p === from, errno: 'EXDEV' }]);

    expect(await rejectionOf(() => renameFileAtomic(from, safePath.join(root, 'final.json')))).toMatchObject({ code: 'EXDEV' });
    expect(session.calls.filter((call) => call.op === 'rename')).toHaveLength(1);
  });
});

describe('anywhere but win32', () => {
  it.skipIf(process.platform === 'win32')('renameFileAtomic does not retry contention', async () => {
    // Skipped on win32: there the retry is the behaviour, pinned above.
    const root = suite.root();
    const from = safePath.join(root, 'tmp.json');
    writeFileSync(from, '{}');
    const session = suite.faults(root, [{ op: 'rename', path: (p) => p === from, errno: 'EBUSY' }]);

    expect(await rejectionOf(() => renameFileAtomic(from, safePath.join(root, 'final.json')))).toMatchObject({ code: 'EBUSY' });
    expect(session.calls.filter((call) => call.op === 'rename')).toHaveLength(1);
    suite.restoreFaults();
    expect(present(from)).toBe(true);
  });
});

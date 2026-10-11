/**
 * The Windows rename retry (Review Focus 3): a scanner, indexer or open handle
 * makes a rename of a freshly written tree fail `EBUSY` / `EPERM` / `EACCES` for a
 * moment. Under win32 the swap and `renameFileAtomic` retry, bounded (6 tries,
 * 50·2ⁿ ms); anywhere else, and for any other errno, they do not. The platform is
 * stubbed so the retry runs on every OS; the faults are injected.
 *
 * The backoff is recorded, not waited out (`tree-change-no-backoff.ts`): the exhausted-retry
 * cases pin the bound by the waits the retry asked for — five, 1.55 s in all — to the millisecond.
 */

import { writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import type { FaultFsSession } from '../../src/testing/fault-fs.js';
import type { FaultRule } from '../../src/testing/fault-spec.js';
import { snapshotTree } from '../../src/testing/tree-snapshot.js';
import { applyTreePlan } from '../../src/tree-change/apply.js';
import { renameFileAtomic } from '../../src/tree-change/files.js';
import { planTreeChanges } from '../../src/tree-change/plan.js';

import { backoffWaits } from './tree-change-no-backoff.js';
import { expectUnchanged, isStaged, nthRename, plant, present, readText, rejectionOf, replaceWith, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-change-win32-');
// The win32 rename retry's backoff is recorded, never waited out (see the module).
vi.mock('node:timers/promises', () => import('./tree-change-no-backoff.js'));

/** The whole backoff of six tries: 50·2ⁿ ms between each two, 1.55 s in all. */
const FULL_BACKOFF = [50, 100, 200, 400, 800];
const busySwap = { op: 'rename', path: isStaged, errno: 'EBUSY' } as const;

/** Replace `mp/` under `faults`, expecting a refusal after all six tries with the tree as it was; answers the fault and what fired. */
async function refusedReplace(faults: readonly FaultRule[]): Promise<{ error: unknown; fired: FaultFsSession['fired'] }> {
  const root = suite.root();
  plant(root, { 'mp/a.txt': 'old' });
  const before = snapshotTree(root);
  const plan = await planTreeChanges([replaceWith(safePath.join(root, 'mp'), { 'a.txt': 'new' })]);
  const session = suite.faults(root, faults);

  const error = await rejectionOf(() => applyTreePlan(plan));

  expect(session.fired).toHaveLength(6);
  expect(backoffWaits).toEqual(FULL_BACKOFF);
  suite.restoreFaults();
  expectUnchanged(root, before);
  return { error, fired: session.fired };
}

describe('under win32', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  beforeEach(() => {
    backoffWaits.length = 0;
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
    expect(backoffWaits).toEqual([50, 100]);
    suite.restoreFaults();
    expect(readText(safePath.join(root, 'mp', 'a.txt'))).toBe('new');
  });

  it('a swap refused EBUSY six times is rolled back: the old tree is intact', async () => {
    const { error } = await refusedReplace(Array.from({ length: 7 }, () => ({ ...busySwap })));

    expect(isFsFaultError(error) && error.faultClass === 'busy' && error.side === 'destination').toBe(true);
  });

  // What every apply and rollback suite leans on: the kit's "refuse the nth rename" is refused on
  // EVERY try, so those suites ask the same thing here as anywhere — one injected refusal would be
  // retried into a change that succeeds, and each of them would fail on Windows only.
  it('the kit\'s refused rename (nthRename) is refused on all six tries: the park fails, nothing changed', async () => {
    const { error } = await refusedReplace([nthRename(1, 'EPERM')]);

    expect(isFsFaultError(error) && error.faultClass === 'refused' && error.side === 'destination').toBe(true);
  });

  it('the kit\'s refused SECOND rename is still the swap, not a retry of the park', async () => {
    const { error, fired } = await refusedReplace([nthRename(2, 'EBUSY')]);

    expect(fired.every((call) => isStaged(call.path))).toBe(true);
    expect(isFsFaultError(error) && error.faultClass === 'busy').toBe(true);
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
    expect(backoffWaits).toEqual([]);
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

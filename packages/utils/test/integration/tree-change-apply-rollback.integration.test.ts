/**
 * What a rollback leaves, and what it reports: leftovers recorded on the original
 * failure stay readable through the rollback-incomplete wrapper; the parents a
 * create made are removed on the rollback path too, bounded by the canonical
 * destination however it was spelled; and a parent another stranded change still
 * occupies is not reported as a leftover.
 */

import { describe, expect, it } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { suppressedFaultsOf } from '../../src/errors/suppressed-faults.js';
import { isVatError } from '../../src/errors/vat-error.js';
import { safePath } from '../../src/path-core.js';
import { snapshotTree } from '../../src/testing/tree-snapshot.js';
import { planTreeChanges } from '../../src/tree-change/plan.js';
import { TREE_ROLLBACK_INCOMPLETE_CODE } from '../../src/tree-change/rollback-error.js';

import { expectUnchanged, plant, replaceWith, residueIn, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-change-rollback-');

const REGISTRY_FAILS = { afterSwap: (): Promise<void> => Promise.reject(new Error('registry write failed')) };
const messagesOf = (error: unknown): string[] => suppressedFaultsOf(error).map((fault) => (fault as Error).message);

describe('applyTreePlan — a rollback that cannot finish keeps every leftover readable', () => {
  it('a refused park-back and a refused discard: TREE_ROLLBACK_INCOMPLETE, and the discarded entry is still named', async () => {
    const root = suite.root();
    plant(root, { 'mp/a.md': 'old' });
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'mp'), { 'a.md': 'new' })]);
    const discardRm = { op: 'rm', path: (p: string) => p.endsWith('.discard'), errno: 'EACCES' } as const;

    const error = await suite.failApply(root, plan, [
      { family: 'rename', path: (p) => p.endsWith('.previous'), nth: 2, errno: 'EACCES' },
      discardRm,
      { ...discardRm },
    ], REGISTRY_FAILS);

    expect(isVatError(error, TREE_ROLLBACK_INCOMPLETE_CODE)).toBe(true);
    const discarded = residueIn(root).find((name) => name.endsWith('.discard'));
    expect(discarded).toBeDefined();
    expect(messagesOf(error)).toEqual([expect.stringContaining(discarded ?? '<none>') as string]);
  });
});

describe('applyTreePlan — the parents a create made', () => {
  it('are removed when the rollback undoes the create', async () => {
    const root = suite.root();
    plant(root, { 'keep.md': 'k' });
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'new', 'deep', 'out'), { 'a.md': 'a' })]);

    expect(await suite.failApply(root, plan, [], REGISTRY_FAILS)).toEqual(new Error('registry write failed'));
    expectUnchanged(root, before);
  });

  it('are removed, and nothing above them, for a destination spelled with `..`', async () => {
    const root = suite.root();
    plant(root, { 'keep.md': 'k' });
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceWith(`${root}/q/../z/w/out`, { 'a.md': 'a' })]);

    const error = await suite.fullStagingFault(root, plan);
    expect(isFsFaultError(error) && error.side === 'destination').toBe(true);
    expect(messagesOf(error)).toEqual([]);
    expectUnchanged(root, before);
  });

  it('a parent a stranded create still occupies is not reported as a leftover', async () => {
    const root = suite.root();
    plant(root, { 'keep.md': 'k' });
    // `b` makes `new/`; `a` is created inside it and cannot be moved back off.
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'new', 'b'), { 'b.md': 'b' }, 'b'), replaceWith(safePath.join(root, 'new', 'a'), { 'a.md': 'a' }, 'a')]);

    const error = await suite.failApply(root, plan, [{ op: 'rename', path: (p) => p.includes('/new/.a.') && p.endsWith('.discard'), errno: 'EACCES' }], REGISTRY_FAILS);

    expect(isVatError(error, TREE_ROLLBACK_INCOMPLETE_CODE)).toBe(true);
    expect(messagesOf(error)).toEqual([]);
  });
});

/**
 * `planTreeChanges` / `applyTreePlan` at their edges: a plan that overlaps its own
 * destinations, a `write` fill that reads an input outside its staging, the
 * park-before-swap order on every OS, parents a create made, and the leftovers a
 * failure path cannot remove — each recorded beside the thrown error, never on it.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { suppressedFaultsOf } from '../../src/errors/suppressed-faults.js';
import { isVatError } from '../../src/errors/vat-error.js';
import { safePath } from '../../src/path-core.js';
import { snapshotTree } from '../../src/testing/tree-snapshot.js';
import { applyTreePlan } from '../../src/tree-change/apply.js';
import { planTreeChanges, TREE_DESTS_OVERLAP_CODE, type TreeChange } from '../../src/tree-change/plan.js';
import { TREE_ROLLBACK_INCOMPLETE_CODE } from '../../src/tree-change/rollback-error.js';

import { expectUnchanged, isStaged, plant, present, readText, rejectionOf, replaceWith, residueIn, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-change-edges-');

const removeOf = (dest: string, label = 'legacy'): TreeChange => ({ op: 'remove', dest, ownership: { kind: 'force' }, label });

/**
 * A replace of `dist/out` whose `write` callback plants `files`, each content computed when it runs —
 * synchronously, so a throw inside it reaches the primitive as a synchronous throw.
 */
function distOut(root: string, files: Record<string, () => string>): TreeChange {
  const write = (staged: string): Promise<void> => Promise.resolve(plant(staged, Object.fromEntries(Object.entries(files).map(([name, content]) => [name, content()]))));
  return { op: 'replace', dest: safePath.join(root, 'dist', 'out'), ownership: { kind: 'force' }, fill: { from: 'write', write }, label: 'out' };
}

/** Whether a traced rename is a park (to a `.previous` name) or a swap (from a staged one). */
const renameKind = (call: { path: string; dest?: string }): string => (call.dest?.endsWith('.previous') === true ? 'park' : 'swap');

describe('planTreeChanges — a plan overlapping its own destinations is refused, writing nothing', () => {
  it.each([
    ['[replace mp, replace mp/sub]', (root: string) => [replaceWith(safePath.join(root, 'mp'), {}), replaceWith(safePath.join(root, 'mp', 'sub'), {})]],
    ['[remove plugins, replace plugins/x]', (root: string) => [removeOf(safePath.join(root, 'plugins')), replaceWith(safePath.join(root, 'plugins', 'x'), {})]],
  ] as const)('%s → TREE_DESTS_OVERLAP', async (_name, changesIn) => {
    const root = suite.root();
    plant(root, { 'mp/sub/b.txt': 'b', 'plugins/x/v.txt': 'v' });
    const before = snapshotTree(root);
    expect(isVatError(await rejectionOf(() => planTreeChanges(changesIn(root))), TREE_DESTS_OVERLAP_CODE)).toBe(true);
    expectUnchanged(root, before);
  });
});

describe('applyTreePlan — a write fill classifies only what it writes', () => {
  it('rethrows raw an EACCES the callback hit reading an input outside its staging, and changes nothing', async () => {
    const root = suite.root();
    plant(root, { 'in/secret.md': 's', 'dist/out/old.md': 'old' });
    const before = snapshotTree(root);
    const secret = safePath.join(root, 'in', 'secret.md');
    const plan = await planTreeChanges([distOut(root, { 'copy.md': () => readFileSync(secret, 'utf-8') })]);

    const error = await suite.failApply(root, plan, [{ family: 'read', path: (p) => p === secret, errno: 'EACCES' }]);

    expect(isFsFaultError(error)).toBe(false);
    expect(error).toMatchObject({ code: 'EACCES', path: secret });
    expectUnchanged(root, before);
  });

  it('rethrows raw an EACCES reading a sibling input under the same parent: only the staged tree is the fill\'s', async () => {
    const root = suite.root();
    plant(root, { 'dist/skills/s.md': 's', 'dist/out/old.md': 'old' });
    const sibling = safePath.join(root, 'dist', 'skills', 's.md');
    const plan = await planTreeChanges([distOut(root, { 'copy.md': () => readFileSync(sibling, 'utf-8') })]);

    const error = await suite.failApply(root, plan, [{ family: 'read', path: (p) => p === sibling, errno: 'EACCES' }]);

    expect(isFsFaultError(error)).toBe(false);
    expect(error).toMatchObject({ code: 'EACCES', path: sibling });
  });

  it('classifies its own write under the staged tree as a destination fault, even thrown synchronously', async () => {
    const root = suite.root();
    plant(root, { 'dist/out/old.md': 'old' });
    expect(await suite.fullStagingFault(root, await planTreeChanges([distOut(root, { 'a.md': () => 'a' })]))).toMatchObject({ side: 'destination', faultClass: 'exhausted' });
  });
});

describe('applyTreePlan — every park before any swap, on every OS', () => {
  it('renames in the order park, park, swap, swap for two replaces', async () => {
    const root = suite.root();
    plant(root, { 'one/a.md': 'a', 'two/b.md': 'b' });
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'one'), { 'a.md': 'A' }), replaceWith(safePath.join(root, 'two'), { 'b.md': 'B' })]);
    const session = suite.faults(root, []);

    await applyTreePlan(plan);

    expect(session.calls.filter((call) => call.op === 'rename').map((call) => renameKind(call))).toEqual(['park', 'park', 'swap', 'swap']);
  });
});

describe('applyTreePlan — what a failure leaves', () => {
  it('a create under parents it made: a failed fill removes those parents too', async () => {
    const root = suite.root();
    plant(root, { 'keep.md': 'k' });
    expect(await suite.fullStagingFault(root, await planTreeChanges([replaceWith(safePath.join(root, 'new', 'deep', 'out'), { 'a.md': 'a' })]))).toMatchObject({ side: 'destination', faultClass: 'exhausted' });
  });

  it('a create whose new entry cannot be moved back off is a rollback-incomplete error naming it', async () => {
    const root = suite.root();
    const fresh = safePath.join(root, 'fresh');
    const plan = await planTreeChanges([replaceWith(fresh, { 'x.md': 'x' }, 'fresh')]);
    const error = await suite.failApply(root, plan, [{ op: 'rename', path: (p) => p.endsWith('.discard'), errno: 'EACCES' }], { afterSwap: () => Promise.reject(new Error('registry')) });

    expect(isVatError(error, TREE_ROLLBACK_INCOMPLETE_CODE)).toBe(true);
    expect((error as Error).message).toContain(fresh);
    expect(readText(safePath.join(fresh, 'x.md'))).toBe('x');
  });

  it('a staged tree a failed fill cannot remove is recorded beside the fill\'s fault, naming it', async () => {
    const root = suite.root();
    plant(root, { 'out/old.md': 'old' });
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'out'), { 'a.md': 'a' })]);
    const refused = { op: 'rm', path: isStaged, errno: 'EACCES' } as const;
    suite.faults(root, [{ family: 'write', path: isStaged, errno: 'ENOSPC' }, refused, { ...refused }]);

    const error = await rejectionOf(() => applyTreePlan(plan));
    suite.restoreFaults();

    expect(isFsFaultError(error) && error.faultClass === 'exhausted').toBe(true);
    expect((error as Error).cause).toMatchObject({ code: 'ENOSPC' });
    const [staged] = residueIn(root);
    expect(suppressedFaultsOf(error).map((fault) => (fault as Error).message)).toEqual([expect.stringContaining(staged ?? '<none>') as string]);
  });

  it('a remove whose parked tree cannot go keeps the replace\'s cleanup fault beside the thrown one', async () => {
    const root = suite.root();
    plant(root, { 'mp/a.md': 'a', 'skills/legacy/S.md': 's' });
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'mp'), { 'a.md': 'A' }), removeOf(safePath.join(root, 'skills', 'legacy'))]);
    const refused = { op: 'rm', path: (p: string) => p.endsWith('.previous'), errno: 'EACCES' } as const;
    suite.faults(root, [refused, { ...refused }, { ...refused }, { ...refused }]);

    const error = await rejectionOf(() => applyTreePlan(plan));
    suite.restoreFaults();

    expect(isFsFaultError(error) && (error as Error).message.includes('legacy')).toBe(true);
    const [mpParked] = residueIn(root);
    expect(suppressedFaultsOf(error).map((fault) => (fault as Error).message)).toEqual([expect.stringContaining(mpParked ?? '<none>') as string]);
  });

  it('a parked root the OS will not chmod is still removed when the removal itself is allowed', async () => {
    const root = suite.root();
    plant(root, { 'skills/legacy/S.md': 's' });
    const legacy = safePath.join(root, 'skills', 'legacy');
    const plan = await planTreeChanges([removeOf(legacy)]);
    suite.faults(root, [{ op: 'chmod', path: (p) => p.endsWith('.previous'), errno: 'EPERM' }]);

    expect(await applyTreePlan(plan)).toEqual({ warnings: [] });
    suite.restoreFaults();
    expect(present(legacy)).toBe(false);
    expect(residueIn(safePath.join(root, 'skills'))).toEqual([]);
  });
});

/**
 * `applyTreePlan` on a real filesystem: stage → park → swap → afterSwap →
 * finalize, and a rollback that leaves the user's tree byte-equal to before
 * whichever step the OS refuses. Faults are injected with `installFaultFs`, so
 * every step fails on every OS; a real `chmod` is used only where the mode is the
 * subject (a user's read-only tree).
 */

import { chmodSync, existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { isVatError } from '../../src/errors/vat-error.js';
import { safePath, toForwardSlash } from '../../src/path-core.js';
import { mkdirSyncReal } from '../../src/path-utils.js';
import { symlinkCapability } from '../../src/test-helpers.js';
import { PERMISSIONS_ENFORCED, tmpdirFoldsCase } from '../../src/testing/platform-gates.js';
import { snapshotTree, subtree } from '../../src/testing/tree-snapshot.js';
import { applyTreePlan, applyTreePlanOrLeftover, TREE_CLEANUP_INCOMPLETE_CODE } from '../../src/tree-change/apply.js';
import { planTreeChanges, TREE_DEST_OCCUPIED_CODE, type TreeChange } from '../../src/tree-change/plan.js';
import { TREE_ROLLBACK_INCOMPLETE_CODE } from '../../src/tree-change/rollback-error.js';

import {
  expectUnchanged,
  lstatAs,
  nthRename,
  plant,
  present,
  readText,
  rejectionOf,
  replaceWith,
  residueIn,
  treeChangeSuite,
} from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-change-apply-');
// The win32 rename retry's backoff is recorded, never waited out (see the module).
vi.mock('node:timers/promises', () => import('./tree-change-no-backoff.js'));


const OLD_MP = { 'mp/a.txt': 'old a', 'mp/sub/b.txt': 'old b' };
const NEW_MP = { 'a.txt': 'new a', 'c.txt': 'new c' };

/** A root holding `mp/` (old content) and `skills/legacy/`, and the replace of `mp/`. */
function marketplace(): { root: string; mp: string; legacy: string; replaceMp: TreeChange } {
  const root = suite.root();
  plant(root, { ...OLD_MP, 'skills/legacy/SKILL.md': 'legacy' });
  const mp = safePath.join(root, 'mp');
  return { root, mp, legacy: safePath.join(root, 'skills', 'legacy'), replaceMp: replaceWith(mp, NEW_MP, 'marketplace') };
}

/** A root holding `plugins/Old/v.txt`, and the two spellings of that directory. */
function pluginsOld(): { root: string; upper: string; lower: string } {
  const root = suite.root();
  plant(root, { 'plugins/Old/v.txt': 'old' });
  return { root, upper: safePath.join(root, 'plugins', 'Old'), lower: safePath.join(root, 'plugins', 'old') };
}

const removeOf = (dest: string, label = 'legacy'): TreeChange => ({ op: 'remove', dest, ownership: { kind: 'force' }, label });

describe('planTreeChanges — the live facts', () => {
  it('takes an empty directory under must-be-free and refuses a non-empty one, writing nothing', async () => {
    const root = suite.root();
    plant(root, { 'full/x.md': 'x' });
    mkdirSyncReal(safePath.join(root, 'empty'));
    const free = (dest: string): TreeChange => ({ ...replaceWith(dest, {}), ownership: { kind: 'must-be-free' } });
    expect((await planTreeChanges([free(safePath.join(root, 'empty'))])).changes[0]?.action).toBe('replace');
    const before = snapshotTree(root);
    expect(isVatError(await rejectionOf(() => planTreeChanges([free(safePath.join(root, 'full'))])), TREE_DEST_OCCUPIED_CODE)).toBe(true);
    expectUnchanged(root, before);
  });

  // On the fill's DECLARED side: a tree VAT staged (`environment`) or already copied into user state
  // (`destination`) is not the operator's input, and its refused file must not be reported as one.
  it.for(['source', 'environment', 'destination'] as const)('proves a copy source readable at plan time: a refused file is a fault on the declared side (%s) naming it', async (side) => {
    const root = suite.root();
    plant(root, { 'src/secret.md': 's', 'out/keep.md': 'k' });
    suite.faults(root, [{ family: 'read', path: (p) => p.endsWith('secret.md'), errno: 'EACCES' }]);
    const error = await rejectionOf(() => planTreeChanges([{ op: 'replace', dest: safePath.join(root, 'out'), ownership: { kind: 'force' }, fill: { from: 'copy', source: safePath.join(root, 'src'), side, links: 'preserve' }, label: 'out' }]));
    expect(isFsFaultError(error) && error.side === side && error.path?.endsWith('secret.md'), String(error)).toBe(true);
  });

  // A refusal examining an entry once must not make two decisions of one plan disagree: subsumption
  // saw "unknown", the overlap check a moment later saw "inside", and the planner refused its own plan
  // as a VAT defect (TREE_DESTS_OVERLAP → INTERNAL_ERROR). Each entry is examined once per plan.
  it('examines each entry once per plan: a refusal seen once is the answer every decision gets', async () => {
    const root = suite.root();
    plant(root, { 'mp/plugins/p/x.md': 'x' });
    const outer = safePath.join(root, 'mp');
    const inner = safePath.join(outer, 'plugins', 'p');
    // The first lstat of `outer` is the planner's kind probe; the second, the first identity question.
    suite.faults(root, [{ op: 'lstat', path: (p) => p === outer, nth: 2, errno: 'EACCES' }]);

    const plan = await planTreeChanges([removeOf(inner), removeOf(outer)]);
    suite.restoreFaults();

    expect(plan.changes.map((c) => c.action)).toEqual(['remove', 'remove']);
  });

  // A remove's OWN identity the OS refuses is never a keep: "kept, could not tell" exited 0 with the
  // target still there. Only an other entry's refusal keeps.
  it('refuses a remove whose own identity cannot be examined, rather than keeping it', async () => {
    const root = suite.root();
    plant(root, { 'cache/p/x.md': 'x', 'cache/q/y.md': 'y' });
    const target = safePath.join(root, 'cache', 'p');
    suite.faults(root, [{ op: 'lstat', path: (p) => p === target, nth: 2, errno: 'EACCES' }]);
    const error = await rejectionOf(() => planTreeChanges([{ ...removeOf(target), keepIfSameAs: () => [safePath.join(root, 'cache', 'q')] }]));
    suite.restoreFaults();
    expect(isFsFaultError(error) && error.side === 'destination' && error.path === target, String(error)).toBe(true);
  });

  it('refuses a destination the OS will not examine as a destination fault', async () => {
    const root = suite.root();
    const dest = safePath.join(root, 'out');
    suite.faults(root, [{ op: 'lstat', path: (p) => p === dest, errno: 'EACCES' }]);
    const error = await rejectionOf(() => planTreeChanges([removeOf(dest)]));
    expect(isFsFaultError(error) && error.side === 'destination' && error.faultClass === 'refused').toBe(true);
  });

  // An `lstat` refused with ENOENT while the entry IS there read as "nothing there": a remove was
  // kept and the run exited 0 with the tree still in place; a must-be-free destination read as free.
  it('refuses a destination its parent lists but whose lstat answers ENOENT, rather than reading it as absent', async () => {
    const root = suite.root();
    plant(root, { 'out/keep.md': 'k' });
    const dest = safePath.join(root, 'out');
    suite.faults(root, [{ op: 'lstat', path: (p) => p === dest, errno: 'ENOENT' }]);
    const error = await rejectionOf(() => planTreeChanges([removeOf(dest)]));
    expect(isFsFaultError(error) && error.side === 'destination' && error.errno === 'ENOENT' && error.path === dest, String(error)).toBe(true);
  });
});

describe('applyTreePlan — the happy path', () => {
  it('creates, replaces, writes a file and removes in one plan, leaving no residue', async () => {
    const { root, mp, legacy, replaceMp } = marketplace();
    const plan = await planTreeChanges([
      replaceMp,
      replaceWith(safePath.join(root, 'fresh'), { 'x.txt': 'x' }, 'fresh'),
      { op: 'replace-file', dest: safePath.join(root, 'registry.json'), ownership: { kind: 'vat-state' }, contents: '{"a":1}', label: 'registry' },
      removeOf(legacy),
    ]);
    expect(plan.describe()).toEqual([
      `replace marketplace ${mp}`,
      `create fresh ${safePath.join(root, 'fresh')}`,
      `create registry ${safePath.join(root, 'registry.json')}`,
      `remove legacy ${legacy}`,
    ]);

    expect(await applyTreePlan(plan)).toEqual({ warnings: [] });

    expect(readText(safePath.join(mp, 'c.txt'))).toBe('new c');
    expect(present(safePath.join(mp, 'sub'))).toBe(false);
    expect(readText(safePath.join(root, 'fresh', 'x.txt'))).toBe('x');
    expect(readText(safePath.join(root, 'registry.json'))).toBe('{"a":1}');
    expect(present(legacy)).toBe(false);
    expect([...residueIn(root), ...residueIn(safePath.join(root, 'skills'))]).toEqual([]);
  });

  it('makes a replace-file\'s bytes from a tree an earlier change of the same plan staged (an archive of a staged bundle)', async () => {
    const root = suite.root();
    plant(root, { 'out/stale.md': 'stale', 'out.zip': 'old archive' });
    const out = safePath.join(root, 'out');
    const archive = safePath.join(root, 'out.zip');
    let stagedBundle: string | undefined;
    const plan = await planTreeChanges([
      {
        op: 'replace', dest: out, ownership: { kind: 'force' }, label: 'bundle',
        fill: { from: 'write', write: async (staged) => {
          plant(staged, { 'SKILL.md': 'new bundle' });
          stagedBundle = staged;
        } },
      },
      {
        op: 'replace-file', dest: archive, ownership: { kind: 'force' }, label: 'archive',
        // Asked for only once the bundle above is staged: it reads that staged tree.
        contents: () => `archive of ${readText(safePath.join(stagedBundle ?? 'not staged yet', 'SKILL.md'))}`,
      },
    ]);

    expect(await applyTreePlan(plan)).toEqual({ warnings: [] });

    expect(readText(archive)).toBe('archive of new bundle');
    expect(readText(safePath.join(out, 'SKILL.md'))).toBe('new bundle');
    expect(residueIn(root)).toEqual([]);
  });

  it('copies a source tree into place with a copy fill, its directories owner-writable', async () => {
    const root = suite.root();
    plant(root, { 'src/k/one.md': 'one', 'out/stale.md': 'stale' });
    chmodSync(safePath.join(root, 'src', 'k'), 0o555);
    const out = safePath.join(root, 'out');
    const plan = await planTreeChanges([{ op: 'replace', dest: out, ownership: { kind: 'force' }, fill: { from: 'copy', source: safePath.join(root, 'src'), side: 'source', links: 'preserve' }, label: 'out' }]);

    await applyTreePlan(plan);

    expect(readText(safePath.join(out, 'k', 'one.md'))).toBe('one');
    expect(present(safePath.join(out, 'stale.md'))).toBe(false);
    expect(snapshotTree(out).get('k')).toMatchObject({ kind: 'dir', mode: PERMISSIONS_ENFORCED ? 0o755 : expect.any(Number) as number });
  });

  // A write fill's staged root BECOMES the destination (`dist/skills`, a marketplace): it must get the mode any
  // directory the caller makes gets, never a temp directory's 0700.
  it.skipIf(!PERMISSIONS_ENFORCED)('lands a write fill with the mode a fresh directory gets, not a temp directory\'s 0700', async () => {
    const root = suite.root();
    const probe = safePath.join(root, 'probe');
    mkdirSyncReal(probe);
    const out = safePath.join(root, 'out');

    await applyTreePlan(await planTreeChanges([replaceWith(out, { 'x.txt': 'x' }, 'out')]));

    expect((snapshotTree(root).get('out')?.mode ?? 0).toString(8)).toBe((snapshotTree(root).get('probe')?.mode ?? -1).toString(8));
  });

  // An ino-0 filesystem (FAT, SMB) answers `unknown` for containment: the plan must still copy, and two unrelated changes must both run.
  it('plans and applies on a filesystem reporting ino 0, refusing nothing', async () => {
    const { root, mp, legacy } = marketplace();
    plant(root, { 'src/n.md': 'n' });
    suite.faults(root, [], [lstatAs(() => true, { ino: 0n })]);
    const plan = await planTreeChanges([
      { op: 'replace', dest: mp, ownership: { kind: 'force' }, fill: { from: 'copy', source: safePath.join(root, 'src'), side: 'source', links: 'preserve' }, label: 'mp' },
      removeOf(legacy),
    ]);
    expect(plan.changes.map((c) => c.action)).toEqual(['replace', 'remove']);
    await applyTreePlan(plan);
    suite.restoreFaults();
    expect(readText(safePath.join(mp, 'n.md'))).toBe('n');
    expect(present(legacy)).toBe(false);
  });
});

describe('applyTreePlan — every step failing leaves the tree as it was', () => {
  it('fill fails (ENOSPC writing under the staged tree): nothing changed, nothing staged left', async () => {
    const { root, replaceMp } = marketplace();
    expect(await suite.fullStagingFault(root, await planTreeChanges([replaceMp]))).toMatchObject({ side: 'destination', faultClass: 'exhausted' });
  });

  it('park fails (EPERM on the first rename): nothing changed', async () => {
    const { root, replaceMp } = marketplace();
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceMp]);
    suite.faults(root, [nthRename(1, 'EPERM')]);

    const error = await rejectionOf(() => applyTreePlan(plan));
    suite.restoreFaults();

    expect(isFsFaultError(error) && error.side === 'destination' && error.faultClass === 'refused').toBe(true);
    expectUnchanged(root, before);
  });

  it('swap fails (EBUSY on the second rename): the parked tree is restored', async () => {
    const { root, replaceMp } = marketplace();
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceMp]);
    suite.faults(root, [nthRename(2, 'EBUSY')]);

    const error = await rejectionOf(() => applyTreePlan(plan));
    suite.restoreFaults();

    expect(isFsFaultError(error) && error.faultClass === 'busy').toBe(true);
    expectUnchanged(root, before);
  });

  it('afterSwap throws: both swapped changes are rolled back and its error is the one thrown', async () => {
    const root = suite.root();
    plant(root, { ...OLD_MP, 'two/x.txt': 'old x' });
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceWith(safePath.join(root, 'mp'), NEW_MP), replaceWith(safePath.join(root, 'two'), { 'y.txt': 'y' })]);
    const registryFailed = new Error('registry write failed');

    expect(await rejectionOf(() => applyTreePlan(plan, { afterSwap: () => Promise.reject(registryFailed) }))).toBe(registryFailed);
    expectUnchanged(root, before);
  });

  it('a rollback rename fails: TREE_ROLLBACK_INCOMPLETE names the parked path, and the parked tree still exists', async () => {
    const { root, mp, replaceMp } = marketplace();
    const oldMp = subtree(snapshotTree(root), 'mp');
    const plan = await planTreeChanges([replaceMp]);
    // The park's rename names `.previous` as its target (1st); putting it back names it as its source (2nd).
    const error = await suite.failApply(root, plan, [{ family: 'rename', path: (p) => p.endsWith('.previous'), nth: 2, errno: 'EACCES', everyTry: true }], { afterSwap: () => Promise.reject(new Error('registry')) });

    expect(isVatError(error, TREE_ROLLBACK_INCOMPLETE_CODE)).toBe(true);
    const [parked, ...others] = residueIn(root).filter((name) => name.endsWith('.previous'));
    expect(others).toEqual([]);
    const parkedPath = safePath.join(root, parked ?? '<none>');
    expect((error as Error).message).toContain(parkedPath);
    expect((error as { parked?: unknown }).parked).toEqual([parkedPath]);
    expect((error as Error).cause).toEqual(new Error('registry'));
    // Byte-equal to the user's tree, under its parked name.
    expect([...snapshotTree(parkedPath)].map(([key, entry]) => [key, entry])).toEqual([...oldMp].map(([key, entry]) => [key === 'mp' ? '.' : key.slice('mp/'.length), entry]));
    expect(present(mp)).toBe(false);
  });
});

describe('applyTreePlan — finalize', () => {
  it('on a replace, a previous tree that cannot be removed is a warning naming it, and the new tree is live', async () => {
    const { root, mp, replaceMp } = marketplace();
    const plan = await planTreeChanges([replaceMp]);
    const parkedRm = { op: 'rm', path: (p: string) => p.endsWith('.previous'), errno: 'EACCES' } as const;
    suite.faults(root, [parkedRm, { ...parkedRm }]);

    const { warnings } = await applyTreePlan(plan);
    suite.restoreFaults();

    const [parked] = residueIn(root);
    expect(warnings).toEqual([{ code: TREE_CLEANUP_INCOMPLETE_CODE, path: safePath.join(root, parked ?? '<none>'), message: expect.stringContaining(parked ?? '<none>') as string }]);
    expect(readText(safePath.join(mp, 'a.txt'))).toBe('new a');
  });

  it('on a remove, the same refusal is a destination fault naming the parked path, and the user path is already absent', async () => {
    const { root, legacy } = marketplace();
    const plan = await planTreeChanges([removeOf(legacy)]);
    const parkedRm = { op: 'rm', path: (p: string) => p.endsWith('.previous'), errno: 'EACCES' } as const;
    suite.faults(root, [parkedRm, { ...parkedRm }]);

    const error = await rejectionOf(() => applyTreePlan(plan));
    suite.restoreFaults();

    const [parked] = residueIn(safePath.join(root, 'skills'));
    expect(isFsFaultError(error) && error.side === 'destination').toBe(true);
    expect((error as Error).message).toContain(safePath.join(root, 'skills', parked ?? '<none>'));
    expect(present(legacy)).toBe(false);
  });
});

describe('applyTreePlanOrLeftover — the commit is the line', () => {
  it('a remove whose parked entry will not go is DONE: the refusal comes back as the leftover, never thrown', async () => {
    const { root, legacy } = marketplace();
    const plan = await planTreeChanges([removeOf(legacy)]);
    suite.faults(root, ['rm', 'rm', 'rmdir'].map((op) => ({ op, path: (p: string) => p.endsWith('.previous'), errno: 'EBUSY' as const })));
    const outcome = await applyTreePlanOrLeftover(plan);
    suite.restoreFaults();

    expect(outcome.warnings).toEqual([]);
    expect(isFsFaultError(outcome.leftover) && outcome.leftover.path).toBe(safePath.join(root, 'skills', residueIn(safePath.join(root, 'skills'))[0] ?? '<none>'));
    expect(present(legacy)).toBe(false);
  });

  it('a failure before the commit (afterSwap) is rolled back and thrown, as by applyTreePlan', async () => {
    const { root, legacy } = marketplace();
    const before = snapshotTree(root);
    const refused = new Error('registry write failed');
    const plan = await planTreeChanges([removeOf(legacy)]);

    expect(await rejectionOf(() => applyTreePlanOrLeftover(plan, { afterSwap: () => Promise.reject(refused) }))).toBe(refused);
    expectUnchanged(root, before);
  });

  it('a clean apply has no leftover', async () => {
    const { root, legacy } = marketplace();
    expect(await applyTreePlanOrLeftover(await planTreeChanges([removeOf(legacy)]))).toEqual({ warnings: [] });
    expect(residueIn(root)).toEqual([]);
  });
});

describe('applyTreePlan — a two-change transaction', () => {
  it('replace mp/ and remove skills/legacy; the swap after both parks fails: both are back', async () => {
    const { root, legacy, replaceMp } = marketplace();
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceMp, removeOf(legacy)]);
    // Renames in order: park mp (1), park legacy (2), swap mp (3).
    suite.faults(root, [nthRename(3, 'EBUSY')]);

    expect(isFsFaultError(await rejectionOf(() => applyTreePlan(plan)))).toBe(true);
    suite.restoreFaults();
    expectUnchanged(root, before);
  });

  it('the second park fails: the first is put back', async () => {
    const { root, legacy, replaceMp } = marketplace();
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceMp, removeOf(legacy)]);
    suite.faults(root, [nthRename(2, 'EPERM')]);

    expect(isFsFaultError(await rejectionOf(() => applyTreePlan(plan)))).toBe(true);
    suite.restoreFaults();
    expectUnchanged(root, before);
  });
});

describe('applyTreePlan — case aliasing (Review Focus 1)', () => {
  it('[remove plugins/Old, replace plugins/old] where the two are one entry: plugins/old holds the NEW content', async () => {
    const { root, upper, lower } = pluginsOld();
    // Where the temp filesystem does not fold case, `old` is a second real directory the rewrite makes one entry with `Old`.
    if (!tmpdirFoldsCase()) plant(root, { 'plugins/old/v.txt': 'old' });
    suite.faults(root, [], [lstatAs((p) => p === upper || p === lower, { dev: 7n, ino: 4242n })]);
    const plan = await planTreeChanges([removeOf(upper, 'plugin Old'), replaceWith(lower, { 'v.txt': 'new' }, 'plugin old')]);
    expect(plan.changes.map((c) => c.action)).toEqual(['subsumed', 'replace']);

    await applyTreePlan(plan);
    suite.restoreFaults();

    expect(readText(safePath.join(lower, 'v.txt'))).toBe('new');
    expect(residueIn(safePath.join(root, 'plugins'))).toEqual([]);
  });
});

describe('applyTreePlan — every park before any swap', () => {
  // Skipped where the filesystem does not fold case. Only a case-folding filesystem makes two spellings one directory; elsewhere there is nothing to alias.
  it.skipIf(!tmpdirFoldsCase())('two spellings identity cannot tell apart: the apply rolls back, never ends with nothing', async () => {
    const { root, upper, lower } = pluginsOld();
    // `Old` reports ino 0, so it is judged by a fold and `old` by an id: `unknown`, two changes.
    suite.faults(root, [], [lstatAs((p) => p === upper, { ino: 0n })]);
    const plan = await planTreeChanges([replaceWith(lower, { 'v.txt': 'new' }, 'plugin old'), removeOf(upper, 'plugin Old')]);
    expect(plan.changes.map((c) => c.action)).toEqual(['replace', 'remove']);

    // Parked first, `old` takes `Old` with it, so parking `Old` finds nothing and rolls back. Swapped
    // first, parking `Old` would take the NEW tree and finalize would delete it.
    expect(isFsFaultError(await rejectionOf(() => applyTreePlan(plan)))).toBe(true);
    suite.restoreFaults();
    // Back under the plan's spelling: identity answered `unknown`, so no name on disk can be proven the original.
    expect(readText(safePath.join(upper, 'v.txt'))).toBe('old');
    expect(residueIn(safePath.join(root, 'plugins'))).toEqual([]);
  });

  it.skipIf(!tmpdirFoldsCase())('a rollback puts a directory back under the spelling it had on disk, not the plan\'s', async () => {
    // Skipped where the filesystem does not fold case: two spellings are two directories there.
    const { root, lower } = pluginsOld();
    const before = snapshotTree(root);
    const plan = await planTreeChanges([replaceWith(lower, { 'v.txt': 'new' })]);
    suite.faults(root, [nthRename(2, 'EBUSY')]);

    expect(isFsFaultError(await rejectionOf(() => applyTreePlan(plan)))).toBe(true);
    suite.restoreFaults();
    expectUnchanged(root, before);
  });
});

/** `skills/legacy/` with a 0555 subdirectory holding a file. */
function readOnlyLegacy(): { root: string; legacy: string } {
  const root = suite.root();
  plant(root, { 'skills/legacy/ro/f.md': 'f' });
  const legacy = safePath.join(root, 'skills', 'legacy');
  chmodSync(safePath.join(legacy, 'ro'), 0o555);
  return { root, legacy };
}

describe('applyTreePlan — a user\'s read-only tree (Review Focus 2)', () => {
  it.skipIf(!PERMISSIONS_ENFORCED)('a force remove of a tree with a 0555 subdirectory succeeds and leaves nothing', async () => {
    // Skipped where modes bind nothing (Windows, root): a 0555 directory refuses no removal there.
    const { root, legacy } = readOnlyLegacy();
    await applyTreePlan(await planTreeChanges([removeOf(legacy)]));
    expect(present(legacy)).toBe(false);
    expect(residueIn(safePath.join(root, 'skills'))).toEqual([]);
  });

  it('when the walk cannot chmod the subdirectory: a destination fault naming the parked path, the user path absent', async () => {
    const { root, legacy } = readOnlyLegacy();
    const plan = await planTreeChanges([removeOf(legacy)]);
    suite.faults(root, [
      { op: 'rm', path: (p) => p.endsWith('.previous'), errno: 'EACCES' },
      { op: 'chmod', path: (p) => p.includes('.previous') && p.endsWith('/ro'), errno: 'EACCES' },
    ]);

    const error = await rejectionOf(() => applyTreePlan(plan));
    suite.restoreFaults();

    const [parked] = residueIn(safePath.join(root, 'skills'));
    const parkedPath = safePath.join(root, 'skills', parked ?? '<none>');
    expect(isFsFaultError(error) && error.side === 'destination' && error.faultClass === 'refused').toBe(true);
    expect((error as Error).message).toContain(parkedPath);
    expect(present(legacy)).toBe(false);
    expect(existsSync(safePath.join(parkedPath, 'ro', 'f.md'))).toBe(true);
  });


  // `rm`'s recursion removes siblings concurrently and goes on after it has rejected: the walk
  // that grants rwx can meet a directory the first removal has just taken. Gone is what the walk
  // wants; it used to fail the removal on it (ENOENT), leaving the parked tree behind.
  it('a walk that meets an entry already gone still removes the tree', async () => {
    const { root, legacy } = readOnlyLegacy();
    plant(legacy, { 'other/g.md': 'g' });
    const plan = await planTreeChanges([removeOf(legacy)]);
    // `other` answers as the first removal had just taken it.
    suite.faults(root, [
      { op: 'rm', path: (p) => p.endsWith('.previous'), errno: 'EACCES' },
      { op: 'chmod', path: (p) => p.includes('.previous') && p.endsWith('/other'), errno: 'ENOENT' },
    ]);

    await applyTreePlan(plan);
    suite.restoreFaults();

    expect(present(legacy)).toBe(false);
    expect(residueIn(safePath.join(root, 'skills'))).toEqual([]);
  });
});

describe('applyTreePlan — a link fill', () => {
  it('replaces a tree with a link to the target', async ({ skip }) => {
    if (symlinkCapability() === null) return skip('host cannot create symlinks');
    const root = suite.root();
    plant(root, { 'built/s.md': 's', 'dev/old.md': 'old' });
    const dest = safePath.join(root, 'dev');
    const target = safePath.join(root, 'built');
    await applyTreePlan(await planTreeChanges([{ op: 'replace', dest, ownership: { kind: 'force' }, fill: { from: 'link', target }, label: 'dev' }]));
    const entry = snapshotTree(dest).get('.');
    expect(entry?.kind === 'link' ? toForwardSlash(entry.target) : entry).toBe(target);
    expect(residueIn(root)).toEqual([]);
  });
});

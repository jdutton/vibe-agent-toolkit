/**
 * The apply half of the tree-change primitive: carry out a {@link TreePlan} as one
 * transaction, in a fixed order —
 *
 * 1. **Stage** every new entry beside its destination, on the same filesystem (so
 *    a swap never crosses devices): a `mkdtemp` directory filled by `copyTree`, a
 *    fresh directory (plain `mkdir`, the caller's mode) filled by the `write`
 *    callback, or a fresh name for a file or a link. A failure removes
 *    every staged entry, and every parent directory a create made; no destination
 *    has changed.
 * 2. **Park** every entry being replaced or removed: `rename(dest, <staged>.previous)`.
 *    Every park happens before any swap, so a name is free before anything lands
 *    on it — on a case-folding filesystem `Old` and `old` are one name.
 * 3. **Swap** every staged entry in: `rename(staged, dest)`.
 * 4. **`afterSwap()`** — the caller's own writes that must agree with the tree
 *    (a registry). A throw rolls back every swap.
 * 5. **Rollback**, when 2–4 throw: in reverse, each swapped entry is moved off its
 *    destination and its parked entry renamed back, then the parents a create made
 *    are removed. A parked entry is NEVER deleted on a failure path: if one cannot
 *    be put back — or a create's new entry cannot be moved off — the error is
 *    {@link TreeRollbackIncompleteError}, naming each.
 * 6. **Finalize**: each parked entry is removed, its modes notwithstanding. For a
 *    replace a refusal is only a warning ({@link TREE_CLEANUP_INCOMPLETE_CODE}): the
 *    new tree is live. For a remove, removal is the job, so it is a `destination`
 *    fault naming the parked path — the data is already off the user's path.
 *
 * Every rename is {@link renameFileAtomic}'s, retried under win32 on contention.
 * The primitive's own filesystem faults are classified `destination` (staging sits
 * beside the user's destination); a `copy` source's read is already classified on
 * the fill's declared side; a
 * `write` fill's raw errno is `destination` only when it names a path under the
 * destination's parent — anything else (an input the callback read) is rethrown
 * raw, for the verb's boundary to classify.
 *
 * A thrown failure is never mutated. What a failure path could not clean up (a
 * staged entry, a parent, a replaced tree beside a failed remove) is recorded
 * beside it, off its cause chain: `suppressedFaultsOf(error)`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { fsFaultOf, isAlreadyExistsError, isOccupiedError } from '../errors/errno-table.js';
import { fsBoundary } from '../errors/fs-boundary.js';
import { classifyFsFault, isFsFaultError, withFsFault } from '../errors/fs-fault.js';
import { recordSuppressedFault } from '../errors/suppressed-faults.js';
import { isVatError } from '../errors/vat-error.js';
import { forEachInOrder, mapInOrder } from '../in-order.js';
import { relativeEscapesRoot, safePath, toForwardSlash } from '../path-core.js';

import { copyTree } from './copy-tree.js';
import { removeEntry, renameFileAtomic } from './files.js';
import { sameEntry } from './identity.js';
import { isActive, type PlannedChange, type TreePlan } from './plan.js';
import { TreeRollbackIncompleteError, type TreeRollbackStranded } from './rollback-error.js';
import { PARKED_SUFFIX, stagingName, stagingPrefix } from './staging-names.js';

/** A replaced entry, parked once the new one was live, that could not be removed. */
export const TREE_CLEANUP_INCOMPLETE_CODE = 'TREE_CLEANUP_INCOMPLETE';

/** Suffix of a swapped-in entry moved back off its destination by a rollback. */
const DISCARD_SUFFIX = '.discard';

export interface ApplyOptions {
  /**
   * Runs once every swap is done; a throw rolls every change back and is rethrown.
   * ⚠️ Its own filesystem faults must be classified `destination` (it writes user
   * state beside the tree): should the rollback then fail, the error becomes
   * `TREE_ROLLBACK_INCOMPLETE` (`RUN_INCOMPLETE`), which agrees with every
   * destination row of the refusal table and with no other side's.
   */
  readonly afterSwap?: () => Promise<void>;
}

/** A finding a successful apply reports: the change is done, something beside it is left. */
export interface TreeChangeWarning {
  readonly code: typeof TREE_CLEANUP_INCOMPLETE_CODE;
  /** The entry left behind. */
  readonly path: string;
  readonly message: string;
}

export interface ApplyResult {
  readonly warnings: readonly TreeChangeWarning[];
}

/** One change being applied, and how far it got. */
interface Slot {
  readonly planned: PlannedChange;
  /** The first parent directory staging had to create, if any: removed again on a failure path. */
  createdParent: string | undefined;
  /** The new entry, once staged; its discarded name once a rollback moved it back off. */
  staged: string | undefined;
  /** The previous entry's parked name, once parked. */
  parked: string | undefined;
  /** The name the previous entry had on disk, which a rollback puts it back under. */
  spelled: string | undefined;
  swapped: boolean;
}

const destOf = (slot: Slot): string => slot.planned.change.dest;
const labelOf = (slot: Slot): string => slot.planned.change.label;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Run `work` for `slot`, a raw errno classified `destination` with `action`. */
function onDestination<T>(slot: Slot, action: string, work: () => Promise<T>): Promise<T> {
  return withFsFault({ side: 'destination', action: `${action} ${labelOf(slot)}`, path: destOf(slot) }, work);
}

/**
 * A `write` fill's failure: a raw errno naming a path under the staged tree — all the
 * callback may write — is the destination's; anything else, an input the callback read
 * (a sibling of the destination included), is rethrown as it was, for the verb's
 * boundary to classify.
 */
function writeFillFault(error: unknown, slot: Slot, staged: string): unknown {
  const facts = fsFaultOf(error);
  if (isVatError(error) || facts === undefined) return error;
  const ours = fsBoundary({ destination: [staged] });
  const named = [facts.path, facts.dest].filter((p): p is string => p !== undefined);
  if (!named.some((p) => ours.sideOf(p) === 'destination')) return error;
  return classifyFsFault(error, { side: 'destination', action: `stage the new ${labelOf(slot)}`, path: destOf(slot) });
}

/** The parent of the destination, made when absent; the first directory made is remembered. */
async function makeParent(slot: Slot): Promise<void> {
  const made = await onDestination(slot, 'make the parent directory of', () => fs.mkdir(path.dirname(destOf(slot)), { recursive: true }));
  slot.createdParent = made === undefined ? undefined : toForwardSlash(made);
}

/** How many fresh names a `write` fill tries before an `EEXIST` is the answer (as `mkdtemp` retries its own). */
const STAGING_NAME_TRIES = 8;

/** The staged directory beside `dest`: `mkdtemp` for a copy, a plain `mkdir` of a fresh name for a `write` (see {@link stageTree}). */
async function makeStagedDirectory(dest: string, from: 'copy' | 'write', attempt = 1): Promise<string> {
  if (from === 'copy') return fs.mkdtemp(stagingPrefix(dest));
  const name = stagingName(dest);
  try {
    await fs.mkdir(name);
    return name;
  } catch (error: unknown) {
    // A collision with a leftover of the same random name: draw another, as `mkdtemp` does.
    if (!isAlreadyExistsError(error) || attempt >= STAGING_NAME_TRIES) throw error;
    return makeStagedDirectory(dest, from, attempt + 1);
  }
}

/**
 * Stage a directory tree beside the destination, filled by the copy or the caller's `write`. A copy
 * stages in a `mkdtemp` directory (the copy gives it its source's mode). A `write` stages in a fresh
 * name made by a plain `mkdir`, so the tree it becomes gets the mode any directory the caller makes
 * gets — never a temp directory's 0700 (`dist/skills`, a marketplace). The name is as unique: a
 * collision is `EEXIST`, never a shared directory.
 */
async function stageTree(slot: Slot, fill: Exclude<Extract<PlannedChange['change'], { op: 'replace' }>['fill'], { from: 'link' }>): Promise<void> {
  const staged = toForwardSlash(await onDestination(slot, 'stage the new', () => makeStagedDirectory(destOf(slot), fill.from)));
  slot.staged = staged;
  if (fill.from === 'copy') {
    await onDestination(slot, 'copy the new', () => copyTree(fill.source, staged, { links: fill.links, side: fill.side, ...(fill.filter === undefined ? {} : { filter: fill.filter }) }));
  } else if (fill.from === 'write') {
    // `try`/`await`, not `.catch`: a callback that throws synchronously is judged the same way.
    try {
      await fill.write(staged);
    } catch (error: unknown) {
      throw writeFillFault(error, slot, staged);
    }
  }
}

/** Make the new entry beside the destination. */
async function stage(slot: Slot): Promise<void> {
  const { change } = slot.planned;
  if (change.op === 'remove') return;
  await makeParent(slot);
  if (change.op === 'replace-file') {
    const staged = stagingName(change.dest);
    slot.staged = staged;
    const { contents } = change;
    await onDestination(slot, 'stage the new', () => fs.writeFile(staged, typeof contents === 'function' ? contents() : contents, { flag: 'wx' }));
    return;
  }
  if (change.fill.from !== 'link') {
    await stageTree(slot, change.fill);
    return;
  }
  const staged = stagingName(change.dest);
  slot.staged = staged;
  const { target } = change.fill;
  // `dir`: parity with today's `--dev` lanes, both of which refuse win32 before staging. Should a win32
  // `--dev` lane ever exist, the repo's precedent is `junction` (dev-tools `link-workspace-packages.ts`),
  // which needs no symlink privilege.
  await onDestination(slot, 'stage the link for', () => fs.symlink(target, staged, 'dir'));
}

/**
 * The name `dest` has on disk. On a case-folding filesystem a plan may spell a
 * destination `plugins/old` while the directory is `plugins/Old`: a rollback must
 * put it back as `Old`. When the parent lists `dest`'s own name, that is it (two
 * names one fold apart cannot both exist); otherwise the sibling that is the same
 * entry, judged by identity, never by comparing names.
 */
async function spelledOnDisk(dest: string): Promise<string> {
  const parent = path.dirname(dest);
  const names = await fs.readdir(parent);
  if (names.includes(toForwardSlash(path.basename(dest)))) return dest;
  const alias = names.find((name) => sameEntry(safePath.join(parent, name), dest) === 'same');
  return alias === undefined ? dest : safePath.join(parent, alias);
}

async function park(slot: Slot): Promise<void> {
  const parked = `${slot.staged ?? stagingName(destOf(slot))}${PARKED_SUFFIX}`;
  await onDestination(slot, 'move aside the previous', async () => {
    slot.spelled = await spelledOnDisk(destOf(slot));
    await renameFileAtomic(destOf(slot), parked);
  });
  slot.parked = parked;
}

async function swap(slot: Slot): Promise<void> {
  const staged = slot.staged as string;
  await onDestination(slot, 'put in place the new', () => renameFileAtomic(staged, destOf(slot)));
  slot.swapped = true;
}

/** Remove `entry`, VAT's own leftover; a refusal is recorded beside `error`, never thrown over it. */
async function discard(entry: string | undefined, error: unknown): Promise<void> {
  if (entry === undefined) return;
  try {
    await removeEntry(entry);
  } catch (refused: unknown) {
    recordSuppressedFault(error, classifyFsFault(refused, { side: 'destination', action: `remove the staged ${entry}`, path: entry }));
  }
}

/**
 * Remove, deepest first, the empty parents staging made for `slot`: from the
 * destination's parent up to the first directory `mkdir` made, never past it — both
 * in the canonical spelling, bounded by containment, not by comparing strings. A
 * parent still holding entries (another change's, stranded) is left without a
 * word; one the OS refuses is recorded beside `error`.
 */
function removeMadeParents(slot: Slot, error: unknown): Promise<void> {
  if (slot.createdParent === undefined) return Promise.resolve();
  const top = safePath.resolve(slot.createdParent);
  const removeFrom = (dir: string): Promise<void> => {
    const below = safePath.relative(top, dir);
    if (relativeEscapesRoot(below)) return Promise.resolve();
    return fs.rmdir(dir).then(
      () => (below === '' ? undefined : removeFrom(safePath.resolve(path.dirname(dir)))),
      (refused: unknown) => {
        if (isOccupiedError(refused)) return;
        recordSuppressedFault(error, classifyFsFault(refused, { side: 'destination', action: 'remove the directory made for', path: dir }));
      },
    );
  };
  return removeFrom(safePath.resolve(path.dirname(destOf(slot))));
}

/** Move a swapped-in entry back off its destination, to be discarded. What could not move is returned. */
async function unswap(slot: Slot): Promise<TreeRollbackStranded | undefined> {
  const discarded = `${slot.staged as string}${DISCARD_SUFFIX}`;
  try {
    await renameFileAtomic(destOf(slot), discarded);
    slot.staged = discarded;
    return undefined;
  } catch (refused: unknown) {
    return { dest: destOf(slot), parked: slot.parked, why: `the new content could not be moved off it: ${messageOf(refused)}` };
  }
}

/** Undo one slot: the new entry off the destination, the previous one back on. What could not be undone is returned. */
async function restore(slot: Slot, error: unknown): Promise<TreeRollbackStranded | undefined> {
  const stuck = slot.swapped ? await unswap(slot) : undefined;
  if (stuck !== undefined) return stuck;
  await discard(slot.staged, error);
  if (slot.parked === undefined) return undefined;
  try {
    await renameFileAtomic(slot.parked, slot.spelled ?? destOf(slot));
    return undefined;
  } catch (refused: unknown) {
    return { dest: destOf(slot), parked: slot.parked, why: messageOf(refused) };
  }
}

/** Remove the parents staging made, for every slot fully undone (newest first). */
function removeAllMadeParents(slots: readonly Slot[], error: unknown, stranded: readonly Slot[] = []): Promise<void> {
  return forEachInOrder(slots.toReversed().filter((slot) => !stranded.includes(slot)), (slot) => removeMadeParents(slot, error));
}

/** Undo every slot, newest first; the error to throw is `error`, or a rollback-incomplete one carrying it. */
async function rolledBack(slots: readonly Slot[], error: unknown): Promise<unknown> {
  const outcomes = await mapInOrder(slots.toReversed(), async (slot) => ({ slot, stranded: await restore(slot, error) }));
  const stuck = outcomes.filter((o) => o.stranded !== undefined);
  await removeAllMadeParents(slots, error, stuck.map((o) => o.slot));
  return stuck.length === 0 ? error : new TreeRollbackIncompleteError(error, stuck.map((o) => o.stranded as TreeRollbackStranded));
}

/** Remove a parked entry: `undefined` when gone, else the classified fault naming the parked path. */
async function removeParked(slot: Slot): Promise<unknown> {
  const parked = slot.parked as string;
  try {
    await removeEntry(parked);
    return undefined;
  } catch (refused: unknown) {
    const fault = classifyFsFault(refused, { side: 'destination', action: `remove the previous ${labelOf(slot)}, parked at ${parked}`, path: parked });
    if (!isFsFaultError(fault)) throw refused;
    return fault;
  }
}

/**
 * Remove every parked entry. A replace's refusal is a warning; a remove's is thrown
 * (after every removal was tried), with every other refusal recorded beside it.
 */
async function finalize(slots: readonly Slot[]): Promise<ApplyResult> {
  const parked = slots.filter((slot) => slot.parked !== undefined);
  const outcomes = (await mapInOrder(parked, async (slot) => ({ slot, fault: await removeParked(slot) }))).filter((o) => o.fault !== undefined);
  const thrown = outcomes.find((o) => o.slot.planned.change.op === 'remove');
  if (thrown !== undefined) {
    for (const other of outcomes) if (other !== thrown) recordSuppressedFault(thrown.fault, other.fault);
    throw thrown.fault;
  }
  return {
    warnings: outcomes.map(({ slot, fault }) => ({ code: TREE_CLEANUP_INCOMPLETE_CODE, path: slot.parked as string, message: messageOf(fault) })),
  };
}

/**
 * Carry out `plan`: stage, park, swap, `afterSwap`, finalize — or roll back so
 * every destination is exactly as it was.
 *
 * @param plan - What `planTreeChanges` decided; `keep` and `subsumed` changes are not touched
 * @param options - `afterSwap`, run once the new tree is in place
 * @returns The warnings of a change that is done: a previous tree left beside a replaced one
 * @throws the first failure, after the rollback and unchanged: an `FsFaultError` (side
 *   `destination`, or the fill's declared side for a copy source's read), a `write` fill's own error or raw
 *   errno, or whatever `afterSwap` threw — with what could not be cleaned up in
 *   `suppressedFaultsOf(error)`; {@link TreeRollbackIncompleteError} (cause: that
 *   failure) when the rollback could not undo every change; for a `remove` whose
 *   parked entry cannot be removed, an `FsFaultError` side `destination` naming it
 */
export function applyTreePlan(plan: TreePlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  return applyStages(plan, options);
}

/** What {@link applyTreePlanOrLeftover} finished with: the warnings of a clean apply, or the failure that came after the commit. */
export interface ApplyOutcome extends ApplyResult {
  /**
   * The failure that came once every change was in place (and `afterSwap` had run): a parked entry of
   * a `remove` the OS would not delete. It cannot be undone and is no refusal of the change — the
   * change is DONE, every destination as planned — so it is returned, naming what is left (its `path`
   * the parked entry), for the verb to report beside the work it finished. Absent when the apply finished clean.
   */
  readonly leftover?: unknown;
}

/**
 * {@link applyTreePlan}, for a verb that reports a change it finished even when what it parked could
 * not then be deleted (an uninstall, a clear): a failure before the commit — every swap made and
 * `afterSwap` run — rolled back and is thrown, as by `applyTreePlan`; one after it is returned as
 * `leftover`. The commit is the one line between "nothing finished" and "the change is done".
 */
export async function applyTreePlanOrLeftover(plan: TreePlan, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  let committed = false;
  try {
    return await applyStages(plan, {
      afterSwap: async () => {
        await options.afterSwap?.();
        committed = true;
      },
    });
  } catch (error: unknown) {
    if (!committed) throw error;
    return { warnings: [], leftover: error };
  }
}

async function applyStages(plan: TreePlan, options: ApplyOptions): Promise<ApplyResult> {
  const slots = plan.changes.filter(isActive).map((planned): Slot => ({ planned, createdParent: undefined, staged: undefined, parked: undefined, spelled: undefined, swapped: false }));
  try {
    await forEachInOrder(slots, stage);
  } catch (error: unknown) {
    await forEachInOrder(slots, (slot) => discard(slot.staged, error));
    await removeAllMadeParents(slots, error);
    throw error;
  }
  try {
    await forEachInOrder(slots.filter((slot) => slot.planned.existing !== 'absent'), park);
    await forEachInOrder(slots.filter((slot) => slot.staged !== undefined), swap);
    await options.afterSwap?.();
  } catch (error: unknown) {
    throw await rolledBack(slots, error);
  }
  return finalize(slots);
}

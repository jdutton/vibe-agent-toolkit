/**
 * The plan half of the tree-change primitive: every destructive verb describes
 * what it wants as {@link TreeChange}s, and {@link planTreeChanges} decides, with
 * no side effect, what will actually happen to each — before anything is written.
 *
 * The decisions, in order:
 *
 * 1. **What is there** at each destination (`lstat`; a destination the OS refuses
 *    to examine throws, classified `destination`; "absent" is believed only when
 *    the parent's listing agrees).
 * 2. **Keep.** A `remove` with nothing there, or whose `keepIfSameAs` names an
 *    entry that is `same` **or `unknown`** to it, is kept, with the reason. Only
 *    the target's own unexaminability throws, never a sibling's. A `remove` that
 *    holds a kept entry (or cannot be proven not to) is kept too: a kept entry is
 *    kept whole, never taken away with a directory above it.
 * 3. **Aliasing and containment, by identity.** A `remove` that is the same entry
 *    as a `replace` (`plugins/Old` and `plugins/old` on APFS or NTFS, a link and its
 *    target), or an earlier `remove`, or lies inside any other change's
 *    destination, is `subsumed`: that change parks it. `unknown` is never a merge
 *    and never a refusal — the two changes run as two, and a wrong guess fails the
 *    apply, which rolls back; refusing would refuse every change on a filesystem
 *    that reports `ino` 0. Any other two changes still active whose destinations
 *    are one entry or nest are refused ({@link TREE_DESTS_OVERLAP_CODE}): the
 *    calling verb's defect, never the user's input.
 * 4. **Ownership** of whatever is there: `must-be-free` refuses anything but an
 *    empty directory ({@link TREE_DEST_OCCUPIED_CODE}); `vat-made` refuses what its
 *    `recognise` disowns ({@link TREE_DEST_NOT_OWNED_CODE}); `force` and
 *    `vat-state` take anything.
 * 5. **Holding.** A `copy` source, or a `write` fill's declared `reads`, that is the
 *    destination or inside it ({@link TREE_DEST_HOLDS_SOURCE_CODE}: the replace
 *    would delete it), or that holds the destination
 *    ({@link TREE_SOURCE_HOLDS_DEST_CODE}: a copy into itself), is refused.
 * 6. **Readable source.** Every `copy` source is proven readable (the one
 *    special-file and link policy, `proveTreeReadable`, on the fill's declared `side`).
 *
 * Utils names no refusal code: these are library codes, and the CLI's refusal map
 * decides which refusal each is.
 */

import { lstatSync, readdirSync } from 'node:fs';

import { requireConfirmedAbsent } from '../errors/confirmed-absent.js';
import { isPathAbsentError } from '../errors/errno-table.js';
import { classifyFsFault, type FsSide, withFsFaultSync } from '../errors/fs-fault.js';
import { VatError } from '../errors/vat-error.js';
import { forEachInOrder } from '../in-order.js';
import { relativeEscapesRoot, safePath } from '../path-core.js';

import type { EntryContainment, EntrySameness } from './identity-compare.js';
import { identityOracle } from './identity.js';
import { proveTreeReadable } from './readable-tree.js';
import type { LinkPolicy } from './tree-walk.js';

/** A destination that must be absent or an empty directory already holds something. */
export const TREE_DEST_OCCUPIED_CODE = 'TREE_DEST_OCCUPIED';
/** A destination VAT may replace only when it made it holds something its recogniser disowns. */
export const TREE_DEST_NOT_OWNED_CODE = 'TREE_DEST_NOT_OWNED';
/**
 * Two changes of one plan whose destinations are one entry or nest (other than a remove the other
 * change takes with it): they cannot be one transaction — the outer park would carry the inner
 * change's staging away. The calling verb built a plan it must not, so it is VAT's defect.
 */
export const TREE_DESTS_OVERLAP_CODE = 'TREE_DESTS_OVERLAP';
/** A copy's destination lies inside its source: the copy would copy into itself. */
export const TREE_SOURCE_HOLDS_DEST_CODE = 'TREE_SOURCE_HOLDS_DEST';
/** A copy's source is its destination or lies inside it: the replace would delete what it copies. */
export const TREE_DEST_HOLDS_SOURCE_CODE = 'TREE_DEST_HOLDS_SOURCE';

/** What a recogniser says about a destination that is there. */
export type OwnershipVerdict = { readonly owned: true } | { readonly owned: false; readonly reason: string };

/** Who may lose whatever is at a destination. */
export type Ownership =
  /** Only an absent destination or an empty directory; anything else is refused. */
  | { readonly kind: 'must-be-free' }
  /** The user said `--force`: whatever is there may go. */
  | { readonly kind: 'force' }
  /** Something VAT made before, as `recognise` judges it; anything else is refused. */
  | { readonly kind: 'vat-made'; readonly recognise: (dest: string) => OwnershipVerdict }
  /** State VAT owns outright (a cache, a marketplace under `~/.claude`, `dist/`). */
  | { readonly kind: 'vat-state' };

/** How a replacement tree is made, in a staged place beside its destination. */
export type TreeFill =
  /**
   * `copy` copies `source` by the readable-tree walk. `side` is the side of the verb `source` is on — an input
   * (`source`), VAT's staging (`environment`), or a copy already made into user state (`destination`) — and
   * every read of it, by the proof and by the copy, is classified on it. Required: only the caller knows.
   */
  | { readonly from: 'copy'; readonly source: string; readonly side: FsSide; readonly links: LinkPolicy; readonly filter?: (relative: string) => boolean }
  /** `write` fills the empty staged directory; `reads` are the inputs it reads, held to the same holding check as a copy source. */
  | { readonly from: 'write'; readonly write: (staged: string) => Promise<void>; readonly reads?: readonly string[] }
  /** The staged entry is a link to `target` (a `--dev` lane). */
  | { readonly from: 'link'; readonly target: string };

/**
 * A `replace-file`'s bytes: given, or made when the file is staged. Staging runs in the plan's order, so a
 * function is called only after every earlier change of the plan has staged — a file made FROM a tree the
 * same plan stages (an archive of a staged bundle) is one change of that plan, not a second transaction.
 */
export type FileContents = string | Uint8Array | (() => string | Uint8Array);

/** One change a verb wants. `label` names it in the dry run and in every message. */
export type TreeChange =
  | { readonly op: 'replace'; readonly dest: string; readonly ownership: Ownership; readonly fill: TreeFill; readonly label: string }
  | { readonly op: 'replace-file'; readonly dest: string; readonly ownership: Ownership; readonly contents: FileContents; readonly label: string }
  | { readonly op: 'remove'; readonly dest: string; readonly ownership: Ownership; readonly keepIfSameAs?: () => readonly string[]; readonly label: string };

/** What is at a destination. */
export type EntryKind = 'absent' | 'directory' | 'file' | 'link' | 'special';

/** What will happen to a destination. */
export type PlannedAction = 'create' | 'replace' | 'remove' | 'keep' | 'subsumed';

/** One change, decided. */
export interface PlannedChange {
  readonly change: TreeChange;
  readonly existing: EntryKind;
  readonly action: PlannedAction;
  /** Why it is kept or subsumed. */
  readonly reason?: string;
  /**
   * Set on a remove kept because the OS refused to examine an entry it may be (its `keepIfSameAs`):
   * that entry. A caller that drops its own record of the kept entry names it, so the user can tell
   * what stayed and why (ruling R7 d-I-1: never delete what may BE a kept sibling).
   */
  readonly unexaminedSibling?: string;
}

/** Every change, decided; `describe()` is the dry run, one line per change. */
export interface TreePlan {
  readonly changes: readonly PlannedChange[];
  describe(): readonly string[];
}

/** The filesystem facts the planner decides by: live in {@link planTreeChanges}, faked in its unit test. */
export interface PlanFacts {
  /** What is at `dest`; throws when the OS refuses to examine it. */
  readonly existing: (dest: string) => EntryKind;
  readonly isEmptyDirectory: (dest: string) => boolean;
  readonly sameEntry: (a: string, b: string) => EntrySameness;
  readonly isInside: (child: string, ancestor: string) => EntryContainment;
  /** Throws when the OS refuses to examine `dest`'s identity: a remove's own unexaminability is never a keep. */
  readonly requireExaminable: (dest: string) => void;
  /** Whether the OS refuses to examine `entry`'s identity (an `unknown` that is a refusal, not a fold that cannot tell). */
  readonly refusesToExamine: (entry: string) => boolean;
}

function refusal(code: string, message: string): VatError {
  return new VatError(code, message);
}

/** Why a remove is kept — and the sibling the OS refused to examine, when that is why — or `undefined` when it goes ahead. */
function keepReason(change: TreeChange, existing: EntryKind, facts: PlanFacts): { reason: string; unexaminedSibling?: string } | undefined {
  if (change.op !== 'remove') return undefined;
  if (existing === 'absent') return { reason: 'nothing there' };
  const others = change.keepIfSameAs?.() ?? [];
  // The target's own refusal throws; only an OTHER entry's refusal is `unknown`, a keep.
  if (others.length > 0) facts.requireExaminable(change.dest);
  for (const other of others) {
    const verdict = facts.sameEntry(change.dest, other);
    if (verdict === 'same') return { reason: `${other} is the same entry` };
    if (verdict === 'unknown') {
      const reason = `could not tell whether ${other} is the same entry`;
      return facts.refusesToExamine(other) ? { reason, unexaminedSibling: other } : { reason };
    }
  }
  return undefined;
}

/** The kept entry `planned` (a remove) holds, or may hold: removing it would take that entry with it. */
function heldKeep(planned: PlannedChange, all: readonly PlannedChange[], facts: PlanFacts): PlannedChange | undefined {
  if (planned.action !== 'remove') return undefined;
  return all.find((other) => other !== planned && other.action === 'keep' && other.existing !== 'absent' && facts.isInside(other.change.dest, planned.change.dest) !== 'outside');
}

/**
 * Keep every remove that holds — or cannot be proven not to hold — a kept entry: a
 * kept entry is kept whole, never taken away with a directory above it. Repeated until
 * nothing changes, so a remove holding one that was just kept is kept as well.
 */
function keepingHolders(planned: readonly PlannedChange[], facts: PlanFacts): readonly PlannedChange[] {
  const next = planned.map((each): PlannedChange => {
    const held = heldKeep(each, planned, facts);
    return held === undefined ? each : { ...each, action: 'keep', reason: `holds ${held.change.dest}, which is kept` };
  });
  return next.some((each, index) => each !== planned[index]) ? keepingHolders(next, facts) : planned;
}

function initialAction(change: TreeChange, existing: EntryKind): PlannedAction {
  if (change.op === 'remove') return 'remove';
  return existing === 'absent' ? 'create' : 'replace';
}

/** Whether `other` takes `change`'s destination with it: the same entry as a replace or an earlier remove, or an ancestor of it. */
function subsumes(change: PlannedChange, index: number, other: PlannedChange, otherIndex: number, facts: PlanFacts): boolean {
  if (otherIndex === index || other.action === 'keep' || other.existing === 'absent') return false;
  const sameAllowed = other.change.op !== 'remove' || otherIndex < index;
  if (sameAllowed && facts.sameEntry(change.change.dest, other.change.dest) === 'same') return true;
  return facts.isInside(change.change.dest, other.change.dest) === 'inside';
}

function withSubsumption(planned: PlannedChange, index: number, all: readonly PlannedChange[], facts: PlanFacts): PlannedChange {
  if (planned.action !== 'remove') return planned;
  const by = all.find((other, otherIndex) => subsumes(planned, index, other, otherIndex, facts));
  return by === undefined ? planned : { ...planned, action: 'subsumed', reason: `parked by ${by.change.op} ${by.change.label}` };
}

/** Whether a planned change touches its destination (`keep` and `subsumed` do not). */
export const isActive = ({ action }: PlannedChange): boolean => action === 'create' || action === 'replace' || action === 'remove';

/**
 * Whether `inner`'s destination is `outer`'s or lies under it. Judged by identity where `outer`
 * exists; an absent destination has no identity, so there it is judged by the spelling.
 */
function holds(outer: PlannedChange, inner: PlannedChange, facts: PlanFacts): boolean {
  if (outer.existing === 'absent') return !relativeEscapesRoot(safePath.relative(outer.change.dest, inner.change.dest));
  return facts.sameEntry(inner.change.dest, outer.change.dest) === 'same' || facts.isInside(inner.change.dest, outer.change.dest) === 'inside';
}

/** Refuse two active changes over one tree: the plan is the calling verb's defect. `unknown` is never proof. */
function checkOverlap(planned: readonly PlannedChange[], facts: PlanFacts): void {
  const active = planned.filter((each) => isActive(each));
  for (const [index, first] of active.entries()) {
    const second = active.slice(index + 1).find((other) => holds(first, other, facts) || holds(other, first, facts));
    if (second !== undefined) {
      throw refusal(TREE_DESTS_OVERLAP_CODE, `${first.change.label} (${first.change.dest}) and ${second.change.label} (${second.change.dest}) change one tree; a plan may not overlap its own destinations`);
    }
  }
}

/** Refuse a destination its ownership does not let this change take. */
function checkOwnership(planned: PlannedChange, facts: PlanFacts): void {
  const { change, existing, action } = planned;
  if (existing === 'absent' || action === 'keep' || action === 'subsumed') return;
  const { ownership, dest, label } = change;
  // An empty directory is free for a tree that lands in its place, never for a FILE: a file
  // replacing a directory the user made (a folder they named as an output) is a surprise, not a fill.
  const freeDirectory = change.op !== 'replace-file' && existing === 'directory' && facts.isEmptyDirectory(dest);
  // The refusal says what this change would have done to the destination.
  const verb = change.op === 'remove' ? 'remove' : 'replace';
  if (ownership.kind === 'must-be-free' && !freeDirectory) {
    throw refusal(TREE_DEST_OCCUPIED_CODE, `${label}: ${dest} already holds something (a ${existing}); refusing to ${verb} it`);
  }
  if (ownership.kind === 'vat-made') {
    const verdict = ownership.recognise(dest);
    if (!verdict.owned) throw refusal(TREE_DEST_NOT_OWNED_CODE, `${label}: refusing to ${verb} ${dest}: ${verdict.reason}`);
  }
}

/** The inputs a replace reads, which its destination must neither be, hold, nor lie inside. */
function readsOf(change: TreeChange): readonly string[] {
  if (change.op !== 'replace') return [];
  if (change.fill.from === 'copy') return [change.fill.source];
  return change.fill.from === 'write' ? change.fill.reads ?? [] : [];
}

function checkHolding(planned: PlannedChange, facts: PlanFacts): void {
  if (planned.action !== 'create' && planned.action !== 'replace') return;
  const { dest, label } = planned.change;
  for (const source of readsOf(planned.change)) {
    if (facts.sameEntry(source, dest) === 'same' || facts.isInside(source, dest) === 'inside') {
      throw refusal(TREE_DEST_HOLDS_SOURCE_CODE, `${label}: ${source} is ${dest} or lies inside it, so replacing ${dest} would delete it`);
    }
    if (facts.isInside(dest, source) === 'inside') {
      throw refusal(TREE_SOURCE_HOLDS_DEST_CODE, `${label}: ${dest} lies inside ${source}, which it is made from`);
    }
  }
}

function describeChange({ change, action, reason }: PlannedChange): string {
  const line = `${action} ${change.label} ${change.dest}`;
  return reason === undefined ? line : `${line} (${reason})`;
}

/**
 * The pure planner: every decision of {@link planTreeChanges} but the source
 * proof, made from `facts`.
 *
 * @throws VatError coded `TREE_DESTS_OVERLAP` (a defect in the caller's plan), `TREE_DEST_OCCUPIED`,
 *   `TREE_DEST_NOT_OWNED`, `TREE_DEST_HOLDS_SOURCE` or `TREE_SOURCE_HOLDS_DEST`; whatever `facts` throws
 */
export function planFromFacts(changes: readonly TreeChange[], facts: PlanFacts): TreePlan {
  const drafted = changes.map((change): PlannedChange => {
    const existing = facts.existing(change.dest);
    const kept = keepReason(change, existing, facts);
    return kept === undefined ? { change, existing, action: initialAction(change, existing) } : { change, existing, action: 'keep', ...kept };
  });
  const kept = keepingHolders(drafted, facts);
  const planned = kept.map((draft, index) => withSubsumption(draft, index, kept, facts));
  checkOverlap(planned, facts);
  for (const each of planned) checkOwnership(each, facts);
  for (const each of planned) checkHolding(each, facts);
  return { changes: planned, describe: () => planned.map((each) => describeChange(each)) };
}

const EXAMINE_DEST = { side: 'destination', action: 'examine the destination' } as const;

function kindOf(dest: string): EntryKind {
  let stats;
  try {
    stats = lstatSync(dest);
  } catch (error: unknown) {
    if (!isPathAbsentError(error)) throw classifyFsFault(error, { ...EXAMINE_DEST, path: dest });
    // Absent only when the parent's listing agrees: a refused probe of an entry that is there is a fault.
    requireConfirmedAbsent(dest, error, EXAMINE_DEST, { follows: false });
    return 'absent';
  }
  if (stats.isSymbolicLink()) return 'link';
  if (stats.isDirectory()) return 'directory';
  return stats.isFile() ? 'file' : 'special';
}

/** The live facts of one plan: every identity question asks each entry once, so no two decisions see the filesystem differently. */
function liveFacts(): PlanFacts {
  const oracle = identityOracle();
  return {
    existing: kindOf,
    isEmptyDirectory: (dest) => withFsFaultSync({ side: 'destination', action: 'list the destination', path: dest }, () => readdirSync(dest).length === 0),
    sameEntry: oracle.sameEntry,
    isInside: oracle.isInside,
    requireExaminable: (dest) => {
      oracle.identities(dest);
    },
    refusesToExamine: (entry) => oracle.refuses(entry),
  };
}

/** Prove a copy source readable, as the copy will read it. */
function proveSource({ change, action }: PlannedChange): Promise<void> {
  if (change.op !== 'replace' || change.fill.from !== 'copy' || (action !== 'create' && action !== 'replace')) return Promise.resolve();
  const { source, links, side, filter } = change.fill;
  return proveTreeReadable(source, { links, side, ...(filter === undefined ? {} : { filter }) });
}

/**
 * Decide every change against the filesystem as it is, with no side effect. Each
 * destination is taken in its canonical spelling (`safePath.resolve`: absolute,
 * `.`/`..` resolved, forward slashes); `describe()` prints that spelling.
 * Hand the result to `applyTreePlan`; print `describe()` for a dry run — the two
 * cannot disagree, because the apply does exactly what the plan says.
 *
 * @param changes - What the verb wants, in the order it wants it
 * @throws VatError coded `TREE_DEST_OCCUPIED`, `TREE_DEST_NOT_OWNED`,
 *   `TREE_DEST_HOLDS_SOURCE` or `TREE_SOURCE_HOLDS_DEST`; `FsFaultError` side
 *   `destination` for a destination the OS refuses to examine, on the fill's
 *   declared side for a copy source it refuses to read
 */
export async function planTreeChanges(changes: readonly TreeChange[]): Promise<TreePlan> {
  // One canonical spelling of every destination (absolute, normalized, forward slashes), which the
  // plan, the dry run and the apply — down to the parents a create makes and removes — all use.
  const canonical = changes.map((change) => ({ ...change, dest: safePath.resolve(change.dest) }));
  const plan = planFromFacts(canonical, liveFacts());
  await forEachInOrder(plan.changes, proveSource);
  return plan;
}

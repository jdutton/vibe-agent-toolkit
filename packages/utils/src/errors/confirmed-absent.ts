/**
 * Believe "nothing there" only when the parent's listing agrees.
 *
 * A probe — a read, an `lstat` — that the OS answers with `ENOENT` or `ENOTDIR`
 * means absent only if it is right. Read as absent on its own word, a refusal of a
 * file that IS there turns a registry into an empty one and a destination into a
 * free one, and the write after it drops what was there. The parent's listing is a
 * second, independent witness: an entry it names is there, and the probe's answer
 * was a fault — except a link under a probe that follows links (a read), which
 * sees through it to a target that really is missing. An `lstat` sees the link
 * itself, so for it a listed link is a fault like any entry.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { isPathAbsentError } from './errno-table.js';
import { classifyFsFault, type FsFaultContext, refusedPathOf, type SideOfPath } from './fs-fault.js';

/**
 * The caller's action for a confirmation's fault, with no side of its own: the side is
 * `sideOf(<the path refused>)` — the listed parent's for a refused listing, the entry's for a
 * contradicted probe — never the side of the question the probe was answering.
 */
export type ConfirmationContext = Omit<FsFaultContext, 'side'> & { readonly side?: never };

/** How the probe that said "absent" looked, and whose each path it may touch is. */
export interface ConfirmationProbe {
  /** Whether the probe followed a link (a read, a `stat`) or saw it (`lstat`). */
  readonly follows: boolean;
  /** The side of each path: the entry, and the parent whose listing is the second witness. */
  readonly sideOf: SideOfPath;
}

/**
 * Confirm that nothing is at `entry` after a probe of it said "absent".
 *
 * @param entry - The path the probe examined
 * @param absent - What the probe threw (`ENOENT` / `ENOTDIR`)
 * @param ctx - The caller's action, for the fault
 * @param probe - How the probe looked, and the side of each path it may charge
 * @throws the probe's own error classified on `sideOf(entry)` (naming `entry`) when the parent
 *   lists it (a link only to a probe that does not follow); the listing's error classified on
 *   `sideOf(parent)` when the parent is there but cannot be listed — absence was never shown
 */
export function requireConfirmedAbsent(entry: string, absent: unknown, ctx: ConfirmationContext, probe: ConfirmationProbe): void {
  const parent = path.dirname(entry);
  let listed;
  try {
    listed = readdirSync(parent, { withFileTypes: true }).find((dirent) => dirent.name === path.basename(entry));
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return;
    throw classifyFsFault(error, { ...ctx, side: probe.sideOf(refusedPathOf(error, parent)), path: parent });
  }
  if (listed === undefined || (probe.follows && listed.isSymbolicLink())) return;
  throw classifyFsFault(absent, { ...ctx, side: probe.sideOf(entry), path: entry });
}

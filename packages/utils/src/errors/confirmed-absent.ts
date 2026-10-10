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
import { classifyFsFault, type FsFaultContext } from './fs-fault.js';

/**
 * Confirm that nothing is at `entry` after a probe of it said "absent".
 *
 * @param entry - The path the probe examined
 * @param absent - What the probe threw (`ENOENT` / `ENOTDIR`)
 * @param ctx - The caller's side and action, for the fault
 * @param probe - `follows`: whether the probe followed a link (a read, a `stat`) or saw it (`lstat`)
 * @throws the probe's own error classified on `ctx` (naming `entry`) when the parent
 *   lists it (a link only to a probe that does not follow); the listing's error
 *   classified on `ctx` when the parent is there but cannot be listed — absence was never shown
 */
export function requireConfirmedAbsent(entry: string, absent: unknown, ctx: FsFaultContext, probe: { readonly follows: boolean }): void {
  const parent = path.dirname(entry);
  let listed;
  try {
    listed = readdirSync(parent, { withFileTypes: true }).find((dirent) => dirent.name === path.basename(entry));
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return;
    throw classifyFsFault(error, { ...ctx, path: parent });
  }
  if (listed === undefined || (probe.follows && listed.isSymbolicLink())) return;
  throw classifyFsFault(absent, { ...ctx, path: entry });
}

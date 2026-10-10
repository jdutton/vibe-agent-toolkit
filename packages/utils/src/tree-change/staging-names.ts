/**
 * The names the tree-change primitive gives what it stages, parks and discards beside a
 * destination, and the two questions a listing asks of a name. Pure: no filesystem call.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { safePath } from '../path-core.js';

/** Every staged, parked or discarded entry is named `.<base>.vat-staged-<random>[suffix]` beside the destination. */
const STAGED_INFIX = '.vat-staged-';

/** What a previous entry is renamed to while its replacement goes in: `<staged>.previous`. */
export const PARKED_SUFFIX = '.previous';

/**
 * Whether a directory entry is the primitive's own: a staged tree, a parked
 * previous one, or a discarded one, left beside a destination by a crash or by a
 * removal the OS refused (`.<base>.vat-staged-<random>[.previous]`). A listing of
 * the directory a change sits in must never read one as a sibling it holds.
 *
 * @param name - A directory entry's name
 */
export function isTreeChangeResidue(name: string): boolean {
  return name.startsWith('.') && name.includes(STAGED_INFIX);
}

/**
 * Whether a directory entry is a PARKED previous entry: the one residue that is safe to sweep, since a
 * staged entry may be another process's change still in flight.
 *
 * @param name - A directory entry's name
 */
export function isParkedTreeEntry(name: string): boolean {
  return isTreeChangeResidue(name) && name.endsWith(PARKED_SUFFIX);
}

/** The `mkdtemp` prefix of a staged tree beside `dest`. */
export function stagingPrefix(dest: string): string {
  return safePath.join(path.dirname(dest), `.${path.basename(dest)}${STAGED_INFIX}`);
}

/** A fresh staging name beside `dest`, for an entry `mkdtemp` does not make: a file, a link, or a `write` fill's directory (made with the caller's mode). */
export function stagingName(dest: string): string {
  return `${stagingPrefix(dest)}${randomBytes(4).toString('hex')}`;
}

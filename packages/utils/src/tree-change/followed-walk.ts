/**
 * The two refusals that bound a walk which FOLLOWS links: a link back into the
 * walk ({@link FollowedWalk}, {@link DirectoryWalkRevisitedError}) and, for a walk
 * contained to a root, a link out of it ({@link CopyLinkEscapesSourceError}).
 * `proveTreeReadable` and `copyTree` under `links: 'follow-contained'` hold both;
 * every other following walk holds a {@link FollowedWalk}.
 */

import { classifyFsFault, type FsSide } from '../errors/fs-fault.js';
import { VatError } from '../errors/vat-error.js';
import { toForwardSlash } from '../path-core.js';
import { normalizePath } from '../path-utils.js';

/** The `VatError` code of a {@link DirectoryWalkRevisitedError}. */
export const DIRECTORY_WALK_REVISITED_CODE = 'DIRECTORY_WALK_REVISITED';

/** Thrown when a following walk is led back into a directory it has already entered. */
export class DirectoryWalkRevisitedError extends VatError {
  constructor(dir: string, enteredAs: string) {
    super(
      DIRECTORY_WALK_REVISITED_CODE,
      `Refusing to enter ${dir}: it is the directory already walked as ${enteredAs} — a symlink leads the walk back into itself.`,
    );
  }
}

/**
 * The directories a FOLLOWING walk has entered, by realpath, so a link that
 * leads back into the walk is refused instead of recursed until
 * `ENAMETOOLONG`.
 *
 * A walk that follows links (`direntKindFollowing`) has no cycle guard by
 * construction: `scripts/loop -> .` makes a copy create `dest/loop/loop/…`,
 * writing every file at every level first, and a hashing walk do the same in
 * memory. Every following walk holds one of these and calls {@link enter}
 * on every directory it recurses into — the root included. A REVISIT is
 * refused, not just a cycle: two links to one directory make the walk's
 * output ambiguous (which spelling is the file's path?), and a refusal that
 * names both spellings is the answer the author can act on.
 */
export class FollowedWalk {
  readonly #entered = new Map<string, string>();
  readonly #side: FsSide;

  /** @param side - The side of the verb the walked tree is on: a refused realpath in {@link enter} is a fault there */
  constructor(side: FsSide) {
    this.#side = side;
  }

  /**
   * Record that the walk is entering `dir`. Synchronous on purpose — one
   * realpath per directory entered is nothing beside the listing itself, and
   * the sync and async walkers then share one guard.
   *
   * @param dir - A directory the walk is about to list, in any spelling
   * @throws {DirectoryWalkRevisitedError} When its realpath was entered before
   * @throws FsFaultError on the walk's side (origin `content`) when the OS refuses to resolve it
   */
  enter(dir: string): void {
    const real = toForwardSlash(this.#realpath(dir));
    const before = this.#entered.get(real);
    if (before !== undefined) throw new DirectoryWalkRevisitedError(dir, before);
    this.#entered.set(real, dir);
  }

  #realpath(dir: string): string {
    try {
      return normalizePath(dir);
    } catch (error: unknown) {
      throw classifyFsFault(error, { side: this.#side, origin: 'content', action: `resolve ${dir}`, path: dir });
    }
  }
}

/** The `VatError` code of a {@link CopyLinkEscapesSourceError}. */
export const COPY_LINK_ESCAPES_SOURCE_CODE = 'COPY_LINK_ESCAPES_SOURCE';

/** Thrown when a link inside a tree walked with `links: 'follow-contained'` points outside it. */
export class CopyLinkEscapesSourceError extends VatError {
  constructor(link: string, src: string) {
    super(
      COPY_LINK_ESCAPES_SOURCE_CODE,
      `Refusing to copy ${link}: it is a symlink to a path outside ${src}. ` +
        'A copy follows links, so this would ship content the source tree does not own — ' +
        'replace the link with the files, or point it inside the tree.',
    );
  }
}

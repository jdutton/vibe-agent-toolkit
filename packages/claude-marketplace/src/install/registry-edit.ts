/**
 * One edit of Claude Code's registry files (`known_marketplaces.json`,
 * `installed_plugins.json`, `settings.json`) that an install or uninstall makes
 * beside its tree changes, as the `afterSwap` of their plan: the tree and the
 * registry must agree after any failure (invariant I7).
 *
 * Every new content is computed before the first write, from the bytes each file
 * held when the plan read it — and each file must still hold exactly those bytes when
 * the edit is applied, or the edit is refused with none of them written (another
 * program wrote the file meanwhile; its write is kept). Each file is replaced whole (`replaceFile`: a temp
 * beside it renamed over it), never truncated in place. A write that fails puts
 * back, newest first, every file already written — its prior bytes, or no file
 * where there was none — and rethrows, so the plan's rollback restores the tree
 * to match. A file that cannot be put back makes the error
 * `TREE_ROLLBACK_INCOMPLETE` (`TreeRollbackIncompleteError`), naming it: the registry then disagrees
 * with the restored tree, and the run must not read as a clean refusal.
 */

import fs from 'node:fs/promises';

import { forEachInOrder, FsFaultError, isPathAbsentError, mapInOrder, replaceFile, TreeRollbackIncompleteError, type TreeRollbackStranded, withFsFault } from '@vibe-agent-toolkit/utils';

/** One registry file: what it held when read (`undefined`: no file), and what it is to hold. */
export interface RegistryFileChange {
  readonly path: string;
  readonly prior: Buffer | undefined;
  readonly next: string;
}

/** The registry half of an install or uninstall: applied once its tree is in place, undone on its own failure. */
export interface RegistryEdit {
  /** The files it rewrites, in the order it writes them. */
  readonly files: readonly string[];
  /** Write every file; on a failure, restore each one written and rethrow (see the module comment). */
  apply(): Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Put one written file back as it was; the file, stranded with the new content, when it could not be. */
async function restore(change: RegistryFileChange): Promise<TreeRollbackStranded | undefined> {
  try {
    await (change.prior === undefined ? fs.rm(change.path, { force: true }) : replaceFile(change.path, change.prior));
    return undefined;
  } catch (refused: unknown) {
    return { dest: change.path, parked: undefined, why: `it could not be put back: ${messageOf(refused)}` };
  }
}

/** Restore every written file, newest first; the error to throw is `error`, or the one rollback-incomplete shape carrying it. */
async function restored(written: readonly RegistryFileChange[], error: unknown): Promise<unknown> {
  const stuck = (await mapInOrder(written.toReversed(), restore)).filter((each): each is TreeRollbackStranded => each !== undefined);
  return stuck.length === 0 ? error : new TreeRollbackIncompleteError(error, stuck);
}

/** What `path` holds now: its bytes, or `undefined` when no file is there. A read the OS refuses is thrown raw, for the caller's boundary. */
async function bytesNow(path: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path);
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return undefined;
    throw error;
  }
}

/**
 * Refuse an edit whose file no longer holds what the plan read — another install, or Claude Code
 * saving its settings, wrote it while the trees were staged. The edit's new content was computed
 * from the stale read, so writing it would drop what the other writer added, and a rollback would
 * put the stale bytes back over it. The table's `busy` destination fault: nothing is wrong with the
 * file, re-running reads it again.
 */
async function requireUnchanged(action: string, change: RegistryFileChange): Promise<void> {
  const now = await withFsFault({ side: 'destination', action, path: change.path }, () => bytesNow(change.path));
  const unchanged = now === undefined ? change.prior === undefined : change.prior?.equals(now) === true;
  if (unchanged) return;
  throw new FsFaultError({
    side: 'destination',
    faultClass: 'busy',
    errno: 'EBUSY',
    path: change.path,
    origin: 'argument',
    action: `${action}: the file was changed by another program after VAT read it, so it was left as that program wrote it and nothing was installed or removed`,
    cause: undefined,
  });
}

/**
 * The edit that makes each file in `changes` hold its `next` content.
 *
 * @param action - A verb phrase for a fault's message: `register plugin <key>`
 * @param changes - Every file, its prior bytes and its new content, computed before anything is written
 */
export function registryEdit(action: string, changes: readonly RegistryFileChange[]): RegistryEdit {
  return {
    files: changes.map((change) => change.path),
    async apply(): Promise<void> {
      const written: RegistryFileChange[] = [];
      // Every file is checked before the first is written: a refusal here has changed none of them.
      await forEachInOrder(changes, (change) => requireUnchanged(action, change));
      try {
        await forEachInOrder(changes, async (change) => {
          await withFsFault({ side: 'destination', action, path: change.path }, () => replaceFile(change.path, change.next));
          written.push(change);
        });
      } catch (error: unknown) {
        throw await restored(written, error);
      }
    },
  };
}

import { spawnSync } from 'node:child_process';

import { isProcessGoneError } from './errors/errno-table.js';

/** A spawned child, as {@link killProcessTree} needs it. */
export interface KillableChild {
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
}

/** How {@link killProcessTree} reaches the child's descendants, and whether it also goes through the child. */
export interface KillProcessTreeOptions {
  /**
   * POSIX: the child was spawned `detached`, so it leads a process group and the kill takes the
   * whole GROUP (the negated pid) — its grandchildren included. False: the child's pid alone (a
   * child that is not a leader has no group of its own to kill). Ignored on Windows, where
   * `taskkill /T` walks the tree from the child.
   */
  readonly groupLeader: boolean;
  /**
   * Also SIGKILL through `child.kill`, the call whose refusal Node reports as the child's `error`
   * event — for a caller that watches that event to retry or report a kill that did not land.
   */
  readonly throughChild: boolean;
}

/**
 * SIGKILL a child and every process it started — the ONE way VAT kills a process tree.
 *
 * - **POSIX**: the child's process group when it leads one (`groupLeader`), else its pid.
 * - **Windows**: `taskkill /T /F`, which terminates the child and its whole tree. Windows has no
 *   process groups, and `child.kill` there is `TerminateProcess` of the child alone.
 * - A child with no pid (never spawned) has nothing to kill. A kill whose target is already gone
 *   ({@link isProcessGoneError}) is absorbed; anything else the kill throws stays loud — a reaper
 *   that says nothing about a tree it did not reap leaves processes running unseen.
 *
 * @param child - The spawned child
 * @param options - See {@link KillProcessTreeOptions}
 */
export function killProcessTree(child: KillableChild, options: KillProcessTreeOptions): void {
  const { pid } = child;
  if (pid !== undefined) {
    if (process.platform === 'win32') {
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- taskkill is a fixed Windows system command (no PATH-injection surface); it is the only way to terminate a Windows process tree.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      killAbsorbingGone(options.groupLeader ? -pid : pid);
    }
  }
  if (options.throughChild) child.kill('SIGKILL');
}

/** SIGKILL `target` (a pid, or a negated group id); a target already gone has nothing left to kill. */
function killAbsorbingGone(target: number): void {
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    if (!isProcessGoneError(error)) throw error;
  }
}

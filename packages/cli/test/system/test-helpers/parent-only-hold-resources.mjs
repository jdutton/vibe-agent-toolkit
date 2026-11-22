/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process holds its
 * resources phase, on a FREE event loop, at its first `fs.promises.stat` of a path ending in
 * `VAT_TEST_PARENT_HOLD_STAT`, and creates `VAT_TEST_PARENT_HELD_FILE` as the hold begins.
 *
 * So a case can end the run in the middle of the resources phase, at the same point in both modes:
 * sequential, before any checks child exists; overlapped, with the child the gate spawned already
 * running. The resources phase stats each member after the home population has settled, so an
 * overlapped run's gate has already acted when the hold begins; the case still waits for the
 * child's pid file before it acts. The loop stays free (a timer, not `Atomics.wait`), so a signal
 * handler, the watchdog's timer or an uncaught throw from a timer runs at once: what the case
 * measures is the supervisor's handling, not the hold.
 *
 * The hold ends at {@link MAX_HOLD_MS}, a ceiling below the system tier's per-test timeout, and the
 * stat then goes ahead. With `VAT_TEST_PARENT_HOLD_UNTIL=child-exit` it ends earlier, as soon as
 * the OVERLAPPED checks child (one spawned with a file descriptor for its stderr) has exited, so an
 * ending of the child (the watchdog's kill included, which no `exit` handler of the child's own
 * sees) lands before the checks turn. A parent that sees fewer than two cores is sequential and
 * spawns no child during the resources phase: there it does not hold at all. `syncBuiltinESMExports()`
 * makes the named `node:fs/promises` and `node:child_process` imports the CLI uses see the patches.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

import { toForwardSlash } from '@vibe-agent-toolkit/utils/path';

import { onOverlappedSpawn } from './overlapped-spawn.mjs';

/** Ceiling on the hold, below the system tier's per-test timeout. */
const MAX_HOLD_MS = 60_000;
/** The one value `VAT_TEST_PARENT_HOLD_UNTIL` takes. */
const CHILD_EXIT = 'child-exit';

const suffix = process.env['VAT_TEST_PARENT_HOLD_STAT'];
const heldFile = process.env['VAT_TEST_PARENT_HELD_FILE'];
const until = process.env['VAT_TEST_PARENT_HOLD_UNTIL'];

/** Wait on a timer, so the loop stays free. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.argv.includes('--supervised-by')) {
  if (suffix === undefined || heldFile === undefined) {
    throw new Error('parent-only-hold-resources.mjs needs VAT_TEST_PARENT_HOLD_STAT and VAT_TEST_PARENT_HELD_FILE');
  }
  if (until !== undefined && until !== CHILD_EXIT) {
    throw new Error(`parent-only-hold-resources.mjs: VAT_TEST_PARENT_HOLD_UNTIL is '${CHILD_EXIT}' or unset, not '${until}'`);
  }
  // Whether the overlapped child has exited, and what a hold in progress runs when it does.
  let childExited = false;
  let releaseHold = () => undefined;
  if (until === CHILD_EXIT) {
    onOverlappedSpawn((child) => child.once('exit', () => {
      childExited = true;
      releaseHold();
    }));
  }
  const hold = () => {
    if (until !== CHILD_EXIT) return delay(MAX_HOLD_MS);
    if (os.availableParallelism() < 2) return Promise.resolve();
    return new Promise((resolve) => {
      const ceiling = setTimeout(resolve, MAX_HOLD_MS);
      releaseHold = () => {
        clearTimeout(ceiling);
        resolve();
      };
      if (childExited) releaseHold();
    });
  };
  const stat = fs.promises.stat;
  let held = false;
  fs.promises.stat = async (path, ...rest) => {
    if (!held && toForwardSlash(String(path)).endsWith(suffix)) {
      held = true;
      fs.writeFileSync(heldFile, '', 'utf-8');
      await hold();
    }
    return stat(path, ...rest);
  };
  syncBuiltinESMExports();
}

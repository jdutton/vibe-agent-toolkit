/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): in the SUPERVISING process, one member
 * becomes unreadable AFTER the checks overlap gate judged it admitted from the store: its warm
 * admission's readability probe (the first `fs/promises` `open` of the file whose path ends with
 * `VAT_TEST_PARENT_PROBE_REFUSED`) is refused with `EACCES`. The run keeps that refusal as the
 * member's one answer, so no later lane opens it again; a later open would succeed.
 *
 * - When the parent reports two or more cores (overlap expected), the probe is held until the
 *   overlapped checks child has been spawned, so the refusal lands after the gate, never before it.
 *   A sequential run spawns at its turn, after the resources phase, so it is not held.
 * - At the checks banner the parent creates `VAT_TEST_CHILD_RELEASE_FILE`, which the child holds for
 *   (`child-only-stderr-marker.mjs`): so the child is still running while the parent finishes its
 *   lanes, and the post-spawn window the debug facts report covers any write they make.
 * - `VAT_TEST_PARENT_PROBE_TRACE`: `refused` is appended there when the refusal fires, so the case can
 *   tell the fault was injected.
 *
 * `syncBuiltinESMExports()` makes the named `open` import of `node:fs/promises` and the named `spawn`
 * import see the patches.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

import { toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';

/** Ceiling on the hold, below the system tier's per-test timeout. */
const MAX_HOLD_MS = 30_000;

const suffix = process.env['VAT_TEST_PARENT_PROBE_REFUSED'];
const trace = process.env['VAT_TEST_PARENT_PROBE_TRACE'];
const release = process.env['VAT_TEST_CHILD_RELEASE_FILE'];

if (!process.argv.includes('--supervised-by') && suffix !== undefined && trace !== undefined && release !== undefined) {
  const spawned = Promise.withResolvers();
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, ...rest) => {
    if (Array.isArray(args) && args.includes('--supervised-by')) spawned.resolve(undefined);
    return spawn(command, args, ...rest);
  };

  const open = fsp.open;
  let refused = false;
  fsp.open = async (path, ...rest) => {
    if (!refused && toForwardSlashAnyPlatform(String(path)).endsWith(`/${suffix}`)) {
      refused = true;
      if (os.availableParallelism() >= 2) {
        const ceiling = new Promise((resolve) => setTimeout(resolve, MAX_HOLD_MS).unref());
        await Promise.race([spawned.promise, ceiling]);
      }
      fs.appendFileSync(trace, 'refused\n', 'utf-8');
      throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: 'EACCES', syscall: 'open', path: String(path) });
    }
    return open(path, ...rest);
  };

  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).includes('▶ Surface: checks')) fs.writeFileSync(release, '', 'utf-8');
    return write(chunk, ...rest);
  };
  syncBuiltinESMExports();
}

/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process, right after it
 * spawns an OVERLAPPED checks child (one whose stderr is a file descriptor, not `'inherit'`),
 * blocks its thread until `VAT_TEST_PARENT_AWAIT_FILE` exists.
 *
 * So an overlapped child is known to have done what the case waits for (written its marker,
 * exited) before the parent reaches the checks turn: what the turn finds in `stderr.log` no longer
 * depends on how fast the resources phase ran. A sequential child is spawned with `'inherit'` and
 * never waited for, so the preload is inert in the sequential arm.
 *
 * `Atomics.wait` between looks for the file, with {@link MAX_HOLD_MS} as a ceiling; the named
 * `spawn` import the supervisor uses sees the patch through `syncBuiltinESMExports()`.
 *
 * `VAT_TEST_PARENT_TURN_TRACE`: when the parent writes the checks banner (its turn), it appends how
 * many progress directories (`vat-check-*` in its temp directory) then hold a `stderr.log`. An
 * overlapped child's directory must outlive the child until the turn has copied it: one that went
 * at the child's exit leaves nothing for the turn, even where an open read fd still reaches the
 * unlinked file.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import { onOverlappedSpawn } from './overlapped-spawn.mjs';

/** Ceiling on the hold, below the system tier's per-test timeout. */
const MAX_HOLD_MS = 60_000;
/** One synchronous wait between looks for the file. */
const SLICE_MS = 20;

const awaited = process.env['VAT_TEST_PARENT_AWAIT_FILE'];
const turnTrace = process.env['VAT_TEST_PARENT_TURN_TRACE'];

/** How many progress directories in this process's temp directory hold a `stderr.log` now. */
function heldStderrLogs() {
  const tmp = normalizedTmpdir();
  return fs.readdirSync(tmp)
    .filter((name) => name.startsWith('vat-check-') && fs.existsSync(safePath.join(tmp, name, 'stderr.log'))).length;
}

if (!process.argv.includes('--supervised-by') && awaited !== undefined && turnTrace !== undefined) {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).includes('▶ Surface: checks')) fs.appendFileSync(turnTrace, `${String(heldStderrLogs())}\n`, 'utf-8');
    return write(chunk, ...rest);
  };

  onOverlappedSpawn(() => {
    const slot = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + MAX_HOLD_MS;
    while (!fs.existsSync(awaited) && Date.now() < deadline) Atomics.wait(slot, 0, 0, SLICE_MS);
  });
  syncBuiltinESMExports();
}

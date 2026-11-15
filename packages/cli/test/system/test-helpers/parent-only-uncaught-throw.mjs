/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process throws an
 * UNCAUGHT error from a timer of its own — nowhere near the watchdog poll, whose throws the
 * supervisor catches — once the file `TEST_PARENT_THROW_FILE` exists.
 *
 * The CLI's last-resort handler (`installLastResortExit`) ends the process on that throw with
 * `process.exit`, which no signal handler sees: so the case reaches the supervisor's `exit` guard
 * alone. The case creates the file when it is ready — the child stalled (see
 * `child-only-stall-in-population.mjs`) and its positive controls taken — so the throw lands
 * while the child is supervised, and never before the case can observe it alive.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import fs from 'node:fs';

const trigger = process.env['TEST_PARENT_THROW_FILE'];

if (!process.argv.includes('--supervised-by') && trigger !== undefined) {
  const watch = setInterval(() => {
    if (!fs.existsSync(trigger)) return;
    clearInterval(watch);
    throw new Error('test-only: an uncaught throw in the supervising process, outside the watchdog poll');
  }, 50);
  // Never what keeps a process alive: a run that ends before the trigger appears ends.
  watch.unref();
}

/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): on SIGUSR2, the SUPERVISING process
 * blocks its event loop for `TEST_PARENT_BLOCK_MS` (`Atomics.wait`), so a case can deliver signals
 * while no JavaScript listener can run, as a busy event loop leaves them: the kernel delivers each
 * signal to Node's C handler at once, and its listeners run only once the loop turns.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
const block = Number(process.env['TEST_PARENT_BLOCK_MS']);

if (!process.argv.includes('--supervised-by')) {
  if (!Number.isFinite(block) || block <= 0) throw new Error('parent-only-block-on-usr2.mjs needs TEST_PARENT_BLOCK_MS');
  process.on('SIGUSR2', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, block);
  });
}

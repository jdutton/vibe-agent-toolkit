/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process's FIRST stderr
 * write that contains `VAT_TEST_PARENT_THROW_ON_STDERR` throws a plain `Error`.
 *
 * Aimed at a line the resources phase prints for its own finding, it is a throw inside that phase
 * that is not a run refusal: the phase is published as refused and the run goes on to the checks
 * turn. Only the first such write throws, so the same text replayed later (the checks child's own
 * stderr, when overlapped) is written.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
const needle = process.env['VAT_TEST_PARENT_THROW_ON_STDERR'];

if (!process.argv.includes('--supervised-by') && needle !== undefined) {
  const write = process.stderr.write.bind(process.stderr);
  let thrown = false;
  process.stderr.write = (chunk, ...rest) => {
    if (!thrown && String(chunk).includes(needle)) {
      thrown = true;
      throw new Error('test-only: a stderr write in the supervising process threw');
    }
    return write(chunk, ...rest);
  };
}

/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD prefixes every stderr write with `[checks child] `, so a case reading the run's (shared)
 * stderr can tell WHICH process printed a line — the child inherits its supervisor's stderr.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
const CHILD_TAG = '[checks child] ';

if (process.argv.includes('--supervised-by')) {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => write(`${CHILD_TAG}${String(chunk)}`, ...rest);
}

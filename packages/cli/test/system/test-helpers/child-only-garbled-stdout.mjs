/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD prefixes its stdout with one stray line, so a run that completed its population publishes
 * a document its parent cannot parse.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
if (process.argv.includes('--supervised-by')) {
  const write = process.stdout.write.bind(process.stdout);
  let garbled = false;
  process.stdout.write = (chunk, ...rest) => {
    if (!garbled) {
      garbled = true;
      write('stray line before the document\n');
    }
    return write(chunk, ...rest);
  };
}

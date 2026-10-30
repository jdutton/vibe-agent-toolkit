/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD publishes its document as usual and then exits 3 where that document implies 0 — so the
 * supervisor sees a whole, valid, clean report beside an exit code that contradicts it.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
if (process.argv.includes('--supervised-by')) {
  const exit = process.exit.bind(process);
  process.exit = (code) => exit(code === 0 || code === undefined ? 3 : code);
}

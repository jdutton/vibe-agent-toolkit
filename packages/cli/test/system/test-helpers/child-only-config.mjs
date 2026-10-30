/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD reads its config from `TEST_CHILD_ONLY_CONFIG` (through `VAT_TEST_CONFIG`, the config
 * loader's own override) while its parent reads the project's — so the child alone can be handed a
 * config it refuses.
 *
 * Acts only in the process whose argv carries `--cost-log` (the supervised child). VAT's source
 * gains no knob for this.
 */
const childConfig = process.env['TEST_CHILD_ONLY_CONFIG'];

if (process.argv.includes('--cost-log') && childConfig !== undefined) {
  process.env['VAT_TEST_CONFIG'] = childConfig;
}

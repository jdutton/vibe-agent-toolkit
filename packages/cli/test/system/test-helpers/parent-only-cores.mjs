/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process reports
 * `VAT_TEST_CORES` from `os.availableParallelism()`, so one build of `vat validate` can be run
 * overlapped (2) and sequential (1) on the same machine, with the core count the only variable.
 *
 * The checks overlap gate reads `os.availableParallelism()` at its call through the `node:os`
 * default export; `syncBuiltinESMExports()` makes a named ESM import see the patch too. The CHILD
 * is left alone: its parse pool is pinned by `VAT_PARSE_POOL_SIZE` in both arms, and the core
 * count it sees must not differ between them.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

const cores = Number(process.env['VAT_TEST_CORES']);

if (!process.argv.includes('--supervised-by')) {
  if (!Number.isInteger(cores) || cores < 1) throw new Error('parent-only-cores.mjs needs VAT_TEST_CORES, a positive integer');
  os.availableParallelism = () => cores;
  syncBuiltinESMExports();
}

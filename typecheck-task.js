/**
 * Every cached typecheck task: `node typecheck-task.js <tsconfig>` runs `tsc --noEmit -p <tsconfig>`
 * in the current directory, after the same build guard a package lint passes
 * (`programTaskRefusal()` in `eslint-config-support.js`). Turbo keys a typecheck on the emitted
 * declarations and has no `dependsOn`, so a run without the root `typecheck` script's build would
 * check against a stale `dist/` and cache the verdict. Run it only through `bun run typecheck`.
 *
 * A refusal throws, as `eslint.config.js` does for a lint, and the process exits non-zero; tsc's own
 * exit status is passed through unchanged.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { missingDeclaredTypes, programTaskRefusal } from './eslint-config-support.js';

const [project, ...extra] = process.argv.slice(2);
if (project === undefined || extra.length > 0) {
  throw new Error('Usage: node typecheck-task.js <tsconfig>');
}
const refusal = programTaskRefusal('typecheck', process.env, missingDeclaredTypes);
if (refusal !== undefined) throw new Error(refusal);

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project], { stdio: 'inherit' });
if (result.error !== undefined) throw result.error;
if (result.status === null) throw new Error(`tsc was ended by ${result.signal ?? 'a signal'}`);
process.exitCode = result.status;

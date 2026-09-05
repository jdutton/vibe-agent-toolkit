/**
 * Where the built vat CLI entry is, for the commands that re-invoke it as a
 * child process.
 *
 * ## 🪤 `dist/bin.js`, deliberately NOT `dist/bin/vat.js`
 *
 * `packages/lab/src/harness/instrument.ts` documents `dist/bin/vat.js` as a
 * re-resolving WRAPPER: it looks the CLI up again at run time, so spawning it
 * can execute a different build than the one the caller is running from. A
 * supervisor that thinks it is bounding its own code, and a corpus runner that
 * thinks it is auditing with its own validators, both need the entry point that
 * cannot be redirected.
 *
 * ## Why the two branches
 *
 * `node` cannot execute `.ts`, so a caller running from SOURCE under vitest
 * still has to reach the COMPILED entry — which is why the source-tree branch
 * walks across to `packages/cli/dist/bin.js` rather than to a sibling. A build
 * is therefore a precondition for every test that spawns the CLI, and a system
 * test that skipped it would prove things about a stale `dist`.
 *
 * 🪤 Shared rather than copied. This resolution lived inline in
 * `commands/corpus/runner.ts` and a second caller wanted it; a second copy is a
 * duplication-gate failure under this repo's zero-tolerance policy, and — worse
 * — two copies drift, so one caller would keep spawning the wrapper long after
 * the other stopped. The `__dirname`-relative hops below are correct for THIS
 * module's location and nothing else, which is precisely why it is not a snippet
 * to paste.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the path to the built vat CLI entry.
 *
 * @returns An absolute path to `dist/bin.js`
 */
export function resolveVatBinPath(): string {
  // Compiled tree: packages/cli/dist/utils/vat-bin-path.js → packages/cli/dist/bin.js
  const compiled = safePath.resolve(HERE, '../bin.js');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- internal path
  if (existsSync(compiled)) return compiled;
  // Source tree (vitest): packages/cli/src/utils/vat-bin-path.ts → packages/cli/dist/bin.js
  return safePath.resolve(HERE, '../../dist/bin.js');
}

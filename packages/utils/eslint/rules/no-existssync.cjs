/**
 * ESLint rule: no-existssync
 *
 * In product source, flags every use of `existsSync` from `node:fs` / `fs`:
 * a named import (aliased too) that is called or handed on as a value, a
 * namespace, default, `require()` or `await import()` binding read as
 * `fs.existsSync`, the same read straight off the loading expression
 * (`require('node:fs').existsSync`, `(await import('node:fs')).existsSync`), a
 * destructure of it out of any of those, and a re-export.
 *
 * `existsSync` answers `false` for `ENOENT` — and equally for `EACCES` (a
 * parent the process may not search), `ELOOP` and every other errno. So a
 * path the OS would not let VAT look at reads as "absent", and the run goes on
 * as if it were: a LICENSE is skipped, a manifest is "not found", a plugin
 * directory is missing. The replacement asks the one errno classifier:
 * `pathPresent(path, mode, sideOf, absence)` from `@vibe-agent-toolkit/utils` answers
 * `false` only for an absence, and throws every other errno as a classified
 * `FS_FAULT` on the caller's side.
 *
 * ## Scope
 *
 * Product source: a file under `packages/<pkg>/src/` that is not itself a test
 * file. Tests and test-support (`packages/<pkg>/test/`) are not linted — a
 * fixture asking whether its own scratch file exists is not a run deciding
 * what to do. Like `no-io-in-unit-tier`, the layout is this repo's, which is
 * why the rule is not in `configs.recommended`.
 *
 * ## The floor — what this rule cannot see
 *
 * It follows bindings through scope, not values through data flow:
 * - an fs namespace copied first (`const f = fs; f.existsSync(p)`) or passed
 *   as an argument;
 * - `import('node:fs').then((fs) => fs.existsSync(p))`, and a `require`
 *   built by `createRequire`;
 * - a project module that re-exports it under another name is caught at its
 *   own `export { existsSync } from 'node:fs'`, not at the importers of that
 *   module.
 *
 * Option `allowFiles: string[]` — repo-relative paths of today's offenders,
 * the ratchet. Name files, never directories.
 *
 * @example
 * // BAD — an EACCES parent reads as "no manifest"
 * if (!existsSync(manifestPath)) return emptyInventory();
 *
 * // GOOD — absent is false; a refused stat throws a classified FS_FAULT
 * if (!pathPresent(manifestPath, { follow: pluginDir }, everywhere('source'), 'probe')) return emptyInventory();
 */

'use strict';

const { productSourceFsBan } = require('./fs-binding-scan.cjs');

module.exports = productSourceFsBan({
  docs: {
    description:
      'Disallow existsSync from node:fs in product source — it answers false for a path it could not ' +
      'look at (EACCES, ELOOP) exactly as for one that is not there',
    bans: '`existsSync()` from `node:fs` — called, handed on, destructured or re-exported — under `packages/*/src/`',
    useInstead: '`pathPresent(path, mode, sideOf, absence)` (absent only on an absence; every other errno a classified `FS_FAULT`)',
  },
  messageId: 'existsSync',
  message:
    'existsSync answers false for a path it could not look at (EACCES, ELOOP) exactly as for one that is ' +
    'not there, so "could not look" goes on as "absent". Use pathPresent(path, mode, sideOf, absence) from ' +
    '@vibe-agent-toolkit/utils: false only for an absence, every other errno a classified FS_FAULT.',
  modules: new Set(['node:fs', 'fs']),
  banned: new Set(['existsSync']),
  untyped: null,
});

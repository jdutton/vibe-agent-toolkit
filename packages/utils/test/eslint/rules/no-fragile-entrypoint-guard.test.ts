import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/**
 * Both halves are about a guard that answers `false` for the script it was asked
 * to run, so the process exits 0 having executed nothing.
 *
 * - `import.meta.main` is `undefined` before Node 24.2 / 22.18 — measured
 *   `undefined` on a real 22.13.0, which is a floor this repo declares.
 * - `import.meta.url === pathToFileURL(process.argv[1]).href` is a raw string
 *   compare with no realpath, so it is `false` whenever the script was reached
 *   through a symlink (every `node_modules/.bin` shim). Measured false on both
 *   22.14.0 and 24.13.1.
 *
 * The VALID rows carry the weight: `import.meta.url` and `import.meta.dirname`
 * must stay untouched, and a `pathToFileURL(...).href` that is not being
 * compared to `import.meta.url` is just a URL.
 */
const CASES: RuleCases = {
  valid: [
    { code: 'if (isEntrypoint(import.meta.url)) { run(); }' },
    { code: 'const u = import.meta.url;' },
    { code: 'const d = import.meta.dirname;' },
    { code: 'const f = import.meta.filename;' },
    // A property named `main` on something that is not `import.meta`.
    { code: 'const m = pkg.main;' },
    { code: 'const m = meta.main;' },
    // `pathToFileURL(...).href` on its own is just a URL.
    { code: 'const h = pathToFileURL(p).href;' },
    // Compared against something other than `import.meta.url`.
    { code: 'if (recorded === pathToFileURL(process.argv[1]).href) { run(); }' },
    // `import.meta.url` compared against something that is not a file URL built
    // from argv — a cache key, a manifest entry.
    { code: 'if (import.meta.url === entry.href) { run(); }' },
    // `fileURLToPath` of something that is NOT this module's own URL.
    { code: 'if (fileURLToPath(specifier) === process.argv[1]) { run(); }' },
    // An ordinary CLI argument. `argv[2]` and up are not the invoked script, so
    // comparing one to anything is not this defect — the index is the whole
    // difference and the rule has to keep it.
    { code: 'if (fileURLToPath(import.meta.url) === process.argv[2]) { run(); }' },
    // Reading argv[1] without comparing it to where this module lives.
    { code: 'const entry = process.argv[1];' },
    { code: "if (process.argv[1] === '--help') { run(); }" },
  ],
  invalid: [
    { code: 'if (import.meta.main) { run(); }', errors: [{ messageId: 'importMetaMain' }] },
    { code: 'function m() { if (!import.meta.main) { return; } }', errors: [{ messageId: 'importMetaMain' }] },
    { code: 'export const isMain = import.meta.main;', errors: [{ messageId: 'importMetaMain' }] },
    {
      code: 'if (import.meta.url === pathToFileURL(process.argv[1]).href) { run(); }',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    // Reversed operands — the same question, and a rule keyed on operand order
    // would be half blind.
    {
      code: 'if (pathToFileURL(process.argv[1]).href === import.meta.url) { run(); }',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    // The `!==` spelling, and the guarded-argv variant that `import-marketplace.ts`
    // actually shipped.
    {
      code: 'function m() { if (import.meta.url !== pathToFileURL(process.argv[1]).href) { return; } }',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    {
      code: 'const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    // Namespace-imported `url.pathToFileURL`, which a callee-identifier-only
    // matcher would miss.
    {
      code: 'if (import.meta.url === url.pathToFileURL(process.argv[1]).href) { run(); }',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    // The PATH-space spelling of the identical defect. Same missing realpath
    // pass, same silent false through a `.bin` shim — the comparison is simply
    // performed after converting the module URL to a path instead of before
    // converting the invoked path to a URL. A rule that only knew the URL-space
    // form would be a mechanism with a hole in its own premise.
    {
      code: 'if (fileURLToPath(import.meta.url) === process.argv[1]) { run(); }',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    {
      code: 'if (process.argv[1] === fileURLToPath(import.meta.url)) { run(); }',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    {
      code: 'function m() { if (url.fileURLToPath(import.meta.url) !== process.argv[1]) { return; } }',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
    // `const { argv } = process` — the same operand, one destructure removed.
    {
      code: 'const isMain = fileURLToPath(import.meta.url) === argv[1];',
      errors: [{ messageId: 'rawEntrypointCompare' }],
    },
  ],
};

describe('no-fragile-entrypoint-guard', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-fragile-entrypoint-guard', CASES); });
});

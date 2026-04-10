/**
 * ESLint rule: no-fs-promises-cp
 *
 * Prevents usage of cp() from node:fs/promises in favor of cpSync() from node:fs.
 *
 * Why: Node 22's async cp() with { recursive: true } silently drops files in
 * nested directories (observed with .mjs files in deeply nested paths).
 * The files are simply missing from the destination with no error thrown.
 * cpSync() from node:fs does not have this bug and works correctly across
 * all Node versions (22, 24+).
 *
 * This is a known Node.js issue, not a VAT bug. Until the Node.js team fixes
 * the async cp() implementation, cpSync() is the safe default.
 *
 * If you need async cp() for a specific use case and have verified it works
 * correctly with your file structure, disable this rule with an eslint-disable
 * comment explaining why async is required.
 *
 * Auto-fix: Replaces cp() with cpSync() and updates import from node:fs/promises to node:fs.
 */

const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'cp',
  unsafeModule: 'node:fs/promises',
  safeFn: 'cpSync',
  safeModule: 'node:fs',
  message:
    'Use cpSync() from node:fs instead of cp() from node:fs/promises. ' +
    'Node 22 async cp({ recursive: true }) silently drops files in nested directories. ' +
    'cpSync() works correctly across all Node versions.',
});

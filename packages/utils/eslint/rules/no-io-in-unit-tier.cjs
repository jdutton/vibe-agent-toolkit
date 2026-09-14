/**
 * ESLint rule: no-io-in-unit-tier
 *
 * In a UNIT-tier test file, flags an import of `node:child_process` /
 * `child_process` and any call to `mkdtemp`, `mkdtempSync`, `spawn`,
 * `spawnSync`, `execSync` or `execFileSync` — bare or through a namespace.
 *
 * The tiers are a promise about cost and about what is being tested: a unit
 * test exercises logic and finishes in milliseconds; an integration test
 * wires real components; a system test runs the real binary. A `*.test.ts`
 * that spawns `git` or mints a temp directory has silently moved tiers
 * without moving files — it runs under the unit budget, it is coverage-
 * instrumented as if it were pure, and it is the first thing to flake on a
 * loaded CI runner. The audit measured the class at 93 unit files touching
 * the real filesystem and 5 spawning real processes. Moving a file to the
 * tier it belongs to is a rename; this rule makes the rename happen at the
 * desk rather than in a 53-second package run.
 *
 * ## The tier boundary, as this rule reads it
 *
 * A file is unit-tier when it is a test file (`*.test.ts` and friends) under
 * `packages/<pkg>/test/` at any depth, EXCEPT when it sits under an
 * `integration/` or `system/` directory or carries the `.integration.test.`
 * / `.system.test.` suffix. Helpers (`test-helpers.ts`) are not test files
 * and are not checked here; a helper that spawns is caught at the unit file
 * that calls it only if the call is visible there, which is a known floor.
 *
 * Option `allowFiles: string[]` — repo-relative paths of today's offenders,
 * the ratchet. Name files, never directories.
 *
 * @example
 * // BAD in packages/x/test/thing.test.ts — a system test wearing a unit name
 * const out = spawnSync('node', [bin, '--json']);
 *
 * // GOOD — same code, in packages/x/test/system/thing.system.test.ts
 */

'use strict';

const { calleeName } = require('./callee-name.cjs');
const { createExemptPathMatcher, isTestFile } = require('./exempt-path-matcher.cjs');

const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process']);
const IO_CALLS = new Set(['mkdtemp', 'mkdtempSync', 'spawn', 'spawnSync', 'execSync', 'execFileSync']);

/** `packages/<pkg>/test/` anywhere in the path, with either separator already normalised. */
const PACKAGE_TEST_DIR = /(?:^|\/)packages\/[^/]+\/test\//u;

/** The integration and system tiers, by directory or by suffix. */
const OTHER_TIER = /\/(?:integration|system)\/|\.(?:integration|system)\.test\./u;

/** Whether `filename` is a unit-tier test file under a package's `test/`. */
function isUnitTierFile(filename) {
  if (!filename) {
    return false;
  }
  const normalized = String(filename).replaceAll('\\', '/');
  return isTestFile(normalized) && PACKAGE_TEST_DIR.test(normalized) && !OTHER_TIER.test(normalized);
}

/** The banned callee name of a call, bare (`spawn(…)`) or namespaced (`cp.spawn(…)`), or null. */
function bannedCallName(call) {
  const name = calleeName(call);
  return name !== null && IO_CALLS.has(name) ? name : null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow child_process imports and mkdtemp/spawn/exec calls in unit-tier test files — ' +
        'a test that spawns or writes to disk belongs in the integration or system tier',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      childProcessImport:
        "A unit-tier test imports '{{source}}': spawning a process is integration or system work. " +
        'Move the file to test/integration/ (*.integration.test.ts) or test/system/ ' +
        '(*.system.test.ts), or mock the module.',
      ioCall:
        'A unit-tier test calls {{name}}(): real processes and temp directories belong to the ' +
        'integration or system tier. Move the file to that tier, or test the logic without the I/O.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const isAllowed = createExemptPathMatcher(context.options?.[0]?.allowFiles ?? []);
    if (!isUnitTierFile(filename) || isAllowed(filename)) {
      return {};
    }

    function checkModule(node, sourceNode) {
      const source = sourceNode?.type === 'Literal' ? sourceNode.value : null;
      if (typeof source === 'string' && CHILD_PROCESS_MODULES.has(source)) {
        context.report({ node, messageId: 'childProcessImport', data: { source } });
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind !== 'type') {
          checkModule(node, node.source);
        }
      },
      ImportExpression(node) {
        checkModule(node, node.source);
      },
      CallExpression(node) {
        const name = bannedCallName(node);
        if (name !== null) {
          context.report({ node, messageId: 'ioCall', data: { name } });
        }
      },
    };
  },
};

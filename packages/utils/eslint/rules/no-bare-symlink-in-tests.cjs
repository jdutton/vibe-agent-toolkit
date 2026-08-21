/**
 * ESLint rule: no-bare-symlink-in-tests
 *
 * Bans `fs.symlinkSync()` / `fs.promises.symlink()` in test files, in favor of
 * `createSymlink()` / `createSymlinkAsync()` from `@vibe-agent-toolkit/utils`.
 *
 * Why: creating a symlink on Windows needs Developer Mode or
 * `SeCreateSymbolicLinkPrivilege`, which most dev boxes and CI agents lack. A
 * bare `symlinkSync()` call throws `EPERM` there with no visible skip — the
 * test just fails, or (worse) the failure is masked by a `try`/`catch` that
 * swallows it silently. `createSymlink()`/`createSymlinkAsync()` require a
 * `SymlinkCapability` token as their first argument, and the only way to mint
 * one is `symlinkCapability()`, which performs the real probe. That token
 * requirement is what this rule enforces structurally: a test cannot reach the
 * real syscall without first proving — or explicitly declining via vitest's
 * `skip()` — that the host supports it.
 *
 * No auto-fix: unlike a straight rename, the replacement needs a capability
 * token threaded from a probe call, which is a judgment call about where that
 * probe belongs in the surrounding test (per-test via `{ skip }`, or hoisted
 * to a shared `beforeAll`) that a mechanical fixer cannot make safely.
 */

const { EXEMPT_FILES_SCHEMA, createConfigurableExemptPathMatcher, isTestFile } = require('./exempt-path-matcher.cjs');

/** `node:fs` names carrying the sync primitive. */
const SYNC_MODULES = new Set(['node:fs', 'fs']);
/** `node:fs/promises` names carrying the async primitive. */
const ASYNC_MODULES = new Set(['node:fs/promises', 'fs/promises']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ban bare fs.symlinkSync()/fs.symlink() in test files — route through createSymlink()/createSymlinkAsync()',
      category: 'Cross-Platform',
      recommended: true,
    },
    fixable: null,
    schema: [EXEMPT_FILES_SCHEMA],
    messages: {
      noBareSymlink:
        'Bare {{fn}}() in a test file can throw EPERM on Windows without Developer Mode. ' +
        'Probe with symlinkCapability() and call {{safeFn}}(cap, ...) from @vibe-agent-toolkit/utils, ' +
        "routing a missing capability through vitest's skip() rather than a silent return.",
    },
  },

  create(context) {
    if (!isTestFile(context.getFilename())) {
      return {};
    }

    const exemptMatcherFor = createConfigurableExemptPathMatcher([]);
    if (exemptMatcherFor(context)(context.getFilename())) {
      return {};
    }

    // Local names bound to each module's default/namespace import, e.g.
    // `import fs from 'node:fs/promises'` binds `fs` to ASYNC_MODULES.
    const syncNamespaceNames = new Set();
    const asyncNamespaceNames = new Set();
    // Whether `symlinkSync` / `symlink` were pulled in as bare named imports.
    let syncNamedImported = false;
    let asyncNamedImported = false;

    function namespaceLocalName(importNode) {
      const spec = importNode.specifiers.find(
        (candidate) => candidate.type === 'ImportDefaultSpecifier' || candidate.type === 'ImportNamespaceSpecifier',
      );
      return spec ? spec.local.name : null;
    }

    function importsNamed(importNode, name) {
      return importNode.specifiers.some(
        (spec) => spec.type === 'ImportSpecifier' && spec.imported.name === name,
      );
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (SYNC_MODULES.has(source)) {
          const local = namespaceLocalName(node);
          if (local) syncNamespaceNames.add(local);
          syncNamedImported = syncNamedImported || importsNamed(node, 'symlinkSync');
        }
        if (ASYNC_MODULES.has(source)) {
          const local = namespaceLocalName(node);
          if (local) asyncNamespaceNames.add(local);
          asyncNamedImported = asyncNamedImported || importsNamed(node, 'symlink');
        }
      },

      CallExpression(node) {
        const { callee } = node;

        // Bare `symlinkSync(...)` from a named import.
        if (syncNamedImported && callee.type === 'Identifier' && callee.name === 'symlinkSync') {
          context.report({ node, messageId: 'noBareSymlink', data: { fn: 'symlinkSync', safeFn: 'createSymlink' } });
          return;
        }

        // Bare `symlink(...)` from a named `node:fs/promises` import.
        if (asyncNamedImported && callee.type === 'Identifier' && callee.name === 'symlink') {
          context.report({ node, messageId: 'noBareSymlink', data: { fn: 'symlink', safeFn: 'createSymlinkAsync' } });
          return;
        }

        // `fs.promises.symlink(...)` — the two-hop shape reached via a tracked
        // sync namespace import (`import fs from 'node:fs'`).
        if (
          callee.type === 'MemberExpression' &&
          callee.property.name === 'symlink' &&
          callee.object.type === 'MemberExpression' &&
          callee.object.property.name === 'promises' &&
          callee.object.object.type === 'Identifier' &&
          syncNamespaceNames.has(callee.object.object.name)
        ) {
          context.report({ node, messageId: 'noBareSymlink', data: { fn: 'symlink', safeFn: 'createSymlinkAsync' } });
          return;
        }

        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') {
          return;
        }
        const receiver = callee.object.name;

        // `fs.symlinkSync(...)` / `nodeFs.symlinkSync(...)` on a tracked sync namespace.
        if (syncNamespaceNames.has(receiver) && callee.property.name === 'symlinkSync') {
          context.report({ node, messageId: 'noBareSymlink', data: { fn: 'symlinkSync', safeFn: 'createSymlink' } });
          return;
        }

        // `fs.symlink(...)` on a tracked async namespace (the common
        // `import fs from 'node:fs/promises'` shape).
        if (asyncNamespaceNames.has(receiver) && callee.property.name === 'symlink') {
          context.report({ node, messageId: 'noBareSymlink', data: { fn: 'symlink', safeFn: 'createSymlinkAsync' } });
        }
      },
    };
  },
};

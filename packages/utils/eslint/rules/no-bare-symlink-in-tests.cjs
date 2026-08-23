/**
 * ESLint rule: no-bare-symlink-in-tests
 *
 * Bans unguarded `fs.symlinkSync()` / `fs.promises.symlink()`, with a different
 * remedy on each side of the test boundary:
 *
 * - **test files** → route through `createSymlink()` / `createSymlinkAsync()`
 *   from `@vibe-agent-toolkit/utils`, which require a probed capability token.
 * - **shipped code** → there is no wrapper to route through, and there must not
 *   be: `createSymlink()` lives on the `utils/testing` subpath, so pointing
 *   production code at it would be worse advice than the bare call. Prefer a
 *   junction for a directory link on win32, or catch the failure and name the
 *   missing privilege. An `eslint-disable` justification is the sanctioned way
 *   to say "this platform is deliberately out of scope" — see
 *   `cli/src/commands/agent/install.ts`, where `--dev` is knowingly unavailable
 *   on an unprivileged Windows and fails saying exactly that.
 *
 * ⚠️ **The name is now narrower than the rule.** It covers shipped code too;
 * renaming it is a public-API change to `@vibe-agent-toolkit/utils/eslint` and
 * has not been done.
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

const {
  EXEMPT_FILES_SCHEMA,
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createConfigurableExemptPathMatcher,
  isTestFile,
  reportUnanchoredExemptEntries,
} = require('./exempt-path-matcher.cjs');

/** `node:fs` names carrying the sync primitive. */
const SYNC_MODULES = new Set(['node:fs', 'fs']);
/** `node:fs/promises` names carrying the async primitive. */
const ASYNC_MODULES = new Set(['node:fs/promises', 'fs/promises']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ban unguarded fs.symlinkSync()/fs.symlink() — route tests through createSymlink()/createSymlinkAsync(), and guard shipped code against the Windows privilege requirement',
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
      // Deliberately a different remedy, not a reworded version of the same one.
      // Production code cannot `skip()`, and `createSymlink()` lives on the
      // `@vibe-agent-toolkit/utils/testing` subpath — telling shipped code to
      // import a test helper would be worse advice than the bare call.
      unguardedSymlink:
        'Unguarded {{fn}}() will throw EPERM on Windows unless the process holds ' +
        'SeCreateSymbolicLinkPrivilege (Developer Mode or an elevated shell) — most user machines ' +
        'and CI agents do not. For a DIRECTORY link prefer a junction on win32 ' +
        "(`process.platform === 'win32' ? 'junction' : 'dir'`, absolute target), which needs no " +
        'elevation; otherwise catch the failure and say what privilege is missing, or degrade to a copy. ' +
        'If this platform is deliberately out of scope, say so in an eslint-disable justification.',
      [UNANCHORED_EXEMPT_FILE]: UNANCHORED_EXEMPT_MESSAGE,
    },
  },

  create(context) {
    const filename = context.getFilename();

    const exemptMatcherFor = createConfigurableExemptPathMatcher([]);
    if (exemptMatcherFor(context)(filename)) {
      // Still surface a malformed exemption list: the file we are standing in
      // may be exempt only BECAUSE the entry is unanchored.
      return {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },
      };
    }

    // Test files and shipped code are both covered, with different remedies.
    //
    // The rule was test-only for one revision, and that left two blind spots
    // that mattered: VAT's own `src/` fixture builders (`trap-corpus.ts` had to
    // be migrated by hand precisely because no rule could see it), and — since
    // this rule ships publicly on `@vibe-agent-toolkit/utils/eslint` — every
    // adopter's production code, which faces the identical Windows hazard with
    // none of the test lane's ability to skip.
    //
    // ⚠️ Extending it is what MAKES `exemptFiles` load-bearing:
    // `packages/utils/src/test-helpers.ts` holds the one sanctioned
    // `symlinkSync` call and is not a test file, so it was previously excluded
    // for free. It now needs a real exemption entry in eslint.config.js.
    const messageId = isTestFile(filename) ? 'noBareSymlink' : 'unguardedSymlink';

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
      Program(node) {
        reportUnanchoredExemptEntries(context, node);
      },

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
          context.report({ node, messageId, data: { fn: 'symlinkSync', safeFn: 'createSymlink' } });
          return;
        }

        // Bare `symlink(...)` from a named `node:fs/promises` import.
        if (asyncNamedImported && callee.type === 'Identifier' && callee.name === 'symlink') {
          context.report({ node, messageId, data: { fn: 'symlink', safeFn: 'createSymlinkAsync' } });
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
          context.report({ node, messageId, data: { fn: 'symlink', safeFn: 'createSymlinkAsync' } });
          return;
        }

        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') {
          return;
        }
        const receiver = callee.object.name;

        // `fs.symlinkSync(...)` / `nodeFs.symlinkSync(...)` on a tracked sync namespace.
        if (syncNamespaceNames.has(receiver) && callee.property.name === 'symlinkSync') {
          context.report({ node, messageId, data: { fn: 'symlinkSync', safeFn: 'createSymlink' } });
          return;
        }

        // `fs.symlink(...)` on a tracked async namespace (the common
        // `import fs from 'node:fs/promises'` shape).
        if (asyncNamespaceNames.has(receiver) && callee.property.name === 'symlink') {
          context.report({ node, messageId, data: { fn: 'symlink', safeFn: 'createSymlinkAsync' } });
        }
      },
    };
  },
};

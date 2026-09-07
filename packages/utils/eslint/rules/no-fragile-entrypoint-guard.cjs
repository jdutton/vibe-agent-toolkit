/**
 * ESLint rule: no-fragile-entrypoint-guard
 *
 * Ban the two "am I the script Node was asked to run?" idioms that answer
 * **false for the script they are guarding**, so the process exits 0 having done
 * nothing at all.
 *
 * @example
 * // ❌ BAD — undefined before Node 24.2 / 22.18
 * if (import.meta.main) { await main(); }
 *
 * // ❌ BAD — raw string compare, no realpath: false through any `.bin` symlink
 * if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { … }
 *
 * // ✅ GOOD
 * import { isEntrypoint } from '@vibe-agent-toolkit/utils/process';
 * if (isEntrypoint(import.meta.url)) { await main(); }
 *
 * ## Why a lint rule and not a comment
 *
 * Both defects have already shipped in this repo, and both were invisible to
 * every gate:
 *
 * - `import.meta.main` was added in Node **24.2 / 22.18**. Measured on the exact
 *   floor this repo declares — `>=22.13.0` — the property is `undefined`:
 *
 *   ```
 *   $ node-v22.13.0 --input-type=module -e "console.log(import.meta.main)"  -> undefined
 *   $ node-v24.13.1 --input-type=module -e "console.log(import.meta.main)"  -> true
 *   ```
 *
 *   So a repository-structure gate guarded this way printed nothing and exited 0
 *   on the very Node its own CI job installs. A contributor sitting exactly on
 *   the supported floor got a green pre-commit gate that had run no rule.
 *
 * - `import.meta.url === pathToFileURL(process.argv[1]).href` compares two
 *   strings with no realpath pass. Invoked through a `node_modules/.bin` shim —
 *   i.e. the normal way a package's own bin is run — `process.argv[1]` is the
 *   SYMLINK and `import.meta.url` is the resolved target, the strings differ,
 *   and the guard is false. Measured false on Node 22.14.0 and 24.13.1 alike,
 *   where `isEntrypoint()` is true.
 *
 * The first of those was fixed once already and the fix was pinned by nothing:
 * reverting all three call sites to `if (import.meta.main)` left the entire test
 * suite green, because the only thing standing against it was three prose
 * comments addressed to a human. A banner is not a mechanism. This rule is.
 *
 * ## What it does NOT flag
 *
 * `import.meta.url`, `import.meta.dirname` and `import.meta.filename` are all
 * fine and all common — only `.main` is the unavailable one. And
 * `pathToFileURL(x).href` is only a finding when it is being compared to
 * `import.meta.url`; on its own it is just a URL.
 *
 * ## No `exemptFiles`
 *
 * Unlike the wrapper rules in this pack, there is no implementation file that
 * has to call the banned thing: `isEntrypoint()` is written in terms of
 * `process.argv[1]` and a realpath comparison, and touches neither idiom. An
 * exemption option here would only ever be used to opt a file out of a fix.
 */

'use strict';

/** `import.meta`, as the parser sees it. */
function isImportMeta(node) {
  return (
    node !== null &&
    node !== undefined &&
    node.type === 'MetaProperty' &&
    node.meta?.name === 'import' &&
    node.property?.name === 'meta'
  );
}

/**
 * `import.meta.<name>` — a static, non-computed member of `import.meta`.
 *
 * @param {object} node - Any node.
 * @param {string} name - The property to match, e.g. `main`.
 * @returns {boolean}
 */
function isImportMetaMember(node, name) {
  return (
    node !== null &&
    node !== undefined &&
    node.type === 'MemberExpression' &&
    node.computed === false &&
    isImportMeta(node.object) &&
    node.property?.type === 'Identifier' &&
    node.property.name === name
  );
}

/**
 * The called function's NAME, whether called bare or off a namespace.
 *
 * `pathToFileURL(p)` and `url.pathToFileURL(p)` are the same call, and a matcher
 * that only understood the bare form would be blind to every file that imports
 * `node:url` as a namespace.
 *
 * @param {object} callee - The `callee` of a CallExpression.
 * @returns {string | undefined}
 */
function calleeName(callee) {
  if (callee === null || callee === undefined) return undefined;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.computed === false) {
    return callee.property?.type === 'Identifier' ? callee.property.name : undefined;
  }
  return undefined;
}

/** `pathToFileURL(…).href`, in either import style. */
function isPathToFileUrlHref(node) {
  return (
    node !== null &&
    node !== undefined &&
    node.type === 'MemberExpression' &&
    node.computed === false &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'href' &&
    node.object?.type === 'CallExpression' &&
    calleeName(node.object.callee) === 'pathToFileURL'
  );
}

/** Identity comparisons; `==`/`!=` on these operands never occurs and is not the idiom. */
const IDENTITY_OPERATORS = new Set(['===', '!==']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban entrypoint guards that silently answer false — `import.meta.main` (undefined before Node 24.2/22.18) and a raw `import.meta.url === pathToFileURL(argv[1]).href` compare (false through any symlink). Use `isEntrypoint()`.',
      category: 'Cross-Platform',
      recommended: false,
    },
    messages: {
      importMetaMain:
        '`import.meta.main` is undefined before Node 24.2 / 22.18, so this guard is FALSE on older supported Node and the script exits 0 having done nothing. Use `isEntrypoint(import.meta.url)` from `@vibe-agent-toolkit/utils/process`.',
      rawEntrypointCompare:
        'Comparing `import.meta.url` to `pathToFileURL(process.argv[1]).href` is a raw string compare with no realpath, so it is FALSE whenever the script is reached through a symlink (any `node_modules/.bin` shim) and the script exits 0 having done nothing. Use `isEntrypoint(import.meta.url)` from `@vibe-agent-toolkit/utils/process`.',
    },
    schema: [],
  },

  create(context) {
    return {
      MemberExpression(node) {
        if (isImportMetaMember(node, 'main')) {
          context.report({ node, messageId: 'importMetaMain' });
        }
      },

      BinaryExpression(node) {
        if (!IDENTITY_OPERATORS.has(node.operator)) return;

        const compares =
          (isImportMetaMember(node.left, 'url') && isPathToFileUrlHref(node.right)) ||
          (isImportMetaMember(node.right, 'url') && isPathToFileUrlHref(node.left));

        if (compares) {
          context.report({ node, messageId: 'rawEntrypointCompare' });
        }
      },
    };
  },
};

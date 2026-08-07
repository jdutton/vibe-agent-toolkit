/**
 * ESLint rule: no-unsafe-root-join
 *
 * Flags `safePath.join(<root>, …)` and `safePath.resolve(<root>, …)` where
 * the first argument is an identifier whose name ends in "root" (case-insensitive,
 * e.g. harnessRoot, stagedRoot, pluginRoot). These are security-root path joins
 * that should use `safePath.joinUnderRoot()` to prevent caller-controlled segments
 * from escaping the root on Windows via drive-letter or absolute path injection.
 *
 * Rule is intentionally narrow: only *Root-named first arguments are flagged to
 * avoid false positives on ordinary joins.
 *
 * @example
 * // ❌ BAD — silent escape on Windows if item.name is 'C:\evil'
 * const dest = safePath.join(harnessRoot, stagedDirName(item.name));
 *
 * // ✅ GOOD — throws on Windows drive-letter or absolute segment
 * const dest = safePath.joinUnderRoot(harnessRoot, stagedDirName(item.name));
 */

'use strict';

/** Return true when the identifier name ends with 'root' (case-insensitive). */
function isRootIdentifier(name) {
  return name.toLowerCase().endsWith('root');
}

/**
 * Return true when the first argument of a CallExpression is an Identifier
 * whose name ends in 'root' (case-insensitive).
 */
function firstArgIsRootIdentifier(node) {
  if (node.arguments.length === 0) return false;
  const first = node.arguments[0];
  return first.type === 'Identifier' && isRootIdentifier(first.name);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce safePath.joinUnderRoot() for joins whose first arg is a security root variable (name ends in "Root").',
      category: 'Security',
      recommended: true,
    },
    messages: {
      useJoinUnderRoot:
        'Use safePath.joinUnderRoot({{root}}, …) instead of safePath.{{method}}({{root}}, …) ' +
        'when the first argument is a security root. ' +
        'safePath.{{method}}() does not prevent caller-controlled segments from escaping the root on Windows.',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        // Must be a MemberExpression: safePath.<method>(...)
        if (node.callee.type !== 'MemberExpression') return;

        const obj = node.callee.object;
        const prop = node.callee.property;

        // Object must be the identifier 'safePath'
        if (obj.type !== 'Identifier' || obj.name !== 'safePath') return;

        // Method must be 'join' or 'resolve'
        if (prop.type !== 'Identifier') return;
        const method = prop.name;
        if (method !== 'join' && method !== 'resolve') return;

        // First argument must be an identifier ending in 'root'
        if (!firstArgIsRootIdentifier(node)) return;

        const rootName = node.arguments[0].name;
        context.report({
          node,
          messageId: 'useJoinUnderRoot',
          data: { root: rootName, method },
        });
      },
    };
  },
};

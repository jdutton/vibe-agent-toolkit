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
      category: 'Path handling',
      bans: '`safePath.join(someRoot, x)` where `x` can escape',
      useInstead: '`safePath.joinUnderRoot()`',
      subpath: '/path',
      // Not in `recommended`: an unsound heuristic, pending a rewrite. It keys on
      // whether an identifier's NAME ends in `root` rather than on whether any
      // segment is caller-controlled, so it is noisy and blind at once — measured
      // on a 4,670-file adopter tree: 108 findings, 0 autofixable, and every one
      // of these verified by execution:
      //
      //   FIRES   safePath.join(repoRoot, 'docs', 'product')  <- all literals, cannot escape
      //   FIRES   safePath.resolve(packageRoot, '..', '..')   <- escaping IS the intent
      //   FIRES   safePath.join(repoRoot)                     <- one argument, no segment
      //   silent  safePath.join(base, userInput)              <- THE dangerous shape, missed
      //
      // A rule that misses the case it exists to catch must not ride in a config
      // named `recommended` at any severity — a safety core that cries wolf
      // teaches people to ignore it, which costs the true positives too. It still
      // earns `error` where scoped to directories in which a path escape is a
      // security boundary (VAT scopes it to the skill-test staging code).
      // Re-include it when it keys on taint rather than on naming.
      recommended: false,
      recommendedSeverity: 'error',
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

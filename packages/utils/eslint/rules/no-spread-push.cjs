/**
 * ESLint rule: no-spread-push
 *
 * Reports `target.push(...items)` and `target.unshift(...items)` where a spread
 * argument is anything but an array literal written in place.
 *
 * Why: a spread argument is an argument list, and V8 throws `RangeError: Maximum
 * call stack size exceeded` past roughly 125,000 arguments. A walk is unbounded:
 * a gitignored `.venv` of 200,000 files overflowed `candidates.push(...walked)`
 * in the projection crawl, and three agent-skills walks had the same shape. Whether
 * an array is bounded cannot be read off the code, and a list that is small today
 * is a walk's output after a refactor, so the spread is refused everywhere the
 * rule runs. `appendAll(target, items)` from `@vibe-agent-toolkit/utils` appends
 * one item at a time; spreading into an array literal (`appendAll(lines, ['x',
 * ...rest])`) is not an argument list and is allowed.
 *
 * No autofix: the rewrite adds an import whose specifier depends on the package
 * the file is in, and `push` returns a length `appendAll` does not.
 */

'use strict';

const METHODS = new Set(['push', 'unshift']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow spreading an array into push() or unshift(): an argument list overflows the call stack past ~125,000 items',
      category: 'Correctness',
      bans: '`target.push(...items)`',
      useInstead: '`appendAll(target, items)`',
      // Not recommended: a spread of a small fixed array is idiomatic in an
      // adopter's code, and only a codebase whose arrays come from unbounded walks
      // pays for refusing every one. This repo enables it over product source.
      recommended: false,
      recommendedSeverity: 'error',
    },
    messages: {
      spread:
        'Do not spread into {{method}}(): an argument list overflows the call stack past ~125,000 items. Use appendAll(target, items) from @vibe-agent-toolkit/utils.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        if (!METHODS.has(callee.property.name)) return;
        const spread = node.arguments.find((argument) => argument.type === 'SpreadElement' && argument.argument.type !== 'ArrayExpression');
        if (spread === undefined) return;
        context.report({ node: spread, messageId: 'spread', data: { method: callee.property.name } });
      },
    };
  },
};

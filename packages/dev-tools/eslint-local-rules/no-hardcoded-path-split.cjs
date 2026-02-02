/**
 * ESLint rule to disallow splitting strings by hardcoded path separators
 *
 * Using .split('/') or .split('\\') on file paths breaks on Windows/Unix.
 * Use path.basename(), path.dirname(), or normalize with toForwardSlash() first.
 *
 * @example
 * // ❌ BAD - breaks on Windows (paths use backslashes)
 * const filename = filePath.split('/').pop();
 * const parts = filePath.split('\\');
 *
 * // ✅ GOOD - use path.basename() for filename
 * import { basename } from 'node:path';
 * const filename = basename(filePath);
 *
 * // ✅ GOOD - normalize then split if you need path segments
 * import { toForwardSlash } from '@vibe-agent-toolkit/utils';
 * const parts = toForwardSlash(filePath).split('/');
 */

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow splitting strings by hardcoded path separators',
      category: 'Cross-platform compatibility',
      recommended: true,
    },
    messages: {
      noHardcodedSplit:
        'Avoid .split(\'/\') or .split(\'\\\\\') on file paths (breaks on Windows/Unix). ' +
        'Use path.basename() to extract filename, or toForwardSlash() from @vibe-agent-toolkit/utils to normalize paths first.',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        // Check if this is a .split() call
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'split'
        ) {
          return;
        }

        // Check if the argument is a hardcoded path separator
        const firstArg = node.arguments[0];
        if (!firstArg) {
          return;
        }

        // Check for literal '/' or '\\'
        const isPathSeparator =
          (firstArg.type === 'Literal' &&
            typeof firstArg.value === 'string' &&
            (firstArg.value === '/' || firstArg.value === '\\')) ||
          // Check for regex like /[/\\]/ or /\//
          (firstArg.type === 'Literal' &&
            firstArg.value instanceof RegExp &&
            (firstArg.value.source.includes('/') ||
              firstArg.value.source.includes('\\\\')));

        if (isPathSeparator) {
          context.report({
            node,
            messageId: 'noHardcodedSplit',
          });
        }
      },
    };
  },
};

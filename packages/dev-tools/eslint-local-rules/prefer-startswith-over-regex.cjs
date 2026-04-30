/**
 * ESLint rule: prefer-startswith-over-regex
 *
 * Catches `/^literal/.test(s)` and `/literal$/.test(s)` patterns where the
 * literal portion contains only plain characters and `\/` escape sequences,
 * and recommends `s.startsWith('literal')` / `s.endsWith('literal')`.
 *
 * Why a local rule?
 * `unicorn/prefer-string-starts-ends-with` already handles the simple case
 * but conservatively rejects any pattern containing `\` — including the
 * common `\/` (escaped slash) sequence. SonarCloud's S6557 catches these,
 * but only post-merge. This rule shifts that detection left into ESLint.
 *
 * Examples:
 *   /^file:\/\//.test(s)   →  s.startsWith('file://')
 *   /^https?:\/\//.test(s) →  NOT flagged (contains `?` quantifier)
 *   /^[a-z]+/.test(s)      →  NOT flagged (contains `[` character class)
 *   /\.txt$/.test(s)       →  NOT flagged (contains `.` metachar)
 */

'use strict';

const METACHARS = ['^', '$', '+', '[', '{', '(', '.', '?', '*', '|'];

/**
 * Treat `\/` as a single literal `/` and check the remainder for any
 * regex metacharacter or other backslash-escape we don't understand.
 * Returns the literal string if safely convertible, otherwise null.
 */
function literalEquivalent(patternBody) {
  // Step 1: collapse `\/` (the only escape we accept) into a literal `/`.
  const flattened = patternBody.replaceAll('\\/', '/');
  // Step 2: any remaining `\` is an escape we don't understand (\d, \w, \\, etc.).
  if (flattened.includes('\\')) {
    return null;
  }
  // Step 3: reject any regex metacharacter we'd be silently flattening.
  for (const ch of flattened) {
    if (METACHARS.includes(ch)) {
      return null;
    }
  }
  return flattened;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Prefer String#startsWith / String#endsWith over /^literal/.test() — even when the literal includes \\/ escape sequences',
      recommended: true,
    },
    messages: {
      preferStartsWith:
        "Prefer `<string>.startsWith('{{literal}}')` over `/{{pattern}}/.test(<string>)`. " +
        'Treat \\/ as the literal / character.',
      preferEndsWith:
        "Prefer `<string>.endsWith('{{literal}}')` over `/{{pattern}}/.test(<string>)`. " +
        'Treat \\/ as the literal / character.',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'test'
        ) {
          return;
        }
        const obj = node.callee.object;
        if (obj.type !== 'Literal' || !obj.regex) {
          return;
        }
        const { pattern, flags } = obj.regex;
        if (flags.includes('i') || flags.includes('m')) {
          return;
        }

        if (pattern.startsWith('^')) {
          const body = pattern.slice(1);
          const literal = literalEquivalent(body);
          if (literal !== null && literal !== '') {
            context.report({
              node,
              messageId: 'preferStartsWith',
              data: { literal, pattern },
            });
            return;
          }
        }

        if (pattern.endsWith('$') && !pattern.endsWith('\\$')) {
          const body = pattern.slice(0, -1);
          const literal = literalEquivalent(body);
          if (literal !== null && literal !== '') {
            context.report({
              node,
              messageId: 'preferEndsWith',
              data: { literal, pattern },
            });
          }
        }
      },
    };
  },
};

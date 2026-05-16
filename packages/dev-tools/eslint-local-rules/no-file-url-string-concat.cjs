/**
 * ESLint rule: no-file-url-string-concat
 *
 * Disallow constructing `file://` URLs by string concatenation or template
 * literal interpolation. Filesystem paths on Windows contain `\` and `C:`,
 * and naively prefixing them with `file://` produces non-canonical URLs that
 * never compare equal to `import.meta.url`, never round-trip through `new URL`,
 * and silently break entry-point checks like:
 *
 *   if (import.meta.url === `file://${process.argv[1]}`) { ... }   // ❌ Windows
 *
 * `pathToFileURL()` is the only correct constructor: it percent-encodes
 * separators, prepends the right number of slashes for drive letters, and
 * matches what Node produces for `import.meta.url`.
 *
 * @example
 * // ❌ BAD — Windows-broken
 * const u = `file://${process.argv[1]}`;
 * const u2 = 'file://' + somePath;
 *
 * // ✅ GOOD
 * import { pathToFileURL } from 'node:url';
 * const u = pathToFileURL(process.argv[1]).href;
 */

'use strict';

const FILE_URL_PREFIX = 'file://';

function literalStartsWithFileUrl(node) {
  if (!node) return false;
  if (node.type === 'Literal') {
    return typeof node.value === 'string' && node.value.startsWith(FILE_URL_PREFIX);
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length > 0) {
    const cooked = node.quasis[0].value.cooked;
    return typeof cooked === 'string' && cooked.startsWith(FILE_URL_PREFIX);
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow constructing `file://` URLs by string concatenation; use `pathToFileURL()` from `node:url`.',
      category: 'Cross-platform compatibility',
      recommended: true,
    },
    messages: {
      useFileUrlBuilder:
        'Do not build `file://` URLs by string concatenation — on Windows, paths contain `\\` and drive letters and produce non-canonical URLs that never compare equal to `import.meta.url`. Use `pathToFileURL(path).href` from `node:url`.',
    },
    schema: [],
  },

  create(context) {
    return {
      TemplateLiteral(node) {
        if (node.expressions.length === 0) return;
        if (node.quasis.length === 0) return;
        const cooked = node.quasis[0].value.cooked;
        if (typeof cooked === 'string' && cooked.startsWith(FILE_URL_PREFIX)) {
          context.report({ node, messageId: 'useFileUrlBuilder' });
        }
      },

      BinaryExpression(node) {
        if (node.operator !== '+') return;
        if (literalStartsWithFileUrl(node.left) || literalStartsWithFileUrl(node.right)) {
          context.report({ node, messageId: 'useFileUrlBuilder' });
        }
      },
    };
  },
};

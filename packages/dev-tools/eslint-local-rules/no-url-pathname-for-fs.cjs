/**
 * ESLint rule: no-url-pathname-for-fs
 *
 * Prevents `.pathname` access on a `URL` constructed from `import.meta.url`.
 * On Windows, `new URL('../x', import.meta.url).pathname` returns `/D:/...`
 * which breaks `fs` operations (ENOENT or `D:\D:\...`).
 *
 * Fix: use `fileURLToPath(new URL(...))` from `node:url`, or
 * `resolveFromImportMeta()` from `@vibe-agent-toolkit/utils`.
 *
 * @example
 * // ❌ BAD — Windows-broken
 * const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;
 *
 * // ✅ GOOD
 * import { fileURLToPath } from 'node:url';
 * const p = fileURLToPath(new URL('../fixtures/x.yaml', import.meta.url));
 */

'use strict';

/**
 * Returns true if `node` is the `import.meta.url` `MemberExpression`.
 */
function isImportMetaUrl(node) {
  return (
    node?.type === 'MemberExpression' &&
    node.object?.type === 'MetaProperty' &&
    node.object.meta?.name === 'import' &&
    node.object.property?.name === 'meta' &&
    node.property?.name === 'url'
  );
}

const SKIP_KEYS = new Set(['parent', 'loc', 'range']);

function childIsAstNode(value) {
  return value && typeof value === 'object' && typeof value.type === 'string';
}

/**
 * Walks an AST subtree looking for `import.meta.url`.
 * Returns true if found, false otherwise.
 */
function containsImportMetaUrl(node) {
  if (!node || typeof node !== 'object') return false;
  if (isImportMetaUrl(node)) return true;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    // eslint-disable-next-line security/detect-object-injection
    const value = node[key];
    if (Array.isArray(value) && value.some((item) => containsImportMetaUrl(item))) {
      return true;
    }
    if (childIsAstNode(value) && containsImportMetaUrl(value)) {
      return true;
    }
  }
  return false;
}

function isUrlConstructorWithImportMeta(node) {
  if (node?.type !== 'NewExpression') return false;
  if (node.callee?.name !== 'URL') return false;
  return node.arguments.some((arg) => containsImportMetaUrl(arg));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow `.pathname` on a URL built from `import.meta.url`; use `fileURLToPath()` instead.',
      category: 'Cross-platform compatibility',
      recommended: true,
    },
    messages: {
      useFileURLToPath:
        'Do not use `.pathname` on `new URL(..., import.meta.url)` — on Windows it returns `/D:/...` and breaks `fs`. ' +
        'Use `fileURLToPath(new URL(...))` from `node:url` or `resolveFromImportMeta()` from `@vibe-agent-toolkit/utils`.',
    },
    schema: [],
  },

  create(context) {
    return {
      MemberExpression(node) {
        if (node.property.type !== 'Identifier' || node.property.name !== 'pathname') {
          return;
        }
        if (isUrlConstructorWithImportMeta(node.object)) {
          context.report({ node, messageId: 'useFileURLToPath' });
        }
      },
    };
  },
};

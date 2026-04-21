/**
 * ESLint rule: no-bare-dynamic-import-path
 *
 * Prevents `await import(p)` where `p` is a raw filesystem path.
 * On Windows, ESM dynamic import of a bare path fails — it requires a `file://`
 * URL. Observed bug: `await import('D:\\a\\repo\\config.js')` throws.
 *
 * Fix: `await import(pathToFileURL(p).href)` from `node:url`, or
 * `await dynamicImportPath(p)` from `@vibe-agent-toolkit/utils`.
 *
 * Heuristic (intentionally narrow — some false positives are preferable to
 * false negatives for a shift-left lint rule, but the user can suppress per line):
 *   - String literal starting with `/` or `C:\` style absolute path → flag
 *   - Call to `path.join`, `path.resolve`, `join`, `resolve`, `safePath.*` → flag
 *   - Identifier whose name matches /path|file|config|module|dir/i → flag
 *     (will have false positives on well-named variables that already hold
 *     file:// URLs; suppress those call-sites with eslint-disable-next-line.)
 *   - Template literal that embeds a path-shaped call → flag
 *
 * Does NOT flag:
 *   - Relative module specifiers (`./foo.js`, `../bar.js`)
 *   - Bare package names (`some-pkg`)
 *   - Expressions ending in `.href` (assume correct `pathToFileURL(x).href`)
 */

'use strict';

const PATH_CALL_NAMES = new Set(['join', 'resolve']);
const PATH_OBJECT_NAMES = new Set(['path', 'safePath']);
const PATH_SHAPED_IDENTIFIER = /path|file|config|module|dir/i;
const ABSOLUTE_PATH_LITERAL = /^(\/|[A-Za-z]:[\\/])/;

function isPathCallExpression(node) {
  if (node?.type !== 'CallExpression') return false;
  const callee = node.callee;
  // bare call: join(...), resolve(...)
  if (callee.type === 'Identifier' && PATH_CALL_NAMES.has(callee.name)) {
    return true;
  }
  // member call: path.join, path.resolve, safePath.join, safePath.resolve
  if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    PATH_OBJECT_NAMES.has(callee.object.name) &&
    callee.property.type === 'Identifier'
  ) {
    return true;
  }
  return false;
}

function isHrefAccess(node) {
  return (
    node?.type === 'MemberExpression' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'href'
  );
}

function isRelativeOrBareSpecifier(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('./') || value.startsWith('../') || value === '.' || value === '..') {
    return true;
  }
  // Bare package name — no leading slash, no drive letter.
  if (ABSOLUTE_PATH_LITERAL.test(value)) return false;
  return !value.includes('\\');
}

function templateHasPathCall(node) {
  if (node?.type !== 'TemplateLiteral') return false;
  return node.expressions.some((expr) => isPathCallExpression(expr));
}

function classifyImportArgument(arg) {
  if (!arg) return null;

  // Literal string specifier — flag only if absolute path-shaped.
  if (arg.type === 'Literal' && typeof arg.value === 'string') {
    if (isRelativeOrBareSpecifier(arg.value)) return null;
    if (ABSOLUTE_PATH_LITERAL.test(arg.value)) return 'absolute-literal';
    return null;
  }

  // Template literal with a path call embedded.
  if (arg.type === 'TemplateLiteral') {
    if (templateHasPathCall(arg)) return 'template-with-path-call';
    return null;
  }

  // `pathToFileURL(x).href` or similar — correct form, do not flag.
  if (isHrefAccess(arg)) return null;

  // path.join(...) / path.resolve(...) / join(...) / resolve(...)
  if (isPathCallExpression(arg)) return 'path-call';

  // Bare identifier whose name hints at a filesystem path.
  if (arg.type === 'Identifier' && PATH_SHAPED_IDENTIFIER.test(arg.name)) {
    return 'path-shaped-identifier';
  }

  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow dynamic `import()` of a filesystem path; wrap with `pathToFileURL(p).href`.',
      category: 'Cross-platform compatibility',
      recommended: true,
    },
    messages: {
      useFileUrl:
        'Dynamic `import()` of a filesystem path fails on Windows. ' +
        'Wrap with `pathToFileURL(p).href` from `node:url`, or use `dynamicImportPath(p)` from `@vibe-agent-toolkit/utils`.',
    },
    schema: [],
  },

  create(context) {
    return {
      ImportExpression(node) {
        const kind = classifyImportArgument(node.source);
        if (kind) {
          context.report({ node, messageId: 'useFileUrl' });
        }
      },
    };
  },
};

/**
 * ESLint rule to enforce normalizing path operations before string comparisons
 *
 * path.relative(), path.dirname(), path.basename(), path.join() return OS-specific separators.
 * When comparing with literal strings (especially in markdown), normalize to forward slashes.
 *
 * @example
 * // ❌ BAD - path.relative() returns backslashes on Windows
 * const relativePath = path.relative(baseDir, filePath);
 * if (content.includes(relativePath)) { ... }  // FAILS on Windows!
 *
 * // ✅ GOOD - normalize before comparison
 * import { toForwardSlash } from '@vibe-agent-toolkit/utils';
 * const relativePath = toForwardSlash(path.relative(baseDir, filePath));
 * if (content.includes(relativePath)) { ... }
 */

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow using path operations directly in string comparisons',
      category: 'Cross-platform compatibility',
      recommended: true,
    },
    messages: {
      normalizePathOperation:
        'Wrap path.{{method}}() with toForwardSlash() from @vibe-agent-toolkit/utils before using in string operations. ' +
        'Path operations return OS-specific separators that fail in cross-platform comparisons.',
    },
    schema: [],
  },

  create(context) {
    // Path methods that return paths with OS-specific separators
    const pathMethodsReturningPaths = new Set([
      'relative',
      'dirname',
      'basename',
      'join',
      'resolve',
      'normalize',
    ]);

    // String methods that compare/search strings
    const stringComparisonMethods = new Set([
      'includes',
      'indexOf',
      'lastIndexOf',
      'startsWith',
      'endsWith',
      'split',
      'replace',
      'replaceAll',
      'match',
      'search',
    ]);

    // Track variables that hold unwrapped path operation results
    const unwrappedPathVariables = new Set();
    const wrappedPathVariables = new Set();

    // If `node` is a `path.<method>(...)` call where method returns
    // OS-specific separators, return that method name. Otherwise undefined.
    const unnormalizedPathCallMethod = (node) =>
      node?.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'path' &&
      pathMethodsReturningPaths.has(node.callee.property.name)
        ? node.callee.property.name
        : undefined;

    const isStringComparisonCall = (node) =>
      node.callee.type === 'MemberExpression' &&
      stringComparisonMethods.has(node.callee.property.name);

    const reportPathArgument = (arg) => {
      const method = unnormalizedPathCallMethod(arg);
      if (method !== undefined) {
        context.report({ node: arg, messageId: 'normalizePathOperation', data: { method } });
        return;
      }
      if (
        arg.type === 'Identifier' &&
        unwrappedPathVariables.has(arg.name) &&
        !wrappedPathVariables.has(arg.name)
      ) {
        context.report({
          node: arg,
          messageId: 'normalizePathOperation',
          data: { method: 'operation' },
        });
      }
    };

    const reportTemplateLiteralExpressions = (templateLiteral) => {
      for (const expr of templateLiteral.expressions) {
        const method = unnormalizedPathCallMethod(expr);
        if (method !== undefined) {
          context.report({
            node: expr,
            messageId: 'normalizePathOperation',
            data: { method },
          });
        }
      }
    };

    return {
      VariableDeclarator(node) {
        if (!node.init || node.id.type !== 'Identifier') return;

        if (unnormalizedPathCallMethod(node.init) !== undefined) {
          unwrappedPathVariables.add(node.id.name);
          return;
        }

        // Initializer is `toForwardSlash(<expr>)` — treat the variable as wrapped.
        if (
          node.init.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === 'toForwardSlash' &&
          node.init.arguments.length === 1
        ) {
          wrappedPathVariables.add(node.id.name);
        }
      },

      CallExpression(node) {
        if (!isStringComparisonCall(node)) return;
        for (const arg of node.arguments) {
          reportPathArgument(arg);
          if (arg.type === 'TemplateLiteral') {
            reportTemplateLiteralExpressions(arg);
          }
        }
      },
    };
  },
};

/**
 * ESLint rule: no-path-resolve-dirname
 *
 * Prevents usage of path.resolve(__dirname, ...) in test files.
 * Enforces normalizePath() from @vibe-agent-toolkit/utils instead.
 *
 * Why:
 * - path.resolve() doesn't normalize Windows 8.3 short paths (RUNNER~1)
 * - This causes test failures on Windows CI where paths contain short names
 * - normalizePath() handles Windows 8.3 resolution consistently
 *
 * Applies to:
 * - Test files (*.test.ts, *.test.js, test/**, __tests__/**)
 * - Only when first argument is __dirname
 *
 * Auto-fix: Replaces path.resolve(__dirname, ...) with normalizePath(__dirname, ...)
 *           and removes orphaned path import if no longer used.
 */

const SAFE_MODULE = '@vibe-agent-toolkit/utils';
const PATH_MODULES = new Set(['node:path', 'path']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce normalizePath() instead of path.resolve(__dirname) in tests',
      category: 'Cross-platform compatibility',
      recommended: true,
    },
    fixable: 'code',
    schema: [],
    messages: {
      noPathResolveDirname:
        'Use normalizePath() from @vibe-agent-toolkit/utils instead of path.resolve(__dirname) for Windows 8.3 path compatibility.',
    },
  },

  create(context) {
    const filename = context.getFilename();
    const sourceCode = context.getSourceCode();

    // Only apply to test files
    const isTestFile =
      filename.includes('.test.') ||
      filename.includes('/test/') ||
      filename.includes('\\test\\') ||
      filename.includes('__tests__');

    if (!isTestFile) {
      return {};
    }

    // Exempt path-utils.ts since it implements the helper functions
    if (filename.includes('path-utils.ts')) {
      return {};
    }

    let pathImportNode = null;
    let pathDefaultName = null;
    let hasNormalizePathImport = false;
    let safeImportNode = null;
    let pathMemberExpressionCount = 0;
    let reportedNodes = [];

    return {
      ImportDeclaration(node) {
        // Track path module imports
        if (PATH_MODULES.has(node.source.value)) {
          pathImportNode = node;
          for (const spec of node.specifiers) {
            if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
              pathDefaultName = spec.local.name;
            }
          }
        }

        // Track normalizePath imports
        if (node.source.value === SAFE_MODULE) {
          safeImportNode = node;
          for (const spec of node.specifiers) {
            if (spec.type === 'ImportSpecifier' && spec.imported.name === 'normalizePath') {
              hasNormalizePathImport = true;
            }
          }
        }
      },

      MemberExpression(node) {
        // Count all path.* member expressions to know if import can be removed
        if (
          pathDefaultName &&
          node.object.type === 'Identifier' &&
          node.object.name === pathDefaultName
        ) {
          pathMemberExpressionCount++;
        }
      },

      CallExpression(node) {
        // Check for path.resolve(__dirname, ...)
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === pathDefaultName &&
          node.callee.property.name === 'resolve' &&
          node.arguments.length > 0 &&
          node.arguments[0].name === '__dirname'
        ) {
          reportedNodes.push(node);
          context.report({
            node,
            messageId: 'noPathResolveDirname',
            fix(fixer) {
              const fixes = [];

              // Replace path.resolve with normalizePath
              fixes.push(fixer.replaceText(node.callee, 'normalizePath'));

              // Add normalizePath import if needed
              if (!hasNormalizePathImport) {
                if (safeImportNode) {
                  // Add to existing @vibe-agent-toolkit/utils import
                  const lastSpecifier =
                    safeImportNode.specifiers[safeImportNode.specifiers.length - 1];
                  fixes.push(fixer.insertTextAfter(lastSpecifier, ', normalizePath'));
                } else {
                  // Create new import after path import or at the top
                  const targetNode = pathImportNode || sourceCode.ast.body[0];
                  const newImport = `\nimport { normalizePath } from '${SAFE_MODULE}';`;
                  fixes.push(fixer.insertTextAfter(targetNode, newImport));
                }
                hasNormalizePathImport = true;
              }

              // Remove path import if this was the only path.* usage
              if (pathImportNode && pathMemberExpressionCount === reportedNodes.length) {
                fixes.push(fixer.remove(pathImportNode));
              }

              return fixes;
            },
          });
        }
      },
    };
  },
};

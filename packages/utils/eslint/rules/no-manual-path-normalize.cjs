/**
 * ESLint rule to enforce using toForwardSlash() instead of manual normalization
 *
 * Detects manual path normalization patterns and suggests using the utility function.
 *
 * @example
 * // ❌ BAD - manual normalization
 * const normalized = relativePath.split(path.sep).join('/');
 * const normalized = somePath.split('\\').join('/');
 *
 * // ✅ GOOD - use utility function
 * import { toForwardSlash } from '@vibe-agent-toolkit/utils/path';
 * const normalized = toForwardSlash(relativePath);
 */

const {
  DEAD_UNSAFE_IMPORT,
  DEAD_UNSAFE_IMPORT_MESSAGE,
  reportDeadUnsafeImports,
} = require('./dead-import.cjs');
const {
  SAFE_MODULE_ONLY_SCHEMA,
  SAFE_PATH_MODULE,
  insertAboveWithComments,
  isNameAlreadyBound,
  resolveSafeModule,
} = require('./safe-import.cjs');

const SAFE_FN = 'toForwardSlash';
const PATH_MODULES = new Set(['node:path', 'path']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow manual path normalization patterns',
      category: 'Cross-platform compatibility',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      useToForwardSlash:
        'Use toForwardSlash() from {{safeModule}} instead of manual path normalization. ' +
        'Manual normalization is error-prone and less maintainable.',
      [DEAD_UNSAFE_IMPORT]: DEAD_UNSAFE_IMPORT_MESSAGE,
    },
    schema: [SAFE_MODULE_ONLY_SCHEMA],
  },

  create(context) {
    const sourceCode = context.getSourceCode();
    const targetModule = resolveSafeModule(context, SAFE_PATH_MODULE);
    // Seeded from SCOPE: a file that already imports `toForwardSlash` from the
    // barrel must have the call rewritten WITHOUT gaining a second binding of
    // the same name — that is a SyntaxError. See `safe-import.cjs`.
    let hasToForwardSlashImport = isNameAlreadyBound(sourceCode, SAFE_FN);
    // Never mutated — the dead-import leg must not be armed by a flag that a
    // suppressed report's `fix()` can spend. See `dead-import.cjs`.
    const safeBoundInSource = hasToForwardSlashImport;
    let utilsImportNode = null;
    // `path.sep` is the last `path.*` reference in plenty of files, and
    // `toForwardSlash(raw)` consumes it — leaving the same dead `node:path`
    // binding the `safePath` rules used to leave.
    const pathImportNodes = [];

    return {
      'Program:exit'() {
        reportDeadUnsafeImports(context, sourceCode, pathImportNodes, safeBoundInSource);
      },

      ImportDeclaration(node) {
        if (PATH_MODULES.has(node.source.value)) {
          pathImportNodes.push(node);
        }
        if (node.source.value === targetModule) {
          utilsImportNode = node;
          for (const spec of node.specifiers) {
            if (spec.type === 'ImportSpecifier' && spec.imported.name === SAFE_FN) {
              hasToForwardSlashImport = true;
            }
          }
        }
      },

      CallExpression(node) {
        // Check for .split(...).join('/') pattern
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.name === 'join' &&
          node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal' &&
          node.arguments[0].value === '/'
        ) {
          // Check if the object is a .split() call
          const splitCall = node.callee.object;
          if (
            splitCall.type === 'CallExpression' &&
            splitCall.callee.type === 'MemberExpression' &&
            splitCall.callee.property.name === 'split' &&
            splitCall.arguments.length === 1
          ) {
            const splitArg = splitCall.arguments[0];

            // Check if splitting by path.sep, '\\', or '\\\\'
            const isSplittingByPathSep =
              (splitArg.type === 'MemberExpression' &&
                splitArg.object.name === 'path' &&
                splitArg.property.name === 'sep') ||
              (splitArg.type === 'Literal' && (splitArg.value === '\\' || splitArg.value === '\\\\'));

            if (isSplittingByPathSep) {
              const variableBeingSplit = splitCall.callee.object;

              context.report({
                node,
                messageId: 'useToForwardSlash',
                data: { safeModule: targetModule },
                fix(fixer) {
                  const fixes = [];

                  // Replace the entire .split(...).join('/') with toForwardSlash(...)
                  const originalVar = sourceCode.getText(variableBeingSplit);
                  fixes.push(fixer.replaceText(node, `${SAFE_FN}(${originalVar})`));

                  // Add import if needed
                  if (!hasToForwardSlashImport) {
                    if (utilsImportNode) {
                      // Add to existing utils import
                      const lastSpecifier = utilsImportNode.specifiers.at(-1);
                      fixes.push(fixer.insertTextAfter(lastSpecifier, `, ${SAFE_FN}`));
                    } else {
                      // Create new import at the top
                      const firstNode = sourceCode.ast.body[0];
                      const newImport = `import { ${SAFE_FN} } from '${targetModule}';\n`;
                      fixes.push(insertAboveWithComments(fixer, sourceCode, firstNode, newImport));
                    }
                    // NOT latched. The comment here used to claim that without a
                    // `hasToForwardSlashImport = true` a second occurrence would
                    // insert the import twice; an adversarial run could not
                    // reproduce that at any occurrence count. It cannot happen:
                    // both reports insert identical text at the identical anchor,
                    // so the ranges coincide and ESLint applies one and drops the
                    // other as overlapping.
                    //
                    // Latching it is not free, either. ESLint runs `fix()` for a
                    // SUPPRESSED problem before the `eslint-disable` filter
                    // discards it, so the first report could spend the flag and
                    // then be thrown away — leaving later occurrences rewritten
                    // to a `toForwardSlash` nothing imports.
                  }

                  return fixes;
                },
              });
            }
          }
        }
      },
    };
  },
};

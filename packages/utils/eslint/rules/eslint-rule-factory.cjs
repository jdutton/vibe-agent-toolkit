/**
 * ESLint Rule Factory - Shared implementation for unsafe operation rules
 *
 * Creates ESLint rules that detect unsafe operations and suggest safe alternatives.
 * Supports auto-fixing with import management.
 *
 * @param {Object} config - Rule configuration
 * @param {string} config.unsafeFn - Name of unsafe function (e.g., 'tmpdir', 'mkdirSync')
 * @param {string} config.unsafeModule - Module containing unsafe function (e.g., 'node:os', 'node:fs')
 * @param {string} config.safeFn - Name of safe replacement function (e.g., 'normalizedTmpdir')
 * @param {string} config.safeModule - Module containing safe function. Pass the
 *   NARROW subpath that owns the symbol (`@vibe-agent-toolkit/utils/fs`), never
 *   the barrel — see `safe-import.cjs` for why.
 * @param {string} config.message - Error message to display
 * @param {readonly string[]} [config.exemptFiles] - FALLBACK repo-relative paths
 *   allowed to call the unsafe function, used only when the consuming config
 *   passes no `exemptFiles` option. Ship this empty: an exemption names one file
 *   in one repo, so a baked-in default is a hole in every OTHER repo. Consumers
 *   declare their own via the rule option (see `exempt-path-matcher.cjs`).
 * @param {boolean} [config.checkMemberExpression] - Check for obj.method() calls (default: false)
 * @returns {Object} ESLint rule definition
 *
 * @example
 * // no-os-tmpdir.cjs
 * const factory = require('./eslint-rule-factory.cjs');
 * module.exports = factory({
 *   unsafeFn: 'tmpdir',
 *   unsafeModule: 'node:os',
 *   safeFn: 'normalizedTmpdir',
 *   safeModule: SAFE_FS_MODULE,
 *   message: 'Use normalizedTmpdir() for Windows compatibility',
 * });
 *
 * // …and in the consumer's eslint.config.js, naming ITS implementation file:
 * // '@vibe-agent-toolkit/no-os-tmpdir': ['error', { exemptFiles: ['src/paths.ts'] }]
 */

const {
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createConfigurableExemptPathMatcher,
  reportUnanchoredExemptEntries,
} = require('./exempt-path-matcher.cjs');
const {
  EXEMPT_AND_SAFE_MODULE_SCHEMA,
  isNameAlreadyBound,
  resolveSafeModule,
} = require('./safe-import.cjs');

/**
 * Helper function to filter unsafe import specifiers
 * Extracted to reduce nesting depth for code quality
 */
function filterUnsafeSpecifiers(importNode, unsafeFn) {
  return importNode.specifiers.filter((s) => s.imported && s.imported.name === unsafeFn);
}

/**
 * Helper function to remove unsafe import specifiers
 * Extracted to reduce nesting depth for code quality
 */
function removeUnsafeImportSpecifiers(fixer, sourceCode, unsafeImportNode, unsafeSpecs) {
  const fixes = [];
  for (const spec of unsafeSpecs) {
    const comma = sourceCode.getTokenAfter(spec);
    if (comma?.value === ',') {
      fixes.push(fixer.removeRange([spec.range[0], comma.range[1]]));
    } else {
      const commaBefore = sourceCode.getTokenBefore(spec);
      if (commaBefore?.value === ',') {
        fixes.push(fixer.removeRange([commaBefore.range[0], spec.range[1]]));
      } else {
        fixes.push(fixer.remove(spec));
      }
    }
  }
  return fixes;
}

module.exports = function createNoUnsafeRule(config) {
  const {
    unsafeFn,
    unsafeModule,
    safeFn,
    safeModule,
    message,
    exemptFiles = [],
    checkMemberExpression = false,
  } = config;

  const exemptMatcherFor = createConfigurableExemptPathMatcher(exemptFiles);

  // Normalize module names (support both 'node:os' and 'os')
  const moduleVariants = [unsafeModule];
  if (unsafeModule.startsWith('node:')) {
    moduleVariants.push(unsafeModule.replace('node:', ''));
  } else {
    moduleVariants.push(`node:${unsafeModule}`);
  }

  return {
    meta: {
      type: 'problem',
      docs: {
        description: `Enforce use of ${safeFn}() instead of ${unsafeFn}()`,
        category: 'Best Practices',
        recommended: true,
      },
      fixable: 'code',
      schema: [EXEMPT_AND_SAFE_MODULE_SCHEMA],
      messages: {
        noUnsafeOperation: message,
        [UNANCHORED_EXEMPT_FILE]: UNANCHORED_EXEMPT_MESSAGE,
      },
    },

    create(context) {
      const sourceCode = context.getSourceCode();
      // Resolved per invocation, not at factory-construction time: the option is
      // the consuming repo's, and one repo can configure the same rule
      // differently across config blocks.
      const targetModule = resolveSafeModule(context, safeModule);

      // Only the declared implementation file(s) may call the unsafe function.
      if (exemptMatcherFor(context)(context.getFilename())) {
        // Still surface a malformed exemption list: the file we are standing in
        // may be exempt only BECAUSE the entry is unanchored.
        return {
          Program(node) {
            reportUnanchoredExemptEntries(context, node);
          },
        };
      }

      let hasUnsafeImport = false;
      // Seeded from SCOPE, not from "did I see an import from safeModule?".
      // A file already importing `safeFn` from the barrel needs the call
      // rewritten but must NOT gain a second binding of the same name — that is
      // a SyntaxError, not a redundant import. See `safe-import.cjs`.
      let hasSafeImport = isNameAlreadyBound(sourceCode, safeFn);
      let unsafeImportNode = null;
      let safeImportNode = null;

      return {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },

        ImportDeclaration(node) {
          // Track unsafe module imports
          if (moduleVariants.includes(node.source.value)) {
            unsafeImportNode = node;
            for (const spec of node.specifiers) {
              if (spec.type === 'ImportSpecifier' && spec.imported.name === unsafeFn) {
                hasUnsafeImport = true;
              }
            }
          }

          // Track safe module imports
          if (node.source.value === targetModule) {
            safeImportNode = node;
            for (const spec of node.specifiers) {
              if (spec.type === 'ImportSpecifier' && spec.imported.name === safeFn) {
                hasSafeImport = true;
              }
            }
          }
        },

        CallExpression(node) {
          let isUnsafeCall = false;

          // Check for direct function call: unsafeFn()
          if (node.callee.name === unsafeFn) {
            isUnsafeCall = true;
          }

          // Check for member expression: obj.unsafeFn()
          if (
            checkMemberExpression &&
            node.callee.type === 'MemberExpression' &&
            node.callee.property.name === unsafeFn
          ) {
            isUnsafeCall = true;
          }

          if (!isUnsafeCall) {
            return;
          }

          context.report({
            node,
            messageId: 'noUnsafeOperation',
            data: { safeModule: targetModule },
            fix(fixer) {
              const fixes = [];

              // Replace unsafe call with safe call
              if (node.callee.type === 'MemberExpression') {
                // For obj.method(), replace just the method name
                fixes.push(fixer.replaceText(node.callee.property, safeFn));
              } else {
                // For method(), replace the whole callee
                fixes.push(fixer.replaceText(node.callee, safeFn));
              }

              // Add import if needed
              if (!hasSafeImport) {
                if (safeImportNode) {
                  // Add to existing safe module import
                  const lastSpecifier = safeImportNode.specifiers.at(-1);
                  fixes.push(fixer.insertTextAfter(lastSpecifier, `, ${safeFn}`));
                } else {
                  // Create new import after unsafe import or at the top
                  const targetNode = unsafeImportNode || sourceCode.ast.body[0];
                  const newImport = `import { ${safeFn} } from '${targetModule}';\n`;
                  fixes.push(fixer.insertTextAfter(targetNode, newImport));
                }
              }

              // Remove unsafe import if it's the only specifier
              if (hasUnsafeImport && unsafeImportNode) {
                const unsafeSpecs = filterUnsafeSpecifiers(unsafeImportNode, unsafeFn);
                if (unsafeImportNode.specifiers.length === 1 && unsafeSpecs.length === 1) {
                  // Remove entire import
                  fixes.push(fixer.remove(unsafeImportNode));
                } else if (unsafeSpecs.length > 0) {
                  // Remove just the unsafe specifier
                  fixes.push(...removeUnsafeImportSpecifiers(fixer, sourceCode, unsafeImportNode, unsafeSpecs));
                }
              }

              return fixes;
            },
          });
        },
      };
    },
  };
};

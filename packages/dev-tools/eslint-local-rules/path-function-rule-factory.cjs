/**
 * ESLint Rule Factory for banning specific path functions from node:path
 *
 * Handles both import styles:
 * - Named: import { join } from 'node:path' → join(...)
 * - Default/namespace: import path from 'node:path' → path.join(...)
 *
 * Auto-fixes to safePath.fn() from @vibe-agent-toolkit/utils.
 */

const PATH_MODULES = new Set(['node:path', 'path']);
const SAFE_MODULE = '@vibe-agent-toolkit/utils';
const SAFE_OBJECT = 'safePath';

/**
 * Remove a named import specifier, handling comma cleanup.
 */
function removeSpecifier(fixer, sourceCode, importNode, spec) {
  if (importNode.specifiers.length === 1) {
    return [fixer.remove(importNode)];
  }
  const comma = sourceCode.getTokenAfter(spec);
  if (comma?.value === ',') {
    return [fixer.removeRange([spec.range[0], comma.range[1]])];
  }
  const commaBefore = sourceCode.getTokenBefore(spec);
  if (commaBefore?.value === ',') {
    return [fixer.removeRange([commaBefore.range[0], spec.range[1]])];
  }
  return [fixer.remove(spec)];
}

/**
 * Track path module specifiers from an import declaration.
 */
function trackPathImport(node, unsafeFn, state) {
  for (const spec of node.specifiers) {
    if (spec.type === 'ImportSpecifier' && spec.imported.name === unsafeFn) {
      state.namedImportSpec = spec;
      state.namedImportNode = node;
    }
    if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
      state.defaultImportName = spec.local.name;
    }
  }
}

/**
 * Track safe module import from an import declaration.
 */
function trackSafeImport(node, state) {
  state.safeImportNode = node;
  for (const spec of node.specifiers) {
    if (spec.type === 'ImportSpecifier' && spec.imported.name === SAFE_OBJECT) {
      state.hasSafePathImport = true;
    }
  }
}

/**
 * Check if a call expression is an unsafe path function call.
 * Returns { isUnsafe, isNamed } or null if not a match.
 */
function classifyCall(node, unsafeFn, state) {
  // Direct call from named import: join(...)
  if (
    node.callee.type === 'Identifier' &&
    node.callee.name === unsafeFn &&
    state.namedImportSpec
  ) {
    return { isNamed: true };
  }
  // Member expression: path.join(...)
  if (
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === state.defaultImportName &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === unsafeFn
  ) {
    return { isNamed: false };
  }
  return null;
}

/**
 * Build auto-fix for an unsafe path function call.
 */
function buildFix(fixer, node, unsafeFn, isNamed, sourceCode, state) {
  const fixes = [fixer.replaceText(node.callee, `${SAFE_OBJECT}.${unsafeFn}`)];

  if (!state.hasSafePathImport) {
    if (state.safeImportNode) {
      const lastSpec = state.safeImportNode.specifiers[state.safeImportNode.specifiers.length - 1];
      fixes.push(fixer.insertTextAfter(lastSpec, `, ${SAFE_OBJECT}`));
    } else {
      const targetNode = state.namedImportNode || sourceCode.ast.body[0];
      fixes.push(fixer.insertTextAfter(targetNode, `\nimport { ${SAFE_OBJECT} } from '${SAFE_MODULE}';`));
    }
    state.hasSafePathImport = true;
  }

  if (isNamed && state.namedImportNode) {
    fixes.push(...removeSpecifier(fixer, sourceCode, state.namedImportNode, state.namedImportSpec));
  }

  return fixes;
}

module.exports = function createPathFunctionRule(config) {
  const { unsafeFn, message } = config;

  return {
    meta: {
      type: 'problem',
      docs: {
        description: `Enforce safePath.${unsafeFn}() instead of path.${unsafeFn}()`,
        category: 'Cross-platform compatibility',
        recommended: true,
      },
      fixable: 'code',
      schema: [],
      messages: {
        noUnsafePathFn: message,
      },
    },

    create(context) {
      const filename = context.getFilename();
      // Exempt the implementation file and its unit test (which tests platform-native behavior)
      if (filename.includes('path-utils.ts') || filename.includes('path-utils.test.ts')) {
        return {};
      }

      const sourceCode = context.getSourceCode();
      const state = {
        namedImportSpec: null,
        namedImportNode: null,
        defaultImportName: null,
        hasSafePathImport: false,
        safeImportNode: null,
      };

      return {
        ImportDeclaration(node) {
          if (PATH_MODULES.has(node.source.value)) {
            trackPathImport(node, unsafeFn, state);
          }
          if (node.source.value === SAFE_MODULE) {
            trackSafeImport(node, state);
          }
        },

        CallExpression(node) {
          const classification = classifyCall(node, unsafeFn, state);
          if (!classification) {
            return;
          }

          context.report({
            node,
            messageId: 'noUnsafePathFn',
            fix(fixer) {
              return buildFix(fixer, node, unsafeFn, classification.isNamed, sourceCode, state);
            },
          });
        },
      };
    },
  };
};

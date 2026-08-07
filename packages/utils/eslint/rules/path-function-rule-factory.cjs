/**
 * ESLint Rule Factory for banning specific path functions from node:path
 *
 * Handles both import styles:
 * - Named: import { join } from 'node:path' → join(...)
 * - Default/namespace: import path from 'node:path' → path.join(...)
 *
 * Auto-fixes to safePath.fn() from `@vibe-agent-toolkit/utils/path` — the narrow
 * subpath that owns `safePath`, NOT the barrel. See `safe-import.cjs`.
 */

const {
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createConfigurableExemptPathMatcher,
  reportUnanchoredExemptEntries,
} = require('./exempt-path-matcher.cjs');
const {
  EXEMPT_AND_SAFE_MODULE_SCHEMA,
  SAFE_PATH_MODULE,
  isNameAlreadyBound,
  resolveSafeModule,
} = require('./safe-import.cjs');

const PATH_MODULES = new Set(['node:path', 'path']);
const SAFE_OBJECT = 'safePath';

/**
 * The files allowed to call raw `node:path` functions are whichever ones the
 * CONSUMING repo says implement (or assert) its `safePath` wrappers — declared
 * per-rule as `{ exemptFiles: [...] }`, matched at a path-segment boundary (see
 * `exempt-path-matcher.cjs` for why these are not substrings).
 *
 * This list used to be hardcoded to VAT's own `packages/utils/src/path-core.ts`
 * et al. Those paths are meaningless in an adopter's tree and actively harmful
 * as a default — a same-named file at the same repo-relative path would inherit
 * an exemption it never declared. Default: nothing is exempt.
 */
const exemptMatcherFor = createConfigurableExemptPathMatcher();

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
      const lastSpec = state.safeImportNode.specifiers.at(-1);
      fixes.push(fixer.insertTextAfter(lastSpec, `, ${SAFE_OBJECT}`));
    } else {
      const targetNode = state.namedImportNode || sourceCode.ast.body[0];
      fixes.push(fixer.insertTextAfter(targetNode, `\nimport { ${SAFE_OBJECT} } from '${state.safeModule}';`));
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
      schema: [EXEMPT_AND_SAFE_MODULE_SCHEMA],
      messages: {
        noUnsafePathFn: message,
        [UNANCHORED_EXEMPT_FILE]: UNANCHORED_EXEMPT_MESSAGE,
      },
    },

    create(context) {
      if (exemptMatcherFor(context)(context.getFilename())) {
        // Still surface a malformed exemption list: the file we are standing in
        // may be exempt only BECAUSE the entry is unanchored.
        return {
          Program(node) {
            reportUnanchoredExemptEntries(context, node);
          },
        };
      }

      const sourceCode = context.getSourceCode();
      const state = {
        // Resolved per invocation — the option belongs to the consuming repo,
        // which may point different rules at different re-export entries.
        safeModule: resolveSafeModule(context, SAFE_PATH_MODULE),
        namedImportSpec: null,
        namedImportNode: null,
        defaultImportName: null,
        // Seeded from SCOPE, not from "did I see an import from SAFE_MODULE?".
        // A file already importing `safePath` from the barrel needs the call
        // rewritten but must NOT gain a second binding of the same name.
        hasSafePathImport: isNameAlreadyBound(sourceCode, SAFE_OBJECT),
        safeImportNode: null,
      };

      return {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },

        ImportDeclaration(node) {
          if (PATH_MODULES.has(node.source.value)) {
            trackPathImport(node, unsafeFn, state);
          }
          if (node.source.value === state.safeModule) {
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
            // The module name reaches the message through `{{safeModule}}` rather
            // than being spelled out in each rule's string, so the advice cannot
            // drift from where the fixer actually writes the import.
            data: { safeModule: state.safeModule },
            fix(fixer) {
              return buildFix(fixer, node, unsafeFn, classification.isNamed, sourceCode, state);
            },
          });
        },
      };
    },
  };
};

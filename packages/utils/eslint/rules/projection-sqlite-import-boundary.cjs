/**
 * ESLint rule: projection-sqlite-import-boundary
 *
 * Flags every import of `@vibe-agent-toolkit/projection-sqlite`, or of any of
 * its subpaths, in whatever file the rule is enabled for.
 *
 * The storage backend is a choice made at one edge: `resources` declares the
 * storage port and never names a backend, and the CLI picks one and injects it.
 * A second importer is how a backend's own handle — the run database, which
 * runs SQL — reaches code written against the port. So the rule has no scope of
 * its own: the config that enables it names the files that MAY import the
 * backend, through its `files`/`ignores`, and every other file it covers may
 * not.
 *
 * A type is an import too. A type-only import is erased at runtime, but it is
 * how a module comes to be written against a handle it was never meant to hold,
 * so every shape is covered: a static `import` (`import type` included), an
 * `export … from`, `export * from`, a dynamic `import()`, a type position
 * `import('…').T`, `import x = require('…')` and `require('…')`, each with a
 * literal or a plain template-literal specifier.
 *
 * Why a rule and not `no-restricted-imports`: flat config replaces a rule's
 * options per matching block, so a block that exempts one file from this ban
 * would also drop every other ban the same rule carries there.
 *
 * @example
 * // BAD — in resources: the port's package names its backend
 * import type { RunDatabase } from '@vibe-agent-toolkit/projection-sqlite';
 *
 * // GOOD — written against the port
 * import type { FactStore } from '@vibe-agent-toolkit/resources';
 */

'use strict';

const BACKEND = '@vibe-agent-toolkit/projection-sqlite';

/** Whether `source` names the backend or one of its subpaths. */
function isBackend(source) {
  return source === BACKEND || source.startsWith(`${BACKEND}/`);
}

/** The text of a literal or expression-free template specifier, or null. */
function specifierText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  if (node?.type === 'TSLiteralType') return specifierText(node.literal);
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow importing @vibe-agent-toolkit/projection-sqlite outside the files the config names — the ' +
        'storage backend is chosen and injected at one edge',
      // Not recommended: which files may import the backend is a fact about this
      // repository's package layout, not about an adopter's.
      recommended: false,
    },
    schema: [],
    messages: {
      backendImport:
        "Do not import '{{source}}' here. The storage backend is chosen and injected at one edge; write " +
        'against the FactStore port from @vibe-agent-toolkit/resources instead.',
    },
  },

  create(context) {
    function check(node, specifier) {
      const source = specifierText(specifier);
      if (source !== null && isBackend(source)) {
        context.report({ node, messageId: 'backendImport', data: { source } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, node.source);
      },
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      TSImportType: (node) => check(node, node.source ?? node.argument),
      TSExternalModuleReference: (node) => check(node, node.expression),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') check(node, node.arguments[0]);
      },
    };
  },
};

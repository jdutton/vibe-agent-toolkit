/**
 * ESLint rule: projection-sqlite-import-boundary
 *
 * Flags every import of `@vibe-agent-toolkit/projection-sqlite`, or of any of
 * its subpaths, in whatever file the rule is enabled for — by its package name,
 * or by a relative path that resolves, against the file being linted, to
 * anything under `packages/projection-sqlite/`.
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
 * `import('…').T`, `import x = require('…')`, `require('…')`, a
 * `createRequire(…)('…')` call or a call through a name bound to
 * `createRequire(…)`, and an ambient `declare module '…'`, each with a literal
 * or a plain template-literal specifier.
 *
 * Known limits, all needing data flow the rule does not do: a computed
 * specifier (`import(name)`), a `createRequire` result passed through anything
 * but a direct binding, and a path that reaches the backend through a symlink
 * or a `paths` alias in a tsconfig.
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

const { normalizeForMatch } = require('./exempt-path-matcher.cjs');

const BACKEND = '@vibe-agent-toolkit/projection-sqlite';

/** The backend's directory, as a path segment pair a resolved import lands under. */
const BACKEND_DIRECTORY = '/packages/projection-sqlite/';

/**
 * `specifier` resolved against the directory of `filename`, forward-slashed.
 * Lexical only: `.` and `..` segments are folded, nothing is read from disk.
 */
function resolveRelative(filename, specifier) {
  // Segments by match rather than by splitting: a rule module requires nothing
  // outside the rule pack, `node:path` included.
  const normalized = normalizeForMatch(filename);
  const segments = normalized.match(/[^/]+/g) ?? [];
  segments.pop();
  for (const segment of specifier.match(/[^/]+/g) ?? []) {
    if (segment === '..') segments.pop();
    else if (segment !== '.') segments.push(segment);
  }
  return `${normalized.startsWith('/') ? '/' : ''}${segments.join('/')}`;
}

/** Whether `source`, imported from `filename`, names the backend or anything inside it. */
function isBackend(source, filename) {
  if (source === BACKEND || source.startsWith(`${BACKEND}/`)) return true;
  if (!source.startsWith('./') && !source.startsWith('../')) return false;
  return resolveRelative(filename, source).includes(BACKEND_DIRECTORY);
}

/** Whether `node` is a call of `createRequire`, bare or as `module.createRequire`. */
function isCreateRequireCall(node) {
  if (node?.type !== 'CallExpression') return false;
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'createRequire';
  return callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
    && callee.property.name === 'createRequire';
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
    const filename = context.filename ?? context.getFilename();
    /** Names bound directly to a `createRequire(…)` result: each is a `require`. */
    const requireNames = new Set(['require']);

    function check(node, specifier) {
      const source = specifierText(specifier);
      if (source !== null && isBackend(source, filename)) {
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
      TSModuleDeclaration: (node) => {
        if (node.id.type === 'Literal') check(node, node.id);
      },
      VariableDeclarator: (node) => {
        if (node.id.type === 'Identifier' && isCreateRequireCall(node.init)) requireNames.add(node.id.name);
      },
      CallExpression: (node) => {
        const { callee } = node;
        const isRequire = (callee.type === 'Identifier' && requireNames.has(callee.name)) || isCreateRequireCall(callee);
        if (isRequire) check(node, node.arguments[0]);
      },
    };
  },
};

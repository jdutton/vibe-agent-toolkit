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
 * or a plain template-literal specifier. `createRequire` is recognised bare, as
 * any name an `import { createRequire as … }` binds, and as a member
 * (`module.createRequire`); the names bound to its result are collected from
 * the whole file before any call is checked, so a call written above its
 * binding is reported too.
 *
 * Known limits, all needing data flow the rule does not do: a computed
 * specifier (`import(name)`); a `createRequire` or a `createRequire(…)` result
 * reached through anything but a direct `const`/`let`/`var` binding or an
 * import specifier (a destructure of `require('node:module')`, an assignment,
 * an argument); names matched by spelling, so a shadowing binding of the same
 * name is reported as well; and a path that reaches the backend through a
 * symlink or a `paths` alias in a tsconfig.
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

/**
 * A resolved path that IS the backend's package directory or lies inside it: the
 * directory, then the end of the path or a separator. A sibling whose name
 * merely starts the same (`projection-sqlite-extras`) is neither.
 */
const LANDS_IN_BACKEND = /\/packages\/projection-sqlite(?:\/|$)/u;

/** A Windows drive segment (`C:`), which a `..` cannot climb above. */
const DRIVE = /^[A-Za-z]:$/u;

/**
 * `specifier` resolved against the directory of `filename`, forward-slashed.
 * Lexical only: `.` and `..` segments are folded, nothing is read from disk. A
 * `..` at the root stays there, as real resolution does, so a drive letter is
 * never popped and one path gives one answer on Windows and on POSIX.
 */
function resolveRelative(filename, specifier) {
  // Segments by match rather than by splitting: a rule module requires nothing
  // outside the rule pack, `node:path` included.
  const normalized = normalizeForMatch(filename);
  const segments = normalized.match(/[^/]+/gu) ?? [];
  const floor = DRIVE.test(segments[0] ?? '') ? 1 : 0;
  segments.pop();
  for (const segment of specifier.match(/[^/]+/gu) ?? []) {
    if (segment === '..') {
      if (segments.length > floor) segments.pop();
    } else if (segment !== '.') {
      segments.push(segment);
    }
  }
  return `${normalized.startsWith('/') ? '/' : ''}${segments.join('/')}`;
}

/** Whether `source`, imported from `filename`, names the backend or anything inside it. */
function isBackend(source, filename) {
  if (source === BACKEND || source.startsWith(`${BACKEND}/`)) return true;
  if (!source.startsWith('./') && !source.startsWith('../')) return false;
  // ESLint's filenames are absolute, so the resolved path keeps its root (`/` or
  // a drive) and the directory always follows a separator.
  return LANDS_IN_BACKEND.test(resolveRelative(filename, source));
}

/** The modules `createRequire` is imported from. */
const MODULE_MODULES = new Set(['module', 'node:module']);

/**
 * Whether `node` is a call of `createRequire`: by one of `names`, or as a
 * member (`module.createRequire`).
 */
function isCreateRequireCall(node, names) {
  if (node?.type !== 'CallExpression') return false;
  const { callee } = node;
  if (callee.type === 'Identifier') return names.has(callee.name);
  return callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
    && callee.property.name === 'createRequire';
}

/** Every local name an `import { createRequire as … }` of `node:module` binds, and the bare name. */
function createRequireNames(program) {
  const names = new Set(['createRequire']);
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || !MODULE_MODULES.has(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' ? specifier.imported : null;
      const importedName = imported?.type === 'Identifier' ? imported.name : imported?.value;
      if (importedName === 'createRequire') names.add(specifier.local.name);
    }
  }
  return names;
}

/** Every name a variable declarator anywhere in the file binds to a `createRequire(…)` result. */
function boundRequireNames(sourceCode, creators) {
  const names = new Set(['require']);
  for (const scope of sourceCode.scopeManager.scopes) {
    for (const variable of scope.variables) {
      const declarator = variable.defs.find((def) => def.node.type === 'VariableDeclarator')?.node;
      if (declarator?.id.type === 'Identifier' && isCreateRequireCall(declarator.init, creators)) {
        names.add(declarator.id.name);
      }
    }
  }
  return names;
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
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    /** The names `createRequire` goes by in this file. */
    let creators = new Set(['createRequire']);
    /** Names bound directly to a `createRequire(…)` result: each is a `require`. */
    let requireNames = new Set(['require']);

    function check(node, specifier) {
      const source = specifierText(specifier);
      if (source !== null && isBackend(source, filename)) {
        context.report({ node, messageId: 'backendImport', data: { source } });
      }
    }

    return {
      // Both sets come from the whole file before any call is visited, so the
      // order a binding and its use are written in does not decide the verdict.
      Program: (node) => {
        creators = createRequireNames(node);
        requireNames = boundRequireNames(sourceCode, creators);
      },
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
      CallExpression: (node) => {
        const { callee } = node;
        const isRequire = (callee.type === 'Identifier' && requireNames.has(callee.name))
          || isCreateRequireCall(callee, creators);
        if (isRequire) check(node, node.arguments[0]);
      },
    };
  },
};

/**
 * ESLint rule: no-existssync
 *
 * In product source, flags every use of `existsSync` from `node:fs` / `fs`:
 * a named import (aliased too) that is called or handed on as a value, a
 * namespace, default, `require()` or `await import()` binding read as
 * `fs.existsSync`, the same read straight off the loading expression
 * (`require('node:fs').existsSync`, `(await import('node:fs')).existsSync`), a
 * destructure of it out of any of those, and a re-export.
 *
 * `existsSync` answers `false` for `ENOENT` — and equally for `EACCES` (a
 * parent the process may not search), `ELOOP` and every other errno. So a
 * path the OS would not let VAT look at reads as "absent", and the run goes on
 * as if it were: a LICENSE is skipped, a manifest is "not found", a plugin
 * directory is missing. The replacement asks the one errno classifier:
 * `pathPresent(path, mode, side, absence)` from `@vibe-agent-toolkit/utils` answers
 * `false` only for an absence, and throws every other errno as a classified
 * `FS_FAULT` on the caller's side.
 *
 * ## Scope
 *
 * Product source: a file under `packages/<pkg>/src/` that is not itself a test
 * file. Tests and test-support (`packages/<pkg>/test/`) are not linted — a
 * fixture asking whether its own scratch file exists is not a run deciding
 * what to do. Like `no-io-in-unit-tier`, the layout is this repo's, which is
 * why the rule is not in `configs.recommended`.
 *
 * ## The floor — what this rule cannot see
 *
 * It follows bindings through scope, not values through data flow:
 * - an fs namespace copied first (`const f = fs; f.existsSync(p)`) or passed
 *   as an argument;
 * - `import('node:fs').then((fs) => fs.existsSync(p))`, and a `require`
 *   built by `createRequire`;
 * - a project module that re-exports it under another name is caught at its
 *   own `export { existsSync } from 'node:fs'`, not at the importers of that
 *   module.
 *
 * Option `allowFiles: string[]` — repo-relative paths of today's offenders,
 * the ratchet. Name files, never directories.
 *
 * @example
 * // BAD — an EACCES parent reads as "no manifest"
 * if (!existsSync(manifestPath)) return emptyInventory();
 *
 * // GOOD — absent is false; a refused stat throws a classified FS_FAULT
 * if (!pathPresent(manifestPath, 'follow', 'source', 'probe')) return emptyInventory();
 */

'use strict';

const { createExemptPathMatcher, isTestFile, normalizeForMatch } = require('./exempt-path-matcher.cjs');

const FS_MODULES = new Set(['node:fs', 'fs']);
const BANNED = 'existsSync';

/** `packages/<pkg>/src/` anywhere in a forward-slashed path. */
const PACKAGE_SRC_DIR = /(?:^|\/)packages\/[^/]+\/src\//u;

/** Whether `filename` is product source: under a package's `src/`, and not a test file. */
function isProductSource(filename) {
  if (!filename) {
    return false;
  }
  const normalized = normalizeForMatch(filename);
  return PACKAGE_SRC_DIR.test(normalized) && !isTestFile(normalized);
}

/** The string a key spells: an identifier's name or a string literal's value, else null. */
function spelledName(node, computed) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  return !computed && node?.type === 'Identifier' ? node.name : null;
}

/** TypeScript wrappers that change a value's type, never the value: `x as T`, `x!`, `x satisfies T`. */
const TYPE_ONLY_WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression']);

/** `node` with every type-only wrapper and one `await` peeled off. */
function unwrapped(node) {
  let expr = node;
  while (TYPE_ONLY_WRAPPERS.has(expr?.type)) {
    expr = expr.expression;
  }
  return expr?.type === 'AwaitExpression' ? unwrapped(expr.argument) : expr;
}

/**
 * The module a `require('x')`, `import('x')` or `await import('x')` initialiser
 * loads (a `require('x') as typeof X` too), or null for any other initialiser
 * (or a computed specifier).
 */
function loadedModuleOf(init) {
  const expr = unwrapped(init);
  if (expr?.type === 'ImportExpression') {
    return spelledName(expr.source, true);
  }
  const isRequire = expr?.type === 'CallExpression' && expr.callee.type === 'Identifier' && expr.callee.name === 'require';
  return isRequire ? spelledName(expr.arguments[0], true) : null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow existsSync from node:fs in product source — it answers false for a path it could not ' +
        'look at (EACCES, ELOOP) exactly as for one that is not there',
      category: 'Filesystem and process',
      bans: '`existsSync()` from `node:fs` — called, handed on, destructured or re-exported — under `packages/*/src/`',
      useInstead: '`pathPresent(path, mode, side, absence)` (absent only on an absence; every other errno a classified `FS_FAULT`)',
      // Not recommended: the scope (`packages/<pkg>/src/`) is a claim about this
      // repo's layout, and an adopter's tree has its own (see `no-io-in-unit-tier`).
      recommended: false,
      recommendedSeverity: 'error',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      existsSync:
        'existsSync answers false for a path it could not look at (EACCES, ELOOP) exactly as for one that is ' +
        'not there, so "could not look" goes on as "absent". Use pathPresent(path, mode, side, absence) from ' +
        '@vibe-agent-toolkit/utils: false only for an absence, every other errno a classified FS_FAULT.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const isAllowed = createExemptPathMatcher(context.options?.[0]?.allowFiles ?? []);
    if (!isProductSource(filename) || isAllowed(filename)) {
      return {};
    }
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function report(node) {
      context.report({ node, messageId: 'existsSync' });
    }

    /** Every read of a binding that holds `existsSync` itself. */
    function reportReads(variable) {
      for (const ref of variable?.references ?? []) {
        if (ref.isRead()) {
          report(ref.identifier);
        }
      }
    }

    /** `const { existsSync } = <fs>`: the bindings the pattern makes of it. */
    function reportDestructured(declarator) {
      if (declarator.id.type !== 'ObjectPattern') {
        return;
      }
      const variables = sourceCode.getDeclaredVariables(declarator);
      for (const prop of declarator.id.properties) {
        if (prop.type === 'Property' && prop.value.type === 'Identifier' && spelledName(prop.key, prop.computed) === BANNED) {
          reportReads(variables.find((variable) => variable.name === prop.value.name));
        }
      }
    }

    /** A binding of the whole fs module: `fs.existsSync` / `fs['existsSync']`, and a destructure of it. */
    function scanNamespace(variable) {
      for (const ref of variable?.references ?? []) {
        const id = ref.identifier;
        const parent = id.parent;
        if (!ref.isRead()) {
          continue;
        }
        if (parent.type === 'MemberExpression' && parent.object === id && spelledName(parent.property, parent.computed) === BANNED) {
          report(parent);
        } else if (parent.type === 'VariableDeclarator' && parent.init === id) {
          reportDestructured(parent);
        }
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type' || !FS_MODULES.has(node.source.value)) {
          return;
        }
        for (const spec of node.specifiers) {
          const [variable] = sourceCode.getDeclaredVariables(spec);
          if (spec.type !== 'ImportSpecifier') {
            scanNamespace(variable);
          } else if (spec.importKind !== 'type' && spelledName(spec.imported, false) === BANNED) {
            reportReads(variable);
          }
        }
      },
      // `import fs = require('node:fs')`.
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference;
        if (ref.type === 'TSExternalModuleReference' && FS_MODULES.has(spelledName(ref.expression, true))) {
          scanNamespace(sourceCode.getDeclaredVariables(node)[0]);
        }
      },
      VariableDeclarator(node) {
        if (!FS_MODULES.has(loadedModuleOf(node.init))) {
          return;
        }
        if (node.id.type === 'Identifier') {
          scanNamespace(sourceCode.getDeclaredVariables(node)[0]);
        } else {
          reportDestructured(node);
        }
      },
      // `require('node:fs').existsSync` / `(await import('node:fs')).existsSync`: no binding to follow.
      MemberExpression(node) {
        if (spelledName(node.property, node.computed) === BANNED && FS_MODULES.has(loadedModuleOf(node.object))) {
          report(node);
        }
      },
      ExportNamedDeclaration(node) {
        if (!FS_MODULES.has(node.source?.value)) {
          return;
        }
        for (const spec of node.specifiers) {
          if (spelledName(spec.local, false) === BANNED) {
            report(spec);
          }
        }
      },
      ExportAllDeclaration(node) {
        if (FS_MODULES.has(node.source.value)) {
          report(node);
        }
      },
    };
  },
};

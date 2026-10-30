/**
 * Shared scanner: every read of a named `node:fs` function, however it is reached.
 *
 * `no-existssync` and `no-link-following-fs` both ban functions of the fs module,
 * and both must see the same shapes — a named import (aliased too) that is called
 * or handed on as a value, a namespace, default, `require()` or `await import()`
 * binding read as `fs.name` (or `fs.promises.name`), the same read straight off the
 * loading expression (`require('node:fs').name`), a destructure of it out of any
 * of those, and a re-export. One copy, so the two rules cannot drift apart on what
 * counts as a use.
 *
 * It follows bindings through scope, not values through data flow: an fs namespace
 * copied first (`const f = fs`) or passed as an argument, `import('node:fs').then`,
 * and a `require` built by `createRequire` are not seen. A project module that
 * re-exports a banned function is caught at its own re-export.
 *
 * Also the one shape of such a rule ({@link productSourceFsBan}): its scope, its `allowFiles`
 * option and its report — each rule supplies only what it bans and why.
 *
 * Exports no `meta`, so the plugin entry point does not register it as a rule.
 */

'use strict';

const { createExemptPathMatcher, isTestFile, normalizeForMatch } = require('./exempt-path-matcher.cjs');

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

/** The namespace of the fs module's promise API, read off the module: `fs.promises`. */
const PROMISES = 'promises';

/**
 * The visitors that report every use of a `banned` function of a `modules` module.
 *
 * @param {import('eslint').Rule.RuleContext} context - The rule's context
 * @param {{ modules: ReadonlySet<string>, banned: ReadonlySet<string>, report: (node: object, name: string) => void }} spec
 *   - `modules`: the specifiers that load the fs module (`node:fs`, `fs`, and any promise flavour)
 *   - `banned`: the function names to report
 *   - `report`: called once per use, with the node and the banned name it reaches
 */
function fsBindingVisitors(context, { modules, banned, report }) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();

  /** Every read of a binding that holds a banned function itself. */
  function reportReads(variable, name) {
    for (const ref of variable?.references ?? []) {
      if (ref.isRead()) {
        report(ref.identifier, name);
      }
    }
  }

  /** `const { name } = <fs>`: the bindings the pattern makes of a banned function, or of `promises`. */
  function reportDestructured(declarator) {
    if (declarator.id.type !== 'ObjectPattern') {
      return;
    }
    const variables = sourceCode.getDeclaredVariables(declarator);
    for (const prop of declarator.id.properties) {
      const key = prop.type === 'Property' ? spelledName(prop.key, prop.computed) : null;
      if (prop.type !== 'Property' || prop.value.type !== 'Identifier' || key === null) {
        continue;
      }
      const variable = variables.find((candidate) => candidate.name === prop.value.name);
      if (banned.has(key)) {
        reportReads(variable, key);
      } else if (key === PROMISES) {
        scanNamespace(variable);
      }
    }
  }

  /** `<ns>.name`, `<ns>['name']` and `<ns>.promises.name` off one namespace expression. */
  function scanMember(node) {
    const parent = node.parent;
    if (parent.type !== 'MemberExpression' || parent.object !== node) {
      return;
    }
    const name = spelledName(parent.property, parent.computed);
    if (banned.has(name)) {
      report(parent, name);
    } else if (name === PROMISES) {
      scanMember(parent);
    }
  }

  /** A binding of the whole fs module: `fs.name` / `fs['name']`, and a destructure of it. */
  function scanNamespace(variable) {
    for (const ref of variable?.references ?? []) {
      const id = ref.identifier;
      const parent = id.parent;
      if (!ref.isRead()) {
        continue;
      }
      if (parent.type === 'VariableDeclarator' && parent.init === id) {
        reportDestructured(parent);
      } else {
        scanMember(id);
      }
    }
  }

  return {
    ImportDeclaration(node) {
      if (node.importKind === 'type' || !modules.has(node.source.value)) {
        return;
      }
      for (const spec of node.specifiers) {
        const [variable] = sourceCode.getDeclaredVariables(spec);
        const imported = spec.type === 'ImportSpecifier' ? spelledName(spec.imported, false) : null;
        if (spec.type !== 'ImportSpecifier' || imported === PROMISES) {
          scanNamespace(variable);
        } else if (spec.importKind !== 'type' && banned.has(imported)) {
          reportReads(variable, imported);
        }
      }
    },
    // `import fs = require('node:fs')`.
    TSImportEqualsDeclaration(node) {
      const ref = node.moduleReference;
      if (ref.type === 'TSExternalModuleReference' && modules.has(spelledName(ref.expression, true))) {
        scanNamespace(sourceCode.getDeclaredVariables(node)[0]);
      }
    },
    VariableDeclarator(node) {
      if (!modules.has(loadedModuleOf(node.init))) {
        return;
      }
      if (node.id.type === 'Identifier') {
        scanNamespace(sourceCode.getDeclaredVariables(node)[0]);
      } else {
        reportDestructured(node);
      }
    },
    // `require('node:fs').name` / `(await import('node:fs')).name`: no binding to follow.
    MemberExpression(node) {
      const name = spelledName(node.property, node.computed);
      if (banned.has(name) && modules.has(loadedModuleOf(node.object))) {
        report(node, name);
      }
    },
    ExportNamedDeclaration(node) {
      if (!modules.has(node.source?.value)) {
        return;
      }
      for (const spec of node.specifiers) {
        const name = spelledName(spec.local, false);
        if (banned.has(name)) {
          report(spec, name);
        }
      }
    },
    ExportAllDeclaration(node) {
      if (modules.has(node.source.value)) {
        report(node, '*');
      }
    },
  };
}

/** The syntax of a value that is a function, never a link type: `() => …`, `function () {}`. */
const FUNCTION_LITERALS = new Set(['ArrowFunctionExpression', 'FunctionExpression']);

/**
 * Whether the use at `node` is a CALL that passes a third argument which can be a link type — not a
 * function literal (a callback), not `undefined`, not `null`. Syntax only: a callback passed by
 * name in the third place (`fs.symlink(t, p, done)`) reads as a type, as a variable holding one does.
 */
function passesThirdArgument(node) {
  const call = node.parent;
  if (call?.type !== 'CallExpression' || call.callee !== node) {
    return false;
  }
  const third = call.arguments[2];
  if (third === undefined || FUNCTION_LITERALS.has(third.type)) {
    return false;
  }
  return !(third.type === 'Identifier' && third.name === 'undefined') && !(third.type === 'Literal' && third.value === null);
}

/**
 * A rule banning fs functions in product source (`packages/<pkg>/src/`, not a test file), with an
 * `allowFiles: string[]` option of repo-relative paths it skips. Not recommended: the scope is a
 * claim about this repo's layout, and an adopter's tree has its own.
 *
 * @param {object} spec
 * @param {{ description: string, bans: string, useInstead: string }} spec.docs - The rule's docs
 * @param {string} spec.messageId - The id of its message for a `banned` function
 * @param {string} spec.message - The message; `{{name}}` is the banned function's name
 * @param {Set<string>} spec.modules - The module specifiers whose functions are banned
 * @param {Set<string>} spec.banned - The function names banned in every use
 * @param {{ names: Set<string>, messageId: string, message: string } | null} spec.untyped - Functions
 *   banned in every use EXCEPT a call that passes a third (type) argument — `symlink`, whose type
 *   Node on Windows otherwise picks by following the target — and their message; `null` for none
 */
function productSourceFsBan({ docs, messageId, message, modules, banned, untyped }) {
  const untypedNames = untyped?.names ?? new Set();
  const scanned = new Set([...banned, ...untypedNames]);
  const messages = untyped === null ? { [messageId]: message } : { [messageId]: message, [untyped.messageId]: untyped.message };
  return {
    meta: {
      type: 'problem',
      docs: { ...docs, category: 'Filesystem and process', recommended: false, recommendedSeverity: 'error' },
      schema: [
        {
          type: 'object',
          properties: {
            allowFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          },
          additionalProperties: false,
        },
      ],
      messages,
    },

    create(context) {
      const filename = context.filename ?? context.getFilename();
      const isAllowed = createExemptPathMatcher(context.options?.[0]?.allowFiles ?? []);
      if (!isProductSource(filename) || isAllowed(filename)) {
        return {};
      }
      const report = (node, name) => {
        if (!untypedNames.has(name)) {
          context.report({ node, messageId, data: { name } });
        } else if (!passesThirdArgument(node)) {
          context.report({ node, messageId: untyped.messageId, data: { name } });
        }
      };
      return fsBindingVisitors(context, { modules, banned: scanned, report });
    },
  };
}

module.exports = { fsBindingVisitors, isProductSource, productSourceFsBan };

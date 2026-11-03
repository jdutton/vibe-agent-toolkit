/**
 * ESLint rule to enforce the forward-slash converters instead of hand-rolled
 * normalization.
 *
 * Two converters, because a backslash means two different things:
 *
 * - `toForwardSlash(p)` — a NATIVE path (from `fs`, `path.*`, git). Converts
 *   only where the host's separator is a backslash; on POSIX a backslash is a
 *   filename character and is kept. `split(path.sep).join('/')` is exactly
 *   this, so it autofixes here.
 * - `toForwardSlashAnyPlatform(text)` — AUTHOR-WRITTEN text (an href, a glob, a
 *   config value, an archive entry name). Converts every backslash on every
 *   host. A literal-backslash `split('\\').join('/')`, `replaceAll('\\', '/')`
 *   or `replace(/\\/g, '/')` is exactly this, so each autofixes here — never to
 *   `toForwardSlash`, which would silently stop converting on POSIX.
 *
 * Whether a given literal-backslash site is really author text is the author's
 * call; the fix preserves behaviour, and a native-path site should then be
 * switched to `toForwardSlash` by hand.
 *
 * @example
 * // ❌ BAD - manual normalization
 * const a = relativePath.split(path.sep).join('/');
 * const b = href.replaceAll('\\', '/');
 *
 * // ✅ GOOD - use the utility functions
 * import { toForwardSlash, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils/path';
 * const a = toForwardSlash(relativePath);
 * const b = toForwardSlashAnyPlatform(href);
 */

const {
  DEAD_UNSAFE_IMPORT,
  DEAD_UNSAFE_IMPORT_MESSAGE,
  reportDeadUnsafeImports,
} = require('./dead-import.cjs');
const { loadedModuleOf, moduleBindingVisitors } = require('./fs-binding-scan.cjs');
const {
  createSafeImporter,
  SAFE_MODULE_ONLY_SCHEMA,
  SAFE_PATH_MODULE,
  resolveSafeModule,
} = require('./safe-import.cjs');

const NATIVE_FN = 'toForwardSlash';
const ANY_PLATFORM_FN = 'toForwardSlashAnyPlatform';
const MESSAGE_FOR = { [NATIVE_FN]: 'useToForwardSlash', [ANY_PLATFORM_FN]: 'useToForwardSlashAnyPlatform' };
const PATH_MODULES = new Set(['node:path', 'path']);
const BACKSLASH = '\\';

/** `.name(...)` on some receiver, with exactly `arity` arguments? */
function isMethodCall(node, name, arity) {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.property.name === name &&
    node.arguments.length === arity
  );
}

function isStringLiteral(node, value) {
  return node.type === 'Literal' && node.value === value;
}

/** `/\\/g` — one literal backslash, global. */
function isGlobalBackslashRegex(node) {
  return node.type === 'Literal' && node.regex?.pattern === String.raw`\\` && node.regex.flags.includes('g');
}

/**
 * Does `def` bind the WHOLE `node:path` module — `import path from`, `import * as path from`,
 * `const path = require(…)` / `await import(…)`, or `import path = require(…)`?
 */
function bindsPathModule(def) {
  if (def.type === 'ImportBinding' && def.parent?.type === 'ImportDeclaration') {
    return PATH_MODULES.has(def.parent.source.value) && def.parent.importKind !== 'type'
      && (def.node.type === 'ImportDefaultSpecifier' || def.node.type === 'ImportNamespaceSpecifier');
  }
  if (def.type === 'ImportBinding' && def.node.type === 'TSImportEqualsDeclaration') {
    const ref = def.node.moduleReference;
    return ref.type === 'TSExternalModuleReference' && PATH_MODULES.has(ref.expression.value);
  }
  return def.type === 'Variable' && def.node.id.type === 'Identifier' && PATH_MODULES.has(loadedModuleOf(def.node.init));
}

/**
 * `<ns>.sep` where `<ns>` resolves THROUGH SCOPE to the whole `node:path` module. Matched by
 * spelling, `import { posix as path }` — whose `sep` is always `/` — or a parameter named `path`
 * was rewritten to `toForwardSlash`, which converts backslashes on Windows where the original
 * did not.
 */
function isPathSep(sourceCode, node) {
  if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier'
    || node.property.name !== 'sep') {
    return false;
  }
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.object.name);
    if (variable !== undefined) return variable.defs.length === 1 && bindsPathModule(variable.defs[0]);
  }
  return false;
}

/**
 * `<x>.split(<sep>).join('/')` → the converter it is equivalent to.
 *
 * Splitting on a TWO-backslash SEQUENCE (e.g. collapsing a UNC server prefix)
 * is a different operation that neither converter matches, so it is not
 * reported.
 */
function matchSplitJoin(sourceCode, node) {
  if (!isMethodCall(node, 'join', 1) || !isStringLiteral(node.arguments[0], '/')) return undefined;
  const split = node.callee.object;
  if (!isMethodCall(split, 'split', 1)) return undefined;
  const [separator] = split.arguments;
  if (isPathSep(sourceCode, separator)) return { receiver: split.callee.object, fn: NATIVE_FN };
  if (isStringLiteral(separator, BACKSLASH)) return { receiver: split.callee.object, fn: ANY_PLATFORM_FN };
  return undefined;
}

/** `<x>.replaceAll('\\', '/')` or `<x>.replace(/\\/g, '/')` → the any-platform converter. */
function matchReplace(node) {
  const isReplace = isMethodCall(node, 'replace', 2) || isMethodCall(node, 'replaceAll', 2);
  if (!isReplace || !isStringLiteral(node.arguments[1], '/')) return undefined;
  const [pattern] = node.arguments;
  const allBackslashes =
    isGlobalBackslashRegex(pattern) ||
    (node.callee.property.name === 'replaceAll' && isStringLiteral(pattern, BACKSLASH));
  return allBackslashes ? { receiver: node.callee.object, fn: ANY_PLATFORM_FN } : undefined;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow manual path normalization patterns',
      category: 'Path handling',
      bans: "hand-rolled `.replace(/\\\\/g, '/')` / `split(path.sep).join('/')`",
      useInstead: '`toForwardSlash()` (native paths) / `toForwardSlashAnyPlatform()` (authored text)',
      subpath: '/path',
      recommended: true,
      recommendedSeverity: 'error',
    },
    fixable: 'code',
    messages: {
      useToForwardSlash:
        'Use toForwardSlash() from {{safeModule}} instead of manual path normalization. ' +
        'It converts a native path only where the host separator is a backslash.',
      useToForwardSlashAnyPlatform:
        'Use toForwardSlashAnyPlatform() from {{safeModule}} instead of a hand-rolled backslash replace. ' +
        'If this string is a native filesystem/git path rather than authored text, use toForwardSlash() — ' +
        'on POSIX a backslash is a filename character.',
      [DEAD_UNSAFE_IMPORT]: DEAD_UNSAFE_IMPORT_MESSAGE,
    },
    schema: [SAFE_MODULE_ONLY_SCHEMA],
  },

  create(context) {
    const sourceCode = context.getSourceCode();
    const targetModule = resolveSafeModule(context, SAFE_PATH_MODULE);
    // Bound, may-rewrite and the import each fix carries, per converter: the pack's ONE fixer
    // contract (`createSafeImporter` in `safe-import.cjs`), answered from scope and never mutated.
    const importers = {
      [NATIVE_FN]: createSafeImporter(sourceCode, NATIVE_FN, targetModule),
      [ANY_PLATFORM_FN]: createSafeImporter(sourceCode, ANY_PLATFORM_FN, targetModule),
    };
    // The dead-import leg's OTHER gate: a `toForwardSlash(…)` call is the text
    // this fixer writes for `path.sep`, and the only evidence available that it
    // wrote it here. Read from the source, never from a `fix()`.
    let safeReplacementCalled = false;
    // `path.sep` is the last `path.*` reference in plenty of files, and
    // `toForwardSlash(raw)` consumes it — leaving a dead `node:path` binding, whichever
    // whole-module shape bound it (`isPathSep`): an import, `require()`, `import()` or
    // `import path = require()`.
    const pathImportNodes = [];
    const bindings = moduleBindingVisitors(PATH_MODULES, (node) => pathImportNodes.push(node));

    return {
      VariableDeclarator: bindings.VariableDeclarator,
      TSImportEqualsDeclaration: bindings.TSImportEqualsDeclaration,

      'Program:exit'() {
        reportDeadUnsafeImports(
          context,
          sourceCode,
          pathImportNodes,
          importers[NATIVE_FN].boundInSource,
          safeReplacementCalled,
          // Rewrites `split(path.sep)`, never a named import.
          new Set(),
        );
      },

      ImportDeclaration(node) {
        bindings.ImportDeclaration(node);
        importers[NATIVE_FN].noteImport(node);
        importers[ANY_PLATFORM_FN].noteImport(node);
      },

      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === NATIVE_FN) {
          safeReplacementCalled = true;
        }
        const match = matchSplitJoin(sourceCode, node) ?? matchReplace(node);
        if (!match) return;
        const importer = importers[match.fn];
        const report = { node, messageId: MESSAGE_FOR[match.fn], data: { safeModule: targetModule } };
        // No fix where the converter call would reach another binding, nor for an optional chain
        // (`a?.replaceAll(…)`): `converter(a)` drops the `?.`, so it converts or throws where the
        // original yielded `undefined`. Nor for a comma-expression receiver (`(a, b).replaceAll(…)`):
        // as the converter's argument list it becomes TWO arguments, `converter(a, b)`.
        const unfixable = node.parent?.type === 'ChainExpression' || match.receiver.type === 'SequenceExpression';
        if (unfixable || !importer.mayRewrite(node)) {
          context.report(report);
          return;
        }
        context.report({
          ...report,
          fix(fixer) {
            if (!importer.canFix()) return null;
            const receiver = sourceCode.getText(match.receiver);
            // A new import lands above the file's first statement (`null` anchor).
            return [fixer.replaceText(node, `${match.fn}(${receiver})`), ...importer.importFixes(fixer, null)];
          },
        });
      },
    };
  },
};

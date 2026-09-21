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
const {
  SAFE_MODULE_ONLY_SCHEMA,
  SAFE_PATH_MODULE,
  insertAboveWithComments,
  isNameAlreadyBound,
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

function isPathSep(node) {
  return node.type === 'MemberExpression' && node.object.name === 'path' && node.property.name === 'sep';
}

/**
 * `<x>.split(<sep>).join('/')` → the converter it is equivalent to.
 *
 * Splitting on a TWO-backslash SEQUENCE (e.g. collapsing a UNC server prefix)
 * is a different operation that neither converter matches, so it is not
 * reported.
 */
function matchSplitJoin(node) {
  if (!isMethodCall(node, 'join', 1) || !isStringLiteral(node.arguments[0], '/')) return undefined;
  const split = node.callee.object;
  if (!isMethodCall(split, 'split', 1)) return undefined;
  const [separator] = split.arguments;
  if (isPathSep(separator)) return { receiver: split.callee.object, fn: NATIVE_FN };
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
    // Seeded from SCOPE: a file that already binds the name must have the call
    // rewritten WITHOUT gaining a second binding of the same name — that is a
    // SyntaxError. See `safe-import.cjs`.
    const bound = {
      [NATIVE_FN]: isNameAlreadyBound(sourceCode, NATIVE_FN),
      [ANY_PLATFORM_FN]: isNameAlreadyBound(sourceCode, ANY_PLATFORM_FN),
    };
    // Never mutated — the dead-import leg must not be armed by a flag that a
    // suppressed report's `fix()` can spend. See `dead-import.cjs`.
    const safeBoundInSource = bound[NATIVE_FN];
    // The dead-import leg's OTHER gate: a `toForwardSlash(…)` call is the text
    // this fixer writes for `path.sep`, and the only evidence available that it
    // wrote it here. Read from the source, never from a `fix()`.
    let safeReplacementCalled = false;
    let utilsImportNode = null;
    // `path.sep` is the last `path.*` reference in plenty of files, and
    // `toForwardSlash(raw)` consumes it — leaving a dead `node:path` binding.
    const pathImportNodes = [];

    /**
     * Add `fn` to the import, when nothing binds it yet.
     *
     * NOT latched: two reports insert identical text at the identical anchor, so
     * ESLint applies one and drops the other as overlapping. Latching is not
     * free — ESLint runs `fix()` for a SUPPRESSED problem before the
     * `eslint-disable` filter discards it, so a latch could be spent by a report
     * that is then thrown away.
     */
    function importFix(fixer, fn) {
      if (bound[fn]) return [];
      if (utilsImportNode) {
        return [fixer.insertTextAfter(utilsImportNode.specifiers.at(-1), `, ${fn}`)];
      }
      const newImport = `import { ${fn} } from '${targetModule}';\n`;
      return [insertAboveWithComments(fixer, sourceCode, sourceCode.ast.body[0], newImport)];
    }

    return {
      'Program:exit'() {
        reportDeadUnsafeImports(
          context,
          sourceCode,
          pathImportNodes,
          safeBoundInSource,
          safeReplacementCalled,
        );
      },

      ImportDeclaration(node) {
        if (PATH_MODULES.has(node.source.value)) {
          pathImportNodes.push(node);
        }
        if (node.source.value !== targetModule) return;
        utilsImportNode = node;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && spec.imported.name in bound) {
            bound[spec.imported.name] = true;
          }
        }
      },

      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === NATIVE_FN) {
          safeReplacementCalled = true;
        }
        const match = matchSplitJoin(node) ?? matchReplace(node);
        if (!match) return;
        context.report({
          node,
          messageId: MESSAGE_FOR[match.fn],
          data: { safeModule: targetModule },
          fix(fixer) {
            const receiver = sourceCode.getText(match.receiver);
            return [fixer.replaceText(node, `${match.fn}(${receiver})`), ...importFix(fixer, match.fn)];
          },
        });
      },
    };
  },
};

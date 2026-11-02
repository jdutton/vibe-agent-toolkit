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
 * @param {'fix' | { appendArgument: string, suggestion: string } | { autofixAsStatement: true, suggestion: string }} config.rewrite - REQUIRED.
 *   - `'fix'` when the safe function takes the unsafe call's arguments unchanged and
 *     returns the same thing: an autofix swaps the callee.
 *   - `{ autofixAsStatement, suggestion }` when it takes the same arguments but RETURNS
 *     something else: only a call whose result is discarded (an expression statement)
 *     is autofixed; any other is offered as a suggestion described by `suggestion`.
 *   - `{ appendArgument, suggestion }` when it needs an argument the rule cannot know:
 *     no autofix — a suggestion rewrites a one-argument call and appends
 *     `appendArgument`, a placeholder that must fail the typecheck rather than guess a
 *     value that compiles.
 *   No call's fix — autofix or suggestion — ever removes the unsafe import: the binding
 *   may still back a call whose report was suppressed, or one no suggestion was taken
 *   for. The dead-import leg removes it, on the next pass, once nothing references it.
 * @param {Object} config.docs - The rule's `meta.docs` manifest entry: `category`,
 *   `bans`, `useInstead`, optional `subpath`, and `recommended` /
 *   `recommendedSeverity` (what `index.cjs` builds `configs.recommended` from).
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
  DEAD_UNSAFE_IMPORT,
  DEAD_UNSAFE_IMPORT_MESSAGE,
  reportDeadUnsafeImports,
} = require('./dead-import.cjs');
const {
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createConfigurableExemptPathMatcher,
  reportUnanchoredExemptEntries,
} = require('./exempt-path-matcher.cjs');
const { fsBindingVisitors, moduleBindingVisitors } = require('./fs-binding-scan.cjs');
const {
  createSafeImporter,
  EXEMPT_AND_SAFE_MODULE_SCHEMA,
  resolveSafeModule,
} = require('./safe-import.cjs');

/**
 * Read the `rewrite` declaration — see the factory's JSDoc for the three shapes.
 * Anything else throws: a rule the factory cannot read must not build, since the
 * fallback would be an autofix that emits the wrong call.
 *
 * @returns {{ autofix: 'always' | 'statement' | 'never', suggestion?: string, appendArgument?: string }}
 */
function readRewrite(rewrite, unsafeFn) {
  if (rewrite === 'fix') {
    return { autofix: 'always' };
  }
  const isObject = rewrite !== null && typeof rewrite === 'object';
  const appends = isObject && typeof rewrite.appendArgument === 'string';
  const asStatement = isObject && rewrite.autofixAsStatement === true;
  if (!isObject || typeof rewrite.suggestion !== 'string' || appends === asStatement) {
    throw new TypeError(
      `${unsafeFn} rule: \`rewrite\` must be 'fix', { appendArgument, suggestion } or { autofixAsStatement: true, suggestion }`,
    );
  }
  return appends
    ? { autofix: 'never', suggestion: rewrite.suggestion, appendArgument: rewrite.appendArgument }
    : { autofix: 'statement', suggestion: rewrite.suggestion };
}

/** Is `node` a call whose result is discarded — the whole of an expression statement? */
function isStatementCall(node) {
  return node.parent?.type === 'ExpressionStatement' && node.parent.expression === node;
}

/** Is `node` inside a type position (`typeof realpathSync`), where it names a type, not the function? */
function inTypeQuery(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'TSTypeQuery') {
      return true;
    }
  }
  return false;
}

/**
 * How a use of the unsafe function reaches it: the CALL it is the callee of — itself, or through
 * its `.native` variant (`realpathSync.native(x)`) — or null for a value reference (assigned,
 * passed, re-exported), which has no call to rewrite.
 */
function callOf(node) {
  const parent = node.parent;
  if (parent?.type === 'CallExpression' && parent.callee === node) {
    return { call: parent, native: false };
  }
  const nativeMember = parent?.type === 'MemberExpression' && parent.object === node
    && !parent.computed && parent.property.name === 'native';
  const call = parent?.parent;
  return nativeMember && call?.type === 'CallExpression' && call.callee === parent ? { call, native: true } : null;
}

/**
 * The last token of `arg` as written, its wrapping parentheses included: `(x)` in `f((x))` ends at
 * the inner `)`. An argument appended after the node alone would land INSIDE those parens —
 * `f((x, y))`, one sequence expression instead of two arguments.
 */
function lastTokenOfArgument(sourceCode, call, arg) {
  const callOpen = sourceCode.getTokenAfter(call.callee, (token) => token.value === '(');
  let before = sourceCode.getTokenBefore(arg);
  let last = sourceCode.getLastToken(arg);
  let after = sourceCode.getTokenAfter(arg);
  while (before.value === '(' && before.range[0] > callOpen.range[0] && after?.value === ')') {
    last = after;
    before = sourceCode.getTokenBefore(before);
    after = sourceCode.getTokenAfter(after);
  }
  return last;
}

/** One visitor object from several: a selector two of them handle runs both handlers, in order. */
function mergeVisitors(...visitorSets) {
  const merged = {};
  for (const visitors of visitorSets) {
    for (const [selector, handler] of Object.entries(visitors)) {
      const prior = merged[selector];
      merged[selector] = prior ? (node) => { prior(node); handler(node); } : handler;
    }
  }
  return merged;
}

module.exports = function createNoUnsafeRule(config) {
  const {
    unsafeFn,
    unsafeModule,
    safeFn,
    safeModule,
    message,
    docs,
    exemptFiles = [],
    rewrite,
  } = config;

  // Required, never defaulted: a rule whose replacement takes an argument the
  // unsafe call does not carry, or returns something else, must say so, or the
  // default autofix emits a call that does not compile or silently changes a value.
  const mode = readRewrite(rewrite, unsafeFn);
  /** Does this rule autofix THIS call, rather than only suggest a rewrite? */
  const autofixes = (callNode) =>
    mode.autofix === 'always' || (mode.autofix === 'statement' && isStatementCall(callNode));

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
        ...docs,
        // How far the autofix reaches, for the README's Fix column.
        ...(mode.autofix === 'statement' && { fix: 'statement' }),
        ...(mode.autofix === 'never' && { fix: 'suggest' }),
      },
      // Every mode suggests: a `.native` call is never autofixed (see `callOf`).
      hasSuggestions: true,
      // Always fixable: even a rule that autofixes no call removes, through the
      // dead-import leg, the unsafe import its accepted suggestions left behind.
      fixable: 'code',
      schema: [EXEMPT_AND_SAFE_MODULE_SCHEMA],
      messages: {
        noUnsafeOperation: message,
        useSafeCall: mode.suggestion ?? `Replace with ${safeFn}()`,
        [DEAD_UNSAFE_IMPORT]: DEAD_UNSAFE_IMPORT_MESSAGE,
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

      // Bound, may-rewrite and the import each fix carries: the pack's ONE fixer contract
      // (`createSafeImporter` in `safe-import.cjs`), answered from scope and never mutated.
      const importer = createSafeImporter(sourceCode, safeFn, targetModule);
      // The dead-import leg's OTHER gate: does this file actually call `safeFn`,
      // the free function this fixer writes? "The safe symbol is in scope" alone
      // let an unrelated coincidence arm the leg — see `dead-import.cjs`. Read
      // from the source during traversal, never from a `fix()`.
      let safeReplacementCalled = false;
      let unsafeImportNode = null;
      // Every declaration binding the unsafe module — an import, `require()`, `import()` or
      // `import x = require()` — for the dead-import leg (`moduleBindingVisitors`).
      const unsafeBindingNodes = [];
      // Every CALL of the unsafe module's own function, however it is reached — a named import
      // (aliased too), a namespace member `os.tmpdir()`, a destructure of a namespace or of a
      // `require()` / `import()` — resolved through scope by the ONE scan every rule banning a
      // module's function shares (`fs-binding-scan.cjs`). Reported at `Program:exit`, after every
      // import is seen, because a report computes its fix at once and the fix reads the
      // importer's noted import. A `.native` call is only suggested, and a value reference
      // reported with no rewrite.
      /** @type {Map<object, { native: boolean } | null>} each use's node → its call, null for a value reference */
      const unsafeUses = new Map();
      const scan = fsBindingVisitors(context, {
        modules: new Set(moduleVariants),
        banned: new Set([unsafeFn]),
        report: (node, name) => {
          if (name !== '*' && !inTypeQuery(node)) {
            const reached = callOf(node);
            unsafeUses.set(reached?.call ?? node, reached && { native: reached.native });
          }
        },
      });

      const bindings = moduleBindingVisitors(new Set(moduleVariants), (node) => unsafeBindingNodes.push(node));

      return mergeVisitors(scan, bindings, {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },

        'Program:exit'() {
          for (const [node, reached] of [...unsafeUses].sort(([a], [b]) => a.range[0] - b.range[0])) {
            if (reached === null) {
              context.report({ node, messageId: 'noUnsafeOperation', data: { safeModule: targetModule }, suggest: [] });
            } else {
              reportUnsafeCall(node, reached.native);
            }
          }
          reportDeadUnsafeImports(
            context,
            sourceCode,
            unsafeBindingNodes,
            importer.boundInSource,
            safeReplacementCalled,
            new Set([unsafeFn]),
          );
        },

        ImportDeclaration(node) {
          if (moduleVariants.includes(node.source.value)) {
            unsafeImportNode = node;
          }
          importer.noteImport(node);
        },

        CallExpression(node) {
          if (node.callee.type === 'Identifier' && node.callee.name === safeFn) {
            safeReplacementCalled = true;
          }
        },
      });

      function reportUnsafeCall(node, native) {
        // A call this rule does not autofix is offered as a SUGGESTION. One whose
        // replacement needs an argument the rule cannot know (`within`) carries a
        // placeholder that fails the typecheck at that spot — never a guessed value
        // that would compile — and appends to a one-argument call only: further
        // arguments belong to the unsafe function and mean nothing to the safe one.
        const report = { node, messageId: 'noUnsafeOperation', data: { safeModule: targetModule } };
        // No rewrite at all where the importer says the rewritten call would reach a
        // binding other than the safe function. Nor for a constructed first
        // argument (`new URL(…)`): every safe replacement takes a string path, so the
        // rewrite would not compile.
        if (!importer.mayRewrite(node) || node.arguments[0]?.type === 'NewExpression') {
          context.report({ ...report, suggest: [] });
        } else if (!native && autofixes(node)) {
          context.report({ ...report, fix: (fixer) => rewriteCall(fixer) });
        } else {
          const [only, ...rest] = node.arguments;
          const rewritable = mode.appendArgument === undefined
            || (only !== undefined && rest.length === 0 && only.type !== 'SpreadElement');
          context.report({
            ...report,
            suggest: rewritable ? [{ messageId: 'useSafeCall', fix: (fixer) => rewriteCall(fixer) }] : [],
          });
        }

        function rewriteCall(fixer) {
          // A CommonJS file cannot take the import this rewrite needs: no rewrite at all.
          if (!importer.canFix()) return null;
          const fixes = [];

          // Replace the WHOLE callee, member expression or not.
          //
          // Rewriting only the property turned `os.tmpdir()` into
          // `os.normalizedTmpdir()` — a method that does not exist on the
          // `node:os` namespace. The replacement is a free function from
          // OUR package, and the fixer imported it correctly; it just left
          // the call reaching for it through the wrong object. Silent, like
          // the overlap bug below: lint went green (the rule no longer sees
          // `tmpdir`), and it is a dangling MEMBER rather than a dangling
          // identifier, so `no-undef` cannot see it either. `tsc` can.
          fixes.push(fixer.replaceText(node.callee, safeFn));
          if (mode.appendArgument !== undefined) {
            fixes.push(fixer.insertTextAfter(lastTokenOfArgument(sourceCode, node, node.arguments[0]), `, ${mode.appendArgument}`));
          }

          // The import this fix needs, carried by THIS fix on every report — see
          // `createSafeImporter` for why no report may count on another's.
          fixes.push(...importer.importFixes(fixer, unsafeImportNode));

          // The unsafe import is NEVER removed here. ESLint runs `fix()` for a
          // suppressed report before the `eslint-disable` filter discards it, so
          // any removal carried by one report can land while a suppressed call
          // still needs the binding — latched to the first report, the removal
          // rode on an unsuppressed call BEFORE a suppressed one, and the output
          // linted clean and threw `ReferenceError`. Removal is the dead-import
          // leg's alone (`reportDeadUnsafeImports`, at `Program:exit`): it asks
          // scope on the next pass, after the rewrites, whether anything still
          // references the binding.
          return fixes;
        }
      }
    },
  };
};

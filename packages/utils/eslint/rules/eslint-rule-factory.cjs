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
 * @param {boolean} [config.checkMemberExpression] - Check for obj.method() calls (default: false)
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
const {
  EXEMPT_AND_SAFE_MODULE_SCHEMA,
  insertAboveWithComments,
  isNameAlreadyBound,
  resolveSafeModule,
} = require('./safe-import.cjs');

/** Does this declaration bring in `name` as a named specifier? */
function importsName(importNode, name) {
  return importNode.specifiers.some(
    (spec) => spec.type === 'ImportSpecifier' && spec.imported.name === name,
  );
}

/**
 * The local name of `import os from 'node:os'` / `import * as os from 'node:os'`.
 *
 * Without it the member-expression check has no receiver to compare against,
 * and matching on the property name alone turns every `env.tmpdir()` into an
 * `os.tmpdir()` finding.
 */
function namespaceLocalName(importNode) {
  const spec = importNode.specifiers.find(
    (candidate) =>
      candidate.type === 'ImportDefaultSpecifier' || candidate.type === 'ImportNamespaceSpecifier',
  );
  return spec ? spec.local.name : null;
}

/**
 * The module specifier of `require('x')`, `import('x')` or `await import('x')`.
 *
 * A static `import * as os` is not the only way to end up holding the `node:os`
 * namespace, and the fix does not care which way it happened — the whole callee
 * is replaced by a free function, so `os.tmpdir()` becomes `normalizedTmpdir()`
 * whatever bound `os`.
 *
 * This is NOT a return to rc.1, which matched any receiver at all and so
 * "detected" these shapes only as a side effect of the defect that also produced
 * `os.normalizedTmpdir()`. The receiver check stays; this widens what counts as
 * evidence that the receiver IS the module's namespace, and nothing else.
 *
 * @param {object} [init] - The initialiser of a variable declarator.
 * @returns {string|null} The literal module name, or null.
 */
function namespaceModuleOf(init) {
  const expr = init?.type === 'AwaitExpression' ? init.argument : init;
  if (!expr) {
    return null;
  }
  const isDynamicImport = expr.type === 'ImportExpression';
  const isRequire =
    expr.type === 'CallExpression' &&
    expr.callee.type === 'Identifier' &&
    expr.callee.name === 'require';
  if (!isDynamicImport && !isRequire) {
    return null;
  }
  // `ImportExpression.source` / the sole `require` argument. A computed
  // specifier names no module we can check, so it binds nothing we may rewrite.
  const source = isDynamicImport ? expr.source : expr.arguments[0];
  return source?.type === 'Literal' && typeof source.value === 'string' ? source.value : null;
}

/**
 * Helper function to filter unsafe import specifiers
 * Extracted to reduce nesting depth for code quality
 */
function filterUnsafeSpecifiers(importNode, unsafeFn) {
  return importNode.specifiers.filter((s) => s.imported && s.imported.name === unsafeFn);
}

/**
 * Helper function to remove unsafe import specifiers
 * Extracted to reduce nesting depth for code quality
 */
function removeUnsafeImportSpecifiers(fixer, sourceCode, unsafeSpecs) {
  const fixes = [];
  for (const spec of unsafeSpecs) {
    const comma = sourceCode.getTokenAfter(spec);
    if (comma?.value === ',') {
      fixes.push(fixer.removeRange([spec.range[0], comma.range[1]]));
    } else {
      const commaBefore = sourceCode.getTokenBefore(spec);
      if (commaBefore?.value === ',') {
        fixes.push(fixer.removeRange([commaBefore.range[0], spec.range[1]]));
      } else {
        fixes.push(fixer.remove(spec));
      }
    }
  }
  return fixes;
}

module.exports = function createNoUnsafeRule(config) {
  const {
    unsafeFn,
    unsafeModule,
    safeFn,
    safeModule,
    message,
    exemptFiles = [],
    checkMemberExpression = false,
  } = config;

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
        category: 'Best Practices',
        recommended: true,
      },
      fixable: 'code',
      schema: [EXEMPT_AND_SAFE_MODULE_SCHEMA],
      messages: {
        noUnsafeOperation: message,
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

      let hasUnsafeImport = false;
      // Seeded from SCOPE, not from "did I see an import from safeModule?".
      // A file already importing `safeFn` from the barrel needs the call
      // rewritten but must NOT gain a second binding of the same name — that is
      // a SyntaxError, not a redundant import. See `safe-import.cjs`.
      let hasSafeImport = isNameAlreadyBound(sourceCode, safeFn);
      // The SAME question, answered once and never mutated. `hasSafeImport`
      // flips the moment a fix inserts the import, and the dead-import leg must
      // not be armed by a flag a suppressed report can spend — ESLint runs
      // `fix()` before the `eslint-disable` filter discards the problem.
      const safeBoundInSource = hasSafeImport;
      // The dead-import leg's OTHER gate: does this file actually call `safeFn`,
      // the free function this fixer writes? "The safe symbol is in scope" alone
      // let an unrelated coincidence arm the leg — see `dead-import.cjs`. Read
      // from the source during traversal, never from a `fix()`.
      let safeReplacementCalled = false;
      let unsafeImportNode = null;
      const unsafeImportNodes = [];
      let safeImportNode = null;
      // A SET, because a namespace can be bound by a static import, a
      // `require()`, or a dynamic `import()` — see `namespaceModuleOf`.
      const unsafeNamespaceNames = new Set();
      // Latches the REMOVAL only — never the insert. See `fix()` for why the
      // two shared edits must be treated differently.
      let unsafeImportRemoved = false;

      return {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },

        'Program:exit'() {
          reportDeadUnsafeImports(
            context,
            sourceCode,
            unsafeImportNodes,
            safeBoundInSource,
            safeReplacementCalled,
          );
        },

        ImportDeclaration(node) {
          if (moduleVariants.includes(node.source.value)) {
            unsafeImportNode = node;
            unsafeImportNodes.push(node);
            hasUnsafeImport = hasUnsafeImport || importsName(node, unsafeFn);
            const local = namespaceLocalName(node);
            if (local) {
              unsafeNamespaceNames.add(local);
            }
          }
          if (node.source.value === targetModule) {
            safeImportNode = node;
            hasSafeImport = hasSafeImport || importsName(node, safeFn);
          }
        },

        // `const os = require('node:os')` / `const os = await import('node:os')`.
        //
        // Recorded by NAME, matching how the static-import receiver has always
        // been tracked, so a declaration must precede its use — which is the
        // normal shape and the only one either form appears in. Resolving the
        // receiver through scope instead would also reject a shadowing rebind,
        // but it would change detection parity on a population an adopter has
        // already measured across 4,963 files, so it is not worth trading here.
        //
        // KNOWN RESIDUAL, measured: `dead-import.cjs` only removes an
        // `ImportDeclaration`, so after the rewrite `const os = require('node:os')`
        // and `const os = await import('node:os')` are both left behind as
        // `'os' is assigned a value but never used` (the dynamic form also draws
        // `sonarjs/no-dead-store`). Removing a VariableDeclaration is a wider edit
        // than removing an import (multiple declarators, destructuring, an `await`
        // inside control flow), so it is deliberately not done here. A static
        // `import * as os` — the shape that actually appears at scale — is cleaned
        // up. An adopter confirmed the residual 2-for-2 and measured **zero** files
        // using either dynamic shape across 4,963 tracked sources, so the
        // population this would serve is currently empty.
        //
        // If it is ever extended that far, note what makes the dynamic case
        // different in kind: the leftover `await import('node:os')` STILL RUNS.
        // The module is loaded and the promise awaited, and only the binding is
        // dead — so deleting the statement removes an execution, not just a name.
        // For these builtins that is unobservable, which is precisely why the
        // module list is closed; the same edit against an arbitrary module would
        // not be safe, and no `sideEffects` metadata could tell you so.
        VariableDeclarator(node) {
          if (node.id.type !== 'Identifier') {
            return;
          }
          const source = namespaceModuleOf(node.init);
          if (source !== null && moduleVariants.includes(source)) {
            unsafeNamespaceNames.add(node.id.name);
          }
        },

        CallExpression(node) {
          if (node.callee.type === 'Identifier' && node.callee.name === safeFn) {
            safeReplacementCalled = true;
          }

          let isUnsafeCall = false;

          // Check for direct function call: unsafeFn()
          if (node.callee.name === unsafeFn) {
            isUnsafeCall = true;
          }

          // Check for member expression: os.tmpdir()
          //
          // The RECEIVER must be the unsafe module's own namespace binding.
          // Matching on the property name alone made `env.tmpdir()` — any
          // object at all with a same-named method — an `os.tmpdir()` finding.
          // That was survivable while the fixer rewrote only the property
          // (`env.normalizedTmpdir()` fails to compile, so the false positive
          // announced itself); once the whole callee is replaced it becomes
          // `normalizedTmpdir()`, which compiles, type-checks, passes
          // `no-undef`, and silently calls a different function with the
          // receiver discarded. A false positive that produces WORKING code is
          // strictly the more dangerous kind.
          if (
            checkMemberExpression &&
            node.callee.type === 'MemberExpression' &&
            node.callee.object.type === 'Identifier' &&
            unsafeNamespaceNames.has(node.callee.object.name) &&
            node.callee.property.name === unsafeFn
          ) {
            isUnsafeCall = true;
          }

          if (!isUnsafeCall) {
            return;
          }

          context.report({
            node,
            messageId: 'noUnsafeOperation',
            data: { safeModule: targetModule },
            fix(fixer) {
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

              // Add import if needed — on EVERY report, deliberately.
              //
              // The sister factory emits this once per file, because there a
              // report that edits both the import and its own call site spans
              // everything between them, N reports leave N nested ranges, and
              // ESLint keeps one: the defect measured at 146 broken files.
              //
              // That guard does not belong here, and briefly having it was a
              // mistake worth recording. These rules do NOT key detection on
              // the import — `node.callee.name === unsafeFn` is true whether or
              // not the specifier survives — and `hasSafeImport` is reseeded
              // from scope each pass, so pass 2 always finished the job anyway.
              // An adversarial run confirmed the guard changed no output at 4,
              // 40 or 75 call sites. What it DID change was the failure mode:
              // ESLint runs `fix()` for a suppressed problem before the
              // `eslint-disable` filter discards it, so one disable comment on
              // the first call site spent the once-per-file edit and stranded
              // the file with calls the import no longer backs.
              //
              // Every report carrying its own import edit costs a pass and buys
              // a fix that is correct on its own — including when applied alone
              // from an editor's "fix this problem".
              if (!hasSafeImport) {
                if (safeImportNode) {
                  // Add to existing safe module import
                  const lastSpecifier = safeImportNode.specifiers.at(-1);
                  fixes.push(fixer.insertTextAfter(lastSpecifier, `, ${safeFn}`));
                } else {
                  // Land next to the imports, never after arbitrary code —
                  // `insertTextAfter(body[0])` on a file whose first statement
                  // is a `const` welds the declaration onto the end of it.
                  const targetNode = unsafeImportNode || sourceCode.ast.body[0];
                  const declaration = `import { ${safeFn} } from '${targetModule}';`;
                  fixes.push(
                    targetNode.type === 'ImportDeclaration'
                      ? fixer.insertTextAfter(targetNode, `\n${declaration}`)
                      : insertAboveWithComments(fixer, sourceCode, targetNode, `${declaration}\n`),
                  );
                }
              }

              // Remove the unsafe import — LATCHED, unlike the insert above.
              //
              // The asymmetry is the whole design. An insert is safe to repeat
              // (identical text, identical anchor, ESLint drops the duplicate)
              // and repeating it is what keeps each report's fix correct on its
              // own. A REMOVAL is not: if every report removes the specifier,
              // one of those removals lands even when the report that would
              // have rewritten the matching call was suppressed — and the
              // suppressed call is left calling an identifier the import no
              // longer provides. Measured: `tmpdir` undefined, permanently.
              //
              // Latched, the discarded first report simply takes the removal
              // with it, and the worst case is an unused import that
              // `no-unused-vars` will point at. A lint finding, not a crash.
              if (hasUnsafeImport && unsafeImportNode && !unsafeImportRemoved) {
                const unsafeSpecs = filterUnsafeSpecifiers(unsafeImportNode, unsafeFn);
                if (unsafeImportNode.specifiers.length === 1 && unsafeSpecs.length === 1) {
                  // Remove entire import
                  fixes.push(fixer.remove(unsafeImportNode));
                } else if (unsafeSpecs.length > 0) {
                  // Remove just the unsafe specifier
                  fixes.push(...removeUnsafeImportSpecifiers(fixer, sourceCode, unsafeSpecs));
                }
                unsafeImportRemoved = true;
              }

              return fixes;
            },
          });
        },
      };
    },
  };
};

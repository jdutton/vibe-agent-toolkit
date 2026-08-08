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
  SAFE_PATH_MODULE,
  insertAboveWithComments,
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
 *
 * Two specifier shapes are deliberately NOT tracked, because tracking them is
 * what let the fixer delete them:
 *
 * - **Type-only** (`import { type join, … }` / `import type { join }`). The
 *   binding exists only for the type checker; there is no call to rewrite, and
 *   removing the specifier silently breaks every `typeof join` that referenced
 *   it. `no-undef` cannot see the damage — it is a TYPE reference.
 * - **Aliased** (`import { join as pathJoin }`). The rule never reported
 *   `pathJoin(...)` in the first place — `classifyCall` matches on the callee's
 *   name — so tracking the specifier bought nothing and cost the whole import:
 *   an unrelated unbound `join(` elsewhere in the file made the fixer remove
 *   the alias, breaking every working `pathJoin` call site.
 */
function trackPathImport(node, unsafeFn, state) {
  if (node.importKind === 'type') {
    return;
  }
  for (const spec of node.specifiers) {
    if (
      spec.type === 'ImportSpecifier' &&
      spec.importKind !== 'type' &&
      spec.imported.name === unsafeFn &&
      spec.local.name === unsafeFn
    ) {
      state.namedImportSpec = spec;
      state.namedImportNode = node;
    }
    if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
      state.defaultImportName = spec.local.name;
    }
  }
}

/**
 * Is `name` re-exported by a bare `export { name }` in this file?
 *
 * Removing the import specifier then leaves the export naming nothing, and the
 * result does not PARSE — `Export 'join' is not defined`. An autofix whose
 * output cannot be parsed is the worst outcome available, so the specifier
 * stays and the call sites are still rewritten. Whatever is left is a lint
 * finding a human can read, not a broken file.
 */
function isReExported(sourceCode, name) {
  return sourceCode.ast.body.some(
    (node) =>
      node.type === 'ExportNamedDeclaration' &&
      !node.source &&
      node.specifiers.some((spec) => spec.local?.name === name),
  );
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
 * Is `name` resolvable from `node`'s scope outward — a parameter, a local, an
 * import, or a configured global?
 *
 * Used only to decide whether a bare `join(...)` with no `node:path` import is
 * OUR `join` or somebody else's. `import { join } from 'lodash'` binds the name
 * and is not our business; an unbound `join` is a ReferenceError waiting to
 * happen, and — see `classifyCall` — is exactly what a half-applied autofix
 * leaves behind.
 */
function isIdentifierBound(sourceCode, node, name) {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    if (scope.variables.some((variable) => variable.name === name)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a call expression is an unsafe path function call.
 *
 * Returns `{ isNamed }` — or `{ importOnly: true }` for a call that is already
 * correct and merely missing its import — or null if not a match.
 */
function classifyCall(node, unsafeFn, state, sourceCode) {
  const isMember = node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier';

  // Direct call: join(...)
  if (node.callee.type === 'Identifier' && node.callee.name === unsafeFn) {
    if (state.namedImportSpec) {
      return { isNamed: true };
    }
    // REPAIR LEG. Keying detection on "did I see the import?" made this rule
    // stop reporting the moment a fix removed the specifier, so a partial
    // `--fix` reached a stable fixpoint over source that no longer compiles and
    // exited clean.
    //
    // Gated on `safePath` already being bound, which is what makes it a repair
    // rather than a second, sloppier detector. An unbound `join` is NOT reliably
    // our `join`: ESLint scope analysis does not bind `declare global { function
    // join() }`, and it cannot see an ambient global from a `globals.d.ts`, an
    // `@types` package, or a bundler — `resolve` and `relative` are entirely
    // plausible as those. Requiring `safePath` in scope narrows this to the
    // half-migrated file it exists to finish, where the name really was ours.
    if (state.safePathBoundInSource && !isIdentifierBound(sourceCode, node.callee, unsafeFn)) {
      return { isNamed: false };
    }
    return null;
  }

  // Namespace call: path.join(...)
  if (
    isMember &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === state.defaultImportName &&
    node.callee.property.name === unsafeFn
  ) {
    return { isNamed: false };
  }

  // REPAIR LEG, the other half: `safePath.join(...)` with no `safePath` in
  // scope. This is what a partially-applied fix leaves — and without it, that
  // state is PERMANENT rather than transient.
  //
  // ESLint runs `fix()` for a problem BEFORE the `eslint-disable` filter
  // discards it, so a suppressed report on the first call site consumes the
  // once-per-file import edit and then throws it away. Every other call is
  // rewritten to `safePath.join`, nothing imports `safePath`, and no report
  // survives to carry the import on any later pass. Recognising the orphaned
  // call is what closes that loop; it costs one extra pass, and only in a file
  // that is already broken.
  if (
    isMember &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === SAFE_OBJECT &&
    node.callee.property.name === unsafeFn &&
    !isIdentifierBound(sourceCode, node.callee.object, SAFE_OBJECT)
  ) {
    return { importOnly: true };
  }

  return null;
}

/**
 * Build auto-fix for an unsafe path function call.
 *
 * ## Why the import edits are emitted at most ONCE per file
 *
 * ESLint merges the fixes one `fix()` yields into a SINGLE range spanning
 * `min..max`, and applies only non-overlapping ranges per pass. A fix that
 * touches both the import and its own call site therefore spans everything in
 * between — so N such reports produce N nested ranges, ESLint keeps the
 * shortest and DISCARDS THE REST.
 *
 * That is not an edge case, it is every file with more than one call site. The
 * import edit landed, the other calls did not, and (before `classifyCall` grew
 * its bare-call leg) the next pass could no longer see them because the
 * specifier it keyed on was gone. `--fix` reached a stable fixpoint over source
 * that does not compile and exited clean. An adopter measured 146 files left
 * with a dangling reference across one sweep — worst single file, 75 call sites.
 *
 * So: the shared edits belong to the first report, and every later report emits
 * a fix LOCAL to its own callee. Nothing overlaps, and one pass fixes the file.
 * `no-manual-path-normalize.cjs` carries the same guard for the same reason.
 *
 * Only the FIRST report's fix is self-sufficient, and that is load-bearing:
 * applying a later one ALONE — an editor's "fix this problem", or an
 * `eslint-disable` on the first call site — rewrites the call without adding
 * the import. ESLint runs `fix()` before the disable filter, so a suppressed
 * report consumes the once-per-file edit and then discards it.
 *
 * That state is recoverable rather than permanent ONLY because `classifyCall`
 * has a repair leg for an orphaned `safePath.join(...)`. Without it the file
 * stays broken through every subsequent `--fix`, because no report is left to
 * carry the import — measured, not reasoned about. An earlier draft of this
 * comment asserted the recovery came free from `hasSafePathImport` being seeded
 * from scope; that was wrong, and an adversarial run produced the stable broken
 * fixpoint to prove it.
 *
 * The shared edits still cannot be hoisted onto their own report: removing
 * `join` from the import while a suppressed `join(...)` call survives is the
 * same broken output reached a different way. `exemptFiles` opts a whole file
 * out.
 */
function importSafePath(fixer, sourceCode, state) {
  if (state.safeImportNode) {
    const lastSpec = state.safeImportNode.specifiers.at(-1);
    return fixer.insertTextAfter(lastSpec, `, ${SAFE_OBJECT}`);
  }
  const targetNode = state.namedImportNode || sourceCode.ast.body[0];
  const declaration = `import { ${SAFE_OBJECT} } from '${state.safeModule}';`;
  // Land the new import next to the imports, not after arbitrary code. A file
  // reported only through a repair leg may have no path import at all, and
  // `insertTextAfter(body[0])` would push the declaration below the statement
  // that needs it — legal, since imports hoist, but it reads as though the
  // fixer lost track of the file.
  return targetNode.type === 'ImportDeclaration'
    ? fixer.insertTextAfter(targetNode, `\n${declaration}`)
    : insertAboveWithComments(fixer, sourceCode, targetNode, `${declaration}\n`);
}

function buildFix(fixer, node, unsafeFn, classification, sourceCode, state) {
  // REPAIR: an orphaned `safePath.join(...)` is already the call we want, and
  // the only thing missing is the import that a discarded report was carrying.
  //
  // This deliberately ignores `state.hasSafePathImport`. That flag is mutated
  // inside `fix()`, and ESLint runs `fix()` for a SUPPRESSED problem before the
  // disable filter throws it away — so on every pass the suppressed report
  // spends the flag first and the repair emits nothing. The file then never
  // recovers, which is precisely the stable broken fixpoint this leg exists to
  // break. The gate that makes ignoring the flag safe is immutable: this
  // classification is only reached when `safePath` is unbound in the SOURCE.
  //
  // Several orphaned calls yield the identical insert at the identical anchor,
  // so ESLint applies one and drops the rest as overlapping — which is the
  // desired outcome, not a hazard.
  if (classification.importOnly) {
    return [importSafePath(fixer, sourceCode, state)];
  }

  const fixes = [fixer.replaceText(node.callee, `${SAFE_OBJECT}.${unsafeFn}`)];

  if (!state.hasSafePathImport) {
    fixes.push(importSafePath(fixer, sourceCode, state));
    state.hasSafePathImport = true;
  }

  if (
    classification.isNamed &&
    state.namedImportNode &&
    !state.namedImportRemoved &&
    !isReExported(sourceCode, unsafeFn)
  ) {
    fixes.push(...removeSpecifier(fixer, sourceCode, state.namedImportNode, state.namedImportSpec));
    state.namedImportRemoved = true;
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
        [DEAD_UNSAFE_IMPORT]: DEAD_UNSAFE_IMPORT_MESSAGE,
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
        // Both of these guard a SHARED edit against being emitted by more than
        // one report — see `buildFix` for what ESLint does with the overlap.
        namedImportRemoved: false,
        defaultImportName: null,
        // Seeded from SCOPE, not from "did I see an import from SAFE_MODULE?".
        // A file already importing `safePath` from the barrel needs the call
        // rewritten but must NOT gain a second binding of the same name.
        hasSafePathImport: isNameAlreadyBound(sourceCode, SAFE_OBJECT),
        // The SAME question, answered once and never mutated. `hasSafePathImport`
        // flips to true the moment a fix inserts the import, and gating the
        // repair leg on a flag that the first report can flip would arm it for
        // the rest of THIS pass — re-admitting the ambient-global false positive
        // in any file that also has a `path.join()` to fix.
        safePathBoundInSource: isNameAlreadyBound(sourceCode, SAFE_OBJECT),
        safeImportNode: null,
        // EVERY path-module declaration, not just the one carrying `unsafeFn`.
        // A file's dead binding is `import path from 'node:path'`, which
        // `trackPathImport` only ever recorded as a NAME. See `dead-import.cjs`.
        pathImportNodes: [],
      };

      return {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },

        'Program:exit'() {
          reportDeadUnsafeImports(
            context,
            sourceCode,
            state.pathImportNodes,
            state.safePathBoundInSource,
          );
        },

        ImportDeclaration(node) {
          if (PATH_MODULES.has(node.source.value)) {
            state.pathImportNodes.push(node);
            trackPathImport(node, unsafeFn, state);
          }
          if (node.source.value === state.safeModule) {
            trackSafeImport(node, state);
          }
        },

        CallExpression(node) {
          const classification = classifyCall(node, unsafeFn, state, sourceCode);
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
              return buildFix(fixer, node, unsafeFn, classification, sourceCode, state);
            },
          });
        },
      };
    },
  };
};

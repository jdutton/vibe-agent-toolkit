/**
 * ESLint rule: no-raw-node-path
 *
 * Bans the `node:path` functions that `safePath` wraps — `join`, `resolve`,
 * `relative` — and autofixes each call to `safePath.<fn>()` from
 * `@vibe-agent-toolkit/utils/path`. The wrappers add `toForwardSlash()`, so the
 * result never carries the backslashes `node:path` produces on Windows, which
 * is what turns a Map key, a string comparison or a glob match into a
 * platform-dependent bug.
 *
 * ONE rule with a `functions` option table, not one rule id per function. The
 * three functions are one concept — "never touch `node:path` raw" — and every
 * line of this file is shared between them; publishing them as three ids meant
 * three README rows, three suites, three disable vocabularies and a dead-import
 * helper whose whole purpose was cleaning up after the other two.
 *
 * Handles both import styles:
 * - Named: `import { join } from 'node:path'` → `join(...)`
 * - Default/namespace: `import path from 'node:path'` → `path.join(...)`
 *
 * Auto-fixes to `safePath.<fn>()` from the narrow subpath that owns `safePath`,
 * NOT the barrel. See `safe-import.cjs`.
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
  createSafeImporter,
  EXEMPT_AND_SAFE_MODULE_SCHEMA,
  SAFE_PATH_MODULE,
  resolveSafeModule,
} = require('./safe-import.cjs');

const PATH_MODULES = new Set(['node:path', 'path']);
const SAFE_OBJECT = 'safePath';
/** Specifiers that bind the whole module: `import path from …`, `import * as path from …`. */
const MODULE_SPECIFIERS = new Set(['ImportDefaultSpecifier', 'ImportNamespaceSpecifier']);

/**
 * The `node:path` functions `safePath` wraps, and therefore the only values
 * `functions` accepts: a name outside this list has no `safePath.<fn>` to be
 * rewritten to, and a fixer that wrote one would produce a call on a member
 * that does not exist.
 */
const WRAPPED_FUNCTIONS = Object.freeze(['join', 'resolve', 'relative']);

/**
 * The files allowed to call raw `node:path` functions are whichever ones the
 * CONSUMING repo says implement (or assert) its `safePath` wrappers — declared
 * as `{ exemptFiles: [...] }`, matched at a path-segment boundary (see
 * `exempt-path-matcher.cjs` for why these are not substrings).
 *
 * This list used to be hardcoded to VAT's own `packages/utils/src/path-core.ts`
 * et al. Those paths are meaningless in an adopter's tree and actively harmful
 * as a default — a same-named file at the same repo-relative path would inherit
 * an exemption it never declared. Default: nothing is exempt.
 */
const exemptMatcherFor = createConfigurableExemptPathMatcher();

/**
 * Record the declaration a function's named import lives in: where a new
 * `safePath` import is anchored. Which CALLS are this rule's is not decided here
 * but by {@link pathImportSpecifierOf}, through scope.
 */
function trackPathImport(node, state) {
  if (node.importKind === 'type') {
    return;
  }
  for (const spec of node.specifiers) {
    if (spec.type === 'ImportSpecifier' && spec.importKind !== 'type' && spec.local.name === spec.imported.name) {
      const fnState = state.byFn.get(spec.imported.name);
      if (fnState) {
        fnState.namedImportNode = node;
      }
    }
  }
}

/**
 * The VALUE `node:path` import specifier `identifier` resolves to THROUGH SCOPE, or null.
 *
 * Resolved, never matched by name: a parameter or local named `path` or `join` shadows the
 * import, and a rule that matched the callee's spelling rewrote `function f(path) { path.join() }`
 * onto `safePath`. A type-only specifier backs no value, so it is not a call site either — and
 * tracking one let the fixer delete it, breaking every `typeof join` where `no-undef` cannot see.
 *
 * @param {object} sourceCode - ESLint `SourceCode`.
 * @param {object} identifier - The callee identifier, or the object of a member callee.
 * @returns {object | null} The `ImportSpecifier` / `ImportDefaultSpecifier` / `ImportNamespaceSpecifier`.
 */
function pathImportSpecifierOf(sourceCode, identifier) {
  for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      const def = variable.defs[0];
      // `import x = require()` is an ImportBinding too, with no `ImportDeclaration` parent: not tracked.
      const isValuePathImport = def?.type === 'ImportBinding'
        && def.parent?.type === 'ImportDeclaration'
        && PATH_MODULES.has(def.parent.source.value)
        && def.parent.importKind !== 'type'
        && def.node.importKind !== 'type';
      return isValuePathImport ? def.node : null;
    }
  }
  return null;
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
 * If this is the call THIS rule's fixer writes — `safePath.<fn>(…)` for one of
 * the configured functions — return that function's name.
 *
 * The evidence that this rule migrated something in this file, and the reason it
 * is not enough to ask whether `safePath` is merely in scope. Read by BOTH legs
 * that would otherwise mistake a file-wide fact for a claim about one function:
 * the dead-import leg, and the bare-call repair leg in `classifyCall`.
 * Matched whether or not `safePath` is bound: an ORPHANED `safePath.join(…)` —
 * the repair leg's own subject — is still this fixer's handiwork.
 *
 * @param {object} node - A `CallExpression`.
 * @param {Map<string, object>} byFn - Per-function state, keyed by name.
 * @returns {string | undefined} The wrapped function's name, or undefined.
 */
function safeReplacementCallee(node, byFn) {
  const { callee } = node;
  const isSafeMember =
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === SAFE_OBJECT &&
    callee.property.type === 'Identifier' &&
    byFn.has(callee.property.name);
  return isSafeMember ? callee.property.name : undefined;
}

/**
 * Classify a bare `fn(...)` call — a NAMED import, a REPAIR candidate, or not ours.
 *
 * REPAIR LEG. Keying detection on "did I see the import?" made this rule stop
 * reporting the moment a fix removed the specifier, so a partial `--fix`
 * reached a stable fixpoint over source that no longer compiles and exited
 * clean.
 *
 * An unbound `join` is NOT reliably our `join`: ESLint scope analysis does not
 * bind `declare global { function join() }`, and it cannot see an ambient
 * global from a `globals.d.ts`, an `@types` package, or a bundler — `resolve`
 * and `relative` are entirely plausible as those. So the leg needs a second
 * condition, and `safePathBoundInSource` alone was the wrong one: it is a fact
 * about the FILE, not about `fn`, and a SIBLING function in this same table
 * hands it over for free. The `resolve` leg rewrites a `path.resolve(...)` and
 * imports `safePath`; on the next `--fix` pass the `join` leg sees a file with
 * `safePath` bound and an ambient-global `join(...)` that predates any of this
 * pack's involvement, and rewrites it to a different function. Measured with
 * both legs enabled over one file.
 *
 * So this is only a CANDIDATE. `Program:exit` admits it once the file has been
 * seen to contain a `safePath.<fn>(...)` call — the same positive evidence the
 * dead-import leg reads, and the only in-file signal that THIS function is
 * mid-migration HERE. No fix of this pack's removes the `node:path` specifier
 * beside a live call any more (the dead-import leg takes it only once nothing
 * references it), so a strand reaching this leg was left by an older release of
 * this rule, whose specifier removal shipped in the same all-or-nothing merged
 * fix as a callee rewrite — and so always beside a `safePath.<fn>(` call.
 *
 * What this gives up: a file a HUMAN half-migrated by hand — import deleted,
 * not one call rewritten — is no longer finished by `--fix`. That file is a
 * loud `no-undef`/`tsc` error rather than a silent one, and it was never this
 * pack's doing. Silently redirecting a live call to another function is.
 */
function classifyBareCall(node, fnState, state, sourceCode) {
  const spec = pathImportSpecifierOf(sourceCode, node.callee);
  if (spec?.type === 'ImportSpecifier' && spec.imported.name === fnState.fn) {
    return { fn: fnState.fn, isNamed: true };
  }
  if (state.safePathBoundInSource && !isIdentifierBound(sourceCode, node.callee, fnState.fn)) {
    return { fn: fnState.fn, isNamed: false, isRepair: true };
  }
  return null;
}

/**
 * Check if a call expression is an unsafe path function call.
 *
 * Returns `{ fn, isNamed }` — or `{ fn, importOnly: true }` for a call that is
 * already correct and merely missing its import — or `{ fn, isRepair: true }`
 * for a bare call that is ours only if the file also shows THIS function
 * mid-migration, which `Program:exit` decides once the whole file has been seen
 * — or null if not a match.
 */
function classifyCall(node, state, sourceCode) {
  const { callee } = node;

  // Direct call: join(...)
  if (callee.type === 'Identifier') {
    const fnState = state.byFn.get(callee.name);
    return fnState ? classifyBareCall(node, fnState, state, sourceCode) : null;
  }

  if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier' || callee.object.type !== 'Identifier') {
    return null;
  }
  const fn = callee.property.name;
  if (!state.byFn.has(fn)) {
    return null;
  }

  // Namespace call: path.join(...), `path` resolved through scope to the default or namespace import.
  if (MODULE_SPECIFIERS.has(pathImportSpecifierOf(sourceCode, callee.object)?.type)) {
    return { fn, isNamed: false };
  }

  // REPAIR LEG, the other half: `safePath.join(...)` with no `safePath` in
  // scope. An older release of this rule left exactly this: it carried the
  // import on the first report only, and a suppressed first report spent it,
  // so every other call was rewritten with no import. Without this leg no
  // report survives to carry the import on any later pass; recognising the
  // orphaned call is what finishes such a file.
  if (callee.object.name === SAFE_OBJECT && !isIdentifierBound(sourceCode, callee.object, SAFE_OBJECT)) {
    return { fn, importOnly: true };
  }

  return null;
}

/**
 * Build auto-fix for an unsafe path function call.
 *
 * Every report's fix carries the `safePath` import while the SOURCE does not bind it — the pack's
 * one fixer contract, `createSafeImporter` in `safe-import.cjs`. This rule once emitted the import
 * on the FIRST report only, through a flag flipped inside `fix()`; ESLint runs `fix()` for a
 * report an `eslint-disable` later discards, so a suppressed first call spent the flag and every
 * other fix — applied alone from an editor, or in the same pass — rewrote its call to an unbound
 * `safePath`. A fix carrying both the import and its call overlaps every other such fix, so a
 * multi-site file takes a second pass; it never takes a broken one.
 */
function buildFix(fixer, node, classification, state) {
  const fnState = state.byFn.get(classification.fn);
  // A CommonJS file cannot take the `safePath` import every leg below may need.
  if (!state.importer.canFix()) return null;
  // A `safePath` the rewritten call would reach instead of this package's — a shadowing parameter
  // or local, or a top-level binding that is not ours: no rewrite.
  if (!state.importer.mayRewrite(node)) return null;

  // REPAIR: an orphaned `safePath.join(...)` — left by an older release of this rule — is
  // already the call we want, and the only thing missing is the import. Several orphaned calls
  // yield the identical insert at the identical anchor, so ESLint applies one and drops the rest.
  if (classification.importOnly) {
    return state.importer.importFixes(fixer, fnState.namedImportNode);
  }

  const fixes = [
    fixer.replaceText(node.callee, `${SAFE_OBJECT}.${classification.fn}`),
    ...state.importer.importFixes(fixer, fnState.namedImportNode),
  ];

  // The `node:path` specifier is NEVER removed here. ESLint runs `fix()` for a
  // suppressed report before the disable filter discards it, so a removal riding
  // on any one report lands even when a suppressed call still reads `join(...)` —
  // an unsuppressed call BEFORE it was enough, and the output linted clean and
  // threw `ReferenceError`. The dead-import leg removes the specifier on the next
  // pass, once scope says nothing (a call, a re-export) references it.
  return fixes;
}

/** Per-function state: the specifier THIS function owns, and its migration evidence. */
function createFunctionState(fn) {
  return {
    fn,
    namedImportNode: null,
    // Set from the SOURCE as traversal walks it, and read only at
    // `Program:exit` — so it is a fact about the text being linted, not about
    // what a `fix()` intends to write. See `dead-import.cjs`, and the repair
    // leg in `classifyBareCall`, which gates on the same flag.
    safeReplacementCalled: false,
    // Bare unbound calls awaiting that evidence. Held rather than reported,
    // because a candidate can precede the migrated call that vouches for it.
    deferredRepairs: [],
  };
}

/** Options schema: `exemptFiles` and `safeModule` from the shared schema, plus the function table. */
const OPTIONS_SCHEMA = Object.freeze({
  ...EXEMPT_AND_SAFE_MODULE_SCHEMA,
  properties: {
    ...EXEMPT_AND_SAFE_MODULE_SCHEMA.properties,
    functions: {
      type: 'array',
      items: { enum: WRAPPED_FUNCTIONS },
      minItems: 1,
      uniqueItems: true,
    },
  },
});

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce safePath.join() / .resolve() / .relative() instead of the raw node:path functions',
      category: 'Path handling',
      bans: '`path.join()`, `path.resolve()`, `path.relative()`',
      useInstead: '`safePath.join()` / `.resolve()` / `.relative()`',
      subpath: '/path',
      // `warn`, not `error`: by far the highest-churn rule in the pack — it
      // fires on every raw `node:path` call in an existing codebase. Measured
      // on a 4,670-file adopter tree: 3,963 + 372 + 1 findings, every one of
      // them autofixable. `warn` lets a project run `--fix` and burn the list
      // down incrementally instead of blocking CI on day one; raise it to
      // `error` once the backlog is clear, which is what VAT itself does. The
      // criterion is MIGRATION VOLUME, not how real the finding is.
      recommended: true,
      recommendedSeverity: 'warn',
    },
    fixable: 'code',
    schema: [OPTIONS_SCHEMA],
    messages: {
      noUnsafePathFn:
        'Use safePath.{{fn}}() from {{safeModule}} instead of path.{{fn}}(). ' +
        'path.{{fn}}() returns backslashes on Windows, causing Map key mismatches and path comparison bugs.',
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
    const functions = context.options[0]?.functions ?? WRAPPED_FUNCTIONS;
    const safeModule = resolveSafeModule(context, SAFE_PATH_MODULE);
    // Bound, may-rewrite and the import each fix carries: the pack's ONE fixer contract
    // (`createSafeImporter` in `safe-import.cjs`), answered from scope and never mutated.
    const importer = createSafeImporter(sourceCode, SAFE_OBJECT, safeModule);
    const state = {
      // Resolved per invocation — the option belongs to the consuming repo,
      // which may point different rules at different re-export entries.
      safeModule,
      byFn: new Map(functions.map((fn) => [fn, createFunctionState(fn)])),
      importer,
      // Does the SOURCE bind this package's `safePath`? Gates the repair leg and the dead-import
      // leg; no fix can flip it, so a suppressed report cannot arm either.
      safePathBoundInSource: importer.boundInSource,
      // EVERY path-module declaration, not just the ones carrying a wrapped
      // function. A file's dead binding is `import path from 'node:path'`,
      // which `trackPathImport` does not record. See `dead-import.cjs`.
      pathImportNodes: [],
    };

    const report = (node, classification) => {
      context.report({
        node,
        messageId: 'noUnsafePathFn',
        // The module name reaches the message through `{{safeModule}}` rather
        // than being spelled out in a per-function string, so the advice cannot
        // drift from where the fixer actually writes the import.
        data: { fn: classification.fn, safeModule: state.safeModule },
        fix(fixer) {
          return buildFix(fixer, node, classification, state);
        },
      });
    };

    return {
      Program(node) {
        reportUnanchoredExemptEntries(context, node);
      },

      'Program:exit'() {
        // Holding these back cannot change any FIX, only when it is computed.
        // A repair candidate is classified only when `safePath` is bound in the
        // source, so the importer is bound and the call resolves to no
        // import: the report carries no import insert and no specifier removal,
        // and therefore nothing shared that an earlier report could have spent
        // first. (`importOnly` is the mirror case — it requires `safePath`
        // UNBOUND — so the two can never arise in the same file.)
        let anyReplacementCalled = false;
        for (const fnState of state.byFn.values()) {
          if (!fnState.safeReplacementCalled) {
            continue;
          }
          anyReplacementCalled = true;
          for (const candidate of fnState.deferredRepairs) {
            report(candidate, { fn: fnState.fn, isNamed: false });
          }
        }
        reportDeadUnsafeImports(
          context,
          sourceCode,
          state.pathImportNodes,
          state.safePathBoundInSource,
          anyReplacementCalled,
          new Set(state.byFn.keys()),
        );
      },

      ImportDeclaration(node) {
        if (PATH_MODULES.has(node.source.value)) {
          state.pathImportNodes.push(node);
          trackPathImport(node, state);
        }
        state.importer.noteImport(node);
      },

      CallExpression(node) {
        const replaced = safeReplacementCallee(node, state.byFn);
        if (replaced !== undefined) {
          state.byFn.get(replaced).safeReplacementCalled = true;
        }

        const classification = classifyCall(node, state, sourceCode);
        if (!classification) {
          return;
        }

        if (classification.isRepair) {
          state.byFn.get(classification.fn).deferredRepairs.push(node);
          return;
        }

        report(node, classification);
      },
    };
  },
};

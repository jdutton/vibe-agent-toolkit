/**
 * Removing the import binding THIS PACK's own fixers just orphaned.
 *
 * ## The gap this closes
 *
 * `path.join(a, b)` rewrites to `safePath.join(a, b)`, and when that was the
 * file's last `path.*` reference the `import path from 'node:path'` is left
 * bound to nothing. An adopter measured the consequence over ~5,100 sites:
 * `--fix` converged, and **536 errors survived across 232 files** — 289
 * `no-unused-vars` plus 247 `sonarjs/unused-import`, every one of them this same
 * class. Their repo gates at `--max-warnings=0`, so the fixed output did not
 * lint clean and the migration was not actually complete.
 *
 * The `no-undef` fixpoint check the rest of this pack leans on is structurally
 * blind to it: a dead import leaves nothing DANGLING, it leaves something SPARE.
 *
 * ## Why this cannot be delegated to the ecosystem
 *
 * `@typescript-eslint/no-unused-vars` declares `meta.fixable: 'code'` — and for
 * an unused import it emits only a SUGGESTION, which `--fix` never applies.
 * `eslint-plugin-sonarjs/unused-import` declares no fixer at all. Measured on
 * `@typescript-eslint/eslint-plugin@8.65.0`, with both rules enabled alongside
 * ours in a single `verifyAndFix`: the import survived. `meta.fixable` is a
 * capability flag about the RULE, not a promise about any given report.
 *
 * Those rules abstain for a real reason — removing an import can change
 * behaviour (`import './polyfill'`, modules with top-level effects), and a
 * generic rule cannot prove otherwise. A rule that CREATED the orphan is in a
 * strictly better position: it knows it just consumed the binding's last
 * reference, and it knows the module, because its own config named it.
 *
 * ## Why the module list is closed, and hardcoded
 *
 * Every entry is a Node builtin that this pack already targets, and every one is
 * side-effect-free with certainty decided here, at authoring time. The only
 * general signal available instead would be package.json `sideEffects` — author
 * declared, unverified, absent by default (and absence means "assume side
 * effects"), sometimes a glob array rather than a boolean, requiring filesystem
 * resolution per import inside a linter expected to be pure and fast, and it
 * **does not apply to `node:` builtins at all**, which is the only case here.
 * So: no `sideEffects` lookup, no I/O, no new dependency, and deliberately NOT
 * a general `unused-import-no-side-effects` rule. For blanket cleanup outside
 * this list, `eslint-plugin-unused-imports` already exists and already autofixes.
 *
 * Bare aliases (`path`, `os`, …) are listed beside their `node:`-prefixed
 * spellings because the rules themselves treat the two as one module. Detecting
 * `path.join()` from `import path from 'path'` and then declining to clean up
 * after it would leave exactly the adopter's blocker in place for whichever
 * spelling a file happened to use.
 */

const { loadedModuleOf } = require('./fs-binding-scan.cjs');

const REMOVABLE_MODULES = new Set([
  'node:path',
  'path',
  'node:os',
  'os',
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:child_process',
  'child_process',
]);

const DEAD_UNSAFE_IMPORT = 'deadUnsafeImport';
// States what the rule can actually observe, and no more. The earlier wording —
// "this rule's autofix rewrote the last call that referenced it" — asserted a
// CAUSE, and the leg cannot see causes: by the time a binding reads as dead the
// rewrite that killed it is a pass in the past and left no trace naming which
// import it drew on. On a file with two imports of the same module, one of them
// dead since before the pack ever ran, that sentence was simply false about one
// of the two. See `reportDeadUnsafeImports` for what the gate does prove.
const DEAD_UNSAFE_IMPORT_MESSAGE =
  "'{{local}}' has no remaining references, and this file already calls the safe " +
  "replacement this rule's autofix writes. Remove the '{{module}}' import.";

/**
 * Does this declaration bring in anything the type checker alone can see?
 *
 * A `type` binding has zero references by construction — scope analysis does not
 * record type positions as references — so "nothing uses it" is not evidence of
 * anything. Deleting one silently breaks every `typeof join` and every
 * annotation that named it, and NEITHER `no-undef` nor `no-unused-vars` can see
 * the damage, because the reference it broke was a type reference. Round 2 of
 * this work learned that by shipping the deletion first.
 */
function hasTypeOnlyBinding(node) {
  return (
    node.importKind === 'type' || node.specifiers.some((spec) => spec.importKind === 'type')
  );
}

/**
 * Is every binding this declaration introduces now unreferenced?
 *
 * Whole declarations here; a dead SPECIFIER beside a live one is
 * {@link deadRewrittenSpecifiers}'s, and only for a name the calling rule
 * rewrites.
 *
 * Re-exports need no special guard: `export { path }` and `export default path`
 * both register as references under espree AND `@typescript-eslint/parser`
 * (measured, both parsers), so such a declaration is never dead here — and the
 * same holds for a specifier, whose count {@link deadRewrittenSpecifiers} reads.
 */
function isDeadRemovableImport(sourceCode, node) {
  if (!REMOVABLE_MODULES.has(node.source.value)) {
    return false;
  }
  // A bare `import 'node:path';` declares no bindings, which would make "every
  // binding is dead" vacuously true. Whether the module has side effects is
  // beside the point — the author wrote a statement whose only possible purpose
  // is its effect, and deleting it is an edit nobody asked for.
  if (node.specifiers.length === 0 || hasTypeOnlyBinding(node)) {
    return false;
  }
  // `every` over a non-empty list: the `specifiers.length === 0` bail above is
  // what makes that safe, and it is the ONLY thing that does. A second
  // `declared.length > 0` here would look like belt-and-braces and would in fact
  // be a guard that can never fire — which mutation testing reports as an
  // unguarded line, correctly, because deleting the real check leaves it green.
  return sourceCode
    .getDeclaredVariables(node)
    .every((variable) => variable.references.length === 0);
}

/**
 * The named specifiers of a PARTLY live declaration that are now unreferenced
 * and that name a function the calling rule rewrites (`join` in
 * `import { join, dirname } from 'node:path'`).
 *
 * The rule's call fixes never remove a specifier — a suppressed report runs its
 * `fix()` too, so a removal riding on any one of them strands a suppressed call
 * — and without this the dead `join` beside a live `dirname` would survive every
 * pass as `no-unused-vars`. Narrowed to the rule's own names, so a specifier dead
 * for somebody else's reason is not this leg's to take. A default or namespace
 * binding beside a sole named specifier is left alone: removing the braces' only
 * member is the comma surgery where removal bugs live, for one rare shape.
 *
 * @param {object} sourceCode - ESLint `SourceCode` for the file being linted.
 * @param {object} node - An `ImportDeclaration` of a removable module.
 * @param {ReadonlySet<string>} rewrittenNames - The imported names the calling rule rewrites.
 * @returns {object[]} The dead specifiers, in source order.
 */
function deadRewrittenSpecifiers(sourceCode, node, rewrittenNames) {
  if (!REMOVABLE_MODULES.has(node.source.value) || hasTypeOnlyBinding(node)) {
    return [];
  }
  const named = node.specifiers.filter((spec) => spec.type === 'ImportSpecifier');
  if (named.length === 1 && named.length < node.specifiers.length) {
    return [];
  }
  return named.filter(
    (spec) =>
      rewrittenNames.has(spec.imported.name)
      && sourceCode.getDeclaredVariables(spec).every((variable) => variable.references.length === 0),
  );
}

/**
 * The fix removing one named specifier and the comma that joined it to a neighbour.
 *
 * @param {object} fixer - ESLint fixer.
 * @param {object} sourceCode - ESLint `SourceCode`.
 * @param {object} spec - An `ImportSpecifier` with at least one named neighbour.
 * @returns {object} The fix.
 */
function removeSpecifierFix(fixer, sourceCode, spec) {
  // Through the next token's start, so `{ join, dirname }` becomes `{ dirname }`, not `{  dirname }`.
  const after = sourceCode.getTokenAfter(spec);
  if (after?.value === ',') {
    return fixer.removeRange([spec.range[0], sourceCode.getTokenAfter(after).range[0]]);
  }
  const before = sourceCode.getTokenBefore(spec);
  return fixer.removeRange([before.range[0], spec.range[1]]);
}

/** `const { a, b } = …` with nothing but plain `name` / `key: name` properties — no default, rest or computed key. */
function isPlainPattern(id) {
  return id.type === 'ObjectPattern' && id.properties.every((property) => property.type === 'Property'
    && !property.computed && property.value.type === 'Identifier');
}

/**
 * Parents whose child statement can be deleted outright. Any other parent (`if`, `else`, a loop, a
 * label, a `for` head) takes the statement as its unbraced body or a part of itself, and deleting it
 * hands that place to the next statement. An `export` wrapper is not listed either: an exported
 * binding is referenced from outside.
 */
const STATEMENT_LISTS = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase', 'TSModuleBlock']);

/** The statement list a {@link STATEMENT_LISTS} parent holds. */
function siblingsOf(statement) {
  return statement.parent.type === 'SwitchCase' ? statement.parent.consequent : statement.parent.body;
}

/**
 * Whether deleting `statement` outright could change what its neighbours mean, so a lone `;` must
 * stand in for it. Decided from the AST, not from a list of risky tokens:
 * - the statement before it has no `;` of its own and something follows, so the follower could
 *   continue it (`const a = f()` then `[1].map(g)` is `f()[1].map(g)`; `<any>c` under TypeScript); or
 * - a string statement follows and only directives precede, so the string would become a directive.
 */
function mustLeaveEmptyStatement(sourceCode, statement) {
  const siblings = siblingsOf(statement);
  const index = siblings.indexOf(statement);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  if (next === undefined) return false;
  const continuesPrevious = previous !== undefined && sourceCode.getLastToken(previous).value !== ';';
  const becomesDirective = next.type === 'ExpressionStatement' && next.expression.type === 'Literal'
    && typeof next.expression.value === 'string'
    && siblings.slice(0, index).every((sibling) => typeof sibling.directive === 'string');
  return continuesPrevious || becomesDirective;
}

/**
 * The one way this module deletes a whole statement: outright, or as a lone `;` where
 * {@link mustLeaveEmptyStatement} says deleting it would change its neighbours' meaning.
 *
 * @param {object} sourceCode - ESLint `SourceCode`.
 * @param {object} fixer - ESLint fixer.
 * @param {object} statement - The statement to delete, directly in a {@link STATEMENT_LISTS} parent.
 * @returns {object} The fix.
 */
function removeStatement(sourceCode, fixer, statement) {
  return mustLeaveEmptyStatement(sourceCode, statement) ? fixer.replaceText(statement, ';') : fixer.remove(statement);
}

/**
 * The statement to remove for a `require()` / `import()` / `await import()` binding of a removable
 * module whose every binding is dead, or null to keep it.
 *
 * Only a WHOLE declaration of exactly one declarator: `const os = require('node:os'), n = 1` keeps
 * both, never comma surgery. Only one directly in a statement list ({@link STATEMENT_LISTS}), and
 * not a binding written again after its declaration (`os = …` is a reference the removal would
 * strand). Only a namespace binding (`const os = …`) or a plain destructure of one
 * (`const { tmpdir } = …`), so no default value's side effect goes with it.
 *
 * @param {object} sourceCode - ESLint `SourceCode`.
 * @param {object} declarator - A `VariableDeclarator` the binding scan found.
 * @returns {{ statement: object, module: string } | null}
 */
function deadLoadingDeclaration(sourceCode, declarator) {
  const module = loadedModuleOf(declarator.init);
  const statement = declarator.parent;
  const removable = REMOVABLE_MODULES.has(module)
    && STATEMENT_LISTS.has(statement.parent?.type)
    && statement.declarations.length === 1
    && (declarator.id.type === 'Identifier' || isPlainPattern(declarator.id));
  const dead = removable && sourceCode.getDeclaredVariables(declarator)
    .every((variable) => variable.references.every((reference) => reference.init === true));
  return dead ? { statement, module } : null;
}

/**
 * `import os = require('node:os')`, a value import directly in a statement list (so not
 * `export import os = …`, which parses as an `ExportNamedDeclaration` around it), whose binding
 * nothing references — or null.
 */
function deadImportEquals(sourceCode, node) {
  const ref = node.moduleReference;
  const module = ref.type === 'TSExternalModuleReference' ? ref.expression.value : null;
  const dead = REMOVABLE_MODULES.has(module) && STATEMENT_LISTS.has(node.parent?.type)
    && node.importKind !== 'type'
    && sourceCode.getDeclaredVariables(node).every((variable) => variable.references.length === 0);
  return dead ? { statement: node, module } : null;
}

/** Report and remove one dead non-`import` binding statement. */
function reportDeadStatement(context, sourceCode, bindingNode, dead) {
  context.report({
    node: dead.statement,
    messageId: DEAD_UNSAFE_IMPORT,
    data: {
      local: sourceCode.getDeclaredVariables(bindingNode).map((variable) => variable.name).join("', '"),
      module: dead.module,
    },
    fix: (fixer) => removeStatement(sourceCode, fixer, dead.statement),
  });
}

/**
 * Report — and remove — every import declaration this pass emptied out, and
 * every specifier of {@link deadRewrittenSpecifiers}. Also a `require()` /
 * `import()` / `import x = require()` binding of the module, when the whole
 * statement is dead ({@link deadLoadingDeclaration}, {@link deadImportEquals}).
 *
 * Runs at `Program:exit`, over the SOURCE as it stands this pass. That ordering
 * is the safety property, not an implementation detail: while a live reference
 * survives in the text being linted, the binding is not dead and nothing is
 * reported. The removal therefore lands on a later pass, after the rewrite that
 * consumed the last reference — never speculatively alongside it.
 *
 * ## The two-part gate, and the evidence it cannot get
 *
 * Both gates keep this a REPAIR leg rather than a general unused-import rule,
 * and both must be read from the SOURCE, never from a flag a `fix()` can flip:
 * ESLint runs `fix()` for a suppressed problem before the `eslint-disable`
 * filter discards it, so any mutable "did I add the import?" flag is already
 * spent and lying by the time this runs.
 *
 * - `safeBoundInSource` — the safe symbol is in scope at all.
 * - `replacementCalled` — THIS rule's own replacement is actually CALLED in this
 *   file (`safePath.join(…)`, `normalizedTmpdir()`, `toForwardSlash(…)`), which
 *   is the text its fixer writes and nothing else does.
 *
 * The first alone was the whole gate once, and it let an unrelated coincidence
 * arm the leg: `safePath` reaches scope for reasons that have nothing to do with
 * a call this pack consumed, and any `node:path` import that happened to be dead
 * already — dead before the pack ever ran, for somebody else's reason — was then
 * deleted under a message claiming this fixer had orphaned it. That is the
 * general unused-import rule the module docstring above declines to be, reached
 * by accident. The second gate closes it: no call to this rule's replacement
 * means this rule rewrote nothing here, whatever else is in scope.
 *
 * It does NOT get down to the individual declaration, and it cannot. Per-import
 * evidence has to name WHICH import a consumed reference belonged to, and the
 * only pass that knows is the one doing the rewrite — where every reference is
 * still live and nothing is dead to report. Removing speculatively in that pass
 * instead is the trap the rest of this pack is built around: a suppressed call
 * report still runs its `fix()`, so the removal lands while the call it was
 * paired with survives, and the file is left with a dangling reference (146 of
 * them, measured, in the defect this file exists to prevent). Latching state
 * across passes to carry the answer forward is the rejected `WeakMap` approach
 * for the same reason, one layer worse. So a file holding two imports of one
 * module, one of them dead all along, still gets both removed and one true
 * message plus one that merely describes the file rather than the history. The
 * message is worded to stay true of both; the residual is a redundant deletion,
 * never a broken one.
 *
 * Being over-strict here is cheap by construction: a gate that declines leaves
 * an unused import, which is a lint finding a human reads. Only firing wrongly
 * costs anything, and only the CALL rewrite can break a file.
 *
 * Its own report, with its own `fix`, deliberately — so the deletion appears in
 * lint output and can be suppressed at the import line, rather than a rewrite
 * quietly taking a declaration with it.
 *
 * Several rules in this pack can reach the same dead declaration in the same
 * pass (a file using only `path.join` and `path.resolve` finishes owing nothing
 * to `path`). They emit identical removals over an identical range, so ESLint
 * applies one and drops the rest as overlapping. Measured with the three
 * `safePath` rules enabled together over a file using all three: one
 * `verifyAndFix`, output clean under `no-undef` and `no-unused-vars`, nothing
 * left to report.
 *
 * In a check-only run that same file yields N identical messages, one per
 * enabled rule. **Do not "fix" that by latching across rules.** These rule
 * instances do share a module scope here, so a `WeakMap` keyed on `SourceCode`
 * would dedupe them — and would reintroduce the exact trap round 2 was spent
 * escaping. ESLint runs `fix()` for a suppressed problem BEFORE the
 * `eslint-disable` filter discards it, so an `eslint-disable-next-line` naming
 * whichever rule happened to win the latch would consume the file's only
 * removal and then throw it away, leaving the import permanently undeletable and
 * unreported. Duplicate messages on a file that is about to be fixed are the
 * cheap failure; a silently stranded file is not.
 *
 * @param {object} context - ESLint rule context.
 * @param {object} sourceCode - ESLint `SourceCode` for the file being linted.
 * @param {object[]} importNodes - Declarations binding the unsafe module seen this pass:
 *   `ImportDeclaration`s, and — from a rule that rewrites those shapes — the `VariableDeclarator`s
 *   and `TSImportEqualsDeclaration`s `moduleBindingVisitors` finds.
 * @param {boolean} safeBoundInSource - Was the safe symbol already bound in the SOURCE?
 * @param {boolean} replacementCalled - Does the SOURCE call this rule's own safe
 *   replacement? Both are required, and both are the caller's to compute from
 *   source — see the gate discussion above for why neither may be defaulted.
 * @param {ReadonlySet<string>} rewrittenNames - The imported names the calling
 *   rule's fixes rewrite (empty for a rule that rewrites no named import). Required:
 *   an omitted set would silently strand every dead specifier.
 */
function reportDeadUnsafeImports(
  context,
  sourceCode,
  importNodes,
  safeBoundInSource,
  replacementCalled,
  rewrittenNames,
) {
  if (!(rewrittenNames instanceof Set)) {
    throw new TypeError('reportDeadUnsafeImports: rewrittenNames must be a Set');
  }
  if (!safeBoundInSource || !replacementCalled) {
    return;
  }
  for (const node of importNodes) {
    if (node.type === 'ImportDeclaration') {
      reportDeadImportDeclaration(context, sourceCode, node, rewrittenNames);
      continue;
    }
    const dead = node.type === 'VariableDeclarator'
      ? deadLoadingDeclaration(sourceCode, node)
      : deadImportEquals(sourceCode, node);
    if (dead) reportDeadStatement(context, sourceCode, node, dead);
  }
}

/**
 * {@link reportDeadUnsafeImports} for one `ImportDeclaration`: the whole declaration when every
 * binding is dead and it is removable, else each dead specifier the rule rewrites.
 */
function reportDeadImportDeclaration(context, sourceCode, node, rewrittenNames) {
  if (!isDeadRemovableImport(sourceCode, node)) {
    for (const spec of deadRewrittenSpecifiers(sourceCode, node, rewrittenNames)) {
      context.report({
        node: spec,
        messageId: DEAD_UNSAFE_IMPORT,
        data: { local: spec.local.name, module: node.source.value },
        fix: (fixer) => removeSpecifierFix(fixer, sourceCode, spec),
      });
    }
    return;
  }
  context.report({
    node,
    messageId: DEAD_UNSAFE_IMPORT,
    data: {
      local: sourceCode
        .getDeclaredVariables(node)
        .map((variable) => variable.name)
        .join("', '"),
      module: node.source.value,
    },
    // An outright removal takes the declaration and leaves its newline, so a
    // blank line remains where the import was. That is exactly what the
    // specifier-removal leg in `no-raw-node-path.cjs` has always
    // done — its fixtures pin the leading `\n` — and matching it keeps one
    // behaviour rather than two. Extending the range through a trailing
    // whitespace-only remainder would tidy both, and should be done to both at
    // once, once an adopter has measured whether their formatter cares.
    fix: (fixer) => removeStatement(sourceCode, fixer, node),
  });
}

module.exports = {
  DEAD_UNSAFE_IMPORT,
  DEAD_UNSAFE_IMPORT_MESSAGE,
  REMOVABLE_MODULES,
  reportDeadUnsafeImports,
};

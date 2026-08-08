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
const DEAD_UNSAFE_IMPORT_MESSAGE =
  "'{{local}}' is no longer used — this rule's autofix rewrote the last call that " +
  "referenced it. Remove the '{{module}}' import.";

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
 * Whole declarations only. A partially-dead declaration (`import path, { sep }`
 * with `sep` still live) needs comma surgery, which is where removal bugs live,
 * and it is not the shape the adopter measured — so it is left alone and stays a
 * visible `no-unused-vars` finding rather than a risky edit.
 *
 * Re-exports need no special guard: `export { path }` and `export default path`
 * both register as references under espree AND `@typescript-eslint/parser`
 * (measured, both parsers), so such a declaration is never dead here. Round 2
 * added an explicit `isReExported` check for the SPECIFIER-removal path, where
 * the reference count is not consulted at all; this path reads the count, so a
 * second check would be a guard that can never fire.
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
 * Report — and remove — every import declaration this pass emptied out.
 *
 * Runs at `Program:exit`, over the SOURCE as it stands this pass. That ordering
 * is the safety property, not an implementation detail: while a live reference
 * survives in the text being linted, the binding is not dead and nothing is
 * reported. The removal therefore lands on a later pass, after the rewrite that
 * consumed the last reference — never speculatively alongside it.
 *
 * `migrated` gates the whole leg on the safe symbol being bound in the file, and
 * is what keeps this a REPAIR leg rather than a general unused-import rule. It
 * must be read from the SOURCE and never from a flag a `fix()` can flip: ESLint
 * runs `fix()` for a suppressed problem before the `eslint-disable` filter
 * discards it, so any mutable "did I add the import?" flag is already spent and
 * lying by the time this runs.
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
 * @param {object[]} importNodes - Unsafe-module `ImportDeclaration`s seen this pass.
 * @param {boolean} migrated - Was the safe symbol already bound in the SOURCE?
 */
function reportDeadUnsafeImports(context, sourceCode, importNodes, migrated) {
  if (!migrated) {
    return;
  }
  for (const node of importNodes) {
    if (!isDeadRemovableImport(sourceCode, node)) {
      continue;
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
      // `fixer.remove(node)` takes the declaration and leaves its newline, so a
      // blank line remains where the import was. That is exactly what the
      // specifier-removal leg in `path-function-rule-factory.cjs` has always
      // done — its fixtures pin the leading `\n` — and matching it keeps one
      // behaviour rather than two. Extending the range through a trailing
      // whitespace-only remainder would tidy both, and should be done to both at
      // once, once an adopter has measured whether their formatter cares.
      fix: (fixer) => fixer.remove(node),
    });
  }
}

module.exports = {
  DEAD_UNSAFE_IMPORT,
  DEAD_UNSAFE_IMPORT_MESSAGE,
  REMOVABLE_MODULES,
  reportDeadUnsafeImports,
};

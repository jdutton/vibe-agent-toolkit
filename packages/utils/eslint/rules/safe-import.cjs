/**
 * Where each safe replacement lives, and whether it is already in scope.
 *
 * ## Why the autofix targets a SUBPATH and not the barrel
 *
 * `@vibe-agent-toolkit/utils` publishes fifteen entry points. `safePath` and
 * `toForwardSlash` are reachable from `./path`, which pulls in nothing but
 * `node:path`; the barrel drags five third-party dependencies behind it. Every
 * rule in this pack used to autofix to the barrel while the README table shipped
 * beside it named the narrow subpath — so a release whose entire purpose was
 * narrow subpaths shipped lint rules that mechanically rewrote code AWAY from
 * them, one autofix at a time. An adopter running the pack over 4,670 files hit
 * 4,719 such sites.
 *
 * Naming the modules once, here, is what keeps the fixer, the error message and
 * the README from drifting apart again: a rule that hardcodes its own copy of
 * the string is how the first divergence happened.
 *
 * ## Why `isNameAlreadyBound` exists
 *
 * A fixer that adds `import { safePath } from '<target>'` to a file that already
 * imports `safePath` from somewhere else does not produce a redundant import —
 * it produces `SyntaxError: Identifier 'safePath' has already been declared`.
 *
 * That was latent while the target WAS the barrel (the fixer's own "do I already
 * import from the target?" check happened to cover the only module anyone
 * imported from). Pointing the fixer at `./path` makes it live for exactly the
 * population being migrated: every file that already reaches the helpers through
 * the barrel. So the check has to be "is this NAME bound?", not "did I see an
 * import from MY module?".
 *
 * Scope analysis rather than import scanning, because a top-level
 * `const safePath = ...` collides just as fatally as an import does.
 */

const { EXEMPT_FILES_SCHEMA } = require('./exempt-path-matcher.cjs');

const PACKAGE_NAME = '@vibe-agent-toolkit/utils';

/** `safePath`, `toForwardSlash`. */
const SAFE_PATH_MODULE = `${PACKAGE_NAME}/path`;
/** `normalizePath`, `normalizedTmpdir`, `mkdirSyncReal`, `resolveFromImportMeta`, `dynamicImportPath`. */
const SAFE_FS_MODULE = `${PACKAGE_NAME}/fs`;
/** `safeExecSync`. */
const SAFE_PROCESS_MODULE = `${PACKAGE_NAME}/process`;

/**
 * Is `name` already bound at the top level of the linted file?
 *
 * Checks the module scope (or the global scope for `sourceType: 'script'`), which
 * is where an added `import` declaration would land. A binding of the same name
 * inside a nested function is deliberately NOT a conflict — an import at the top
 * of the file is still legal, it is merely shadowed there.
 *
 * @param {object} sourceCode - ESLint `SourceCode` for the file being linted.
 * @param {string} name - The identifier the fixer wants to import.
 * @returns {boolean} True when adding an import of `name` would redeclare it.
 */
function isNameAlreadyBound(sourceCode, name) {
  const globalScope = sourceCode.getScope(sourceCode.ast);
  // `getScope(Program)` hands back the GLOBAL scope, not the module scope —
  // and every `import` binding lives in the module scope, which is its child.
  // Reading `globalScope.variables` alone finds nothing and the check silently
  // answers "not bound" for every ES module, i.e. exactly the files it exists
  // to protect. (RuleTester caught this: the fix emitted a duplicate binding.)
  const moduleScope = globalScope.childScopes.find((child) => child.type === 'module');
  const scope = moduleScope ?? globalScope;
  return scope.variables.some((variable) => variable.name === name);
}

/**
 * Insert `text` above `node`, ABOVE its leading comments.
 *
 * `fixer.insertTextBefore(node)` uses the node's own start offset, which is
 * after any comment attached to it — so inserting an import before the first
 * statement dropped it BETWEEN an `eslint-disable-next-line` and the line that
 * directive protects. The directive then applies to the inserted import, and
 * the statement the developer had deliberately suppressed silently becomes
 * fixable. A fixer that can revoke a suppression is a fixer that edits code
 * nobody asked it to touch.
 *
 * @param {object} fixer - ESLint rule fixer.
 * @param {object} sourceCode - ESLint `SourceCode` for the file being fixed.
 * @param {object} node - The node to insert above.
 * @param {string} text - Text to insert, including its own trailing newline.
 */
function insertAboveWithComments(fixer, sourceCode, node, text) {
  const comments = sourceCode.getCommentsBefore(node);
  const start = (comments[0] ?? node).range[0];
  return fixer.insertTextBeforeRange([start, start], text);
}

/**
 * The `safeModule` rule option: point the fixer at YOUR re-export seam.
 *
 * The narrow-subpath defaults above are right for a consumer importing this
 * package directly, and wrong for one that re-exports the helpers through its
 * own module. An adopter measured the difference: of the 61 packages in their
 * workspace that would receive a new import, **52 (620 files) do not declare
 * `@vibe-agent-toolkit/utils` at all**. Under pnpm's isolated `node_modules` an
 * undeclared import does not degrade — it fails to resolve. Across their top 25
 * affected packages our default resolved in 0; their own seam resolved in 24.
 * So the autofix is only as useful as its ability to name a specifier that
 * resolves where the fix lands, and only the consuming repo knows what that is.
 *
 * PER-RULE rather than one shared `settings` key, because a seam does not have
 * to split its symbols the way this package does. The same adopter's narrow
 * entry carries `normalizedTmpdir`/`mkdirSyncReal` but NOT `safePath`, so their
 * `no-os-tmpdir` and `no-path-join` need different targets — the exact "path
 * rules here, fs rules there" case a single key cannot express.
 */
const SAFE_MODULE_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 1,
});

/**
 * Add the `safeModule` property to a rule's options schema.
 *
 * `additionalProperties: false` is preserved deliberately: a typo'd `safeModules`
 * must be a loud config error, not a silently ignored override that leaves the
 * fixer writing the default specifier into every file.
 *
 * @param {object} [schema] - Existing options-object schema to extend.
 * @returns {object} Frozen schema accepting `safeModule` alongside `schema`'s own keys.
 */
function withSafeModuleOption(schema) {
  return Object.freeze({
    type: 'object',
    properties: { ...schema?.properties, safeModule: SAFE_MODULE_PROPERTY },
    additionalProperties: false,
  });
}

/** Options schema for rules that take BOTH `exemptFiles` and `safeModule`. */
const EXEMPT_AND_SAFE_MODULE_SCHEMA = withSafeModuleOption(EXEMPT_FILES_SCHEMA);

/** Options schema for rules that only name a module in their advice text. */
const SAFE_MODULE_ONLY_SCHEMA = withSafeModuleOption();

/**
 * The module this rule should name, for this rule invocation.
 *
 * @param {object} context - ESLint rule context.
 * @param {string} fallbackModule - The rule's narrow-subpath default.
 * @returns {string} The configured `safeModule`, or the default.
 */
function resolveSafeModule(context, fallbackModule) {
  const configured = context.options?.[0]?.safeModule;
  return typeof configured === 'string' && configured.length > 0 ? configured : fallbackModule;
}

module.exports = {
  EXEMPT_AND_SAFE_MODULE_SCHEMA,
  PACKAGE_NAME,
  SAFE_FS_MODULE,
  SAFE_MODULE_ONLY_SCHEMA,
  SAFE_PATH_MODULE,
  SAFE_PROCESS_MODULE,
  insertAboveWithComments,
  isNameAlreadyBound,
  resolveSafeModule,
  withSafeModuleOption,
};

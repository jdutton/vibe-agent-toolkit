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
 * ## Why `safeBindingOf` exists
 *
 * A fixer that adds `import { safePath } from '<target>'` to a file that already
 * imports `safePath` from somewhere else does not produce a redundant import —
 * it produces `SyntaxError: Identifier 'safePath' has already been declared`.
 * And "the name is bound" is not "the safe function is bound": a same-named
 * import from another module, or a type-only one, would catch the rewritten
 * call. So the question has three answers — absent, ours, foreign — and only the
 * first two take a rewrite.
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
 * The file's top-level scope: where an added `import` lands, and where a CommonJS
 * file's own top-level `const` lives.
 *
 * `getScope(Program)` hands back the GLOBAL scope, and both of those are its
 * child: the module scope of an ES module, or the function scope ESLint wraps
 * around a `sourceType: 'commonjs'` file. Reading the global scope alone answers
 * "not bound" for exactly the files the check exists to protect.
 *
 * @param {object} sourceCode - ESLint `SourceCode` for the file being linted.
 * @returns {object} The top-level eslint-scope `Scope`.
 */
function topLevelScope(sourceCode) {
  const globalScope = sourceCode.getScope(sourceCode.ast);
  const fileScope = globalScope.childScopes.find(
    (child) => child.type === 'module' || (child.type === 'function' && child.block === sourceCode.ast),
  );
  return fileScope ?? globalScope;
}

/** Is `source` a module this package publishes the safe helpers from: the target seam, or this package's barrel or a subpath? */
function isSafeSource(source, targetModule) {
  return source === targetModule || source === PACKAGE_NAME || source.startsWith(`${PACKAGE_NAME}/`);
}

/** Is `def` a VALUE `import { name } from '<safe source>'` — not aliased onto `name`, not type-only? */
function isSafeValueImport(def, name, targetModule) {
  const spec = def.node;
  const declaration = def.parent;
  return def.type === 'ImportBinding'
    && spec.type === 'ImportSpecifier'
    && spec.imported.name === name
    && spec.importKind !== 'type'
    && declaration?.importKind !== 'type'
    && isSafeSource(declaration.source.value, targetModule);
}

/** Is `def` a top-level `const { name } = require('<safe source>')` — the CommonJS spelling of the same import? */
function isSafeRequire(def, name, targetModule) {
  const declarator = def.node;
  const init = declarator?.init;
  const required = init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require'
    && init.arguments.length === 1 && init.arguments[0].type === 'Literal' && typeof init.arguments[0].value === 'string';
  return def.type === 'Variable' && required && isSafeSource(init.arguments[0].value, targetModule)
    && declarator.id.type === 'ObjectPattern'
    && declarator.id.properties.some((property) => property.type === 'Property' && !property.computed
      && property.key.type === 'Identifier' && property.key.name === name
      && property.value.type === 'Identifier' && property.value.name === name);
}

/**
 * What the file's top-level `name` is, for a fixer that rewrites a call to `name(…)`:
 *
 * - `'absent'` — nothing binds it: rewrite, and add the import.
 * - `'safe'` — a VALUE import (or `require` destructure) of the safe function itself, from the
 *   target seam or this package: rewrite, add nothing.
 * - `'foreign'` — anything else: a same-named import from another module, a type-only import, a
 *   local declaration. The rewritten call would reach THAT binding, or no value at all, and adding
 *   an import beside it redeclares the name — so no rewrite: the finding stays, fixed by hand.
 *
 * "The name is bound" is not "the safe function is bound": a fixer that read it so rewired
 * `tmpdir()` to a local module's `normalizedTmpdir`, and wrote a call to a type-only import.
 *
 * @param {object} sourceCode - ESLint `SourceCode` for the file being linted.
 * @param {string} name - The replacement's identifier.
 * @param {string} targetModule - The module the fixer imports `name` from.
 * @returns {'absent' | 'safe' | 'foreign'}
 */
function safeBindingOf(sourceCode, name, targetModule) {
  const variable = topLevelScope(sourceCode).variables.find((candidate) => candidate.name === name);
  if (variable === undefined) return 'absent';
  const safe = variable.defs.length > 0
    && variable.defs.every((def) => isSafeValueImport(def, name, targetModule) || isSafeRequire(def, name, targetModule));
  return safe ? 'safe' : 'foreign';
}

/**
 * Is `name` bound in a scope between `node` and the file's top level? A call rewritten
 * to `name` there reaches that inner binding, not the top-level one the fixer imports.
 *
 * @param {object} sourceCode - ESLint `SourceCode` for the file being linted.
 * @param {object} node - The call site.
 * @param {string} name - The replacement's identifier.
 * @returns {boolean} True when an inner scope shadows `name` at `node`.
 */
function isShadowedAt(sourceCode, node, name) {
  const top = topLevelScope(sourceCode);
  for (let scope = sourceCode.getScope(node); scope && scope !== top; scope = scope.upper) {
    if (scope.variables.some((variable) => variable.name === name)) return true;
  }
  return false;
}

/**
 * Can `name` be added to this existing import of the safe module? Only a VALUE
 * import with named specifiers takes one: appended to a type-only import the value
 * is type-only, to a namespace import the result does not parse, and a side-effect
 * import has no specifier to append after.
 *
 * @param {object} importNode - An `ImportDeclaration`.
 * @returns {boolean} True when `, name` may follow its last specifier.
 */
function takesNamedSpecifier(importNode) {
  return importNode.importKind !== 'type'
    && importNode.specifiers.some((spec) => spec.type === 'ImportSpecifier');
}

/**
 * Can the linted file take an `import` declaration? A CommonJS script cannot:
 * one inserted there leaves the file unparsable, so a fix that needs an import
 * it cannot add is withheld — the finding stays, rewritten by hand.
 *
 * @param {object} sourceCode - ESLint `SourceCode` for the file being linted.
 * @returns {boolean} True for an ES module.
 */
function acceptsImport(sourceCode) {
  return sourceCode.ast.sourceType === 'module';
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
  // A hashbang is never a comment to insert above: it must stay the file's first line, or the
  // file does not parse. ESLint exposes it as a `Shebang` comment.
  const firstComment = sourceCode.getCommentsBefore(node).find((comment) => comment.type !== 'Shebang');
  const start = (firstComment ?? node).range[0];
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
 * `no-os-tmpdir` and `no-raw-node-path` need different targets — the exact "path
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
  acceptsImport,
  EXEMPT_AND_SAFE_MODULE_SCHEMA,
  PACKAGE_NAME,
  SAFE_FS_MODULE,
  SAFE_MODULE_ONLY_SCHEMA,
  SAFE_PATH_MODULE,
  SAFE_PROCESS_MODULE,
  insertAboveWithComments,
  isShadowedAt,
  resolveSafeModule,
  safeBindingOf,
  takesNamedSpecifier,
  withSafeModuleOption,
};

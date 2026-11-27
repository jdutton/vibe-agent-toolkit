/**
 * ESLint rule: registry-iteration
 *
 * The relations a projection store holds and a statement can name are declared in three
 * registries: `PROJECTION_TABLES`, `ROW_SET_TABLES` and `DERIVED_TABLES`. Each is enumerated only
 * through its accessors (`storedRelationSpecs()`, `queryableRelationSpecs()`, `allDerivedSpecs()`),
 * so a new relation reaches every reader the moment its registry entry exists. A reader that
 * enumerates one registry by hand holds a second list, and the relation a later registry adds is
 * silently missing from it.
 *
 * So, outside the files named by `allowFiles` (the registry modules that implement the accessors),
 * the rule reports enumerating a registry: `Object.values|keys|entries|getOwnPropertyNames(X)`,
 * `Reflect.ownKeys(X)` and `for (… in X)`. Named access (`PROJECTION_TABLES.blobs.name`,
 * `PROJECTION_TABLES[key]`) and `'blobs' in PROJECTION_TABLES` are not enumeration and are not
 * reported.
 *
 * `X` is a registry when it resolves, through the file's scopes, to an import of one of the three
 * names (renamed or not), a namespace import's member of that name (`ns.ROW_SET_TABLES`), a `const`
 * initialised from one, or a declaration of that name in the file; a cast around it is seen
 * through. An unresolved name (a global) is judged by its spelling. Not followed: a registry handed
 * through a function parameter or a property of another object.
 *
 * Option `allowFiles: string[]` — repo-relative paths of the registry modules, matched at a
 * path-segment boundary. Ship it empty: which file owns a registry is a fact about one repository.
 *
 * @example
 * // BAD — a second list of the stored relations
 * for (const spec of Object.values(PROJECTION_TABLES)) create(spec);
 *
 * // GOOD — the one list
 * for (const spec of storedRelationSpecs()) create(spec);
 */

'use strict';

const { memberName } = require('./callee-name.cjs');
const { ALLOW_FILES_SCHEMA, isAllowListedFile } = require('./exempt-path-matcher.cjs');

/** The registries: enumerated only through their accessors. */
const REGISTRIES = new Set(['PROJECTION_TABLES', 'ROW_SET_TABLES', 'DERIVED_TABLES']);

/** `receiver.method(X)` calls that enumerate `X`'s own keys. */
const ENUMERATORS = new Map([
  ['Object', new Set(['values', 'keys', 'entries', 'getOwnPropertyNames'])],
  ['Reflect', new Set(['ownKeys'])],
]);

/** Expression wrappers that change a value's static type and nothing else. */
const TRANSPARENT = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

/**
 * The variable an identifier resolves to, walking up the scope chain, or null for a global: one the
 * file never declares (ESLint's global scope holds the builtins as variables without a definition).
 */
function resolveVariable(sourceCode, identifier) {
  for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable.defs.length > 0 ? variable : null;
  }
  return null;
}

/** The registry an import specifier binds, or null: `{ X }`, `{ X as Y }`. */
function importedRegistry(specifier) {
  if (specifier.type !== 'ImportSpecifier') return null;
  const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
  return REGISTRIES.has(imported) ? imported : null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow enumerating a relation registry (PROJECTION_TABLES, ROW_SET_TABLES, DERIVED_TABLES) outside the ' +
        'registry modules — every reader iterates the one list its accessors return',
      // Not recommended: it names one package's registries, and which file owns them is a fact
      // about this repository.
      recommended: false,
      recommendedSeverity: 'error',
      category: 'Correctness',
      bans: '`Object.values`/`keys`/`entries`/`getOwnPropertyNames(X)`, `Reflect.ownKeys(X)`, `for (… in X)` over `PROJECTION_TABLES`, `ROW_SET_TABLES` or `DERIVED_TABLES` (renamed and namespace imports included)',
      useInstead: '`storedRelationSpecs()`, `queryableRelationSpecs()`, `allDerivedSpecs()` filtered by `kind`; named access stays legal',
    },
    schema: [ALLOW_FILES_SCHEMA],
    messages: {
      iteration:
        '{{name}} is enumerated outside its registry module: a second list of the relations, which a relation ' +
        'added later is missing from. Iterate storedRelationSpecs(), queryableRelationSpecs() or allDerivedSpecs() ' +
        '(filter by kind); named access is fine.',
    },
  },

  create(context) {
    if (isAllowListedFile(context)) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** The registry an identifier names through its binding, or null. */
    function identifierRegistry(identifier, seen) {
      const variable = resolveVariable(sourceCode, identifier);
      if (variable === null) return REGISTRIES.has(identifier.name) ? identifier.name : null;
      if (seen.has(variable)) return null;
      seen.add(variable);
      const [definition] = variable.defs;
      if (definition.type === 'ImportBinding') return importedRegistry(definition.node);
      if (definition.type === 'Variable' && definition.node.init) {
        const aliased = registryOf(definition.node.init, seen);
        if (aliased !== null) return aliased;
      }
      // Declared here under the registry's own name: the registry module, or a copy of it.
      const declaresValue = definition.type === 'Variable' || definition.type === 'ClassName' || definition.type === 'FunctionName';
      return declaresValue && REGISTRIES.has(identifier.name) ? identifier.name : null;
    }

    /** The registry `node` evaluates to, or null. */
    function registryOf(node, seen = new Set()) {
      if (TRANSPARENT.has(node.type)) return registryOf(node.expression, seen);
      if (node.type === 'Identifier') return identifierRegistry(node, seen);
      if (node.type === 'MemberExpression') {
        const name = memberName(node);
        return name !== null && REGISTRIES.has(name) ? name : null;
      }
      return null;
    }

    /** Whether `callee` is one of {@link ENUMERATORS}. */
    function isEnumerator(callee) {
      if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return false;
      const methods = ENUMERATORS.get(callee.object.name);
      return methods !== undefined && methods.has(memberName(callee)) && resolveVariable(sourceCode, callee.object) === null;
    }

    function check(node, target) {
      const name = target === undefined ? null : registryOf(target);
      if (name !== null) context.report({ node, messageId: 'iteration', data: { name } });
    }

    return {
      CallExpression(node) {
        if (isEnumerator(node.callee)) check(node, node.arguments[0]);
      },
      ForInStatement(node) {
        check(node.right, node.right);
      },
    };
  },
};

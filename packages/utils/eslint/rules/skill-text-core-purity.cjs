/**
 * ESLint rule: skill-text-core-purity
 *
 * Holds a module to computing from its declaration alone: it refuses a regex
 * literal, any runtime reference to the `RegExp` global (constructed, called,
 * aliased, passed to `Reflect.construct`, reached through `globalThis`), every
 * literal other than `0`, `1`, `-1` and `''` (string, number, bigint and
 * template literals, a tagged template's text included), and every runtime
 * import but two kinds: the named exports of the declaration module the config
 * lists, and a sibling module (`./x.js`, never through `..`), which the same
 * config scope holds to this rule. Booleans and `null` are not constants that
 * can drift, and a type (a type-only import, a literal type, `RegExp` as a
 * type) is erased, so both pass.
 *
 * It also refuses the name `lastIndex` in any position (a member, an alias's
 * member, a destructured key, an object key): the declared regexes are shared,
 * unfrozen objects, and a `lastIndex` the core moved would change what a later
 * `matchAll` over the same regex finds.
 *
 * Why: the skill-text core's output is stored and served from a cache keyed by
 * the digest of its declaration (`SKILL_TEXT_DECLARATION` in resources). A
 * pattern or constant written into the core itself would change its output
 * without moving that digest, and a stale stored value would be served as
 * current. With every such value in the declaration, what the digest leaves
 * uncovered is the core's control flow only.
 *
 * The rule has no scope of its own: the config that enables it scopes it to a
 * directory by glob, minus the declaration module, so every sibling a module may
 * import is itself held to the rule. The config names the declaration module's
 * specifier (`declaration`, exactly as written in the import) and the exports
 * a module may take from it (`declarationExports`): a runtime export the
 * declaration's digest does not cover is out of reach.
 *
 * @example
 * // BAD — a separator the digest cannot see
 * const lines = text.split('\n');
 *
 * // GOOD — from the declaration
 * const lines = text.split(declaration.lineSeparator);
 */

'use strict';


/** A literal value the core may spell: the indices, the sign, and the empty string. */
function isAllowedValue(value) {
  return value === 0 || value === 1 || value === '' || value === true || value === false || value === null;
}

/** Whether `node` is the value half of a shorthand property, whose key half is reported instead. */
function isShorthandValue(node) {
  const { parent } = node;
  return parent?.type === 'Property' && parent.shorthand === true && parent.value === node && parent.key !== node;
}

/** The names the global object goes by. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

/** Parents in which an identifier names a type or a key, never the runtime `RegExp`. */
const TYPE_POSITION_PARENTS = new Set(['TSTypeReference', 'TSQualifiedName', 'TSTypeQuery', 'TSInterfaceHeritage', 'TSClassImplements']);

/**
 * Whether an identifier spelled `RegExp` is a runtime reference to the global:
 * not a type, a property key, a non-global member's property or a declared name.
 */
function isRegExpReference(node) {
  if (node.name !== 'RegExp') return false;
  const { parent } = node;
  if (parent === undefined || parent === null) return true;
  if (TYPE_POSITION_PARENTS.has(parent.type)) return false;
  if ((parent.type === 'Property' || parent.type === 'PropertyDefinition' || parent.type === 'TSPropertySignature' || parent.type === 'MethodDefinition')
    && parent.key === node && !parent.computed) {
    // A key names a field, except one read out of an object by destructuring
    // (`const { RegExp: R } = globalThis`). A shorthand's key is reported as its value.
    return parent.type === 'Property' && !parent.shorthand && parent.parent?.type === 'ObjectPattern';
  }
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
    // `globalThis.RegExp` (and its aliases) reaches the global; `declaration.RegExp` is a field.
    return parent.object.type === 'Identifier' && GLOBAL_OBJECTS.has(parent.object.name);
  }
  return true;
}

/** A segment that is empty, `.` or `..`: one a specifier in normal form never holds. */
const NON_NORMAL_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/u;

/**
 * A sibling module's specifier: `./name.js` or deeper, already in normal form,
 * so it never steps through a parent, not even one it climbs back out of
 * (`./a/../b.js`). Rule modules require nothing, so this reads the segments
 * itself rather than normalizing with `node:path`.
 */
function isSibling(specifier) {
  return specifier.startsWith('./') && !NON_NORMAL_SEGMENT.test(specifier.slice(2));
}

/** A sibling specifier as the module it names: its `./` and script extension dropped. */
function moduleOf(specifier) {
  return specifier.slice(2).replace(SCRIPT_EXTENSION, '');
}

/** The extensions a specifier may spell one TypeScript module with. */
const SCRIPT_EXTENSION = /\.(?:[cm]?js|[cm]?ts)$/u;

/** Parents whose `source` is a module specifier. */
const SOURCE_PARENTS = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression']);

/** Parents whose every literal child is a module specifier or a type. */
const SPECIFIER_OR_TYPE_PARENTS = new Set(['TSLiteralType', 'TSExternalModuleReference', 'TSImportType']);

/**
 * Whether a literal is a module specifier or a type, never a runtime constant.
 * An import it names is the import's own finding, reported once, not twice.
 */
function isSpecifierOrType(node) {
  const { parent } = node;
  if (parent === undefined || parent === null) return false;
  if (SPECIFIER_OR_TYPE_PARENTS.has(parent.type)) return true;
  if (SOURCE_PARENTS.has(parent.type)) return parent.source === node;
  return parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'require'
    && parent.arguments[0] === node;
}

/** Whether an import declaration binds a runtime value. */
function importsValue(node) {
  if (node.importKind === 'type') return false;
  if (node.specifiers.length === 0) return true;
  return node.specifiers.some((specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type');
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow regexes, non-trivial literals and runtime imports in a module that must compute from its ' +
        'declaration alone, so the declaration\'s digest covers everything its output depends on',
      // Not recommended: which module is a declared core is a fact about this
      // repository's skill-text cache, not about an adopter's.
      recommended: false,
    },
    schema: [
      {
        type: 'object',
        properties: {
          declaration: { type: 'string' },
          declarationExports: { type: 'array', items: { type: 'string' } },
        },
        required: ['declaration', 'declarationExports'],
        additionalProperties: false,
      },
    ],
    messages: {
      regexLiteral: 'A regex belongs in the declaration, where its digest sees it.',
      regexReference: 'Reach no RegExp here: a pattern belongs in the declaration, where its digest sees it.',
      lastIndex:
        'Touch no lastIndex here: the declared regexes are shared, so a moved lastIndex changes what every later ' +
        'scan over them finds.',
      literal: 'Only 0, 1, -1 and \'\' may be spelled here: every other constant belongs in the declaration, where its digest sees it.',
      valueImport:
        'Import no runtime value here but a sibling module (./x.js) or, from {{declaration}}, {{allowed}}: what ' +
        'this module computes must depend on the declaration alone. A type-only import is fine.',
    },
  },

  create(context) {
    const [{ declaration, declarationExports }] = context.options;
    // Only a sibling in normal form names one module, so any other spelling of
    // the option would match no import and let the declaration in unrestricted.
    if (!isSibling(declaration)) throw new Error(`skill-text-core-purity: declaration must be a sibling specifier in normal form, got ${JSON.stringify(declaration)}`);
    const declarationModule = moduleOf(declaration);
    const allowed = new Set(declarationExports);
    const data = { declaration, allowed: declarationExports.join(', ') || 'nothing' };

    function reportImport(node) {
      context.report({ node, messageId: 'valueImport', data });
    }

    /** Whether every runtime binding of an import or re-export from the declaration is a listed export. */
    function takesListedExports(node) {
      const specifiers = node.specifiers ?? [];
      if (specifiers.length === 0) return false;
      return specifiers.every((specifier) => {
        if (specifier.importKind === 'type' || specifier.exportKind === 'type') return true;
        const name = specifier.type === 'ImportSpecifier' ? specifier.imported : specifier.local;
        return (specifier.type === 'ImportSpecifier' || specifier.type === 'ExportSpecifier')
          && name.type === 'Identifier' && allowed.has(name.name);
      });
    }

    /** Whether a specifier names the declaration module, however it is spelled. */
    function isDeclaration(specifier) {
      return isSibling(specifier) && moduleOf(specifier) === declarationModule;
    }

    function checkSource(node) {
      const specifier = node.source.value;
      if (isDeclaration(specifier)) {
        if (!takesListedExports(node)) reportImport(node);
        return;
      }
      if (!isSibling(specifier)) reportImport(node);
    }

    return {
      Literal(node) {
        if (isSpecifierOrType(node)) return;
        if (node.regex) {
          context.report({ node, messageId: 'regexLiteral' });
          return;
        }
        if (!isAllowedValue(node.value)) context.report({ node, messageId: 'literal' });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => quasi.value.cooked !== '' || quasi.value.raw !== '')) {
          context.report({ node, messageId: 'literal' });
        }
      },
      Identifier(node) {
        if (isRegExpReference(node)) context.report({ node, messageId: 'regexReference' });
        if (node.name === 'lastIndex' && !isShorthandValue(node)) context.report({ node, messageId: 'lastIndex' });
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') reportImport(node);
      },
      ImportDeclaration(node) {
        if (importsValue(node)) checkSource(node);
      },
      ExportNamedDeclaration(node) {
        if (node.source && node.exportKind !== 'type') checkSource(node);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && (isDeclaration(node.source.value) || !isSibling(node.source.value))) reportImport(node);
      },
      ImportExpression: reportImport,
      TSImportEqualsDeclaration(node) {
        if (node.importKind !== 'type') reportImport(node);
      },
    };
  },
};

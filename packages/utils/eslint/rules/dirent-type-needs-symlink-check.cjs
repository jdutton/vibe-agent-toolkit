/**
 * ESLint rule: dirent-type-needs-symlink-check
 *
 * Flags `.isFile()` / `.isDirectory()` on a Dirent whose binding is never
 * asked `.isSymbolicLink()`.
 *
 * A Dirent describes the entry itself, not what it points at, so for a
 * symlink BOTH `isFile()` and `isDirectory()` are false. A walk written as
 * `if (e.isDirectory()) recurse(); else if (e.isFile()) read();` therefore
 * does not refuse a link, and does not follow it either — it drops the entry
 * on the floor without a word. The sweep found staged skill trees, size
 * accounting and packaging walks with exactly that shape, and every one
 * reported a tree with a symlink in it as clean. The decision about a link —
 * refuse, follow, record — has to be made where it can be seen, on the same
 * binding, before the type test.
 *
 * ## How a binding is known to be a Dirent
 *
 * - the result of `readdir` / `readdirSync` called with `{ withFileTypes: true }`
 *   (any receiver: bare, `fs.`, `fs.promises.`), stored in a variable, assigned
 *   later, or iterated directly by `for…of`;
 * - the result of `opendir` / `opendirSync`, iterated by `for await`;
 * - an element of such a collection, via `for…of` or a callback to `filter` /
 *   `map` / `some` / `every` / `find` / `forEach` / `flatMap` — whether the
 *   collection is a variable or the `readdir` call itself, chained
 *   (`readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory())`),
 *   including through a `filter` / `toSorted` / `slice` that keeps the
 *   collection a Dirent collection;
 * - a parameter or variable annotated `Dirent`, `Dirent[]`,
 *   `readonly Dirent[]` or `Array<Dirent>`.
 *
 * A Stats object from `stat()` / `lstat()` is NOT a Dirent and is never
 * flagged: `stat` already followed the link, and `lstat` callers are asking a
 * different question. A `readdir` without `withFileTypes` yields strings.
 *
 * The guard must be on the SAME binding: an `lstat(e.name).isSymbolicLink()`
 * beside an unguarded `e.isDirectory()` is two questions about two objects,
 * and the rule cannot know they agree.
 *
 * @example
 * // BAD — a symlinked directory is neither, so it silently vanishes
 * for (const e of readdirSync(dir, { withFileTypes: true })) {
 *   if (e.isDirectory()) walk(e); else if (e.isFile()) read(e);
 * }
 *
 * // GOOD — the link is decided first, visibly
 * for (const e of readdirSync(dir, { withFileTypes: true })) {
 *   if (e.isSymbolicLink()) { refuse(e); continue; }
 *   if (e.isDirectory()) walk(e); else if (e.isFile()) read(e);
 * }
 */

'use strict';

const READDIR_FUNCTIONS = new Set(['readdir', 'readdirSync']);
const OPENDIR_FUNCTIONS = new Set(['opendir', 'opendirSync']);
const ELEMENT_CALLBACK_METHODS = new Set([
  'filter', 'map', 'some', 'every', 'find', 'forEach', 'flatMap', 'findIndex', 'findLast',
]);
/** Array methods whose RESULT is still the same Dirent collection (a `map` is not: it produced something else). */
const COLLECTION_PRESERVING_METHODS = new Set(['filter', 'toSorted', 'toReversed', 'slice', 'reverse', 'sort']);
const TYPE_TESTS = new Set(['isFile', 'isDirectory']);
const FUNCTION_TYPES = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'];

/** The callee's bare name: `readdirSync` for both `readdirSync(…)` and `fs.readdirSync(…)`. */
function calleeName(call) {
  const { callee } = call;
  if (callee.type === 'Identifier') {
    return callee.name;
  }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

/** Whether some argument is an object literal carrying `withFileTypes: true`. */
function hasWithFileTypes(call) {
  return call.arguments.some(
    (arg) =>
      arg.type === 'ObjectExpression' &&
      arg.properties.some(
        (prop) =>
          prop.type === 'Property' &&
          !prop.computed &&
          (prop.key.name ?? prop.key.value) === 'withFileTypes' &&
          prop.value.type === 'Literal' &&
          prop.value.value === true,
      ),
  );
}

/** Whether `expr` (possibly awaited) produces Dirents when stored or iterated. */
function isDirentCollectionCall(expr) {
  const call = expr?.type === 'AwaitExpression' ? expr.argument : expr;
  if (call?.type !== 'CallExpression') {
    return false;
  }
  const name = calleeName(call);
  return OPENDIR_FUNCTIONS.has(name) || (READDIR_FUNCTIONS.has(name) && hasWithFileTypes(call));
}

/** Whether a TS type node is the bare `Dirent` reference. */
function isDirentType(typeNode) {
  return (
    typeNode?.type === 'TSTypeReference' &&
    typeNode.typeName.type === 'Identifier' &&
    typeNode.typeName.name === 'Dirent'
  );
}

/**
 * 'element' for `Dirent`, 'collection' for `Dirent[]` / `readonly Dirent[]` /
 * `Array<Dirent>` / `ReadonlyArray<Dirent>`, null otherwise.
 */
function direntKindOfAnnotation(annotation) {
  const typeNode = annotation?.typeAnnotation;
  if (!typeNode) {
    return null;
  }
  if (isDirentType(typeNode)) {
    return 'element';
  }
  if (typeNode.type === 'TSTypeOperator') {
    return direntKindOfAnnotation({ typeAnnotation: typeNode.typeAnnotation }) === 'collection' ? 'collection' : null;
  }
  if (typeNode.type === 'TSArrayType') {
    return isDirentType(typeNode.elementType) ? 'collection' : null;
  }
  const generic = typeNode.type === 'TSTypeReference' ? typeNode.typeArguments ?? typeNode.typeParameters : null;
  return generic && isDirentType(generic.params[0]) ? 'collection' : null;
}

/** The kind of member call a reference participates in: `{ name, call }` or null. */
function memberCallOf(identifier) {
  const member = identifier.parent;
  if (member?.type !== 'MemberExpression' || member.object !== identifier || member.computed) {
    return null;
  }
  const call = member.parent;
  if (call?.type !== 'CallExpression' || call.callee !== member || member.property.type !== 'Identifier') {
    return null;
  }
  return { name: member.property.name, call };
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an isSymbolicLink() check on a Dirent before isFile()/isDirectory() — both are ' +
        'false for a symlink, so an unchecked walk drops links silently',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [],
    messages: {
      direntTypeWithoutSymlinkCheck:
        'A symlink answers false to BOTH isFile() and isDirectory(), so this walk drops every link ' +
        'without a word. Decide the link on this same binding first — ' +
        'if ({{name}}.isSymbolicLink()) { refuse / follow / record } — then test the type.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const collections = new Set();
    const elements = new Set();

    /** The variable an identifier REFERENCE resolves to, or null. */
    function resolvedVariable(identifier) {
      const reference = sourceCode.getScope(identifier).references.find((ref) => ref.identifier === identifier);
      return reference?.resolved ?? null;
    }

    function markDeclared(node, kind) {
      for (const variable of sourceCode.getDeclaredVariables(node)) {
        (kind === 'element' ? elements : collections).add(variable);
      }
    }

    function markAnnotatedParams(fn) {
      const declared = sourceCode.getDeclaredVariables(fn);
      for (const param of fn.params) {
        const kind = param.type === 'Identifier' ? direntKindOfAnnotation(param.typeAnnotation) : null;
        const variable = kind ? declared.find((candidate) => candidate.name === param.name) : null;
        if (variable) {
          (kind === 'element' ? elements : collections).add(variable);
        }
      }
    }

    function isCollectionIdentifier(expr) {
      return expr.type === 'Identifier' && collections.has(resolvedVariable(expr));
    }

    /**
     * Whether `expr` is a Dirent collection: a bound variable, the `readdir`
     * call itself (possibly awaited or parenthesised), or a chain of
     * collection-preserving array methods on one of those.
     */
    function isDirentCollection(expr) {
      if (!expr) {
        return false;
      }
      if (isCollectionIdentifier(expr) || isDirentCollectionCall(expr)) {
        return true;
      }
      const { callee } = expr.type === 'CallExpression' ? expr : {};
      return (
        callee?.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        COLLECTION_PRESERVING_METHODS.has(callee.property.name) &&
        isDirentCollection(callee.object)
      );
    }

    function reportUnguarded(variable) {
      let guarded = false;
      const typeTests = [];
      for (const reference of variable.references) {
        const use = memberCallOf(reference.identifier);
        if (use?.name === 'isSymbolicLink') {
          guarded = true;
        } else if (use && TYPE_TESTS.has(use.name)) {
          typeTests.push(use.call);
        }
      }
      if (guarded) {
        return;
      }
      for (const call of typeTests) {
        context.report({ node: call, messageId: 'direntTypeWithoutSymlinkCheck', data: { name: variable.name } });
      }
    }

    return {
      VariableDeclarator(node) {
        if (isDirentCollectionCall(node.init)) {
          markDeclared(node, 'collection');
        } else if (node.id.type === 'Identifier') {
          const kind = direntKindOfAnnotation(node.id.typeAnnotation);
          if (kind) {
            markDeclared(node, kind);
          }
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === 'Identifier' && isDirentCollectionCall(node.right)) {
          const variable = resolvedVariable(node.left);
          if (variable) {
            collections.add(variable);
          }
        }
      },
      ForOfStatement(node) {
        if (node.left.type !== 'VariableDeclaration') {
          return;
        }
        if (isDirentCollection(node.right)) {
          markDeclared(node.left, 'element');
        }
      },
      CallExpression(node) {
        const { callee } = node;
        const callback = node.arguments[0];
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          ELEMENT_CALLBACK_METHODS.has(callee.property.name) &&
          isDirentCollection(callee.object) &&
          callback &&
          FUNCTION_TYPES.includes(callback.type) &&
          callback.params[0]?.type === 'Identifier'
        ) {
          const declared = sourceCode.getDeclaredVariables(callback);
          const first = declared.find((variable) => variable.name === callback.params[0].name);
          if (first) {
            elements.add(first);
          }
        }
      },
      [FUNCTION_TYPES.join(',')]: markAnnotatedParams,
      'Program:exit'() {
        for (const variable of elements) {
          reportUnguarded(variable);
        }
      },
    };
  },
};

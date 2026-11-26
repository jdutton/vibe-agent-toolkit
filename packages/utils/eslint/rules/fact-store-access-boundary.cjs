/**
 * ESLint rule: fact-store-access-boundary
 *
 * Flags every access to a `FactStore` port member that reads or writes stored
 * facts (`readBlobFacts`, `readExtent`, `writeBlobFacts`, `writeExtent`) in
 * whatever file the rule is enabled for: a call, a reference handed on, a
 * computed access with a literal name, and a destructure.
 *
 * A run reads each stored row once only when every reader goes through one
 * module, the run's stored reader (`stored-reads.ts` in `resources`), which
 * holds what the run read and forgets what a write moves. A second caller of the
 * port is a second read path that decodes rows the run already holds. So the
 * rule has no scope of its own: the config that enables it names the files that
 * MAY reach the port (the reader, the backend implementing it, test suites),
 * through its `files`/`ignores`, and every other file it covers may not.
 *
 * One shape is allowed anywhere: a forwarding wrapper, where the access sits in
 * a function that is itself the value of a property or method of the SAME name
 * (`readBlobFacts: (keys, request) => store.readBlobFacts(keys, request)`). A
 * wrapper is still a store, reached through the reader like any other.
 *
 * Known limits: names matched by spelling, so an unrelated object's member of
 * the same name is reported too; and a name reached through data flow (a
 * computed access with a variable) is not.
 *
 * @example
 * // BAD — a second reader of the tier
 * const rows = await cache.store.readBlobFacts(keys, ALL_BLOB_REQUEST);
 *
 * // GOOD — through the run's reader
 * const rows = await run.stored.of(cache.store).blobs(keys, ALL_BLOB_REQUEST);
 */

'use strict';

/** The port members that reach stored facts. */
const PORT_MEMBERS = new Set(['readBlobFacts', 'readExtent', 'writeBlobFacts', 'writeExtent']);

/** The member name of a `MemberExpression`, when it is spelled out, or null. */
function memberName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  return null;
}

/** The name of a property or method key, when it is spelled out, or null. */
function keyName(node) {
  if (node.key.type === 'Identifier' && !node.computed) return node.key.name;
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value;
  return null;
}

/** The nearest function enclosing `node`, or null. */
function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'FunctionExpression' || current.type === 'ArrowFunctionExpression' || current.type === 'FunctionDeclaration') {
      return current;
    }
  }
  return null;
}

/** Whether `node` sits in a function that is the value of a property or method named `name`. */
function inWrapperNamed(node, name) {
  const fn = enclosingFunction(node);
  const holder = fn?.parent;
  if (holder === undefined || holder === null) return false;
  const isHolder = (holder.type === 'Property' || holder.type === 'MethodDefinition' || holder.type === 'PropertyDefinition')
    && holder.value === fn;
  return isHolder && keyName(holder) === name;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reaching the FactStore port\'s stored-fact members outside the files the config names — a run ' +
        'reads stored rows through one reader',
      // Not recommended: which module is the reader is a fact about this
      // repository's layout, not about an adopter's.
      recommended: false,
    },
    schema: [],
    messages: {
      portAccess:
        "Do not reach the store's '{{name}}' here. A run reads and writes stored facts through its one reader " +
        '(`run.stored.of(store)`, stored-reads.ts), so no row is read twice.',
    },
  },

  create(context) {
    return {
      MemberExpression: (node) => {
        const name = memberName(node);
        if (name === null || !PORT_MEMBERS.has(name) || inWrapperNamed(node, name)) return;
        context.report({ node, messageId: 'portAccess', data: { name } });
      },
      'ObjectPattern > Property': (node) => {
        const name = keyName(node);
        if (name !== null && PORT_MEMBERS.has(name)) context.report({ node, messageId: 'portAccess', data: { name } });
      },
    };
  },
};

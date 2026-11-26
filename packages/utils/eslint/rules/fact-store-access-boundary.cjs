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
 * One shape is allowed anywhere: a forwarding wrapper, a property or method of
 * the SAME name whose body is exactly the call, its own parameters handed on in
 * order, optionally followed by one `.catch(handler)`
 * (`readBlobFacts: (keys, request) => store.readBlobFacts(keys, request)`). A
 * wrapper is still a store, reached through the reader like any other; one that
 * does anything else (memoizes, filters, reads twice) is a second reader.
 *
 * It also reports an import of the resources package's testing helpers
 * (`@vibe-agent-toolkit/resources/testing`, `resources/src/testing/**`) from
 * any file it covers: those helpers reach the port and are exempt, so a module
 * importing them would be a second reader by proxy.
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

/** The one expression `fn` returns, when its body is nothing else: an arrow's expression, or a lone `return`. */
function soleReturned(fn) {
  if (fn.body.type !== 'BlockStatement') return fn.body;
  const [statement, ...rest] = fn.body.body;
  return rest.length === 0 && statement?.type === 'ReturnStatement' ? statement.argument : null;
}

/** `expression` without one trailing `.catch(handler)`. */
function withoutCatch(expression) {
  const callee = expression?.type === 'CallExpression' ? expression.callee : null;
  const isCatch = callee?.type === 'MemberExpression' && memberName(callee) === 'catch' && expression.arguments.length === 1;
  return isCatch ? callee.object : expression;
}

/** Whether `call` hands on exactly `fn`'s own parameters, in order. */
function forwardsParameters(call, fn) {
  if (call.arguments.length !== fn.params.length) return false;
  return fn.params.every((param, index) => {
    const argument = call.arguments[index];
    return param.type === 'Identifier' && argument?.type === 'Identifier' && argument.name === param.name;
  });
}

/**
 * Whether `node` is the forward of a wrapper named `name`: the function holding it is the value of
 * a property or method of that name, and its whole body is the call of `node` with its own
 * parameters, optionally followed by one `.catch(handler)`.
 */
function inWrapperNamed(node, name) {
  const fn = enclosingFunction(node);
  const holder = fn?.parent;
  if (holder === undefined || holder === null) return false;
  const isHolder = (holder.type === 'Property' || holder.type === 'MethodDefinition' || holder.type === 'PropertyDefinition')
    && holder.value === fn;
  if (!isHolder || keyName(holder) !== name) return false;
  const call = withoutCatch(soleReturned(fn));
  return call?.type === 'CallExpression' && call.callee === node && forwardsParameters(call, fn);
}

/** The resources package's testing entry point, by package specifier. */
const TESTING_PACKAGE = /^@vibe-agent-toolkit\/resources\/testing(?:\/|$)/u;
/** The resources package's testing helpers, by source path. */
const TESTING_SOURCE = /\/packages\/resources\/src\/testing(?:\/|\.[cm]?[jt]s$|$)/u;

/**
 * The path `source` names, resolved against `filename` as a URL resolves a relative reference (a
 * file URL's path setter reads a Windows backslash as a separator).
 */
function resolvedFrom(filename, source) {
  const base = new URL('file:///');
  base.pathname = filename;
  return new URL(source, base).pathname;
}

/** Whether `source`, imported from `filename`, names the resources package's testing helpers. */
function namesTestingHelpers(filename, source) {
  if (TESTING_PACKAGE.test(source)) return true;
  return source.startsWith('.') && TESTING_SOURCE.test(resolvedFrom(filename, source));
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
      testingImport:
        "Do not import '{{source}}' here: the resources testing helpers reach the store's reads and writes, so " +
        "only tests may use them. Read through the run's one reader (`run.stored.of(store)`, stored-reads.ts).",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const checkImport = (node, source, kind) => {
      if (kind === 'type' || source?.type !== 'Literal' || typeof source.value !== 'string') return;
      if (namesTestingHelpers(filename, source.value)) context.report({ node, messageId: 'testingImport', data: { source: source.value } });
    };
    return {
      ImportDeclaration: (node) => checkImport(node, node.source, node.importKind),
      ExportNamedDeclaration: (node) => checkImport(node, node.source, node.exportKind),
      ExportAllDeclaration: (node) => checkImport(node, node.source, node.exportKind),
      ImportExpression: (node) => checkImport(node, node.source, 'value'),
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

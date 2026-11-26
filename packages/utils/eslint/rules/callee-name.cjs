/**
 * Shared by the rules that match a call or member by name. `calleeName`: the identifier a call is
 * made through, bare (`spawn(…)`) or as the last member of a non-computed
 * member expression (`cp.spawn(…)`), or `null` for any other callee.
 *
 * Not a rule — exports no `meta`, so `index.cjs` never registers it.
 */

'use strict';

/** @param {object} call - ESTree `CallExpression` node. */
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

/**
 * The member name of a `MemberExpression`, when it is spelled out, or null:
 * `x.f` and `x['f']` both name `f`.
 *
 * @param {object} node - ESTree `MemberExpression` node.
 */
function memberName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  return null;
}

module.exports = { calleeName, memberName };

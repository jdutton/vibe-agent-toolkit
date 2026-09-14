/**
 * Shared by the rules that match a call by name: the identifier a call is
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

module.exports = { calleeName };

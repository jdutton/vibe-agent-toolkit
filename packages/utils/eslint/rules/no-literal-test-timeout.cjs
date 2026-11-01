/**
 * ESLint rule: no-literal-test-timeout
 *
 * Flags a per-test, per-suite or per-hook timeout written as a number:
 * `it(name, fn, 60_000)`, `beforeAll(fn, 3_600_000)`, `it(name, { timeout: 30_000 }, fn)`.
 * A test runner's tier config scales its default to the platform — this repo's
 * integration tier allows 15 minutes per test on Windows and 1 on Unix — and a
 * literal at the call site replaces that with one number for every machine. So
 * the literal that is generous on a fast runner is the timeout on a slow one: a
 * `60_000` that was 1× the Unix default was 1/15 of the Windows one, and failed
 * there on runner speed alone, with no code change.
 *
 * The allowed shapes: omit it (the tier default applies), or derive it from a
 * value the config provides — here `inject('tierTestTimeout') * k` and
 * `inject('tierHookTimeout') * k` (`vitest.shared.ts`) — so every machine gets
 * the same MULTIPLE of its own allowance.
 *
 * A literal may hide in arithmetic (`5 * 60 * 1000`), a cast or parentheses, or
 * behind a same-file `const`; all are flagged. A parameter, an import or any
 * call result is accepted.
 *
 * ⚠️ STILL BLIND (syntax-only rule): a literal behind an IMPORTED constant, a
 * `let`, or an object property. There is deliberately no escape-hatch comment:
 * a hang guard that must stay short is a property of the code under test, and
 * belongs in that code's own timeout (a spawn's `timeout`, an `AbortSignal`),
 * not in the runner's wall clock.
 *
 * Not in `recommended`: the remedy names a value the adopter's runner config
 * must provide, which this pack cannot supply.
 *
 * @example
 * // BAD — one number for every machine
 * it('populates the corpus', async () => { ... }, 60_000);
 *
 * // GOOD — the tier default
 * it('populates the corpus', async () => { ... });
 *
 * // GOOD — a multiple of this machine's allowance
 * beforeAll(async () => { ... }, inject('tierHookTimeout') * 4);
 */

'use strict';

/** Runner globals whose call takes a timeout. */
const TIMED_ROOTS = new Set(['it', 'test', 'describe', 'suite']);
const HOOK_ROOTS = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);

/** Members that return a test function after taking a table or a condition. */
const FACTORY_MEMBERS = new Set(['each', 'for', 'skipIf', 'runIf']);

/** Members that ARE a test function. */
const MODIFIER_MEMBERS = new Set(['concurrent', 'sequential', 'only', 'skip', 'fails', 'todo', 'shuffle']);

/** Wrappers that change a value's type or grouping, not its value. */
const TRANSPARENT = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ChainExpression']);

function unwrap(node) {
  let current = node;
  while (current && TRANSPARENT.has(current.type)) current = current.expression;
  return current;
}

/**
 * The root runner name a callee calls as a test function, or null.
 *
 * `it`, `it.concurrent`, `it.skipIf(c)`, `it.each(t)` all qualify; `it.each`
 * itself (the table call) does not, because its arguments are not a timeout.
 */
function testFunctionRoot(callee) {
  const node = unwrap(callee);
  if (!node) return null;
  if (node.type === 'Identifier') return TIMED_ROOTS.has(node.name) || HOOK_ROOTS.has(node.name) ? node.name : null;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    && MODIFIER_MEMBERS.has(node.property.name)) {
    return testFunctionRoot(node.object);
  }
  if (node.type === 'CallExpression') {
    const factory = unwrap(node.callee);
    if (factory && factory.type === 'MemberExpression' && !factory.computed
      && factory.property.type === 'Identifier' && FACTORY_MEMBERS.has(factory.property.name)) {
      return testFunctionRoot(factory.object);
    }
  }
  return null;
}

/** The `const` initializer an identifier names in this file, or null. */
function constInitializer(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      const definition = variable.defs[0];
      if (definition && definition.type === 'Variable' && definition.parent.kind === 'const'
        && definition.node.id.type === 'Identifier') {
        return definition.node.init;
      }
      return null;
    }
    scope = scope.upper;
  }
  return null;
}

/** True when `node` is a number fully decided in this file. */
function isNumericConstant(sourceCode, node, seen = new Set()) {
  const value = unwrap(node);
  if (!value) return false;
  if (value.type === 'Literal') return typeof value.value === 'number';
  if (value.type === 'UnaryExpression') return isNumericConstant(sourceCode, value.argument, seen);
  if (value.type === 'BinaryExpression') {
    return isNumericConstant(sourceCode, value.left, seen) && isNumericConstant(sourceCode, value.right, seen);
  }
  if (value.type === 'Identifier' && !seen.has(value.name)) {
    seen.add(value.name);
    const init = constInitializer(sourceCode, value);
    return init !== null && isNumericConstant(sourceCode, init, seen);
  }
  return false;
}

/** The literal timeout an argument carries — itself, or its `timeout` property. */
function literalTimeoutIn(sourceCode, argument) {
  const node = unwrap(argument);
  if (!node) return null;
  if (isNumericConstant(sourceCode, node)) return node;
  if (node.type !== 'ObjectExpression') return null;
  for (const property of node.properties) {
    if (property.type === 'Property' && !property.computed && property.key.type === 'Identifier'
      && property.key.name === 'timeout' && isNumericConstant(sourceCode, property.value)) {
      return property.value;
    }
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a numeric per-test or per-hook timeout — omit it, or derive it from the tier\'s ' +
        'platform-scaled value, so a slow machine gets the same multiple of its own allowance',
      category: 'Code and test hygiene',
      bans: '`it(name, fn, 60_000)`, `beforeAll(fn, 300_000)`, `{ timeout: 30_000 }`',
      useInstead: 'the tier default, or a multiple of a value the runner config provides',
      // Not recommended: the remedy names a value the adopter's runner config must provide.
      recommended: false,
    },
    schema: [],
    messages: {
      literalTimeout:
        'A literal timeout replaces the tier\'s platform-scaled default with one number for every ' +
        'machine. Omit it, or write a multiple of inject(\'tierTestTimeout\') / inject(\'tierHookTimeout\').',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        const root = testFunctionRoot(node.callee);
        if (root === null) return;
        // A hook's timeout is its second argument; a test's or suite's is any
        // argument after the name (vitest takes options before or after the body).
        const candidates = HOOK_ROOTS.has(root) ? node.arguments.slice(1, 2) : node.arguments.slice(1);
        for (const argument of candidates) {
          const literal = literalTimeoutIn(sourceCode, argument);
          if (literal !== null) context.report({ node: literal, messageId: 'literalTimeout' });
        }
      },
    };
  },
};

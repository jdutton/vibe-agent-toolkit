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
 * A multiple of the default (`inject('tierTestTimeout') * 60`) fails the other
 * way: it scales an hour-sized Unix budget by the Windows factor too — 15 hours —
 * so a hang burns the CI job's whole allowance and names no test.
 *
 * The allowed shapes: omit it (the tier default applies), pass the tier's own
 * value (`inject('tierTestTimeout')`, `vitest.shared.ts`), or ask for a budget
 * over it with `atLeastTierTimeout(inject('tierTestTimeout'), 3_600_000)` from
 * `@vibe-agent-toolkit/utils/testing` — the default is the floor and the budget
 * a ceiling over it. A number is accepted ONLY as that helper's budget; its first
 * argument (the floor) is walked like any other timeout.
 *
 * A literal is found anywhere in the timeout expression — arithmetic, either arm
 * of a conditional, another call's arguments, a cast or parentheses — and behind
 * a same-file `const`. A parameter, an import, a member read or a call result
 * with no literal argument is accepted.
 *
 * ⚠️ STILL BLIND (syntax-only rule): a literal behind an IMPORTED constant, a
 * `let`, an object property, or an options object held in a `const`. There is
 * deliberately no escape-hatch comment: a hang guard that must stay short is a
 * property of the code under test, and belongs in that code's own timeout (a
 * spawn's `timeout`, an `AbortSignal`), not in the runner's wall clock.
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
 * // GOOD — a measured budget, never below this machine's allowance
 * beforeAll(async () => { ... }, atLeastTierTimeout(inject('tierHookTimeout'), 3_600_000));
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
 * `it`, `it.concurrent`, `it.skipIf(c)`, `it.each(t)`, `it.each\`…\`` all qualify; `it.each`
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
  if (node.type === 'CallExpression' || node.type === 'TaggedTemplateExpression') {
    const factory = unwrap(node.type === 'CallExpression' ? node.callee : node.tag);
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

/** The one call whose numeric argument is accepted: its budget, over the tier's floor. */
const BUDGET_HELPER = 'atLeastTierTimeout';

function isBudgetHelper(callee) {
  const node = unwrap(callee);
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === BUDGET_HELPER;
  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    && node.property.name === BUDGET_HELPER;
}

/**
 * The first numeric literal a timeout expression decides its value with, or null.
 *
 * Walks arithmetic, both arms of a conditional (not its test), call arguments and
 * same-file `const` initializers. The budget helper contributes only its first
 * argument: its second is the one place a number is the contract.
 */
function findLiteral(sourceCode, node, seen) {
  const value = unwrap(node);
  if (!value) return null;
  switch (value.type) {
    case 'Literal':
      return typeof value.value === 'number' ? value : null;
    case 'UnaryExpression':
      return findLiteral(sourceCode, value.argument, seen);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return findLiteral(sourceCode, value.left, seen) ?? findLiteral(sourceCode, value.right, seen);
    case 'ConditionalExpression':
      return findLiteral(sourceCode, value.consequent, seen) ?? findLiteral(sourceCode, value.alternate, seen);
    case 'CallExpression': {
      const walked = isBudgetHelper(value.callee) ? value.arguments.slice(0, 1) : value.arguments;
      for (const argument of walked) {
        const found = findLiteral(sourceCode, argument, seen);
        if (found !== null) return found;
      }
      return null;
    }
    case 'Identifier': {
      if (seen.has(value.name)) return null;
      seen.add(value.name);
      const init = constInitializer(sourceCode, value);
      return init === null ? null : findLiteral(sourceCode, init, seen);
    }
    default:
      // A function (the test body), a member read, a template: not a number decided here.
      return null;
  }
}

/** The literal a timeout argument carries — in itself, or in its `timeout` property. */
function literalTimeoutIn(sourceCode, argument) {
  const node = unwrap(argument);
  if (!node) return null;
  if (node.type !== 'ObjectExpression') return findLiteral(sourceCode, node, new Set());
  for (const property of node.properties) {
    if (property.type === 'Property' && !property.computed && property.key.type === 'Identifier'
      && property.key.name === 'timeout') {
      return findLiteral(sourceCode, property.value, new Set());
    }
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a numeric per-test or per-hook timeout — omit it, or pass a budget through ' +
        'atLeastTierTimeout(tier, budget), so the platform-scaled default is the floor and the budget a ceiling',
      category: 'Code and test hygiene',
      bans: '`it(name, fn, 60_000)`, `beforeAll(fn, tier * 12)`, `{ timeout: isWin ? 900_000 : 60_000 }`',
      useInstead: 'the tier default, or `atLeastTierTimeout(inject(\'tierTestTimeout\'), budget)`',
      // Not recommended: the remedy names a value the adopter's runner config must provide.
      recommended: false,
    },
    schema: [],
    messages: {
      literalTimeout:
        'A number in a timeout replaces or scales the tier\'s platform-scaled default. Omit it, or write ' +
        'atLeastTierTimeout(inject(\'tierTestTimeout\' | \'tierHookTimeout\'), budget).',
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

/**
 * ESLint rule: no-registry-count-pin
 *
 * In a test file, flags `expect(<x>).toHaveLength(<n>)` and
 * `expect(<x>).toBe(<n>)` when `n` is a literal at or above `minLiteral` and
 * `x` is derived from something the file IMPORTED — a registry, a manifest, a
 * rule table pulled from src — rather than from a fixture the test built.
 *
 * Such a pin is a change detector and only a change detector: it fails on
 * every legitimate addition, is fixed by retyping the number, and proves
 * nothing about the set it stands for. The audit found the same four numbers
 * retyped in two files and a prose sentence, all three wrong at once. The
 * assertion that means something is the SET — `toEqual([...names].sort())` —
 * or a derivation from the same source the registry is built from.
 *
 * ## The heuristic, and what it deliberately misses
 *
 * `x` is registry-derived when its value chain reaches an import binding used
 * as a VALUE: `REGISTRY`, `REGISTRY.length`, `Object.keys(REGISTRY)`,
 * `[...REGISTRY]`, `REGISTRY.filter(…)`, a local `const` that holds one of
 * those, or a call to an imported function whose every argument is itself
 * registry-derived (so a zero-argument accessor like `allSpecs()` counts).
 *
 * An imported function applied to LOCAL data — `parse(fixtureText).links` —
 * is NOT registry-derived: the count is the fixture's. That includes a literal
 * argument, so `loadModule('../index.cjs')` is missed on purpose; a literal
 * module path and a literal fixture are indistinguishable syntactically, and a
 * rule that fired on `parse('# heading')` would be switched off within a week.
 * The same holds for a method on an imported receiver: `safePath.join(tmp,
 * 'x')` is an imported namespace of FUNCTIONS fed local data, so the result is
 * local — only a method whose arguments are all derived (or callbacks) keeps
 * the receiver's derivation. Measured on this tree: the receiver-only reading
 * flagged `hash.toHaveLength(64)` on a hash of a local file.
 *
 * Option `minLiteral: number` (default 5) — the smallest literal that reads as
 * a count of a registry rather than a shape assertion on a small fixture.
 *
 * @example
 * // BAD — fails on every addition, fixed by retyping 27 → 28
 * expect(Object.keys(plugin.rules)).toHaveLength(27);
 *
 * // GOOD — says WHICH, and fails only when the set actually changes
 * expect(Object.keys(plugin.rules).sort()).toEqual(readdirSync(rulesDir).map(stripExt).sort());
 */

'use strict';

const { isTestFile } = require('./exempt-path-matcher.cjs');

const COUNT_MATCHERS = new Set(['toHaveLength', 'toBe']);
const DEFAULT_MIN_LITERAL = 5;
const FUNCTION_ARGUMENT_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression']);

/** The variable an identifier resolves to, walking up the scope chain, or null. */
function resolveVariable(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
}

/** Whether `expr` is `expect(...)` or `expect.soft(...)`. */
function isExpectCall(expr) {
  if (expr.type !== 'CallExpression') {
    return false;
  }
  const { callee } = expr;
  if (callee.type === 'Identifier') {
    return callee.name === 'expect';
  }
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'soft'
  );
}

/**
 * The subject of the `expect(...)` a matcher chain hangs off, descending
 * through modifiers like `.not` / `.resolves`, or null when the chain does not
 * start at `expect`.
 */
function expectSubject(matcherCallee) {
  let current = matcherCallee.object;
  while (current.type === 'MemberExpression') {
    current = current.object;
  }
  return isExpectCall(current) ? (current.arguments[0] ?? null) : null;
}

/** Whether a numeric literal argument at or above `min` was passed. */
function countLiteral(node, min) {
  const arg = node.arguments[0];
  if (node.arguments.length !== 1 || arg.type !== 'Literal' || typeof arg.value !== 'number') {
    return null;
  }
  return arg.value >= min ? arg : null;
}

/** Whether every element of a call/array/new argument list is registry-derived. */
function createDerivationCheck(sourceCode) {
  const visiting = new Set();

  function variableIsDerived(variable) {
    const def = variable.defs[0];
    if (!def) {
      return false;
    }
    if (def.type === 'ImportBinding') {
      return true;
    }
    if (def.type !== 'Variable' || !def.node.init || visiting.has(variable)) {
      return false;
    }
    visiting.add(variable);
    const result = isDerived(def.node.init);
    visiting.delete(variable);
    return result;
  }

  function elementIsDerived(element) {
    return element?.type === 'SpreadElement' ? isDerived(element.argument) : isDerived(element);
  }

  /**
   * Whether no LOCAL data enters a call: every argument is registry-derived,
   * a callback (`.filter((r) => …)` transforms, it does not supply data), or
   * absent. A literal counts as local data — see the module comment.
   */
  function argumentsCarryNoLocalData(node) {
    return node.arguments.every(
      (arg) => FUNCTION_ARGUMENT_TYPES.has(arg.type) || elementIsDerived(arg),
    );
  }

  function callIsDerived(node) {
    const { callee } = node;
    if (callee.type === 'MemberExpression') {
      // `Object.keys(x)` — a global transform: look at what went in.
      // `x.filter(cb)` / `safePath.join(tmp, 'x')` — a method on a value: the
      // receiver must be derived AND nothing local may enter, or `safePath`
      // (an imported namespace of FUNCTIONS) would make every path derived.
      const receiver = callee.object;
      const receiverVar = receiver.type === 'Identifier' ? resolveVariable(sourceCode, receiver) : null;
      const receiverIsGlobal = receiver.type === 'Identifier' && (receiverVar?.defs.length ?? 0) === 0;
      if (receiverIsGlobal) {
        return node.arguments.some(elementIsDerived);
      }
      return isDerived(receiver) && argumentsCarryNoLocalData(node);
    }
    if (callee.type !== 'Identifier') {
      return false;
    }
    const variable = resolveVariable(sourceCode, callee);
    const isImportedFn = variable?.defs[0]?.type === 'ImportBinding';
    return isImportedFn && argumentsCarryNoLocalData(node);
  }

  function isDerived(expr) {
    if (!expr) {
      return false;
    }
    switch (expr.type) {
      case 'Identifier': {
        const variable = resolveVariable(sourceCode, expr);
        return variable !== null && variableIsDerived(variable);
      }
      case 'MemberExpression':
        return isDerived(expr.object);
      case 'CallExpression':
        return callIsDerived(expr);
      case 'NewExpression':
        return expr.arguments.some(elementIsDerived);
      case 'ArrayExpression':
        return expr.elements.some(elementIsDerived);
      case 'AwaitExpression':
        return isDerived(expr.argument);
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
        return isDerived(expr.expression);
      default:
        return false;
    }
  }

  return isDerived;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow pinning the size of an imported registry with a literal in tests — ' +
        'toHaveLength(27) on something pulled from src is a change detector fixed by retyping',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [
      {
        type: 'object',
        properties: {
          minLiteral: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      registryCountPin:
        'This pins the size of something imported from src to the literal {{literal}}. It fails on ' +
        'every legitimate addition and is fixed by retyping the number, so it detects change ' +
        'without checking anything. Assert the SET (toEqual([...names].sort())) or derive the ' +
        'expected count from the same source the registry is built from.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isTestFile(filename)) {
      return {};
    }
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const min = context.options?.[0]?.minLiteral ?? DEFAULT_MIN_LITERAL;
    const isDerived = createDerivationCheck(sourceCode);

    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          !COUNT_MATCHERS.has(callee.property.name)
        ) {
          return;
        }
        const literal = countLiteral(node, min);
        if (literal === null) {
          return;
        }
        const subject = expectSubject(callee);
        if (subject !== null && isDerived(subject)) {
          context.report({ node, messageId: 'registryCountPin', data: { literal: String(literal.raw) } });
        }
      },
    };
  },
};

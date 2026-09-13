/**
 * ESLint rule: no-version-literal
 *
 * The mechanical half of CLAUDE.md's "NO VERSIONS" rule. Flags the two shapes
 * a hand-maintained version integer takes:
 *
 * 1. `z.literal(<number>)` on a schema field named like a version
 *    (`version`, `schemaVersion`, `formatVersion`, `*_VERSION`, …), with or
 *    without a trailing `.optional()` / `.describe()`;
 * 2. a variable, `let`, or class field named `<X>_VERSION`, `<X>_REVISION`,
 *    `VERSION`, `fooVersion`, … initialised to a numeric literal.
 *
 * Both are a number a human must remember to bump for stored data to be
 * judged valid, and nothing fails when they forget: the number and the shape
 * it claims to describe drift apart silently, and the failure surfaces later
 * as a reader confidently mis-parsing data it should have refused. A strict
 * schema already answers "can I read this?" and moves when the shape moves,
 * for whoever made the edit; a derived digest answers "did these come from
 * the same shape?". The integer answers neither and costs a permanent human
 * obligation.
 *
 * ## Not offenders, and why the rule already leaves them alone
 *
 * - `ANTHROPIC_VERSION = '2023-06-01'` — a STRING header value, an external
 *   fact; the rule only fires on a NUMERIC initialiser.
 * - `SUPPORTED_PYTHON_VERSIONS = [...]` — a real list; the name ends in
 *   `VERSIONS`, not `VERSION`, and the value is an array.
 * - a regex that PARSES versions; a `const VERSION = '…'` in a test fixture.
 * - `version: z.string()` / `z.number()` — a field that CARRIES a version is
 *   fine; a field pinned to one integer is the offender.
 *
 * Option `allowNames: string[]` — identifier / property names exempt from the
 * rule. Ship it empty: the documented non-offenders need no entry, so any
 * entry here is a version constant somebody decided to keep, and CLAUDE.md
 * says there is no such case.
 *
 * @example
 * // BAD — bumped from memory, or not
 * const CACHE_VERSION = 3;
 * const Cached = z.object({ version: z.literal(3), … });
 *
 * // GOOD — the strict schema IS the validity check
 * const Cached = z.object({ … }).strict();
 */

'use strict';

/** A name that reads as a version or revision: `X_VERSION`, `VERSION`, `fooVersion`, `version`. */
const VERSION_NAME = /(?:^|_)(?:VERSION|REVISION)$|(?:^|[a-z])(?:Version|Revision)$|^(?:version|revision)$/u;

/** The numeric literal an initialiser reduces to, seeing through `as const`, or null. */
function numericInitialiser(init) {
  if (!init) {
    return null;
  }
  if (init.type === 'TSAsExpression' || init.type === 'TSSatisfiesExpression') {
    return numericInitialiser(init.expression);
  }
  return init.type === 'Literal' && typeof init.value === 'number' ? init : null;
}

/** The plain name of a declarator id, property key, or class field key, or null. */
function keyName(key) {
  if (key.type === 'Identifier') {
    return key.name;
  }
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : null;
}

/** Whether a property value's chain roots at `z.literal(<number>)`. */
function rootsAtNumericZodLiteral(value) {
  let current = value;
  while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
    const { callee } = current;
    const isZodLiteral =
      callee.object.type === 'Identifier' &&
      callee.object.name === 'z' &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'literal';
    if (isZodLiteral) {
      return numericInitialiser(current.arguments[0]) !== null;
    }
    current = callee.object;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow z.literal(<number>) on a version-named field and <X>_VERSION = <number> ' +
        'constants — a hand-bumped integer deciding data validity is the shape CLAUDE.md bans',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowNames: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      versionConstant:
        '{{name}} is a hand-maintained version integer: nothing fails when it is not bumped, so ' +
        'the number and the shape drift apart silently. Delete it — a .strict() schema already ' +
        'refuses data it cannot read, and a digest of the shape answers "same shape?" without ' +
        'anyone remembering a number.',
      versionLiteralField:
        '{{name}}: z.literal(<number>) pins stored data to an integer a human must remember to ' +
        'bump. Delete the field and let the .strict() schema decide validity, or derive a digest ' +
        'of the shape instead.',
    },
  },

  create(context) {
    const allow = new Set(context.options?.[0]?.allowNames ?? []);

    function checkNamedInitialiser(node, key, init) {
      const name = keyName(key);
      if (name === null || allow.has(name) || !VERSION_NAME.test(name)) {
        return;
      }
      if (numericInitialiser(init) !== null) {
        context.report({ node, messageId: 'versionConstant', data: { name } });
      }
    }

    return {
      VariableDeclarator(node) {
        checkNamedInitialiser(node, node.id, node.init);
      },
      PropertyDefinition(node) {
        checkNamedInitialiser(node, node.key, node.value);
      },
      Property(node) {
        const name = keyName(node.key);
        if (name === null || allow.has(name) || !VERSION_NAME.test(name)) {
          return;
        }
        if (rootsAtNumericZodLiteral(node.value)) {
          context.report({ node, messageId: 'versionLiteralField', data: { name } });
        }
      },
    };
  },
};

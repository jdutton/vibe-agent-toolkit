/**
 * ESLint rule: content-key-opaque (type-aware)
 *
 * A `ContentKey` (`string & { readonly __brand: 'ContentKey' }`) is a key whose text has one owner:
 * the parser and formatter that declare it. Every other file treats it as opaque. So, outside the
 * files named by `allowFiles`, the rule reports:
 *
 * - a type assertion to the brand (`x as ContentKey`, `<ContentKey>x`) from a value that is not a
 *   key already: a key minted without the parser, so nothing checked its shape (narrowing a
 *   `ContentKey | undefined` with `as ContentKey` mints nothing and is not reported);
 * - a string method that reads into the text (`split`, `slice`, `substring`, `indexOf`,
 *   `lastIndexOf`, `startsWith`, `endsWith`, `includes`, `match`, `replace`, `replaceAll`, `at`,
 *   `charAt`) called on a branded value: a second parser of the format, which drifts from the first;
 * - `compareCodeUnits(…)` or `localeCompare(…)` with a branded receiver or argument, and
 *   `compareCodeUnits` handed to `sort`/`toSorted` on an array of keys: order keys through the
 *   format's own comparator;
 * - `===` / `!==` between two branded operands: compare through the format's own equality, which
 *   may come to see two spellings of one key as equal.
 *
 * The brand is found through the type checker, never by the type's name: a type whose
 * intersection carries a `__brand` property of the string literal type `'ContentKey'`, seen through
 * aliases, unions (`ContentKey | undefined`) and type-parameter constraints. A type merely NAMED
 * `ContentKey` with another brand is not one.
 *
 * It does not report a bare `.sort()` or `<` / `>` between keys: the format orders keys exactly as
 * their text orders, so those are harmless. Nor a key handed to something that takes a `string`
 * (`String(key)`, a template literal, a `Map` key): the floor is what the type system can see at the
 * call, so a key widened to `string` first and then sliced is not caught here.
 *
 * It needs type information and refuses to run without it: a type-aware rule run without a program
 * would report nothing, and a check that cannot fail reads as a clean tree.
 *
 * Option `allowFiles: string[]` — repo-relative paths of the files that own the format (its parser),
 * matched at a path-segment boundary. Ship it empty: which file owns the format is a fact about one
 * repository.
 *
 * @example
 * // BAD — a second parser of the key's text
 * const kind = key.slice(0, key.indexOf(':'));
 *
 * // GOOD — the format's own reader
 * const { kind } = contentKeyParts(key);
 */

'use strict';

const { memberName } = require('./callee-name.cjs');
const { createExemptPathMatcher } = require('./exempt-path-matcher.cjs');

/** The brand literal a `ContentKey`'s `__brand` property carries. */
const BRAND = 'ContentKey';

/** String methods that read into a key's text. */
const STRING_METHODS = new Set([
  'split', 'slice', 'substring', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'includes',
  'match', 'replace', 'replaceAll', 'at', 'charAt',
]);

/** Array methods taking a comparator. */
const SORT_METHODS = new Set(['sort', 'toSorted']);

/** The name a callee or argument is called by: `f` or `x.f`, else null. */
function calledName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return memberName(node);
  return null;
}

/** The type checker's view of the file, or a thrown refusal when the lint run gave it no program. */
function typeServices(context) {
  const services = (context.sourceCode ?? context.getSourceCode()).parserServices;
  if (services?.program === undefined || services.program === null || services.esTreeNodeToTSNodeMap === undefined) {
    throw new Error(
      'content-key-opaque needs type information: configure parserOptions.project or projectService for this file. '
        + 'Without a program it would report nothing.',
    );
  }
  return { checker: services.program.getTypeChecker(), nodeMap: services.esTreeNodeToTSNodeMap };
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading, minting, ordering or comparing a branded ContentKey by its text outside the files that own ' +
        'its format — the type checker finds the brand',
      // Not recommended: it names one package's branded type, and which file owns the format is a
      // fact about this repository.
      recommended: false,
      recommendedSeverity: 'error',
      category: 'Correctness',
      bans: '`as ContentKey`, a string method on a `ContentKey`, `compareCodeUnits`/`localeCompare` with one, `===`/`!==` between two (type-aware)',
      useInstead: '`parseContentKey`, `formatContentKey`, `contentKeyParts`, `equalContentKeys`, `orderContentKeys`',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      assertion:
        'A type assertion to ContentKey mints a key nothing parsed. Build it with formatContentKey(…) or read it with ' +
        'parseContentKey(…).',
      stringMethod:
        "'{{method}}' reads into a ContentKey's text: a second parser of the format. Use contentKeyParts(key) or " +
        'parseContentKey(text).',
      comparator:
        "'{{name}}' orders ContentKeys by their text. Use orderContentKeys(…) (a bare .sort() is fine: key order is " +
        'text order).',
      equality: "'{{operator}}' compares two ContentKeys by their text. Use equalContentKeys(a, b).",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (createExemptPathMatcher(context.options?.[0]?.allowFiles ?? [])(filename)) return {};
    const { checker, nodeMap } = typeServices(context);

    /** The types `type` may be at run time: its union members, a type parameter by its constraint. */
    function membersOf(type, seen = new Set()) {
      if (type === undefined || seen.has(type)) return [];
      seen.add(type);
      if (type.isUnion()) return type.types.flatMap((member) => membersOf(member, seen));
      if (type.isTypeParameter()) return membersOf(checker.getBaseConstraintOfType(type), seen);
      return [type];
    }

    /** Whether `type` is an intersection whose `__brand` is the literal `'ContentKey'`. */
    function isBrand(type, tsNode) {
      if (!type.isIntersection()) return false;
      const brand = checker.getPropertyOfType(type, '__brand');
      if (brand === undefined) return false;
      const brandType = checker.getTypeOfSymbolAtLocation(brand, tsNode);
      return brandType.isStringLiteral() && brandType.value === BRAND;
    }

    /** Whether `type` may be a key: any member carries the brand. */
    function carriesBrand(type, tsNode) {
      return membersOf(type).some((member) => isBrand(member, tsNode));
    }

    /** The type of the expression `node` and its TypeScript node, or null when it has none. */
    function typeOf(node) {
      const tsNode = nodeMap.get(node);
      return tsNode === undefined ? null : { type: checker.getTypeAtLocation(tsNode), tsNode };
    }

    /** Whether the expression `node` has a branded type. */
    function isKey(node) {
      const typed = typeOf(node);
      return typed !== null && carriesBrand(typed.type, typed.tsNode);
    }

    /** Whether the expression `node` is a key already, `null`/`undefined` aside: asserting it mints nothing. */
    function isKeyedAlready(node) {
      const typed = typeOf(node);
      if (typed === null) return false;
      const members = membersOf(checker.getNonNullableType(typed.type));
      return members.length > 0 && members.every((member) => isBrand(member, typed.tsNode));
    }

    /** Whether `node` is an array (or tuple, or readonly array) whose elements are branded. */
    function isKeyArray(node) {
      const tsNode = nodeMap.get(node);
      if (tsNode === undefined) return false;
      return checker.getIndexInfosOfType(checker.getTypeAtLocation(tsNode))
        .some((info) => carriesBrand(info.type, tsNode));
    }

    function checkAssertion(node) {
      if (isKey(node) && !isKeyedAlready(node.expression)) context.report({ node, messageId: 'assertion' });
    }

    function checkMethodCall(node, callee) {
      const method = memberName(callee);
      if (method === null) return;
      if (STRING_METHODS.has(method) && isKey(callee.object)) {
        context.report({ node, messageId: 'stringMethod', data: { method } });
      } else if (method === 'localeCompare' && (isKey(callee.object) || node.arguments.some((arg) => isKey(arg)))) {
        context.report({ node, messageId: 'comparator', data: { name: method } });
      } else if (SORT_METHODS.has(method) && node.arguments[0] !== undefined
        && calledName(node.arguments[0]) === 'compareCodeUnits' && isKeyArray(callee.object)) {
        context.report({ node, messageId: 'comparator', data: { name: 'compareCodeUnits' } });
      }
    }

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
      CallExpression(node) {
        const callee = node.callee;
        if (calledName(callee) === 'compareCodeUnits') {
          if (node.arguments.some((arg) => isKey(arg))) {
            context.report({ node, messageId: 'comparator', data: { name: 'compareCodeUnits' } });
          }
          return;
        }
        if (callee.type === 'MemberExpression') checkMethodCall(node, callee);
      },
      BinaryExpression(node) {
        if ((node.operator === '===' || node.operator === '!==') && isKey(node.left) && isKey(node.right)) {
          context.report({ node, messageId: 'equality', data: { operator: node.operator } });
        }
      },
    };
  },
};

/**
 * ESLint rule: content-key-opaque (type-aware)
 *
 * A `ContentKey` (`string & { readonly __brand: 'ContentKey' }`) is a key whose text has one owner:
 * the parser and formatter that declare it. Every other file treats it as opaque: it may hold a key,
 * pass it along and compare two by `===`, and nothing else. So, outside the files named by
 * `allowFiles`, the rule reports:
 *
 * - a type assertion that mints a key without the parser, so nothing checked its shape: to the
 *   brand (`x as ContentKey`, `<ContentKey>x`) from a value that is not a key already, and to an
 *   array, record, container or object holding keys one level in (`as ContentKey[]`,
 *   `as Record<string, ContentKey>`, `as Map<string, ContentKey>`, `as { key: ContentKey }`) from an
 *   `any` or `unknown` value, or from one whose matching element, value, type argument or property
 *   is not a key already (`null`/`undefined` aside). Narrowing a `ContentKey | undefined`, widening
 *   `ContentKey[]` to `readonly ContentKey[]`, asserting `[]` or a partial row whose key field is a
 *   key already mints nothing and is not reported. Deeper holders (a row table, a whole projection)
 *   are not searched: the rule sees keys one level into the asserted type;
 * - an `as never` or `as any` cast (`'x' as never`, `<any>x`) where a key, or values holding keys one
 *   level in, is expected: the checker's contextual type at the cast (a key-typed binding, argument,
 *   property or return). Its own target carries no brand, so it is judged by where it lands;
 * - a user-written type guard or assertion function naming a key, or values holding keys one level
 *   in (`(x): x is ContentKey`, `asserts x is ContentKey[]`): a guard is a cast with a check nothing
 *   ties to the format's parser;
 * - ANY member access on a branded value (`key.slice(…)`, `key.length`, `key.toString()`,
 *   `key[0]`), a spread of one (`[...key]`, `{ ...key }`), a destructure of one (`const [c] = key`),
 *   iterating one (`for (const c of key)`), and one handed to a `RegExp`'s `test`/`exec`: each reads
 *   into the text, a second parser of the format, which drifts from the first. No member is
 *   allowed: a key's fields come from `contentKeyParts(key)`, and handing a key on needs none;
 * - `compareCodeUnits(…)` or `localeCompare(…)` with a branded argument, and `compareCodeUnits`
 *   handed to `sort`/`toSorted` on an array of keys: order keys through the format's own comparator.
 *
 * Equality is the whole text: two keys are equal exactly when their text is, so `===`, `!==`, `==`
 * and `Object.is` between keys are the contract and are not reported. Nor are a bare `.sort()` and
 * `<` / `>`: the format orders keys exactly as their text orders.
 *
 * The brand is found through the type checker, never by the type's name: a type whose
 * intersection carries a `__brand` property of the string literal type `'ContentKey'`, seen through
 * aliases, unions (`ContentKey | undefined`) and type-parameter constraints. A type merely NAMED
 * `ContentKey` with another brand is not one.
 *
 * The floor is what the type system can see at the use: a key handed to something that takes a
 * `string` (`String(key)`, a template literal, `Array.from(key)`) is passing it along, so a key
 * widened to `string` first and then sliced is not caught here.
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
 * const kind = key.slice(0, key.indexOf('.'));
 *
 * // GOOD — the format's own reader
 * const { parserKind } = contentKeyParts(key);
 */

'use strict';

const { memberName } = require('./callee-name.cjs');
const { createExemptPathMatcher } = require('./exempt-path-matcher.cjs');

/** The brand literal a `ContentKey`'s `__brand` property carries. */
const BRAND = 'ContentKey';

/** Array methods taking a comparator. */
const SORT_METHODS = new Set(['sort', 'toSorted']);

/** `RegExp` methods that run the pattern over their argument's text. */
const REGEXP_METHODS = new Set(['test', 'exec']);

/** `ts.TypeFlags` bits this rule reads, by value so the rule needs no `typescript` import. */
const ANY_FLAG = 1;
const UNKNOWN_FLAG = 2;
const NEVER_FLAG = 131_072;
const OBJECT_FLAG = 524_288;

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

/**
 * Whether `type` is `any` or `unknown`: a value the checker knows nothing about. Read off the type
 * itself, never its non-nullable form: that turns `unknown` into `{}`.
 */
function isOpaque(type) {
  return (type.getFlags() & (ANY_FLAG | UNKNOWN_FLAG)) !== 0;
}

/** Whether `node` is `x as const`: it narrows literals and makes nothing a key. */
function isConstAssertion(node) {
  const annotation = node.typeAnnotation;
  return annotation?.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier' && annotation.typeName.name === 'const';
}

/** Whether `node` is a type assertion other than `as const`. */
function isMintingForm(node) {
  return (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion') && !isConstAssertion(node);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow minting, reading into or ordering a branded ContentKey by its text outside the files that own ' +
        'its format — the type checker finds the brand',
      // Not recommended: it names one package's branded type, and which file owns the format is a
      // fact about this repository.
      recommended: false,
      recommendedSeverity: 'error',
      category: 'Correctness',
      bans: 'a cast to `ContentKey` or to an array/object of them (or an `as never`/`as any` cast where one is expected), a user-written `x is ContentKey` guard, any member access, index, spread, destructure, iteration or regex call on a `ContentKey`, `compareCodeUnits`/`localeCompare` with one (type-aware)',
      useInstead: '`parseContentKey`, `formatContentKey`, `contentKeyParts`, `orderContentKeys`; `===` compares two',
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
        'A type assertion to a ContentKey (or to values holding them) mints a key nothing parsed. Build it with ' +
        'formatContentKey(…) or read it with parseContentKey(…).',
      read:
        "{{form}} reads into a ContentKey's text: a second parser of the format. Use contentKeyParts(key), or " +
        'pass the key along whole.',
      guard:
        'A type guard to a ContentKey (or to values holding them) mints keys nothing parsed. Read the value with ' +
        'parseContentKey(…) instead.',
      comparator:
        "'{{name}}' orders ContentKeys by their text. Use orderContentKeys(…) (a bare .sort() is fine: key order is " +
        'text order).',
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

    /** Whether `node` is an array (or tuple, or readonly array) whose elements are branded. */
    function isKeyArray(node) {
      const tsNode = nodeMap.get(node);
      if (tsNode === undefined) return false;
      return checker.getIndexInfosOfType(checker.getTypeAtLocation(tsNode))
        .some((info) => carriesBrand(info.type, tsNode));
    }

    /** Whether `type` holds no value but a key: every non-null member branded, or nothing at all (`never`). */
    function isKeyedType(type, tsNode) {
      const value = checker.getNonNullableType(type);
      if ((value.getFlags() & NEVER_FLAG) !== 0) return true;
      const members = membersOf(value);
      return members.length > 0 && members.every((member) => isBrand(member, tsNode));
    }

    /** One object member's slots, by name: `<i>` type arguments, `[keyType]` index values, properties. */
    function memberSlots(member, tsNode) {
      const typeArguments = member.target === undefined ? [] : checker.getTypeArguments(member);
      return [
        ...typeArguments.map((type, index) => [`<${index}>`, type]),
        ...checker.getIndexInfosOfType(member).map((info) => [`[${checker.typeToString(info.keyType)}]`, info.type]),
        ...checker.getPropertiesOfType(member).map((property) => [property.getName(), checker.getTypeOfSymbolAtLocation(property, tsNode)]),
      ];
    }

    /** A type's slots one level in, over its object members: what an array, record or object holds. */
    function slotsOf(type, tsNode) {
      const containers = membersOf(checker.getNonNullableType(type)).filter((member) => (member.getFlags() & OBJECT_FLAG) !== 0);
      return new Map(containers.flatMap((member) => memberSlots(member, tsNode)));
    }

    /** The slots of `type` one level in that hold keys. */
    function keySlotsOf(type, tsNode) {
      return [...slotsOf(type, tsNode)].filter(([, slot]) => carriesBrand(slot, tsNode));
    }

    /** Whether `type` is a key, or holds keys one level in (an array, record, container or object of them). */
    function holdsKeys(type, tsNode) {
      return carriesBrand(type, tsNode) || keySlotsOf(type, tsNode).length > 0;
    }

    /**
     * Whether asserting `node` mints a key: its target is a key, or holds keys one level in (an
     * array, record, container or object of them), and the value asserted is not already a key there.
     */
    function mintsKey(node) {
      const target = typeOf(node);
      const source = typeOf(node.expression);
      if (target === null || source === null) return false;
      const { tsNode } = target;
      if (carriesBrand(target.type, tsNode)) return !isKeyedType(source.type, tsNode);
      const keySlots = keySlotsOf(target.type, tsNode);
      if (keySlots.length === 0) return false;
      if (isOpaque(source.type)) return true;
      const sourceSlots = slotsOf(source.type, tsNode);
      return keySlots.some(([name]) => sourceSlots.has(name) && !isKeyedType(sourceSlots.get(name), tsNode));
    }

    /**
     * Whether `node` is an `as never` / `as any` cast where a key (or values holding keys one level
     * in) is expected: the checker's contextual type at the cast. Its own target carries no brand, so
     * `mintsKey` cannot see it. Under an outer assertion that mints already, the outer one reports.
     */
    function castsIntoKeySlot(node) {
      const target = typeOf(node);
      if (target === null || (target.type.getFlags() & (ANY_FLAG | NEVER_FLAG)) === 0) return false;
      if (isMintingForm(node.parent) && mintsKey(node.parent)) return false;
      const expected = checker.getContextualType(target.tsNode);
      return expected !== undefined && holdsKeys(expected, target.tsNode);
    }

    function checkAssertion(node) {
      if (isMintingForm(node) && (mintsKey(node) || castsIntoKeySlot(node))) context.report({ node, messageId: 'assertion' });
    }

    /** A user-written `x is ContentKey` / `asserts x is ContentKey` guard mints keys nothing parsed. */
    function checkPredicate(node) {
      const tsType = node.typeAnnotation === null || node.typeAnnotation === undefined
        ? undefined
        : nodeMap.get(node.typeAnnotation.typeAnnotation);
      if (tsType !== undefined && holdsKeys(checker.getTypeFromTypeNode(tsType), tsType)) {
        context.report({ node, messageId: 'guard' });
      }
    }

    function reportRead(node, form) {
      context.report({ node, messageId: 'read', data: { form } });
    }

    /** Whether `callee` is a `RegExp`'s `test`/`exec`, by the receiver's type. */
    function isRegExpRun(callee) {
      if (!REGEXP_METHODS.has(memberName(callee))) return false;
      const typed = typeOf(callee.object);
      return typed !== null && typed.type.getSymbol()?.getName() === 'RegExp';
    }

    function checkMethodCall(node, callee) {
      const method = memberName(callee);
      if (method === 'localeCompare' && node.arguments.some((arg) => isKey(arg))) {
        context.report({ node, messageId: 'comparator', data: { name: method } });
      } else if (SORT_METHODS.has(method) && node.arguments[0] !== undefined
        && calledName(node.arguments[0]) === 'compareCodeUnits' && isKeyArray(callee.object)) {
        context.report({ node, messageId: 'comparator', data: { name: 'compareCodeUnits' } });
      } else if (isRegExpRun(callee) && node.arguments.some((arg) => isKey(arg))) {
        reportRead(node, `'${method}' with a ContentKey argument`);
      }
    }

    /** A destructure of a key reads its characters or its string members. */
    function checkPattern(pattern, source) {
      if ((pattern.type === 'ArrayPattern' || pattern.type === 'ObjectPattern') && source !== null && isKey(source)) {
        reportRead(pattern, 'A destructure');
      }
    }

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
      TSTypePredicate: checkPredicate,
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
      MemberExpression(node) {
        if (isKey(node.object)) reportRead(node, node.computed ? 'An index' : `'${memberName(node)}'`);
      },
      SpreadElement(node) {
        if (isKey(node.argument)) reportRead(node, 'A spread');
      },
      VariableDeclarator(node) {
        checkPattern(node.id, node.init);
      },
      AssignmentExpression(node) {
        checkPattern(node.left, node.right);
      },
      ForOfStatement(node) {
        if (isKey(node.right)) reportRead(node.right, 'Iterating');
      },
    };
  },
};

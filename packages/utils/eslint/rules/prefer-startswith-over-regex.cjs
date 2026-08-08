/**
 * ESLint rule: prefer-startswith-over-regex
 *
 * Catches `/^literal/.test(s)` and `/literal$/.test(s)` patterns whose body
 * flattens to a plain string, and recommends `s.startsWith('literal')` /
 * `s.endsWith('literal')`.
 *
 * Why a local rule?
 * `unicorn/prefer-string-starts-ends-with` already handles the simple case
 * but conservatively rejects any pattern containing `\` — including the
 * common `\/` (escaped slash) sequence. SonarCloud's S6557 catches these,
 * but only post-merge. This rule shifts that detection left into ESLint.
 *
 * ## Two shapes this rule deliberately does NOT limit itself to
 *
 * Both were narrowings in the first draft, and an adopter found each of them
 * the same way: SonarCloud raised a MAJOR S6557 on code this rule had reported
 * green.
 *
 * 1. **The regex need not be inline.** `const RE = /^x/; RE.test(s)` is the
 *    same violation as `/^x/.test(s)` — see {@link resolveRegex}.
 * 2. **An escaped non-special character is a literal character.** `\*` is an
 *    unambiguous `*`; refusing every escape but `\/` skipped it — see
 *    {@link literalEquivalent}.
 *
 * Neither could have been caught by scanning an adopter's tree. The rule runs
 * at `error` there, so its finding count is zero BY CONSTRUCTION — lint cannot
 * go green while a violation exists. A 0-vs-0 tie against another
 * implementation is not agreement, it is two rules both failing to fire. For
 * any rule an adopter reports zero findings for, that rule is *unmeasured*.
 *
 * Examples:
 *   /^file:\/\//.test(s)   →  s.startsWith('file://')
 *   /^\*glob/.test(s)      →  s.startsWith('*glob')
 *   const R = /^a/; R.test(s) →  s.startsWith('a')
 *   /^https?:\/\//.test(s) →  NOT flagged (contains `?` quantifier)
 *   /^[a-z]+/.test(s)      →  NOT flagged (contains `[` character class)
 *   /\.txt$/.test(s)       →  NOT flagged (`.` is a metachar; `\.` would flag)
 *   /^\d+/.test(s)         →  NOT flagged (`\d` is a character class)
 */

'use strict';

const METACHARS = new Set(['^', '$', '+', '[', '{', '(', '.', '?', '*', '|']);

/**
 * Escape sequences whose meaning is NOT "the character that follows the
 * backslash": character classes (`\d`, `\w`, `\s`, `\p`), assertions (`\b`),
 * numeric escapes and backreferences (`\0`–`\9`, `\k`), and the code-point
 * forms (`\x`, `\u`, `\c`). `\n`, `\r`, `\t`, `\v`, `\f` ARE single literal
 * characters, but flattening them would put a raw control character into the
 * suggested `startsWith('…')` string, so they are rejected too.
 *
 * Every other escape — `\/`, `\.`, `\*`, `\+`, `\(`, `\\`, `\-` … — is an
 * identity escape, and the character it protects is exactly what a
 * `startsWith` comparison would look for.
 */
const MEANINGFUL_ESCAPE = /[0-9BDPSWbcdfknprstuvwx]/;

/**
 * Flatten a regex body to the plain string it is equivalent to.
 *
 * Returns the literal string if safely convertible, otherwise null. Scans
 * character by character rather than doing a `replaceAll` of the one escape we
 * happen to like: `\/` was accepted and `\*` was not, though both denote a
 * single literal character and neither is a metacharacter once escaped.
 */
function literalEquivalent(patternBody) {
  let literal = '';

  for (let index = 0; index < patternBody.length; index += 1) {
    const char = patternBody[index];

    if (char === '\\') {
      const escaped = patternBody[index + 1];
      // A trailing lone backslash is not a valid pattern; refuse to guess.
      if (escaped === undefined || MEANINGFUL_ESCAPE.test(escaped)) {
        return null;
      }
      literal += escaped;
      index += 1;
      continue;
    }

    // Unescaped metacharacter: flattening it would change what matches.
    if (METACHARS.has(char)) {
      return null;
    }
    literal += char;
  }

  return literal;
}

/**
 * Find the variable `identifier` resolves to, searching outward from its scope.
 */
function findVariable(sourceCode, identifier) {
  for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const found = scope.variables.find((variable) => variable.name === identifier.name);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * The regex `node` denotes: itself when it is a regex literal, or the literal
 * a single-assignment variable was initialised with.
 *
 * The indirection matters because hoisting a regex to a module-level `const` is
 * the normal way to write one — and examining only inline literals meant the
 * rule went quiet on exactly the code most likely to run hot.
 *
 * Conservative on purpose: one definition, one write, and that write is a regex
 * literal. A binding assigned more than once could hold anything by the time
 * `.test()` runs, and nothing here proves which value that is.
 *
 * `indirect` is what lets the caller treat a hoisted regex differently from an
 * inline one — see the `g`/`y` guard, which only a shared object can trip.
 *
 * @returns {{pattern: string, flags: string, indirect: boolean} | null}
 */
function resolveRegex(sourceCode, node) {
  if (node.type === 'Literal' && node.regex) {
    return { ...node.regex, indirect: false };
  }
  if (node.type !== 'Identifier') {
    return null;
  }

  const variable = findVariable(sourceCode, node);
  if (variable?.defs.length !== 1) {
    return null;
  }
  const [definition] = variable.defs;
  if (definition.type !== 'Variable' || !definition.node.init) {
    return null;
  }
  if (variable.references.filter((reference) => reference.isWrite()).length !== 1) {
    return null;
  }

  const { init } = definition.node;
  return init.type === 'Literal' && init.regex ? { ...init.regex, indirect: true } : null;
}

/**
 * Render the flattened literal as JS SOURCE, not as a bare character run.
 *
 * The literal is a string of characters; the message drops it into
 * `startsWith(…)`, which a human reads as source. Those are different
 * languages, and interpolating one into the other loses exactly the characters
 * that matter. `/^C:\\Users/` flattens to `C:\Users` — one backslash — and
 * emitting it raw produced the advice `startsWith('C:\Users')`, which JavaScript
 * reads back as `"C:Users"`. Worse in the realistic case: a `/^\\\\/` UNC check
 * became `startsWith('\\')`, i.e. ONE backslash, silently true for any
 * single-backslash path. A literal containing `'` produced advice that is a
 * `SyntaxError` outright.
 *
 * This rule has no fixer, so the message IS the deliverable — there is no
 * autofixer downstream that would have escaped it correctly.
 */
function asSourceLiteral(literal) {
  return JSON.stringify(literal);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        String.raw`Prefer String#startsWith / String#endsWith over /^literal/.test() — including escaped literals such as \/ and \*, and regexes held in a const`,
      recommended: true,
    },
    messages: {
      // `{{pattern}}` carries its FLAGS. Rendering `/^abc/` for a source
      // `/^abc/g` hid the one character that decides whether the advice is
      // right, from the one person positioned to notice.
      preferStartsWith:
        'Prefer `<string>.startsWith({{literal}})` over `/{{pattern}}/{{flags}}.test(<string>)`. ' +
        String.raw`An escaped character such as \/ or \* is the literal character itself.`,
      preferEndsWith:
        'Prefer `<string>.endsWith({{literal}})` over `/{{pattern}}/{{flags}}.test(<string>)`. ' +
        String.raw`An escaped character such as \/ or \* is the literal character itself.`,
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.getSourceCode();

    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'test'
        ) {
          return;
        }
        // `startsWith` needs a string receiver where `.test()` would have
        // coerced one. Arity is the only part of that this rule can check
        // without types — a zero-argument `.test()` coerces `undefined` to
        // "undefined" and is nobody's prefix check. A non-string ARGUMENT
        // (`/^\[object/.test(v)`) remains a known limitation: `.test` coerces,
        // `startsWith` throws, and only a type checker can tell them apart.
        if (node.arguments.length !== 1) {
          return;
        }

        const regex = resolveRegex(sourceCode, node.callee.object);
        if (!regex) {
          return;
        }
        const { pattern, flags, indirect } = regex;
        if (flags.includes('i') || flags.includes('m')) {
          return;
        }
        // `g` and `y` make `.test()` STATEFUL through `lastIndex`. A regex
        // LITERAL is reconstructed on every evaluation, so its cursor is always
        // 0 and the flags are inert; a hoisted `const` is one object that
        // remembers. `const RE = /^abc/g` answers [true, false, true, false] to
        // four calls on the same string where `startsWith` answers true four
        // times — so resolving through a binding is precisely what makes this
        // advice wrong, and precisely where it must not be given.
        if (indirect && (flags.includes('g') || flags.includes('y'))) {
          return;
        }

        const report = (messageId, literal) => {
          context.report({
            node,
            messageId,
            data: { literal: asSourceLiteral(literal), pattern, flags },
          });
        };

        if (pattern.startsWith('^')) {
          const literal = literalEquivalent(pattern.slice(1));
          if (literal !== null && literal !== '') {
            report('preferStartsWith', literal);
            return;
          }
        }

        if (pattern.endsWith('$') && !pattern.endsWith(String.raw`\$`)) {
          const literal = literalEquivalent(pattern.slice(0, -1));
          if (literal !== null && literal !== '') {
            report('preferEndsWith', literal);
          }
        }
      },
    };
  },
};

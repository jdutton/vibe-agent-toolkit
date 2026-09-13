/**
 * ESLint rule: explicit-zod-strictness
 *
 * Every `z.object({...})` must say, in the same method chain, what it does
 * with a key it does not declare: `.strict()` (refuse), `.passthrough()` /
 * `.loose()` (keep), or `.strip()` (drop — said out loud, for the write-side
 * whitelist whose whole point is dropping). Zod's DEFAULT is that third answer
 * left unsaid, and that is the one this repo cannot afford: CLAUDE.md retired
 * every hand-bumped version integer on the promise that a strict schema is
 * what refuses stale stored data, and a default-strip schema keeps none of that
 * promise. It also hides the adopter-config trap the other way round: a key
 * the schema strips on the way in is a key the adopter thinks is honoured.
 *
 * `z.strictObject()` and `z.looseObject()` are explicit by construction and
 * pass. The marker may sit anywhere later in the chain (`.describe('…')
 * .strict()`, `.strict().optional()`), and `.extend()` / `.partial()` /
 * `.pick()` inherit the policy of what they were called on, so a chain that
 * reaches a marker through them is explicit too.
 *
 * Option `allowDefaultStripIn: string[]` — repo-relative paths of files whose
 * `z.object` calls may keep the default. This is a ratchet list, not a scope:
 * name files, not directories, so a new default-strip schema cannot arrive
 * unannounced under an allowed prefix.
 *
 * @example
 * // BAD — an unknown key vanishes without a word
 * const S = z.object({ version: z.string() });
 *
 * // GOOD — the policy is written where the shape is
 * const S = z.object({ version: z.string() }).strict();
 */

'use strict';

const { createExemptPathMatcher } = require('./exempt-path-matcher.cjs');

/** Chain methods that decide the unknown-key policy. */
const EXPLICIT_METHODS = new Set(['strict', 'passthrough', 'loose', 'strip']);

/** Whether `node` is a `z.object(...)` call. */
function isZodObjectCall(node) {
  const { callee } = node;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'z' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'object'
  );
}

/**
 * Whether the method chain that starts at `call` reaches an explicit
 * unknown-key method. Follows `<call>.<method>(...)` links only: the moment
 * the value is stored, passed, or returned the chain has ended and no later
 * `.strict()` on some other expression counts for this object.
 */
function chainDeclaresPolicy(call) {
  let current = call;
  for (;;) {
    const member = current.parent;
    if (member?.type !== 'MemberExpression' || member.object !== current || member.computed) {
      return false;
    }
    const outer = member.parent;
    if (outer?.type !== 'CallExpression' || outer.callee !== member) {
      return false;
    }
    if (member.property.type === 'Identifier' && EXPLICIT_METHODS.has(member.property.name)) {
      return true;
    }
    current = outer;
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every z.object({...}) to declare its unknown-key policy in the same chain — ' +
        '.strict(), .passthrough(), .loose() or an explicit .strip() — because the default silently strips keys',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowDefaultStripIn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      defaultStrip:
        'This z.object() keeps Zod\'s default of silently DROPPING unknown keys. Say what you mean: ' +
        '.strict() refuses them (the default for anything VAT stores or reads back), ' +
        '.passthrough() keeps them (only for a document some other party owns — say who, beside it), ' +
        '.strip() drops them on purpose (a write-side whitelist — say why, beside it).',
    },
  },

  create(context) {
    const allowed = context.options?.[0]?.allowDefaultStripIn ?? [];
    const filename = context.filename ?? context.getFilename();
    if (createExemptPathMatcher(allowed)(filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        if (isZodObjectCall(node) && !chainDeclaresPolicy(node)) {
          context.report({ node, messageId: 'defaultStrip' });
        }
      },
    };
  },
};

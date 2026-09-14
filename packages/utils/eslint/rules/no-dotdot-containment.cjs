/**
 * ESLint rule: no-dotdot-containment
 *
 * Flags a `..` string test used as a containment check on a path:
 * `rel.startsWith('..')`, `rel.startsWith('../')`, `name.includes('..')`, and
 * `p.split(sep).includes('..')` / `.some(s => …)` / `.indexOf('..')`.
 *
 * A string test answers "does this text contain two dots", which is not the
 * question. The question is "does this resolve INSIDE the root", and the two
 * come apart in every direction that matters:
 *
 * - a symlink inside the root that points outside has no `..` in its name;
 * - `startsWith('..')` also refuses a sibling whose name merely BEGINS with
 *   two dots (`..cache`), and `includes('..')` refuses `a..b`;
 * - on Windows a drive letter or a UNC prefix escapes without a single dot;
 * - the relative path was computed lexically, so a root that is itself a
 *   symlink gives a different answer from the one the filesystem gives.
 *
 * The sweep behind this rule verified sinks — a delete, a copy, an uninstall —
 * guarded by exactly these tests. The answer is one helper that asks the
 * filesystem: `isUnderRoot(root, candidate)` from `@vibe-agent-toolkit/utils`,
 * realpath-based, and honest about a candidate that does not exist yet.
 *
 * ## Scope
 *
 * The receiver must look like a path: an identifier or member whose name
 * carries a path word (`path`, `dir`, `rel`, `root`, `file`, `name`, `id`,
 * `target`, `dest`, `src`, `location`, `folder`), or any call result (a
 * `relative(root, p)` is a path by construction). A segment normaliser's
 * `segment === '..'` compares one segment and is not a containment test; it
 * is left alone, as is `startsWith('./')` and any literal without a `..`
 * segment.
 *
 * @example
 * // BAD — misses a symlink, refuses `..cache`, blind to a drive letter
 * if (safePath.relative(root, p).startsWith('..')) refuse();
 *
 * // GOOD — the filesystem answers
 * if (!isUnderRoot(root, p)) refuse();
 */

'use strict';

/** Words that mark a receiver as path-shaped. */
const PATH_WORD = /path|dir|rel|root|file|name|id|target|dest|src|location|folder/u;

/** A `..` segment at the start of a prefix literal: `..`, `../`, `..\`. */
const DOTDOT_PREFIX = /^\.\.(?:$|[\\/])/u;

/** A `..` segment anywhere in a substring literal: `..`, `/../`, `a/..`. */
const DOTDOT_SEGMENT = /(?:^|[\\/])\.\.(?:$|[\\/])/u;

/** Methods that, after a `.split(...)`, hunt for a segment. */
const MEMBERSHIP_METHODS = new Set(['includes', 'some', 'every', 'indexOf', 'find', 'filter']);

/** The non-computed method name of a call, or null. */
function methodName(call) {
  const { callee } = call;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') {
    return null;
  }
  return callee.property.name;
}

/** The identifier name a receiver is known by, or null when it has none. */
function receiverName(receiver) {
  if (receiver.type === 'Identifier') {
    return receiver.name;
  }
  if (receiver.type === 'MemberExpression' && !receiver.computed && receiver.property.type === 'Identifier') {
    return receiver.property.name;
  }
  return null;
}

/** Whether the receiver is named like a path. */
function isPathNamed(receiver) {
  const name = receiverName(receiver);
  return name !== null && PATH_WORD.test(name.toLowerCase());
}

/** The string value of the first argument when it is a literal, or null. */
function firstStringArg(call) {
  const arg = call.arguments[0];
  return arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value : null;
}

/** `<path>.startsWith('..')` / `<path>.includes('..')` — a `..` test on a path or a call result. */
function isDotdotStringTest(call, method) {
  const literal = firstStringArg(call);
  if (literal === null) {
    return false;
  }
  const receiver = call.callee.object;
  const pathLike = receiver.type === 'CallExpression' || isPathNamed(receiver);
  if (!pathLike) {
    return false;
  }
  if (method === 'startsWith') {
    return DOTDOT_PREFIX.test(literal);
  }
  return method === 'includes' && DOTDOT_SEGMENT.test(literal);
}

/** A `'..'` literal (as an argument, or anywhere inside a callback). */
const DOTDOT_LITERAL = /['"`]\.\.['"`]/u;

/**
 * `<path>.split(...).<membership>(...)` — hunting for a `..` segment. The
 * membership call must actually mention `'..'` (as its argument, or inside
 * its callback): `parts.split('/').filter(Boolean)` is splitting, not hunting.
 */
function isSplitSegmentHunt(call, method, sourceCode) {
  if (!MEMBERSHIP_METHODS.has(method) || call.arguments.length === 0) {
    return false;
  }
  const receiver = call.callee.object;
  return (
    receiver.type === 'CallExpression' &&
    methodName(receiver) === 'split' &&
    isPathNamed(receiver.callee.object) &&
    DOTDOT_LITERAL.test(sourceCode.getText(call.arguments[0]))
  );
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow startsWith('..') / includes('..') / split-and-hunt as a path containment check — " +
        'use the realpath-based isUnderRoot() helper',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [],
    messages: {
      dotdotContainment:
        'A `..` string test is not a containment check: it misses a symlink that points outside, ' +
        'refuses a name that merely starts with two dots, and is blind to a Windows drive letter ' +
        'or UNC prefix. Ask the filesystem: isUnderRoot(root, candidate) from ' +
        '@vibe-agent-toolkit/utils.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        const method = methodName(node);
        if (method === null) {
          return;
        }
        if (isDotdotStringTest(node, method) || isSplitSegmentHunt(node, method, sourceCode)) {
          context.report({ node, messageId: 'dotdotContainment' });
        }
      },
    };
  },
};

/**
 * ESLint rule: no-blind-catch
 *
 * Flags a `catch` clause that never LOOKS at its error and never THROWS. Such
 * a clause answers every failure the same way — a sentinel `return null`, a
 * `continue`, an empty body, a fallback assignment — so the case it was
 * written for (a file that is not there) becomes indistinguishable from the
 * cases it was not (a permission refusal, a corrupt artifact, a `TypeError`
 * from a bug two frames down). The result is a tool that is quietest exactly
 * when it is most wrong: a directory the OS refused to list reports as empty,
 * and a build that examined nothing exits 0.
 *
 * This is the class behind the worst finding in seven consecutive adversarial
 * review rounds on one branch. A crawler learned to REFUSE an unreadable
 * directory instead of skipping it; one caller's `catch { return null }`
 * absorbed the refusal, and `vat audit` silently ran with no population. The
 * fix was type-forcing the seam so `tsc` enumerated the callers — but a blind
 * `catch` is the one seam `tsc` cannot see, because it compiles for every
 * callee that ever learns to throw.
 *
 * ## What counts as handling
 *
 * The rule is a FLOOR, deliberately syntactic: the clause is fine if either
 *
 * 1. the error binding is REFERENCED anywhere in the body — narrowing on it
 *    (`isFilesystemAccessError(e)`, `e instanceof X`, `e.code === 'ENOENT'`),
 *    carrying it into a report (`errors.push(String(e))`, `{ ok: false, error }`),
 *    or logging it — or
 * 2. the body THROWS (a rethrow, or a translation into a louder error), at the
 *    clause's own level — a `throw` inside a nested function is a promise to
 *    fail later, not a rethrow from this catch.
 *
 * A reference is a reference: the rule cannot tell `narrow(e)` from `log(e)`,
 * and does not try. What it guarantees is the weaker, enforceable property —
 * *the error was looked at before being discarded* — which is the property
 * every one of the shipped defects lacked.
 *
 * ## What this rule does NOT catch
 *
 * - `catch (e) { void e; return null; }` — a reference written to dodge the
 *   rule. Code review's job.
 * - A narrowing that is wrong: `if (e instanceof Error) return null` looks at
 *   the error and still absorbs everything. The rule sees a reference.
 * - A catch whose body references the binding only to build a message it
 *   then throws away.
 *
 * There is deliberately NO annotation escape hatch. Every site this rule
 * flags has a legitimate rewrite — narrow and rethrow, or carry the error into
 * the result — and an `eslint-disable` with a reason is already the escape
 * hatch ESLint provides, visible in the diff and countable with
 * `rg 'eslint-disable.*no-blind-catch'`.
 *
 * @example
 * // BAD — "not there" and "refused" and "bug" all become null
 * try { return statSync(p); } catch { return null; }
 *
 * // GOOD — narrowed to the case the sentinel means, everything else stays loud
 * try { return statSync(p); } catch (e) {
 *   if (isPathAbsentError(e)) return null;
 *   throw e;
 * }
 *
 * // GOOD — the error reaches the report instead of vanishing
 * try { return parse(text); } catch (e) {
 *   return { ok: false, reason: String(e) };
 * }
 */

'use strict';

/** Function-boundary node types: a `throw` inside one is not this clause's throw. */
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Keys on an ESTree node that point somewhere other than a child. */
const NON_CHILD_KEYS = new Set(['parent', 'loc', 'range']);

/** Whether `value` is an ESTree node (as opposed to a token, a literal, or null). */
function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

/** Every child node of `node`, in no particular order. */
function childNodes(node) {
  const children = [];
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) {
      continue;
    }
    const value = node[key];
    const values = Array.isArray(value) ? value : [value];
    children.push(...values.filter((child) => isNode(child)));
  }
  return children;
}

/**
 * Whether `body` contains a `ThrowStatement` reachable without crossing a
 * function boundary. Iterative so a deeply nested body cannot blow the stack.
 */
function throwsAtOwnLevel(body) {
  const stack = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === 'ThrowStatement') {
      return true;
    }
    if (!FUNCTION_TYPES.has(node.type)) {
      stack.push(...childNodes(node));
    }
  }
  return false;
}

/**
 * Whether any binding the clause declares (`catch (e)`, `catch ({ code })`) is
 * read in the body. A clause with no param declares nothing and reads nothing.
 */
function readsErrorBinding(sourceCode, node) {
  if (node.param === null) {
    return false;
  }
  const declared = sourceCode.getDeclaredVariables(node);
  return declared.some((variable) => variable.references.length > 0);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a catch clause that neither reads its error nor throws — it absorbs a bug, a ' +
        'permission refusal, or a corrupt artifact into the same answer as the case it was written for',
      category: 'Possible Errors',
      recommended: true,
    },
    schema: [],
    messages: {
      blindCatch:
        'This catch discards the error without looking at it, so a bug, a permission refusal, or a ' +
        'corrupt artifact is absorbed into the same result as the case it was written for. Narrow it ' +
        "to that case and rethrow the rest — `if (isPathAbsentError(e)) return null; throw e;` — or " +
        'carry the error into the result so the report can show it.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CatchClause(node) {
        if (readsErrorBinding(sourceCode, node) || throwsAtOwnLevel(node.body)) {
          return;
        }
        context.report({ node, messageId: 'blindCatch' });
      },
    };
  },
};

/* eslint-disable sonarjs/todo-tag -- This rule governs disabled tests, so its
   documentation and its own test-runner member list necessarily quote the
   `todo` token that sonarjs/todo-tag bans. The ban is why the annotation
   grammar below is SKIP(#N) and not TODO(#N). */

/* STILL BLIND (syntax-only rule): a skip reached through an imported/re-exported binding or an alias of an
   alias; `it.only`; `expect(A).toBe(A)` on named constants; `assert.ok(true)`; a non-empty body with no assertion. */

/**
 * ESLint rule: require-justified-skip
 *
 * Flags test code that claims coverage it does not provide:
 *
 * 1. **Unconditional skips** — `it.skip`, `test.skip`, `describe.skip`, `suite.skip`,
 *    `it.todo`, `test.todo`, and the `xit`/`xdescribe`/`xtest` aliases. The suite
 *    still lists the case, so a reader (and a coverage report) sees a test that
 *    never runs. Also the spellings that dodge a naive `object.property` check:
 *    deeper chains (`test.concurrent.skip`), computed access (`it['skip']`), and
 *    alias assignment (`const gate = describe.skip`).
 * 2. **Tautological assertions** — `expect(<literal>)` (or `expect.soft(...)`)
 *    whose matcher argument is also a literal (or absent): `expect(true).toBe(true)`,
 *    `expect(1 === 1).toBe(true)`, `expect([]).toEqual([])`, `assert(true)`. These
 *    are *worse* than a skip, because they report as PASSING.
 * 3. **Empty test bodies** — `it('x', () => {})`. Same failure mode as (2): a
 *    listed, green case that asserts nothing. `describe` is exempt; an empty
 *    suite claims no case of its own.
 *
 * ## What this rule does NOT catch — read this before trusting it
 *
 * The coherence audit that motivated this rule found **9** instances of tests
 * that asserted something other than what their name claimed. This rule catches
 * **3 of the 9**. The other 6 were live, green, PASSING tests that asserted the
 * wrong thing — a linter cannot see those, because nothing about their syntax is
 * wrong. No amount of tightening this rule will reach them.
 *
 * The real control for that class is a convention, not a lint rule: **every
 * assertion of absence sits beside a positive control on the same fixture.** If
 * a test asserts "no issue was reported", a sibling assertion on the same
 * fixture must prove the detector fires at all — otherwise a detector that never
 * runs is indistinguishable from a detector that correctly found nothing.
 *
 * Worked example in tree:
 * `packages/agent-skills/test/integration/skill-packager.integration.test.ts`
 * (`skill-packager: post-build integrity`, ~lines 1031-1072) — the suppression
 * test asserts `postBuildIssues` is empty, and its sibling asserts the *same*
 * fixture produces `PACKAGED_UNREFERENCED_FILE` when suppression is off. The
 * pair is what makes the empty result meaningful.
 *
 * Treat this rule as the cheap 3/9, not as coverage of the problem.
 *
 * ## Escape hatch — the annotation grammar
 *
 * A flagged call is exempt when a comment on the same line, or on the line
 * immediately above, matches exactly one shape:
 *
 *     /\bSKIP\(#\d+\):\s*\S/
 *
 * i.e. `SKIP(#163): references[] not populated by the extractor yet`. Three
 * parts are all required: the uppercase keyword `SKIP`, a `#`-prefixed GitHub
 * issue number, and a non-empty reason after the colon. A bare
 * `// fix this later` does not qualify — an escape hatch that accepts any
 * comment is not an escape hatch, it is an off switch.
 *
 * Why `SKIP(` and not the more natural `TODO(`: this repo runs
 * `sonarjs/todo-tag` at error level, which bans the `TODO` token in comments
 * outright. A grammar built on `TODO(#N)` would be unusable — every
 * annotation would trip a second rule. One keyword, and it is `SKIP`.
 *
 * Grep the whole tree for outstanding debt with: `rg 'SKIP\(#'`
 *
 * @example
 * // BAD — silently claims a case the suite never runs
 * it.skip('validates broken links', () => { ... });
 *
 * // BAD — reports as PASSING while asserting nothing
 * expect(true).toBe(true);
 *
 * // GOOD — a condition, not a claim of coverage
 * it.skipIf(process.platform === 'win32')('uses POSIX permissions', () => { ... });
 *
 * // GOOD — annotated with a tracking issue and a reason
 * // SKIP(#163): references[] not populated by the extractor yet
 * it.skip('REFERENCE_TARGET_MISSING', () => { ... });
 */

/** Test-runner globals whose `.skip` / `.todo` members disable a case. */
const TEST_ROOTS = new Set(['it', 'test', 'describe', 'suite']);

/** Roots whose empty-bodied call is a case that asserts nothing. `describe` is not one. */
const EMPTY_BODY_ROOTS = new Set(['it', 'test']);

/** Members that disable a case unconditionally. `skipIf` / `runIf` are NOT here. */
const DISABLING_MEMBERS = new Set(['skip', 'todo']);

/** Bare-identifier aliases for the same thing. */
const DISABLING_ALIASES = new Set(['xit', 'xdescribe', 'xtest', 'xspecify']);

/** Identifiers that are literal values rather than references. */
const LITERAL_IDENTIFIERS = new Set(['undefined', 'NaN', 'Infinity']);

/**
 * Annotation grammar. Deliberately narrow: keyword + `#`-issue + non-empty reason.
 * See the module doc comment.
 */
const JUSTIFICATION_PATTERN = /\bSKIP\(#\d+\):\s*\S/;

/**
 * True when `node` is a value that is fully known at parse time, so comparing it
 * against another such value tells you nothing about the code under test.
 */
function isLiteralValue(node) {
  if (!node) {
    return false;
  }
  if (node.type === 'Literal') {
    return true;
  }
  if (node.type === 'TemplateLiteral') {
    return node.expressions.length === 0;
  }
  if (node.type === 'Identifier') {
    return LITERAL_IDENTIFIERS.has(node.name);
  }
  if (node.type === 'UnaryExpression') {
    return isLiteralValue(node.argument);
  }
  // `1 === 1`, `2 > 1` — both operands known, so the comparison is decided at parse time.
  if (node.type === 'BinaryExpression') {
    return isLiteralValue(node.left) && isLiteralValue(node.right);
  }
  // `[]`, `[1, 2]`, `{}` — a collection built entirely from known values.
  if (node.type === 'ArrayExpression') {
    return node.elements.every((element) => element === null || isLiteralValue(element));
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.every(
      (property) => property.type === 'Property' && !property.computed && isLiteralValue(property.value),
    );
  }
  return false;
}

/**
 * Property name of a member access, whether dotted (`it.skip`) or computed with a
 * string key (`it['skip']`). Null when the key is not knowable statically.
 */
function memberName(node) {
  if (!node.computed) {
    return node.property.type === 'Identifier' ? node.property.name : null;
  }
  return node.property.type === 'Literal' && typeof node.property.value === 'string'
    ? node.property.value
    : null;
}

/**
 * True when a member chain bottoms out at a test-runner global, so
 * `test.concurrent.skip` and `test.sequential.skip` count but `myLib.test.skip`
 * does not.
 */
function isTestRootChain(node) {
  let current = node;
  while (current.type === 'MemberExpression') {
    current = current.object;
  }
  return current.type === 'Identifier' && TEST_ROOTS.has(current.name);
}

/** `expect(...)` or `expect.soft(...)` — the soft variant is still an assertion. */
function isExpectCallee(callee) {
  if (callee.type === 'Identifier') {
    return callee.name === 'expect';
  }
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect' &&
    memberName(callee) === 'soft'
  );
}

/**
 * True when a non-invoked `it.skip` is being stored under another name
 * (`const gate = describe.skip`), which reaches every later `gate(...)` call.
 * A ternary branch (`cond ? describe : describe.skip`) is excluded: its parent is
 * the ConditionalExpression, not the declarator, so it stays a runtime gate.
 */
function isAliasAssignment(node) {
  const { parent } = node;
  if (!parent) {
    return false;
  }
  return (
    (parent.type === 'VariableDeclarator' && parent.init === node) ||
    (parent.type === 'AssignmentExpression' && parent.right === node)
  );
}

/** True when a test callback is present but its block body is empty. */
function hasEmptyBody(callback) {
  return (
    Boolean(callback) &&
    (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') &&
    callback.body.type === 'BlockStatement' &&
    callback.body.body.length === 0
  );
}

/**
 * Walk up from `node` through any member chain hanging off it and return the
 * CallExpression that ultimately invokes it, or null when `node` is not being
 * called at all.
 *
 * Used for both halves of this rule:
 *  - `it.skip(...)` and `it.skip.each([...])(...)` resolve to their call, so
 *    they are reported; `(NET ? describe : describe.skip)(...)` and
 *    `const d = cond ? describe : describe.skip` resolve to null, because the
 *    member expression is a ternary branch rather than a callee. That ternary
 *    is a runtime gate — the same thing skipIf() expresses — so it must not be
 *    flagged. (Both shapes exist in this repo; the first draft of this rule
 *    flagged them and was wrong.)
 *  - `expect(x)` resolves through `.not` / `.resolves` / `.toBe` to the
 *    matcher call.
 */
function resolveInvocation(node) {
  let current = node;
  let parent = current.parent;
  while (parent?.type === 'MemberExpression' && parent.object === current) {
    current = parent;
    parent = current.parent;
  }
  if (parent?.type === 'CallExpression' && parent.callee === current) {
    return parent;
  }
  return null;
}

/** Collect every source line covered by a justification comment. */
function collectJustifiedLines(sourceCode) {
  const lines = new Set();
  for (const comment of sourceCode.getAllComments()) {
    if (!JUSTIFICATION_PATTERN.test(comment.value)) {
      continue;
    }
    for (let line = comment.loc.start.line; line <= comment.loc.end.line; line++) {
      lines.add(line);
    }
  }
  return lines;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a tracking-issue justification for skipped tests, and ban tautological assertions',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
    messages: {
      unconditionalSkip:
        'This test is disabled unconditionally, so the suite lists a case it never runs. ' +
        "Fix it, delete it, or annotate it with a tracking issue: '// SKIP(#123): reason' " +
        'on the line above. A platform or environment gate should use skipIf()/runIf() ' +
        'instead — a condition is not a skip.',
      tautologicalAssertion:
        'This assertion compares literals, so it passes no matter what the code does — ' +
        'worse than a skip, because it reports as PASSING. Assert on a value produced by ' +
        'the code under test, or delete the assertion. If the literal really is the subject, ' +
        "annotate it: '// SKIP(#123): reason'.",
      emptyTestBody:
        'This test has an empty body, so it asserts nothing while reporting as PASSING. ' +
        'Give it an assertion, delete it, or — if the case is real but not written yet — ' +
        "make the gap visible with it.todo() plus '// SKIP(#123): reason'.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    let justifiedLines = null;

    /** A finding is exempt when annotated on its own line or the line above. */
    function isJustified(node) {
      justifiedLines ??= collectJustifiedLines(sourceCode);
      const line = node.loc.start.line;
      return justifiedLines.has(line) || justifiedLines.has(line - 1);
    }

    function report(node, messageId) {
      if (!isJustified(node)) {
        context.report({ node, messageId });
      }
    }

    return {
      // `it.skip`, `describe.todo`, and the `it.skip.each(...)` chain (whose
      // inner member expression is `it.skip`).
      MemberExpression(node) {
        if (!DISABLING_MEMBERS.has(memberName(node)) || !isTestRootChain(node.object)) {
          return;
        }
        // Only an invoked skip disables a case, or an alias that will be invoked
        // later. A ternary branch is a gate.
        if (!resolveInvocation(node) && !isAliasAssignment(node)) {
          return;
        }
        report(node, 'unconditionalSkip');
      },

      CallExpression(node) {
        // `xit(...)` / `xdescribe(...)` aliases.
        if (node.callee.type === 'Identifier' && DISABLING_ALIASES.has(node.callee.name)) {
          report(node, 'unconditionalSkip');
          return;
        }

        // `it('x', () => {})` — a listed case whose body asserts nothing, yet PASSES.
        if (node.callee.type === 'Identifier' && EMPTY_BODY_ROOTS.has(node.callee.name)) {
          if (hasEmptyBody(node.arguments[1])) {
            report(node, 'emptyTestBody');
          }
          return;
        }

        // `assert(true)` — never fails. `assert(false, 'unreachable')` is a real
        // guard, so only the always-true spelling is reported.
        if (node.callee.type === 'Identifier' && node.callee.name === 'assert') {
          if (node.arguments[0]?.type === 'Literal' && node.arguments[0].value === true) {
            report(node, 'tautologicalAssertion');
          }
          return;
        }

        // `expect(<literal>).<matcher>(<literal>?)`
        if (!isExpectCallee(node.callee)) {
          return;
        }
        if (node.arguments.length !== 1 || !isLiteralValue(node.arguments[0])) {
          return;
        }
        const matcherCall = resolveInvocation(node);
        if (matcherCall?.arguments.every((argument) => isLiteralValue(argument))) {
          report(matcherCall, 'tautologicalAssertion');
        }
      },
    };
  },
};

/* eslint-disable sonarjs/todo-tag -- This rule governs disabled tests, so its
   documentation and its own test-runner member list necessarily quote the
   `todo` token that sonarjs/todo-tag bans. The ban is why the annotation
   grammar below is SKIP(#N) and not TODO(#N). */

/**
 * ESLint rule: require-justified-skip
 *
 * Flags test code that claims coverage it does not provide:
 *
 * 1. **Unconditional skips** — `it.skip`, `test.skip`, `describe.skip`, `suite.skip`,
 *    `it.todo`, `test.todo`, and the `xit`/`xdescribe`/`xtest` aliases. The suite
 *    still lists the case, so a reader (and a coverage report) sees a test that
 *    never runs.
 * 2. **Tautological assertions** — `expect(<literal>)` whose matcher argument is
 *    also a literal (or absent): `expect(true).toBe(true)`, `expect(1).toBe(1)`,
 *    `expect(true).toBeTruthy()`. These are *worse* than a skip, because they
 *    report as PASSING.
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
  return false;
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
  while (parent && parent.type === 'MemberExpression' && parent.object === current) {
    current = parent;
    parent = current.parent;
  }
  if (parent && parent.type === 'CallExpression' && parent.callee === current) {
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
        if (node.property.type !== 'Identifier' || !DISABLING_MEMBERS.has(node.property.name)) {
          return;
        }
        if (node.object.type !== 'Identifier' || !TEST_ROOTS.has(node.object.name)) {
          return;
        }
        // Only an invoked skip disables a case. A ternary branch is a gate.
        if (!resolveInvocation(node)) {
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

        // `expect(<literal>).<matcher>(<literal>?)`
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'expect') {
          return;
        }
        if (node.arguments.length !== 1 || !isLiteralValue(node.arguments[0])) {
          return;
        }
        const matcherCall = resolveInvocation(node);
        if (matcherCall && matcherCall.arguments.every((argument) => isLiteralValue(argument))) {
          report(matcherCall, 'tautologicalAssertion');
        }
      },
    };
  },
};

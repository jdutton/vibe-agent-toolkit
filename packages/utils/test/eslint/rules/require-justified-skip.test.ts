import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const CASES: RuleCases = {
  valid: [
    // Conditional gates are a platform/environment condition, not a coverage claim.
    { code: "it.skipIf(process.platform === 'win32')('x', () => {});" },
    { code: 'describe.skipIf(!apiKey)("x", () => {});' },
    { code: 'it.runIf(hasPlugins)("x", () => {});' },
    { code: 'describe.runIf(cond)("x", () => {});' },
    // Runtime context skip (vitest `ctx.skip(...)`) — a condition evaluated at run time.
    { code: 'ctx.skip(message);' },
    { code: 'this.skip();' },
    // Ternary gates. Both shapes are live in this repo (corpus-scan.system.test.ts
    // and llm-regression.test.ts) and are skipIf() spelled by hand — a condition,
    // not a coverage claim. The rule's first draft flagged both; it was wrong.
    { code: "(NET ? describe : describe.skip)('x', () => {});" },
    { code: 'const gate = shouldRun ? describe : describe.skip;' },
    { code: "(cond ? it : it.skip)('x', () => {});" },
    { code: 'const gate = cond ? describe.skip : describe;' },
    // Aliasing a runner that is NOT disabled is not a skip.
    { code: 'const runner = describe;' },
    // Ordinary tests and real assertions.
    { code: 'it("x", () => { expect(a).toBe(b); });' },
    { code: 'test("x", async () => { await run(); expect(a).toBe(b); });' },
    // An empty `describe` claims no case of its own — only `it`/`test` do.
    { code: 'describe("x", () => {});' },
    { code: 'expect(result).toBe(true);' },
    { code: 'expect(true).toBe(result);' },
    { code: 'expect(1).toHaveLength(n);' },
    { code: 'expect(value).toBeTruthy();' },
    { code: 'expect.assertions(2);' },
    { code: 'expect(items[0]).toBe("a");' },
    // Non-literal operands — the comparison depends on the code under test.
    { code: 'expect(a === b).toBe(true);' },
    { code: 'expect(result.length > 0).toBe(true);' },
    // Only one side is a known-empty collection — the other is the subject.
    { code: 'expect(result).toEqual([]);' },
    { code: 'expect([]).toEqual(result);' },
    { code: 'expect(result).toEqual({});' },
    // `assert` on a runtime value, and the deliberate always-fail guard.
    { code: 'assert(value);' },
    { code: "assert(false, 'unreachable');" },
    { code: 'assert(items.length > 0);' },
    // `expect.soft` behaves like `expect` — same subject rules apply.
    { code: 'expect.soft(result).toBe(true);' },
    // A deeper chain that does not bottom out at a test-runner global.
    { code: "myLib.test.skip('x', () => {});" },
    { code: "helpers.it['skip']('x', () => {});" },
    { code: "test.concurrent('x', () => { expect(a).toBe(b); });" },
    // Computed access with a non-literal key — unknowable, so not flagged.
    { code: "it[name]('x', () => {});" },
    { code: "obj['skip']('x');" },
    // Justified skips — annotation directly above the call.
    { code: "// SKIP(#163): blocked on extractor work\nit.skip('x', () => {});" },
    { code: "// SKIP(#42): needs a fixture that can distinguish the two lanes\nit.todo('x');" },
    { code: "/* SKIP(#7): flaky under bun, tracked upstream */\ndescribe.skip('x', () => {});" },
    // Justified skip — trailing annotation on the same line.
    { code: "it.todo('x'); // SKIP(#99): waiting on the extractor" },
    // Justified tautology.
    { code: '// SKIP(#12): asserts the matcher itself, not the subject\nexpect(true).toBe(true);' },
  ],
  invalid: [
    { code: "it.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "test.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "describe.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "suite.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "it.todo('x');", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "test.todo('x');", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "it.skip.each([1])('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "xit('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "xdescribe('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "xtest('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // A vague comment is NOT a justification — the grammar is deliberately narrow.
    { code: "// fix this later\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// skip(#12): lowercase does not match\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// SKIP(#12)\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// SKIP(#12):\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// SKIP(): no issue number\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // Only the `SKIP` keyword is accepted. The obvious alternative keyword is banned
    // repo-wide by another sonarjs rule, so a grammar built on it would be unusable.
    { code: "// TODO(#12): wrong keyword\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // An annotation two lines above is out of range.
    { code: "// SKIP(#12): too far away\n\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // Tautological assertions — literal subject, literal (or absent) matcher argument.
    { code: 'expect(true).toBe(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(true).toBe(false);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(1).toBe(1);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: "expect('a').toEqual('a');", errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(true).toBeTruthy();', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(true).not.toBe(false);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(-1).toBe(-1);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(`abc`).toBe("abc");', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(null).toBeNull();', errors: [{ messageId: 'tautologicalAssertion' }] },
    // Aliasing an unconditional skip — one deleted ternary away from the valid
    // gate above, and invisible to the call-site check.
    { code: 'const gate = describe.skip;', errors: [{ messageId: 'unconditionalSkip' }] },
    { code: 'let gate; gate = it.skip;', errors: [{ messageId: 'unconditionalSkip' }] },
    // Always-true expressions that are not `Literal` nodes.
    { code: 'expect(1 === 1).toBe(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(2 > 1).toBeTruthy();', errors: [{ messageId: 'tautologicalAssertion' }] },
    // Empty-collection self-comparison.
    { code: 'expect([]).toEqual([]);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect({}).toEqual({});', errors: [{ messageId: 'tautologicalAssertion' }] },
    // `assert(true)` never fails.
    { code: 'assert(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    // `expect.soft` is still an expect.
    { code: 'expect.soft(true).toBe(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    // Deeper member chains that still bottom out at a test-runner global.
    { code: "test.concurrent.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "test.sequential.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // Computed access spelling the same disabling member.
    { code: "it['skip']('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // A test with no body asserts nothing while reporting as PASSING.
    { code: "it('x', () => {});", errors: [{ messageId: 'emptyTestBody' }] },
    { code: "test('x', async () => {});", errors: [{ messageId: 'emptyTestBody' }] },
  ],
};

describe('require-justified-skip', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('require-justified-skip', CASES); });
});

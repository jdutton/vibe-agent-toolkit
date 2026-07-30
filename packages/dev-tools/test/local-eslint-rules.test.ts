/**
 * Tests for local ESLint rules in packages/dev-tools/eslint-local-rules/.
 *
 * Each rule contributes one row to SUITES below. Adding a new rule means
 * a new RuleCases constant plus a one-line row — keeps RuleTester
 * scaffolding in exactly one place.
 */

import { describe, expect, it } from 'vitest';

import { loadLocalRule, type RuleCases, ruleTester } from './eslint-rule-test-harness.js';

const NO_URL_PATHNAME_FOR_FS_CASES: RuleCases = {
  valid: [
    { code: "import { fileURLToPath } from 'node:url'; const p = fileURLToPath(new URL('../x', import.meta.url));" },
    { code: "const p = new URL('http://example.com').pathname;" },
    { code: 'const p = someUrl.pathname;' },
    { code: "const u = new URL('../x', import.meta.url); const s = u.href;" },
  ],
  invalid: [
    { code: 'const p = new URL(rel, import.meta.url).pathname;', errors: [{ messageId: 'useFileURLToPath' }] },
    { code: "const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;", errors: [{ messageId: 'useFileURLToPath' }] },
    { code: 'const p = new URL(`../fixtures/${name}.yaml`, import.meta.url).pathname;', errors: [{ messageId: 'useFileURLToPath' }] },
  ],
};

const NO_BARE_DYNAMIC_IMPORT_PATH_CASES: RuleCases = {
  valid: [
    { code: "await import('./relative.js');" },
    { code: "await import('../sibling.js');" },
    { code: "await import('some-pkg');" },
    { code: "await import('@scope/pkg');" },
    { code: "import { pathToFileURL } from 'node:url'; const p = '/abs'; await import(pathToFileURL(p).href);" },
    { code: 'const spec = "./x.js"; await import(spec);' },
  ],
  invalid: [
    { code: "await import('/Users/foo/x.js');", errors: [{ messageId: 'useFileUrl' }] },
    { code: String.raw`await import('C:\\x.js');`, errors: [{ messageId: 'useFileUrl' }] },
    { code: "import path from 'node:path'; await import(path.join(dir, 'x.js'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: "import path from 'node:path'; await import(path.resolve('x'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: "import { join } from 'node:path'; await import(join(dir, 'x.js'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: 'const absPath = "/x"; await import(absPath);', errors: [{ messageId: 'useFileUrl' }] },
    { code: 'const configFile = "/x"; await import(configFile);', errors: [{ messageId: 'useFileUrl' }] },
    { code: "import { join } from 'node:path'; await import(`${join(dir, 'x.js')}`);", errors: [{ messageId: 'useFileUrl' }] },
  ],
};

const NO_FILE_URL_STRING_CONCAT_CASES: RuleCases = {
  valid: [
    { code: "import { pathToFileURL } from 'node:url'; const u = pathToFileURL(process.argv[1]).href;" },
    { code: "if (path.startsWith('file://')) {}" },
    { code: "const u = 'file://example.com';" },
    { code: "const u = `file://example.com`;" },
    { code: "new URL('file:///abs/path');" },
    { code: "const s = 'hello' + name;" },
  ],
  invalid: [
    { code: 'const u = `file://${process.argv[1]}`;', errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "if (import.meta.url === `file://${process.argv[1]}`) {}", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "const u = 'file://' + somePath;", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "const u = somePath + 'file://abc';", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: 'const u = `file:///${drive}/${rest}`;', errors: [{ messageId: 'useFileUrlBuilder' }] },
  ],
};

const PREFER_STARTSWITH_OVER_REGEX_CASES: RuleCases = {
  valid: [
    // unicorn would catch these, but our rule treats them as redundant — both are fine.
    { code: "const s = 'x'; if (s.startsWith('file://')) {}" },
    // Patterns with regex metacharacters — must NOT flag (cannot safely flatten).
    { code: String.raw`const s = 'x'; if (/^https?:\/\//.test(s)) {}` },
    { code: "const s = 'x'; if (/^[a-z]+/.test(s)) {}" },
    { code: String.raw`const s = 'x'; if (/\.txt$/.test(s)) {}` },
    { code: "const s = 'x'; if (/^foo|bar/.test(s)) {}" },
    // Flags i/m make literal conversion unsafe — must not flag.
    { code: "const s = 'x'; if (/^foo/i.test(s)) {}" },
    // Other escapes (\d, \w, \\) are not safely flattenable — must not flag.
    { code: String.raw`const s = 'x'; if (/^\d+/.test(s)) {}` },
    // No anchor — not a prefix/suffix check.
    { code: "const s = 'x'; if (/foo/.test(s)) {}" },
    // Method calls that aren't .test() — must not flag.
    { code: "const s = 'x'; const m = /^foo/.exec(s);" },
  ],
  invalid: [
    { code: String.raw`const s = 'x'; if (/^file:\/\//.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/^ssh:\/\//.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const s = 'x'; if (/^foo/.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const s = 'x'; if (/bar$/.test(s)) {}", errors: [{ messageId: 'preferEndsWith' }] },
    { code: "const s = 'x'; if (/^abc-def/.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
  ],
};

interface RuleSuite {
  name: string;
  cases: RuleCases;
}


const NO_UNSAFE_ROOT_JOIN_CASES: RuleCases = {
  valid: [
    // joinUnderRoot — already the safe call, not flagged
    { code: 'safePath.joinUnderRoot(harnessRoot, name);' },
    // First arg does NOT end in 'root' — not a security root join, not flagged
    { code: 'safePath.join(baseDir, name);' },
    { code: 'safePath.join(pluginDir, name);' },
    { code: 'safePath.resolve(outputDir, name);' },
    // Non-safePath member expression — not our rule
    { code: "path.join(harnessRoot, 'sub');"},
    // safePath.relative is not join/resolve — not flagged
    { code: "safePath.relative(harnessRoot, dest);" },
    // No arguments — not flagged
    { code: "safePath.join();" },
  ],
  invalid: [
    {
      code: 'safePath.join(harnessRoot, name);',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.join(stagedRoot, "subdir");',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.join(pluginRoot, stagedDirName(item));',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.resolve(harnessRoot, segment);',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      // Mixed-case 'Root' suffix
      code: 'safePath.join(outputROOT, "child");',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
  ],
};

const REQUIRE_JUSTIFIED_SKIP_CASES: RuleCases = {
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

const SUITES: readonly RuleSuite[] = [
  { name: 'no-url-pathname-for-fs', cases: NO_URL_PATHNAME_FOR_FS_CASES },
  { name: 'no-bare-dynamic-import-path', cases: NO_BARE_DYNAMIC_IMPORT_PATH_CASES },
  { name: 'no-file-url-string-concat', cases: NO_FILE_URL_STRING_CONCAT_CASES },
  { name: 'prefer-startswith-over-regex', cases: PREFER_STARTSWITH_OVER_REGEX_CASES },
  { name: 'no-unsafe-root-join', cases: NO_UNSAFE_ROOT_JOIN_CASES },
  { name: 'require-justified-skip', cases: REQUIRE_JUSTIFIED_SKIP_CASES },
];

describe.each(SUITES)('$name', ({ name, cases }) => {
  const rule = loadLocalRule(`${name}.cjs`);

  it('is registered with a valid schema', () => {
    expect(rule.meta?.type).toBe('problem');
  });

  it('passes RuleTester cases', () => {
    expect(() => { ruleTester.run(name, rule, cases); }).not.toThrow();
  });
});

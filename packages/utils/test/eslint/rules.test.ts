/**
 * Tests for the rules in packages/utils/eslint/rules/.
 *
 * Each rule contributes one row to SUITES below. Adding a new rule means
 * a new RuleCases constant plus a one-line row — keeps RuleTester
 * scaffolding in exactly one place.
 */

import { Linter, type Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  loadLocalRule,
  loadLocalRuleModule,
  type RuleCases,
  ruleTester,
} from './rule-test-harness.js';

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

/**
 * `no-path-join` / `no-path-resolve` / `no-path-relative` share one factory, so
 * they share one case table. The load-bearing legs are the last three invalid
 * cases: a DECOY file whose basename matches an exempt implementation file but
 * whose directory does not. The factory used to exempt via
 * `filename.includes('path-utils.ts')`, so every decoy linted clean — the exact
 * bug that let a private `tools/hooks/path-utils.ts` ship raw path calls in a
 * consumer repo running a fork of these rules.
 *
 * Exemptions are a RULE OPTION, not a built-in list: the file implementing the
 * safe wrapper is repo-specific, so a shipped default would hand every other
 * repo a hole at that path. The last two invalid legs are the regression guard
 * for that — with no options, nothing is exempt.
 */
/**
 * The autofix targets the NARROW subpath that owns `safePath`, not the barrel.
 *
 * The rules used to write `@vibe-agent-toolkit/utils` here while the README
 * table shipped in the same tarball told adopters the replacement lived on
 * `/path` — so the release whose entire purpose was narrow subpaths shipped lint
 * rules that mechanically rewrote code away from them. An adopter running the
 * pack over 4,670 files reported 4,719 such sites.
 */
const SAFE_PATH_MODULE = '@vibe-agent-toolkit/utils/path';
const SAFE_FS_MODULE = '@vibe-agent-toolkit/utils/fs';
const BARREL = '@vibe-agent-toolkit/utils';
const SAFE_IMPORT = `import { safePath } from '${SAFE_PATH_MODULE}';`;
const LINTED_FILE = 'packages/cli/src/example.ts';
const PATH_CORE_IMPL = 'packages/utils/src/path-core.ts';
const PATH_UTILS_IMPL = 'packages/utils/src/path-utils.ts';
const PATH_UTILS_SPEC = 'packages/utils/test/path-utils.test.ts';

/** The exempt-file list VAT itself passes for the three `safePath` rules. */
const PATH_EXEMPT_OPTIONS = [
  { exemptFiles: [PATH_CORE_IMPL, PATH_UTILS_IMPL, PATH_UTILS_SPEC] },
];

function pathFunctionRuleCases(fn: 'join' | 'relative' | 'resolve'): RuleCases {
  const unsafeMemberCode = `import path from 'node:path'; const p = path.${fn}(a, b);`;
  const unsafeMemberOutput = `import path from 'node:path';\n${SAFE_IMPORT} const p = safePath.${fn}(a, b);`;
  const errors = [{ messageId: 'noUnsafePathFn' }];
  const options = PATH_EXEMPT_OPTIONS;
  const decoy = (filename: string) => ({
    code: unsafeMemberCode, filename, options, output: unsafeMemberOutput, errors,
  });

  return {
    valid: [
      // The safe call is never flagged.
      { code: `${SAFE_IMPORT} const p = safePath.${fn}(a, b);`, filename: LINTED_FILE, options },
      // …including when it was reached through the barrel.
      {
        code: `import { safePath } from '${BARREL}'; const p = safePath.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
      },
      // Files the CONSUMING config declared exempt, by their repo-relative paths.
      { code: unsafeMemberCode, filename: PATH_CORE_IMPL, options },
      { code: unsafeMemberCode, filename: `/Users/dev/vat/${PATH_UTILS_IMPL}`, options },
      { code: unsafeMemberCode, filename: PATH_UTILS_SPEC, options },
      // Same exemption, spelled with Windows separators.
      { code: unsafeMemberCode, filename: String.raw`C:\dev\vat\packages\utils\src\path-core.ts`, options },
    ],
    invalid: [
      // Fires on the unsafe member call and the unsafe named import.
      { code: unsafeMemberCode, filename: LINTED_FILE, options, output: unsafeMemberOutput, errors },
      {
        code: `import { ${fn} } from 'node:path'; const p = ${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `\n${SAFE_IMPORT} const p = safePath.${fn}(a, b);`,
        errors,
      },
      // DECOY basenames — same file name, different directory. MUST still fire.
      decoy('tools/hooks/path-utils.ts'),
      decoy('packages/other/src/path-core.ts'),
      decoy('packages/cli/src/my-path-utils.ts'),
      // UNCONFIGURED: the paths that used to be hardcoded into the factory are
      // exempt only because the config above named them. With no options they
      // are ordinary files and MUST fire — otherwise publishing this pack would
      // ship VAT's layout as a silent hole in every adopter's repo.
      { code: unsafeMemberCode, filename: PATH_CORE_IMPL, output: unsafeMemberOutput, errors },
      { code: unsafeMemberCode, filename: PATH_UTILS_IMPL, output: unsafeMemberOutput, errors },
      // ALREADY BOUND: the file reaches `safePath` through the BARREL. Rewrite
      // the call, but do NOT add an import — a second `safePath` binding is
      // `SyntaxError: Identifier 'safePath' has already been declared`, so the
      // autofix would emit code that cannot parse. Latent while the fix target
      // WAS the barrel; live the moment it became `/path`, for exactly the
      // population being migrated.
      {
        code: `import { safePath } from '${BARREL}';\nimport path from 'node:path';\nconst p = path.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `import { safePath } from '${BARREL}';\nimport path from 'node:path';\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
      // Same conflict from a plain top-level declaration, which no
      // import-scanning check would have seen.
      {
        code: `const safePath = makeIt();\nimport path from 'node:path';\nconst p = path.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `const safePath = makeIt();\nimport path from 'node:path';\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
    ],
  };
}

/**
 * A bare-basename `exemptFiles` entry exempts that filename EVERYWHERE.
 *
 * ESLint reports absolute filenames, so the matcher's `endsWith('/' + target)`
 * leg fires for every `path-utils.ts` in the tree — the same repo-wide hole the
 * anchoring rewrite closed, reopened one config entry at a time. Reported
 * through the lint channel rather than as a schema `pattern`, because the schema
 * sees the RAW string and `./path-utils.ts` contains a `/` while normalizing to
 * exactly the same hole.
 */
/**
 * `safeModule` — point the fixer at the CONSUMING repo's re-export seam.
 *
 * The narrow-subpath defaults are right only for a repo importing this package
 * directly. An adopter measured what they cost everyone else: of the 61 packages
 * in their workspace that would receive a new import, **52 (620 files) do not
 * declare `@vibe-agent-toolkit/utils`**. Under pnpm's isolated `node_modules`
 * that import does not degrade, it fails to resolve — so the autofix is only as
 * good as its ability to name a specifier that resolves where the fix lands.
 * Across their top 25 affected packages the default resolved in 0; their seam
 * resolved in 24.
 *
 * PER-RULE, because a seam need not split its symbols the way this package does:
 * theirs carries `normalizedTmpdir` but not `safePath`, so `no-os-tmpdir` and
 * `no-path-join` need different targets — what one shared key cannot express.
 */
const SEAM = '@acme/dev-tools/path-utils';

/**
 * Named because each now heads three suites — its own cases, the `safeModule`
 * cases, and the unanchored-`exemptFiles` cases. One rule per code path:
 * `no-path-join` stands for `path-function-rule-factory`, `no-os-tmpdir` for
 * `eslint-rule-factory`.
 */
const PATH_FACTORY_RULE = 'no-path-join';
const CALL_FACTORY_RULE = 'no-os-tmpdir';

function safeModuleCases(unsafeCode: string, fixedCode: string, errors: object[]): RuleCases {
  return {
    valid: [
      // Already importing from the configured seam — nothing to add.
      { code: fixedCode, filename: LINTED_FILE, options: [{ safeModule: SEAM }] },
    ],
    invalid: [
      {
        code: unsafeCode,
        filename: LINTED_FILE,
        options: [{ safeModule: SEAM }],
        output: fixedCode,
        errors,
      },
    ],
  };
}

const UNANCHORED_ERROR = [{ messageId: 'unanchoredExemptFile' }];

function unanchoredExemptCases(unsafeCode: string, safeCode: string): RuleCases {
  return {
    valid: [
      // Properly anchored: no advisory.
      { code: safeCode, filename: LINTED_FILE, options: [{ exemptFiles: [PATH_UTILS_IMPL] }] },
      // No option at all: nothing to advise about.
      { code: safeCode, filename: LINTED_FILE },
      // Windows-spelled but still anchored.
      {
        code: safeCode,
        filename: LINTED_FILE,
        options: [{ exemptFiles: [String.raw`packages\utils\src\path-utils.ts`] }],
      },
    ],
    invalid: [
      // Fires on a file the entry does NOT match…
      { code: safeCode, filename: LINTED_FILE, options: [{ exemptFiles: ['path-utils.ts'] }], errors: UNANCHORED_ERROR },
      // …and on the file it DOES match, which is exempt only because of it.
      { code: unsafeCode, filename: PATH_UTILS_IMPL, options: [{ exemptFiles: ['path-utils.ts'] }], errors: UNANCHORED_ERROR },
      // `./x` normalizes to the same hole — the spelling a schema `pattern`
      // would have waved through.
      { code: safeCode, filename: LINTED_FILE, options: [{ exemptFiles: ['./path-utils.ts'] }], errors: UNANCHORED_ERROR },
    ],
  };
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

/**
 * `no-os-tmpdir` / `no-fs-mkdirSync` / `no-fs-realpathSync` /
 * `no-child-process-execSync` share the OTHER factory, which had the same
 * substring-exemption bug (`filename.includes('path-utils.ts')`). Same decoy
 * discipline applies: a same-named file in a different directory must fire.
 */
interface UnsafeCallRuleSpec {
  unsafeFn: string;
  unsafeModule: string;
  safeFn: string;
  /** The NARROW subpath that owns `safeFn` — never the barrel. */
  safeModule: string;
  exemptPath: string;
}

function unsafeCallRuleCases(
  { unsafeFn, unsafeModule, safeFn, safeModule, exemptPath }: UnsafeCallRuleSpec,
): RuleCases {
  const unsafeCode = `import { ${unsafeFn} } from '${unsafeModule}';\nconst r = ${unsafeFn}(x);`;
  const output = `import { ${safeFn} } from '${safeModule}';\n\nconst r = ${safeFn}(x);`;
  const errors = [{ messageId: 'noUnsafeOperation' }];
  const options = [{ exemptFiles: [exemptPath] }];
  const decoy = (filename: string) => ({ code: unsafeCode, filename, options, output, errors });
  const exemptBasename = exemptPath.slice(exemptPath.lastIndexOf('/') + 1);

  return {
    valid: [
      {
        code: `import { ${safeFn} } from '${safeModule}';\nconst r = ${safeFn}(x);`,
        filename: LINTED_FILE,
        options,
      },
      { code: unsafeCode, filename: exemptPath, options },
      { code: unsafeCode, filename: `/Users/dev/vat/${exemptPath}`, options },
    ],
    invalid: [
      { code: unsafeCode, filename: LINTED_FILE, options, output, errors },
      // DECOY basenames — the shape that shipped raw tmpdir()/realpathSync()
      // past a fork of this rule pack in a consumer repo.
      decoy(`tools/hooks/${exemptBasename}`),
      decoy(`packages/other/src/${exemptBasename}`),
      // UNCONFIGURED — with no `exemptFiles` option nothing is exempt, including
      // the path this factory used to hardcode. See pathFunctionRuleCases above.
      { code: unsafeCode, filename: exemptPath, output, errors },
      // ALREADY BOUND through the BARREL — rewrite the call, add no import. A
      // second binding of `safeFn` is a SyntaxError, not a redundant import.
      {
        code: `import { ${safeFn} } from '${BARREL}';\nimport { ${unsafeFn} } from '${unsafeModule}';\nconst r = ${unsafeFn}(x);`,
        filename: LINTED_FILE,
        options,
        output: `import { ${safeFn} } from '${BARREL}';\n\nconst r = ${safeFn}(x);`,
        errors,
      },
    ],
  };
}

/**
 * `no-unix-shell-commands` exempts test files, because the tests for the detector
 * necessarily name the banned commands. That exemption was
 * `filename.includes('.test.ts')`, which is a CATEGORY check written as an
 * unanchored substring: it also exempted `example.test.ts.bak`, a `.test.ts`
 * directory, and (really, in this repo) `tsconfig.test.json` via `.test.js`.
 * The valid legs prove genuine test files are STILL exempt — without them the
 * rule could be "fixed" by exempting nothing and this suite would stay green.
 */
const UNIX_CMD_CODE = "safeExecSync('tar', ['xzf', archive]);";
const UNIX_TEST_FILE = 'packages/utils/test/eslint/example.test.ts';
const NO_UNIX_SHELL_COMMANDS_CASES: RuleCases = {
  valid: [
    { code: "safeExecSync('node', [script]);", filename: LINTED_FILE },
    { code: UNIX_CMD_CODE, filename: UNIX_TEST_FILE },
    { code: UNIX_CMD_CODE, filename: `/Users/dev/vat/${UNIX_TEST_FILE}` },
    { code: UNIX_CMD_CODE, filename: String.raw`C:\dev\vat\packages\utils\test\eslint\example.test.ts` },
  ],
  invalid: [
    { code: UNIX_CMD_CODE, filename: LINTED_FILE, errors: [{ messageId: 'noUnixCommand' }] },
    { code: "execSync('tar xzf x.tgz');", filename: LINTED_FILE, errors: [{ messageId: 'noUnixCommand' }] },
    // DECOYS — every one of these linted clean under the substring exemption.
    { code: UNIX_CMD_CODE, filename: 'packages/cli/src/example.test.ts.bak', errors: [{ messageId: 'noUnixCommand' }] },
    { code: UNIX_CMD_CODE, filename: 'packages/cli/src/.test.ts-helpers/impl.ts', errors: [{ messageId: 'noUnixCommand' }] },
  ],
};

const SUITES: readonly RuleSuite[] = [
  { name: 'no-url-pathname-for-fs', cases: NO_URL_PATHNAME_FOR_FS_CASES },
  { name: 'no-bare-dynamic-import-path', cases: NO_BARE_DYNAMIC_IMPORT_PATH_CASES },
  { name: 'no-file-url-string-concat', cases: NO_FILE_URL_STRING_CONCAT_CASES },
  { name: 'prefer-startswith-over-regex', cases: PREFER_STARTSWITH_OVER_REGEX_CASES },
  { name: 'no-unsafe-root-join', cases: NO_UNSAFE_ROOT_JOIN_CASES },
  { name: 'require-justified-skip', cases: REQUIRE_JUSTIFIED_SKIP_CASES },
  { name: 'no-unix-shell-commands', cases: NO_UNIX_SHELL_COMMANDS_CASES },
  { name: PATH_FACTORY_RULE, cases: pathFunctionRuleCases('join') },
  { name: 'no-path-resolve', cases: pathFunctionRuleCases('resolve') },
  { name: 'no-path-relative', cases: pathFunctionRuleCases('relative') },
  {
    name: CALL_FACTORY_RULE,
    cases: unsafeCallRuleCases({
      unsafeFn: 'tmpdir', unsafeModule: 'node:os', safeFn: 'normalizedTmpdir',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }),
  },
  {
    name: 'no-fs-mkdirSync',
    cases: unsafeCallRuleCases({
      unsafeFn: 'mkdirSync', unsafeModule: 'node:fs', safeFn: 'mkdirSyncReal',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }),
  },
  {
    name: 'no-fs-realpathSync',
    cases: unsafeCallRuleCases({
      unsafeFn: 'realpathSync', unsafeModule: 'node:fs', safeFn: 'normalizePath',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }),
  },
  {
    name: 'no-child-process-execSync',
    cases: unsafeCallRuleCases({
      unsafeFn: 'execSync',
      unsafeModule: 'node:child_process',
      safeFn: 'safeExecSync',
      safeModule: '@vibe-agent-toolkit/utils/process',
      exemptPath: 'packages/utils/src/safe-exec.ts',
    }),
  },
  // `safeModule`, once per code path that WRITES an import: the two factories
  // and `no-manual-path-normalize`, which has its own fixer.
  {
    name: PATH_FACTORY_RULE,
    cases: safeModuleCases(
      "import path from 'node:path';\nconst p = path.join(a, b);",
      `import path from 'node:path';\nimport { safePath } from '${SEAM}';\nconst p = safePath.join(a, b);`,
      [{ messageId: 'noUnsafePathFn' }],
    ),
  },
  {
    name: CALL_FACTORY_RULE,
    cases: safeModuleCases(
      "import { tmpdir } from 'node:os';\nconst r = tmpdir();",
      `import { normalizedTmpdir } from '${SEAM}';\n\nconst r = normalizedTmpdir();`,
      [{ messageId: 'noUnsafeOperation' }],
    ),
  },
  {
    name: 'no-manual-path-normalize',
    cases: safeModuleCases(
      "const n = p.split(path.sep).join('/');",
      `import { toForwardSlash } from '${SEAM}';\nconst n = toForwardSlash(p);`,
      [{ messageId: 'useToForwardSlash' }],
    ),
  },
  // The unanchored-`exemptFiles` advisory, once per factory: `no-path-join`
  // covers `path-function-rule-factory`, `no-os-tmpdir` the other one.
  {
    name: PATH_FACTORY_RULE,
    cases: unanchoredExemptCases(
      "import path from 'node:path'; const p = path.join(a, b);",
      `${SAFE_IMPORT} const p = safePath.join(a, b);`,
    ),
  },
  {
    name: CALL_FACTORY_RULE,
    cases: unanchoredExemptCases(
      "import { tmpdir } from 'node:os';\nconst r = tmpdir();",
      `import { normalizedTmpdir } from '${SAFE_FS_MODULE}';\nconst r = normalizedTmpdir();`,
    ),
  },
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

/**
 * `no-command-direct-factory` builds rules rather than being one, so it needs its
 * own suite. Its `exemptPackage` had the DIRECTORY flavor of the substring bug:
 * `filename.includes('packages/git/')` also exempted `vendor/copy-packages/git/`
 * and `tools/my-packages/git/` — any directory whose name merely ENDS WITH the
 * exempt one. Those are the load-bearing invalid legs below.
 */
describe('no-command-direct-factory', () => {
  type CommandRuleConfig = {
    command: string;
    packageName: string;
    availableFunctions: string[];
    exemptPackage?: string;
  };
  const createNoCommandDirectRule =
    loadLocalRuleModule<(config: CommandRuleConfig) => Rule.RuleModule>('no-command-direct-factory.cjs');

  const rule = createNoCommandDirectRule({
    command: 'git',
    packageName: '@vibe-agent-toolkit/git',
    availableFunctions: ['executeGitCommand()'],
    exemptPackage: 'packages/git/',
  });
  const gitCode = "safeExecSync('git', ['status']);";
  const errors = [{ messageId: 'noGitDirect' }];

  it('passes RuleTester cases', () => {
    expect(() => {
      ruleTester.run('no-git-commands-direct', rule, {
        valid: [
          { code: "safeExecSync('node', [script]);", filename: LINTED_FILE },
          { code: gitCode, filename: 'packages/git/src/index.ts' },
          { code: gitCode, filename: '/Users/dev/vat/packages/git/src/index.ts' },
          { code: gitCode, filename: String.raw`C:\dev\vat\packages\git\src\index.ts` },
        ],
        invalid: [
          { code: gitCode, filename: LINTED_FILE, errors },
          { code: "execSync('git status');", filename: LINTED_FILE, errors },
          // DECOY directories — exempted by the old substring check.
          { code: gitCode, filename: 'vendor/copy-packages/git/src/index.ts', errors },
          { code: gitCode, filename: 'tools/my-packages/git/exec.ts', errors },
        ],
      });
    }).not.toThrow();
  });
});

/**
 * A message placeholder and the schema that fills it must not drift apart.
 *
 * `{{safeModule}}` is only ever substituted because the rule read the option and
 * passed it as report `data`. A rule that interpolates it WITHOUT declaring the
 * option in `meta.schema` cannot be pointed at a consumer's seam — its advice
 * would keep naming this package's subpath while the fixers around it wrote the
 * consumer's, which is the same fixer/docs divergence that made the autofix
 * target a blocker in the first place.
 *
 * Declaring the option is only half of it. The other half — that the rule
 * actually passes `safeModule` as report `data` — cannot be seen structurally:
 * a rule may declare the option, read it, and still omit it from a single
 * `context.report` call, at which point ESLint renders the literal
 * `{{safeModule}}` into the message a developer reads. So the second suite
 * below RENDERS every one of these rules and asserts no placeholder survives.
 *
 * The set of rules is pinned by MEMBERSHIP, not by count: each one must have a
 * snippet here that provokes it. Seven of the twenty-one have no RuleTester
 * suite at all, so a check that merely counted would let exactly those drift.
 */
const PATH_IMPORT = "import path from 'node:path';\n";

/** One snippet per rule that interpolates `{{safeModule}}`, chosen to provoke it. */
const SAFE_MODULE_RULE_TRIGGERS: Record<string, string> = {
  'no-path-join': `${PATH_IMPORT}const p = path.join(a, b);`,
  'no-path-resolve': `${PATH_IMPORT}const p = path.resolve(a, b);`,
  'no-path-relative': `${PATH_IMPORT}const p = path.relative(a, b);`,
  'no-path-sep-in-strings': `${PATH_IMPORT}const s = 'a' + path.sep + 'b';`,
  // Reports path calls in ARGUMENT position, not receiver position.
  'no-path-operations-in-comparisons': `${PATH_IMPORT}const y = base.startsWith(path.relative(a, b));`,
  'no-manual-path-normalize': "const n = p.split(path.sep).join('/');",
  'no-hardcoded-path-split': "const parts = p.split('/');",
  'no-path-startswith': "const x = filePath.startsWith('/a');",
  'no-os-tmpdir': "import { tmpdir } from 'node:os';\nconst t = tmpdir();",
  'no-fs-mkdirSync': "import { mkdirSync } from 'node:fs';\nmkdirSync(d, { recursive: true });",
  'no-fs-realpathSync': "import { realpathSync } from 'node:fs';\nconst r = realpathSync(p);",
  'no-fs-promises-cp': "import { cp } from 'node:fs/promises';\nawait cp(a, b);",
  'no-child-process-execSync': "import { execSync } from 'node:child_process';\nexecSync('ls');",
  'no-url-pathname-for-fs': "const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;",
  'no-bare-dynamic-import-path': 'const m = await import(configPath);',
};

describe('every {{safeModule}} placeholder is backed by the option that fills it', () => {
  const plugin = loadLocalRuleModule<{
    rules: Record<string, Rule.RuleModule>;
  }>('../index.cjs');

  const rulesUsingPlaceholder = Object.entries(plugin.rules).filter(([, rule]) =>
    Object.values(rule.meta?.messages ?? {}).some((message) => message.includes('{{safeModule}}')),
  );

  it('exercises exactly the rules that use it (guards against a vacuous pass)', () => {
    // Membership, not cardinality: an unchanged count can mask changed occupants.
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(rulesUsingPlaceholder.map(([name]) => name).sort(byName)).toStrictEqual(
      Object.keys(SAFE_MODULE_RULE_TRIGGERS).sort(byName),
    );
  });

  it.each(rulesUsingPlaceholder)('%s declares the safeModule option', (_name, rule) => {
    const schema = rule.meta?.schema;
    expect(Array.isArray(schema)).toBe(true);
    const [options] = schema as [{ properties?: Record<string, unknown> }];
    expect(options.properties).toHaveProperty('safeModule');
  });

  it.each(rulesUsingPlaceholder)('%s renders the configured module, not the placeholder', (name, rule) => {
    const messages = new Linter().verify(
      SAFE_MODULE_RULE_TRIGGERS[name] ?? '',
      [
        {
          files: ['**/*.ts'],
          plugins: { local: { rules: { [name]: rule } } },
          rules: { [`local/${name}`]: ['error', { safeModule: SEAM }] },
          languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
        },
      ],
      { filename: LINTED_FILE },
    );

    // A snippet that stopped provoking its rule would make the assertions below
    // vacuously true, so require a report before inspecting one.
    expect(messages.length).toBeGreaterThan(0);
    for (const { message } of messages) {
      expect(message).not.toContain('{{');
      expect(message).toContain(SEAM);
    }
  });
});

/**
 * `no-raw-node-path` — ONE rule over the three `node:path` functions `safePath`
 * wraps, driven by a `functions` option table.
 *
 * The case table runs once per wrapped function. The load-bearing legs are the
 * DECOY invalid cases: a file whose basename matches an exempt implementation
 * file but whose directory does not. The rule used to exempt via
 * `filename.includes('path-utils.ts')`, so every decoy linted clean — the exact
 * bug that let a private `tools/hooks/path-utils.ts` ship raw path calls in a
 * consumer repo running a fork of these rules.
 *
 * Exemptions are a RULE OPTION, not a built-in list: the file implementing the
 * safe wrapper is repo-specific, so a shipped default would hand every other
 * repo a hole at that path. The UNCONFIGURED invalid legs are the regression
 * guard for that — with no options, nothing is exempt.
 */

import { describe, expect, it } from 'vitest';

import { safeModuleCases, unanchoredExemptCases } from '../factory-cases.js';
import {
  BARREL,
  LINTED_FILE,
  namedImport,
  NODE_PATH,
  PATH_CORE_IMPL,
  PATH_EXEMPT_OPTIONS,
  PATH_NAMESPACE_IMPORT,
  PATH_UTILS_IMPL,
  PATH_UTILS_SPEC,
  RULE,
  SAFE_IMPORT,
  SEAM,
  WRAPPED_PATH_FUNCTIONS,
  type WrappedPathFunction,
} from '../fixtures.js';
import { fix, lint, ruleConfig, unboundIn } from '../linter-harness.js';
import { expectRulePasses, loadLocalRule, RULE_TESTER_CASES, type RuleCases, ruleTester } from '../rule-tester.js';

const NAME = RULE.rawPath;

function pathFunctionRuleCases(fn: WrappedPathFunction): RuleCases {
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
      // A same-named function from somewhere else is not ours. The repair leg
      // keys on the name being UNBOUND, so binding it — by import, declaration,
      // or parameter — is what keeps it from flagging every `join()` in the
      // ecosystem.
      //
      // EVERY case below puts the call in a DIFFERENT scope from the binding,
      // on purpose. The first draft of these fixtures called at the same level
      // as the binding, which meant `isIdentifierBound`'s walk up `scope.upper`
      // never executed — an adversarial run deleted the entire walk and this
      // suite stayed green while the mutant rewrote lodash's `join` into
      // `safePath.join`. A scope-aware rule needs a scope-crossing fixture.
      {
        code: `${SAFE_IMPORT}\nimport { ${fn} } from 'lodash';\nfunction f(a, b) { return ${fn}(a, b); }`,
        filename: LINTED_FILE,
        options,
      },
      {
        code: `${SAFE_IMPORT}\nfunction ${fn}(x) { return x; }\nfunction f(a) { return ${fn}(a); }`,
        filename: LINTED_FILE,
        options,
      },
      {
        code: `${SAFE_IMPORT}\nexport const run = (${fn}) => () => ${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
      },
      // Without `safePath` in scope the repair leg must not fire AT ALL — this
      // is the gate that keeps ambient globals safe. ESLint scope analysis
      // cannot see a `globals.d.ts`, an `@types` package, or a bundler-injected
      // global, and `resolve`/`relative` are entirely plausible as those.
      { code: `const p = ${fn}(a, b);`, filename: LINTED_FILE, options },
      // …and `safePath` merely BEING bound is not the licence either. A sibling
      // function in the same table supplies that binding for free: the
      // `resolve` leg rewrites a `path.resolve(...)` and imports `safePath`,
      // which flips `safePathBoundInSource` for the `join` leg too. What the
      // repair leg needs is evidence that THIS function is mid-migration in
      // THIS file — a `safePath.<fn>(...)` call already in the source.
      // `joinUnderRoot` is a real `safePath` member and is deliberately not one
      // of them.
      //
      // 'a sibling function binding safePath does not arm the repair leg'
      // below runs the same hazard end to end, through a real `--fix` sweep.
      {
        code: [
          SAFE_IMPORT,
          'export const root = safePath.joinUnderRoot(base, name);',
          `export const p = ${fn}(a, b);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
      },
      // A TYPE-ONLY specifier is not a call site. Tracking it made the fixer
      // DELETE it, and because `typeof join` is a TYPE reference, `no-undef` —
      // and so the fixpoint suite — cannot see the damage.
      //
      // The call has to be here for this fixture to mean anything: with no call
      // there is no report either way, and the case passes under a rule that
      // tracks type specifiers just as happily as one that skips them.
      {
        code: [
          `import { type ${fn} } from 'node:path';`,
          `export type T = typeof ${fn};`,
          `export const p = ${fn}(a, b);`,
        ].join('\n'),
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
      // THREE call sites, ONE pass. RuleTester applies exactly one round of
      // fixes, so `output` here is the whole property: every call rewritten and
      // the import surgery done, with nothing discarded for overlapping.
      //
      // Every fixture above has a single call site, and a single-call-site
      // fixture CANNOT reproduce the defect this guards — the fix that edits
      // both the import and its own call spans the gap between them, so the
      // second and third reports' ranges nested inside the first and ESLint
      // dropped them. The specifier went away, the calls did not, and the next
      // pass had nothing left to key on. See `buildFix` in the rule.
      {
        code: [
          `import { ${fn} } from 'node:path';`,
          `const a1 = ${fn}(a, b);`,
          `const a2 = ${fn}(c, d);`,
          `const a3 = ${fn}(e, f);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
        output: [
          '',
          SAFE_IMPORT,
          `const a1 = safePath.${fn}(a, b);`,
          `const a2 = safePath.${fn}(c, d);`,
          `const a3 = safePath.${fn}(e, f);`,
        ].join('\n'),
        errors: [errors[0], errors[0], errors[0]],
      },
      // Same shape through the namespace import, which removes no specifier —
      // the import INSERT alone is enough to span the file and starve the rest.
      {
        code: [
          PATH_NAMESPACE_IMPORT,
          `const a1 = path.${fn}(a, b);`,
          `const a2 = path.${fn}(c, d);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
        output: [
          PATH_NAMESPACE_IMPORT,
          SAFE_IMPORT,
          `const a1 = safePath.${fn}(a, b);`,
          `const a2 = safePath.${fn}(c, d);`,
        ].join('\n'),
        errors: [errors[0], errors[0]],
      },
      // BARE, UNBOUND call in a file that ALREADY has `safePath` — what a
      // half-applied fix leaves behind. Detection used to require having seen
      // the `node:path` specifier, so once a fix removed it the rule fell
      // silent and `--fix` declared victory over source that no longer
      // compiles. Recognising this shape is what makes a second `--fix` finish
      // the job.
      //
      // The `safePath`-in-scope precondition is the whole difference between a
      // repair leg and a second, worse detector: see the `declare global` and
      // ambient-global valid cases above for what firing without it costs.
      {
        code: `${SAFE_IMPORT}\nconst p = ${fn}(a, b);\nconst q = safePath.${fn}(c, d);`,
        filename: LINTED_FILE,
        options,
        output: `${SAFE_IMPORT}\nconst p = safePath.${fn}(a, b);\nconst q = safePath.${fn}(c, d);`,
        errors,
      },
      // ALIASED specifier: rewrite the unbound `join(`, and KEEP the alias.
      //
      // `pathJoin(...)` is never the callee this rule matches, so tracking the
      // specifier bought nothing — and cost the whole import. An unrelated
      // unbound `join(` elsewhere in the file classified as "named", and the
      // fixer removed the ALIAS, breaking every working `pathJoin` call site.
      // The pinned output below is the proof the alias survives.
      //
      // The last line carries the repair leg's evidence, and this fixture is why
      // it has to be spelled out rather than assumed: the bare `join(c, d)` here
      // is UNBOUND and `safePath` IS in scope, which is the exact shape an
      // ambient global takes — the comment above has always called it
      // "unrelated". Without a `safePath.${fn}(...)` in the file it now goes
      // unreported, and the alias guard would have gone with it. The mutation the
      // guard exists to catch still fails here: track the aliased specifier and
      // `join(c, d)` classifies as NAMED, which removes the alias and breaks the
      // pinned `aliased(a, b)` line.
      {
        code: [
          SAFE_IMPORT,
          `import { ${fn} as aliased } from 'node:path';`,
          'export const p = aliased(a, b);',
          `export const q = ${fn}(c, d);`,
          `export const r = safePath.${fn}(e, f);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
        output: [
          SAFE_IMPORT,
          `import { ${fn} as aliased } from 'node:path';`,
          'export const p = aliased(a, b);',
          `export const q = safePath.${fn}(c, d);`,
          `export const r = safePath.${fn}(e, f);`,
        ].join('\n'),
        errors,
      },
      // RE-EXPORTED specifier: rewrite the call, but KEEP the import.
      //
      // Removing it left `export { join }` naming nothing, and the fixed file
      // did not PARSE — `Export 'join' is not defined`. Output that cannot be
      // parsed is the worst result an autofix can produce, strictly worse than
      // leaving a finding on screen, so the specifier stays and the residual is
      // a lint message a human can read.
      {
        code: `import { ${fn} } from 'node:path';\nexport { ${fn} };\nconst p = ${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `import { ${fn} } from 'node:path';\n${SAFE_IMPORT}\nexport { ${fn} };\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
      // ORPHANED `safePath.join(...)` — the OTHER half of the repair, and the
      // reason the file above can ever recover.
      //
      // ESLint runs `fix()` before the `eslint-disable` filter, so a suppressed
      // report on the first call site consumes the once-per-file import edit
      // and then discards it. Every other call becomes `safePath.join`, nothing
      // imports `safePath`, and no report is left to carry the import on any
      // later pass. An adversarial run produced exactly that as a STABLE
      // fixpoint — `--fix` twice more changed nothing — against a docstring
      // that claimed the state was transient. This leg is what makes the claim
      // true.
      {
        code: `const p = safePath.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `${SAFE_IMPORT}\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
      // DECOY basenames — same file name, different directory. MUST still fire.
      decoy('tools/hooks/path-utils.ts'),
      decoy('packages/other/src/path-core.ts'),
      decoy('packages/cli/src/my-path-utils.ts'),
      // UNCONFIGURED: the paths that used to be hardcoded into the rule are
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
 * The `functions` table is the whole rule: a function left out of it is not
 * this rule's business, and the default is all three. One rule id means one
 * `--fix` pass carries every wrapped function to the same import.
 */
const FUNCTIONS_OPTION_CASES: RuleCases = {
  valid: [
    // Only `join` is configured, so `resolve` is somebody else's.
    { code: `${PATH_NAMESPACE_IMPORT}\nconst p = path.resolve(a, b);`, filename: LINTED_FILE, options: [{ functions: ['join'] }] },
    // `dirname` is not wrapped by `safePath`, so it is never a finding.
    { code: `${PATH_NAMESPACE_IMPORT}\nconst d = path.dirname(p);`, filename: LINTED_FILE },
  ],
  invalid: [
    // All three through one namespace import, one pass, one inserted import.
    {
      code: [
        PATH_NAMESPACE_IMPORT,
        'const a = path.join(x, y);',
        'const b = path.resolve(x);',
        'const c = path.relative(x, y);',
      ].join('\n'),
      filename: LINTED_FILE,
      output: [
        PATH_NAMESPACE_IMPORT,
        SAFE_IMPORT,
        'const a = safePath.join(x, y);',
        'const b = safePath.resolve(x);',
        'const c = safePath.relative(x, y);',
      ].join('\n'),
      errors: [{ messageId: 'noUnsafePathFn' }, { messageId: 'noUnsafePathFn' }, { messageId: 'noUnsafePathFn' }],
    },
    // Two NAMED specifiers on one declaration: the first report takes its own
    // specifier and the shared import insert; the second report's fix — its
    // callee rewrite AND its specifier removal, merged into one range — nests
    // inside the first's and is dropped for this pass. RuleTester shows one
    // pass; 'two named specifiers converge' below runs it to the fixpoint.
    {
      code: "import { join, resolve } from 'node:path';\nconst a = join(x, y);\nconst b = resolve(x);",
      filename: LINTED_FILE,
      output: `import {  resolve } from 'node:path';\n${SAFE_IMPORT}\nconst a = safePath.join(x, y);\nconst b = resolve(x);`,
      errors: [{ messageId: 'noUnsafePathFn' }, { messageId: 'noUnsafePathFn' }],
    },
    // The narrowed table still fires on what it names.
    {
      code: `${PATH_NAMESPACE_IMPORT}\nconst p = path.join(a, b);`,
      filename: LINTED_FILE,
      options: [{ functions: ['join'] }],
      output: `${PATH_NAMESPACE_IMPORT}\n${SAFE_IMPORT}\nconst p = safePath.join(a, b);`,
      errors: [{ messageId: 'noUnsafePathFn' }],
    },
  ],
};

describe(NAME, () => {
  it.each(WRAPPED_PATH_FUNCTIONS)(`${RULE_TESTER_CASES} for %s`, (fn) => {
    expectRulePasses(NAME, pathFunctionRuleCases(fn));
  });

  it('honours the functions table', () => {
    expectRulePasses(NAME, FUNCTIONS_OPTION_CASES);
  });

  it('rejects a function safePath does not wrap', () => {
    // A name outside the table has no `safePath.<fn>` to be rewritten to, so
    // the schema refuses it at config time rather than the fixer writing a
    // call on a member that does not exist.
    expect(() => {
      ruleTester.run(NAME, loadLocalRule(`${NAME}.cjs`), {
        valid: [{ code: 'const d = path.dirname(p);', options: [{ functions: ['dirname'] }] }],
        invalid: [],
      });
    }).toThrow(/"dirname" should be equal to one of the allowed values/);
  });

  it('two named specifiers converge to one import at the fixpoint', () => {
    const source = "import { join, resolve } from 'node:path';\nexport const a = join(x, y);\nexport const b = resolve(x);";
    const cfg = ruleConfig(NAME);
    const { output } = fix(source, cfg);
    expect(output).not.toContain("from 'node:path'");
    expect(output).toContain('safePath.join(x, y)');
    expect(output).toContain('safePath.resolve(x)');
    expect(output.match(/import \{ safePath \}/g)).toHaveLength(1);
    expect(lint(output, cfg)).toStrictEqual([]);
  });

  // `safeModule`, for the code path that WRITES an import.
  it('points the fix at the configured seam', () => {
    expectRulePasses(NAME, safeModuleCases(
      `${PATH_NAMESPACE_IMPORT}\nconst p = path.join(a, b);`,
      `${PATH_NAMESPACE_IMPORT}\nimport { safePath } from '${SEAM}';\nconst p = safePath.join(a, b);`,
      [{ messageId: 'noUnsafePathFn' }],
      // Pass 2 takes the orphaned `path` binding with it; THIS is settled.
      `import { safePath } from '${SEAM}';\nconst p = safePath.join(a, b);`,
    ));
  });

  it('reports an unanchored exemptFiles entry', () => {
    expectRulePasses(NAME, unanchoredExemptCases(
      "import path from 'node:path'; const p = path.join(a, b);",
      `${SAFE_IMPORT} const p = safePath.join(a, b);`,
    ));
  });
});

/**
 * A SUPPRESSED report still consumes the once-per-file import edit.
 *
 * ESLint runs a rule's `fix()` before the `eslint-disable` filter discards the
 * problem, so `buildFix`'s "emit the shared edits once" guard is spent by a
 * report that is then thrown away. Every other call site is rewritten to
 * `safePath.join(...)`, nothing imports `safePath`, and — until the repair leg
 * existed — no report survived to carry the import on any later pass.
 *
 * An adversarial run measured that as a STABLE fixpoint: `--fix` twice more
 * changed nothing, lint reported zero problems, and the file did not compile.
 * The docstring at the time claimed the state was transient. It was not. This
 * test is the claim, executed rather than asserted.
 */
describe('a suppressed first report does not strand the file', () => {
  const cfg = ruleConfig(NAME);
  const defined = { [NAME]: loadLocalRule(`${NAME}.cjs`) };

  it.each(WRAPPED_PATH_FUNCTIONS)('%s converges to compiling source with the first call site disabled', (fn) => {
    const source = [
      namedImport(fn, NODE_PATH),
      `// eslint-disable-next-line local/${NAME}`,
      `export const a = ${fn}('1', '2');`,
      `export const b = ${fn}('3', '4');`,
      `export const c = ${fn}('5', '6');`,
    ].join('\n');

    // Negative control: the disable really does suppress one of four reports.
    expect(lint(source, cfg)).toHaveLength(2);
    expect(unboundIn(source, defined)).toStrictEqual([]);

    const { output } = fix(source, cfg);

    // The whole point: no dangling `safePath`, and no dangling `join`.
    expect(unboundIn(output, defined)).toStrictEqual([]);
    // The suppressed call is left ALONE — it still reads `join(...)`, which is
    // why the `node:path` specifier must survive alongside it.
    expect(output).toContain(`export const a = ${fn}('1', '2');`);
    expect(output).toContain(namedImport(fn, NODE_PATH));
    expect(output).toContain(`export const b = safePath.${fn}('3', '4');`);
  });

  it('recovers a file that a partial fix already stranded', () => {
    // Exactly the broken output the old code produced and then declared clean.
    const stranded = [
      namedImport('join', NODE_PATH),
      "export const a = join('1', '2');",
      "export const b = safePath.join('3', '4');",
    ].join('\n');

    expect(unboundIn(stranded, defined)).toStrictEqual(["'safePath' is not defined."]);

    const { output } = fix(stranded, cfg);
    expect(unboundIn(output, defined)).toStrictEqual([]);
    expect(lint(output, cfg)).toStrictEqual([]);
  });
});

/**
 * `safePath` being bound is a fact about the FILE, not about this function.
 *
 * The bare-call repair leg finishes a file a partial `--fix` left half-migrated,
 * and its gate used to be "`fn` is unbound in scope AND `safePath` is bound
 * somewhere in the source". Neither half is specific to `fn`, and the second is
 * supplied for free by a SIBLING function in the same table: the `resolve` leg
 * rewrites a `path.resolve(...)` and imports `safePath`, so on the next `--fix`
 * pass the `join` leg sees a file with `safePath` bound and a bare, unbound
 * `join(...)` — which, as the rule's own comment concedes, is not reliably our
 * `join`. ESLint scope analysis cannot see a `declare global`, a `globals.d.ts`,
 * an `@types` package, or a bundler-injected global.
 *
 * Measured before the fix, with both legs enabled over the source below: the
 * ambient `join('hello', 'world')` came back as `safePath.join('hello', 'world')`
 * — a published autofixer silently redirecting a call to a different function.
 *
 * The gate is now positive evidence that THIS function is mid-migration in THIS
 * file. Every real strand carries that evidence: the specifier removal ships in
 * the same all-or-nothing merged fix as the callee rewrite that produced it, so a
 * file cannot lose its `node:path` specifier without gaining a
 * `safePath.<fn>(...)` call. The second case below is that claim, executed.
 */
describe('a sibling function binding safePath does not arm the repair leg', () => {
  /** An ambient global from a `globals.d.ts` this linter cannot see. */
  const AMBIENT = "export const banner = join('hello', 'world');";

  it('leaves an unrelated ambient global alone while the sibling migrates', () => {
    const source = [PATH_NAMESPACE_IMPORT, AMBIENT, 'export const p = path.resolve(a, b);'].join('\n');
    const cfg = ruleConfig(NAME);

    // Negative control: on the source as written only the SIBLING reports. The
    // hazard is reachable only across passes, once its fix has bound safePath.
    expect(lint(source, cfg).map(({ message }) => message)).toStrictEqual([
      expect.stringContaining('safePath.resolve()'),
    ]);

    const { output } = fix(source, cfg);

    // The sibling really did migrate — without this, the assertions below would
    // pass just as happily on a file nothing ever touched.
    expect(output).toContain('safePath.resolve(a, b)');
    expect(output).toContain(AMBIENT);
    expect(output).not.toContain('safePath.join(');
  });

  it("still finishes what an editor's single-fix left half-migrated", () => {
    const source = [
      namedImport('join', NODE_PATH),
      "export const a = join('1', '2');",
      "export const b = join('3', '4');",
    ].join('\n');
    const cfg = ruleConfig(NAME, { functions: ['join'] });

    // An editor's "fix this problem" applies ONE report's fix. The first
    // report's is the self-sufficient one — it rewrites its own callee, inserts
    // the `safePath` import AND removes the `node:path` specifier — which strands
    // every other call site as a bare, unbound `join(...)`.
    const firstFix = lint(source, cfg)[0]?.fix;
    if (!firstFix) {
      throw new Error('the first report carries no fix; this fixture no longer builds a strand');
    }
    const stranded = source.slice(0, firstFix.range[0]) + firstFix.text + source.slice(firstFix.range[1]);
    // The strand, and the evidence that comes with it, spelled out rather than
    // assumed: no `node:path` left, a bare `join`, and a migrated sibling call.
    expect(stranded).not.toContain("from 'node:path'");
    expect(stranded).toContain("export const b = join('3', '4');");
    expect(stranded).toContain("export const a = safePath.join('1', '2');");

    const { output } = fix(stranded, cfg);
    expect(output).toContain("export const b = safePath.join('3', '4');");
    expect(lint(output, cfg)).toStrictEqual([]);
  });
});

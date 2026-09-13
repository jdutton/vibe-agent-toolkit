/**
 * `no-os-tmpdir` stands for `eslint-rule-factory.cjs`: besides its own cases it
 * carries the `safeModule` and unanchored-`exemptFiles` legs for that factory,
 * and the receiver-binding suite — `os.tmpdir()` reached through `require()` or
 * a dynamic `import()` is still the `node:os` namespace.
 */

import { describe, expect, it } from 'vitest';

import { safeModuleCases, unanchoredExemptCases, unsafeCallRuleCases } from '../factory-cases.js';
import { PATH_UTILS_IMPL, RULE, SAFE_FS_MODULE, SEAM } from '../fixtures.js';
import { fix, lint, ruleConfig } from '../linter-harness.js';
import { expectRulePasses, RULE_TESTER_CASES } from '../rule-tester.js';

const NAME = RULE.tmpdir;
const UNSAFE = "import { tmpdir } from 'node:os';\nconst r = tmpdir();";

describe(NAME, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(NAME, unsafeCallRuleCases({
      unsafeFn: 'tmpdir', unsafeModule: 'node:os', safeFn: 'normalizedTmpdir',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }));
  });

  it('points the fix at the configured seam', () => {
    expectRulePasses(NAME, safeModuleCases(
      UNSAFE,
      `\nimport { normalizedTmpdir } from '${SEAM}';\nconst r = normalizedTmpdir();`,
      [{ messageId: 'noUnsafeOperation' }],
    ));
  });

  it('reports an unanchored exemptFiles entry', () => {
    expectRulePasses(NAME, unanchoredExemptCases(
      UNSAFE,
      `import { normalizedTmpdir } from '${SAFE_FS_MODULE}';\nconst r = normalizedTmpdir();`,
    ));
  });
});

/**
 * A dangling MEMBER, which a `no-undef` fixpoint check is blind to.
 *
 * `no-os-tmpdir` is the one rule with `checkMemberExpression`, and its fixer
 * rewrote only the property — turning `os.tmpdir()` into
 * `os.normalizedTmpdir()`, a method that does not exist on the `node:os`
 * namespace. The replacement is a free function from this package, and the
 * fixer imported it correctly; it just left the call reaching for it through
 * the wrong object.
 *
 * Same silent shape as the overlap defect: the rule stops reporting (there is
 * no `tmpdir` left to see), so lint goes green over code that throws
 * `TypeError` at every fixed call site. `no-undef` sees a bound `os` and a
 * property access and has nothing to say. Only `tsc` catches it — which is
 * why an adopter's dangling-REFERENCE audit across all nine rewritable
 * symbols came back clean on this rule.
 *
 * rc.1 matched ANY receiver, so it "detected" `require()`/dynamic-import
 * bindings only as a side effect of that defect — and it reported
 * `const os = { tmpdir(){} }` and `env.tmpdir()` as findings it would have
 * rewritten into a call on the wrong function. rc.2 checks the receiver and
 * correctly rejects both, but only recognised a static `import`. Whole-callee
 * replacement is safe however the binding was made, so the two other binding
 * forms belong in the same set — and the false positives must stay rejected,
 * which is what the negative rows pin.
 */
describe('os.tmpdir() is rewritten to a free call, however the namespace was bound', () => {
  const cfg = ruleConfig(NAME);
  const DYNAMIC = "export async function f() {\n  const os = await import('node:os');\n  return os.tmpdir();\n}";
  const REQUIRED = "const os = require('node:os');\nexport function f() { return os.tmpdir(); }";

  it.each([
    ['static import', "import os from 'node:os';\nconst t0 = os.tmpdir();\nconst t1 = os.tmpdir();", 2],
    ['await import()', DYNAMIC, 1],
    ['require()', REQUIRED, 1],
  ])('%s is reported and rewritten to a free call', (_label, source, sites) => {
    expect(lint(source, cfg)).toHaveLength(sites);

    const { output } = fix(source, cfg);
    // The defect the receiver check exists to prevent: a member call on a
    // namespace that has no such member. It compiles and it throws.
    expect(output).not.toMatch(/\bos\s*\.\s*normalizedTmpdir\b/);
    expect(output.match(/(?<![.\w])normalizedTmpdir\(\)/g)).toHaveLength(sites);
    expect(lint(output, cfg)).toStrictEqual([]);
  });

  it.each([
    ['an unrelated object literal', "const os = { tmpdir: () => '/t' };\nexport function f() { return os.tmpdir(); }"],
    ['the same method on another receiver', "const env = { tmpdir: () => '/t' };\nexport function f() { return env.tmpdir(); }"],
    [
      'a dynamic import of a different module',
      "export async function f() {\n  const os = await import('node:util');\n  return os.tmpdir();\n}",
    ],
    ['a require() of a different module', "const os = require('node:util');\nexport function f() { return os.tmpdir(); }"],
    // Not every one-argument call that is handed a module name IS `require`.
    // Without the callee-name check this reports, and the fix would rewrite a
    // call on somebody else's object into a free function.
    ['a call that merely looks like require()', "const os = notRequire('node:os');\nexport function f() { return os.tmpdir(); }"],
  ])('%s is not a finding', (_label, source) => {
    expect(lint(source, cfg)).toStrictEqual([]);
  });
});

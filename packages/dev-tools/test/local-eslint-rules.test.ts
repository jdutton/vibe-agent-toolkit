/**
 * Tests for local ESLint rules in packages/dev-tools/eslint-local-rules/.
 *
 * Each rule contributes one entry to SUITES below. Adding a new rule means
 * adding one row, not a new test file — keeps RuleTester scaffolding in
 * exactly one place.
 */

import { describe, expect, it } from 'vitest';

import { loadLocalRule, type RuleCases, ruleTester } from './eslint-rule-test-harness.js';

interface RuleSuite {
  name: string;
  cases: RuleCases;
}

const SUITES: readonly RuleSuite[] = [
  {
    name: 'no-url-pathname-for-fs',
    cases: {
      valid: [
        { code: "import { fileURLToPath } from 'node:url'; const p = fileURLToPath(new URL('../x', import.meta.url));" },
        { code: "const p = new URL('http://example.com').pathname;" },
        { code: 'const p = someUrl.pathname;' },
        { code: "const u = new URL('../x', import.meta.url); const s = u.href;" },
      ],
      invalid: [
        {
          code: 'const p = new URL(rel, import.meta.url).pathname;',
          errors: [{ messageId: 'useFileURLToPath' }],
        },
        {
          code: "const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;",
          errors: [{ messageId: 'useFileURLToPath' }],
        },
        {
          code: 'const p = new URL(`../fixtures/${name}.yaml`, import.meta.url).pathname;',
          errors: [{ messageId: 'useFileURLToPath' }],
        },
      ],
    },
  },
  {
    name: 'no-bare-dynamic-import-path',
    cases: {
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
    },
  },
  {
    name: 'prefer-startswith-over-regex',
    cases: {
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
    },
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

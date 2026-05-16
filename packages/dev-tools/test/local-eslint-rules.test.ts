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

const NO_JSYAML_DEFAULT_SCHEMA_CASES: RuleCases = {
  valid: [
    // js-yaml with an explicit schema option — all three named schemas accepted
    { code: "import yaml from 'js-yaml'; yaml.load(content, { schema: yaml.CORE_SCHEMA });" },
    { code: "import yaml from 'js-yaml'; yaml.load(content, { schema: yaml.JSON_SCHEMA });" },
    { code: "import yaml from 'js-yaml'; yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });" },
    { code: "import { load, CORE_SCHEMA } from 'js-yaml'; load(content, { schema: CORE_SCHEMA });" },
    { code: "import * as yaml from 'js-yaml'; yaml.loadAll(content, { schema: yaml.CORE_SCHEMA }, () => {});" },
    // Different library (eemeli/yaml) — already YAML 1.2 by default, not flagged
    { code: "import yaml from 'yaml'; yaml.parse(content);" },
    // Unrelated .load() on a non-yaml import — not flagged
    { code: "import other from 'some-other-lib'; other.load(content);" },
  ],
  invalid: [
    {
      code: "import yaml from 'js-yaml'; yaml.load(content);",
      errors: [{ messageId: 'requireSchema' }],
    },
    {
      code: "import yaml from 'js-yaml'; yaml.load(content, {});",
      errors: [{ messageId: 'requireSchema' }],
    },
    {
      code: "import yaml from 'js-yaml'; yaml.loadAll(content);",
      errors: [{ messageId: 'requireSchema' }],
    },
    {
      code: "import { load } from 'js-yaml'; load(content);",
      errors: [{ messageId: 'requireSchema' }],
    },
    {
      code: "import { load as loadYaml } from 'js-yaml'; loadYaml(content);",
      errors: [{ messageId: 'requireSchema' }],
    },
    {
      code: "import * as yaml from 'js-yaml'; yaml.load(content);",
      errors: [{ messageId: 'requireSchema' }],
    },
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

const SUITES: readonly RuleSuite[] = [
  { name: 'no-url-pathname-for-fs', cases: NO_URL_PATHNAME_FOR_FS_CASES },
  { name: 'no-bare-dynamic-import-path', cases: NO_BARE_DYNAMIC_IMPORT_PATH_CASES },
  { name: 'no-file-url-string-concat', cases: NO_FILE_URL_STRING_CONCAT_CASES },
  { name: 'no-jsyaml-default-schema', cases: NO_JSYAML_DEFAULT_SCHEMA_CASES },
  { name: 'prefer-startswith-over-regex', cases: PREFER_STARTSWITH_OVER_REGEX_CASES },
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

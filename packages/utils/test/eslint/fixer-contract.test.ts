/**
 * The ONE fixer contract every call-rewriting rule in the pack shares (`safe-import.cjs`
 * `createSafeImporter`): is the replacement bound, may this call be rewritten, and which
 * import does THIS fix carry. Pinned here across every rewriting rule at once, so a rule
 * that answers any of the three on its own cannot pass.
 */

import * as tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  LINTED_FILE,
  namedImport,
  NODE_FS,
  PATH_NAMESPACE_IMPORT,
  RULE,
  SAFE_FS_MODULE,
  SAFE_PATH_MODULE,
  SAFE_PROCESS_MODULE,
} from './fixtures.js';
import { fix, lint, ruleConfig, unboundIn } from './linter-harness.js';
import { loadLocalRule } from './rule-tester.js';

/** Every rule whose fix or suggestion writes a call to a safe replacement, and that replacement. */
interface RewritingRule {
  name: string;
  /** The replacement the rewritten call names. */
  safeName: string;
  safeModule: string;
  /** The unsafe import line, empty when the shape needs none. */
  unsafeImport: string;
  /** One unsafe use, as a statement. */
  site: (binding: string) => string;
  /** Autofixed (`fix`) or only suggested (`suggest`). */
  rewrite: 'fix' | 'suggest';
}

const REWRITING_RULES: RewritingRule[] = [
  {
    name: RULE.rawPath, safeName: 'safePath', safeModule: SAFE_PATH_MODULE, unsafeImport: PATH_NAMESPACE_IMPORT,
    site: (b) => `export const ${b} = path.join('a', 'b');`, rewrite: 'fix',
  },
  {
    name: RULE.tmpdir, safeName: 'normalizedTmpdir', safeModule: SAFE_FS_MODULE, unsafeImport: namedImport('tmpdir', 'node:os'),
    site: (b) => `export const ${b} = tmpdir();`, rewrite: 'fix',
  },
  {
    name: RULE.mkdir, safeName: 'mkdirSyncReal', safeModule: SAFE_FS_MODULE, unsafeImport: namedImport('mkdirSync', NODE_FS),
    site: (b) => `mkdirSync('${b}');`, rewrite: 'fix',
  },
  {
    name: RULE.realpath, safeName: 'normalizePath', safeModule: SAFE_FS_MODULE, unsafeImport: namedImport('realpathSync', NODE_FS),
    site: (b) => `export const ${b} = realpathSync('${b}');`, rewrite: 'suggest',
  },
  {
    name: RULE.execSync, safeName: 'safeExecSync', safeModule: SAFE_PROCESS_MODULE, unsafeImport: namedImport('execSync', 'node:child_process'),
    site: (b) => `export const ${b} = execSync('${b}');`, rewrite: 'suggest',
  },
  {
    name: RULE.normalize, safeName: 'toForwardSlash', safeModule: SAFE_PATH_MODULE, unsafeImport: PATH_NAMESPACE_IMPORT,
    site: (b) => `export const ${b} = '${b}'.split(path.sep).join('/');`, rewrite: 'fix',
  },
  {
    name: RULE.normalize, safeName: 'toForwardSlashAnyPlatform', safeModule: SAFE_PATH_MODULE, unsafeImport: '',
    site: (b) => String.raw`export const ${b} = '${b}'.replaceAll('\\', '/');`, rewrite: 'fix',
  },
];

const unbound = (name: string): string => `'${name}' is not defined.`;

/** `code` with exactly one fix or suggestion applied, as an editor's "fix this problem" does. */
function applyOne(code: string, edit: { range: [number, number]; text: string }): string {
  return code.slice(0, edit.range[0]) + edit.text + code.slice(edit.range[1]);
}

/** Every single-fix result `verify` offers for `code`: each autofix alone, and each suggestion alone. */
function singleFixOutputs(code: string, rule: RewritingRule): string[] {
  const messages = lint(code, ruleConfig(rule.name));
  const edits = messages.flatMap((message) => [
    ...(message.fix ? [message.fix] : []),
    ...(message.suggestions ?? []).map((suggestion) => suggestion.fix),
  ]);
  return edits.map((edit) => applyOne(code, edit));
}

describe('an aliased import of the safe replacement', () => {
  it.each(REWRITING_RULES.map((rule) => [`${rule.name} → ${rule.safeName}`, rule] as const))(
    '%s: the rewritten call is bound',
    (_label, rule) => {
      const alias = `import { ${rule.safeName} as aliased } from '${rule.safeModule}';`;
      const code = [rule.unsafeImport, alias, 'export const keep = aliased;', rule.site('a')].filter(Boolean).join('\n');
      const defined = { [rule.name]: loadLocalRule(`${rule.name}.cjs`) };
      const outputs = rule.rewrite === 'fix' ? [fix(code, ruleConfig(rule.name)).output] : singleFixOutputs(code, rule);

      // Negative control: something really was rewritten.
      expect(outputs.length).toBeGreaterThan(0);
      for (const output of outputs) {
        expect(output).toContain(`${rule.safeName}`);
        expect(output).not.toBe(code);
        expect(unboundIn(output, defined)).not.toContain(unbound(rule.safeName));
      }
    },
  );
});

describe('every single fix is self-sufficient, after a suppressed report', () => {
  it.each(REWRITING_RULES.map((rule) => [`${rule.name} → ${rule.safeName}`, rule] as const))(
    '%s',
    (_label, rule) => {
      const code = [
        rule.unsafeImport,
        `// eslint-disable-next-line local/${rule.name}`,
        rule.site('a'),
        rule.site('b'),
        rule.site('c'),
      ].filter(Boolean).join('\n');
      const defined = { [rule.name]: loadLocalRule(`${rule.name}.cjs`) };
      const outputs = singleFixOutputs(code, rule);

      // Negative control: the two unsuppressed sites each offer a fix.
      expect(outputs).toHaveLength(2);
      for (const output of outputs) {
        expect(unboundIn(output, defined)).not.toContain(unbound(rule.safeName));
      }
    },
  );
});

/** `no-unused-vars` under the TypeScript parser, which `import x = require()` needs. */
function unusedUnderTs(code: string): string[] {
  const config: Linter.Config[] = [
    { files: ['**/*.ts'], rules: { 'no-unused-vars': 'error' }, languageOptions: { parser: tsParser, sourceType: 'module' } },
  ];
  return new Linter().verify(code, config, { filename: LINTED_FILE }).map(({ message }) => message);
}

function tsRuleConfig(name: string): Linter.Config[] {
  return ruleConfig(name).map((block) => ({ ...block, languageOptions: { parser: tsParser, sourceType: 'module' } }));
}

describe('removing a dead binding never changes what the statements around it mean', () => {
  // A removed statement takes its `;` with it. If the statement BEFORE it has no `;` of its own,
  // whatever follows continues it: `const a = require("a")` then `[1, 2]…` is `require("a")[1, 2]`,
  // and under TypeScript `const a = b` then `<any>c` is `b < any > c`.
  const SAFE = `import { normalizedTmpdir } from '${SAFE_FS_MODULE}';`;
  it.each([
    ['a require() before `[`', 'const a = require("a")\nconst { tmpdir } = require("node:os")\n;[1, 2].forEach(go)\nexport const t = tmpdir()', '[1, 2].forEach(go)'],
    ['a require() before `(`', 'const a = require("a")\nconst { tmpdir } = require("node:os")\n;(async () => go())()\nexport const t = tmpdir()', '(async () => go())()'],
    ['a require() before a TS angle-bracket cast', 'const a = b\nconst os = require("node:os");\n<any>c\nexport const t = os.tmpdir()', '<any>c'],
    ['an import before `[`', `${SAFE}\nconst a = 1\nimport { tmpdir } from 'node:os';\n[1, 2].forEach(go)\nexport const t = tmpdir()`, '[1, 2].forEach(go)'],
    ['an import before a template', `${SAFE}\nconst a = go\nimport { tmpdir } from 'node:os';\n\`x\`.trim()\nexport const t = tmpdir()`, '`x`.trim()'],
  ])('%s', (_label, code, next) => {
    const { output } = new Linter().verifyAndFix(code, tsRuleConfig(RULE.tmpdir), { filename: LINTED_FILE });

    expect(output).not.toContain('node:os');
    const at = output.indexOf(next);
    expect(at).toBeGreaterThan(0);
    expect(output.slice(0, at).trimEnd().endsWith(';')).toBe(true);
  });

  it.each([
    ['first in the body', 'export function f(a = 1) {\n  const os = require("node:os");\n  "use strict";\n  return os.tmpdir() + a;\n}'],
    ['after a directive', 'export function f(a = 1) {\n  "use foo";\n  const os = require("node:os");\n  "use strict";\n  return os.tmpdir() + a;\n}'],
  ])('a string after a removed statement %s does not become a directive', (_label, code) => {
    const { output, messages } = fix(code, ruleConfig(RULE.tmpdir));

    expect(messages.filter((message) => message.fatal === true)).toStrictEqual([]);
    expect(output).not.toContain('node:os');
    expect(output).toMatch(/;\s*;?\s*"use strict";/u);
    expect(output).not.toMatch(/(?:\{|"use foo";)\s*"use strict"/u);
  });

  it('adds no `;` where the statement before already ends in one', () => {
    const code = `${SAFE}\nimport { x } from 'y';\nimport { tmpdir } from 'node:os';\n[1].map(x)\nexport const t = tmpdir();`;
    const { output } = new Linter().verifyAndFix(code, tsRuleConfig(RULE.tmpdir), { filename: LINTED_FILE });

    expect(output).not.toContain('node:os');
    expect(output).not.toMatch(/;\s*;/u);
  });
});

describe('a namespace binding the fix orphaned is removed', () => {
  it.each([
    ['await import()', RULE.tmpdir, "const os = await import('node:os');", 'export const t = os.tmpdir();'],
    ['require()', RULE.tmpdir, "const os = require('node:os');", 'export const t = os.tmpdir();'],
    ['import = require()', RULE.tmpdir, "import os = require('node:os');", 'export const t = os.tmpdir();'],
    ['require() of fs', RULE.mkdir, "const fs = require('node:fs');", "fs.mkdirSync('d');"],
    ['require() of path, consumed by path.sep', RULE.normalize, "const path = require('node:path');", "export const n = 'a'.split(path.sep).join('/');"],
    ['import = require() of path', RULE.normalize, "import path = require('node:path');", "export const n = 'a'.split(path.sep).join('/');"],
    ['a destructured require()', RULE.tmpdir, "const { tmpdir } = require('node:os');", 'export const t = tmpdir();'],
  ])('%s (%s)', (_label, name, binding, use) => {
    const code = `${binding}\n${use}`;
    const cfg = tsRuleConfig(name);
    expect(lint(code, cfg)).toHaveLength(1);

    const { output } = new Linter().verifyAndFix(code, cfg, { filename: LINTED_FILE });

    expect(output).not.toContain(binding);
    expect(unusedUnderTs(output)).toStrictEqual([]);
    expect(new Linter().verify(output, cfg, { filename: LINTED_FILE })).toStrictEqual([]);
  });

  it.each([
    ['still referenced', "const os = require('node:os');\nexport const t = [os.tmpdir(), os.homedir()];", "const os = require('node:os');"],
    ['exported', "export const os = require('node:os');\nexport const t = os.tmpdir();", "export const os = require('node:os');"],
    ['one of two declarators', "const os = require('node:os'), n = 1;\nexport const t = [os.tmpdir(), n];", "const os = require('node:os'), n = 1;"],
    ['a reassigned binding', "let os = require('node:os');\nos = require('os');\nexport const t = os.tmpdir();", "let os = require('node:os');"],
    ['a pattern with a rest element', "const { tmpdir, ...rest } = require('node:os');\nexport const t = tmpdir();", "const { tmpdir, ...rest } = require('node:os');"],
    ['an exported import = require()', "export import os = require('node:os');\nexport const t = os.tmpdir();", "export import os = require('node:os');"],
    // As an unbraced body, deleting the statement would make the NEXT statement that body.
    ['the unbraced if-body is an import = require()', "if (process.env.D) import os = require('node:os');\nmain();\nexport const t = os.tmpdir();", "import os = require('node:os');"],
    ['the unbraced label body is an import = require()', "tag: import os = require('node:os');\nmain();\nexport const t = os.tmpdir();", "import os = require('node:os');"],
  ])('keeps it when %s', (_label, code, survivor) => {
    const { output } = new Linter().verifyAndFix(code, tsRuleConfig(RULE.tmpdir), { filename: LINTED_FILE });
    expect(output).toContain('normalizedTmpdir()');
    expect(output).toContain(survivor);
  });
});

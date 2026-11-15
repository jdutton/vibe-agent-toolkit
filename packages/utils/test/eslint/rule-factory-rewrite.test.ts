/**
 * `eslint-rule-factory`'s `rewrite` declaration is required and validated at
 * construction: a rule whose declaration the factory cannot read must refuse to
 * build, never fall into a default autofix that emits the wrong call.
 */
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import { RULE } from './fixtures.js';
import { LANGUAGE_OPTIONS, ruleConfig } from './linter-harness.js';
import { loadLocalRuleModule } from './rule-tester.js';

type Factory = (config: Record<string, unknown>) => unknown;

const createRule = loadLocalRuleModule<Factory>('eslint-rule-factory.cjs');

const BASE = {
  unsafeFn: 'mkdirSync',
  unsafeModule: 'node:fs',
  safeFn: 'mkdirSyncReal',
  safeModule: '@vibe-agent-toolkit/utils/fs',
  message: 'Use mkdirSyncReal()',
  docs: { category: 'Filesystem and process', bans: 'x', useInstead: 'y', recommended: false },
};

function build(rewrite: unknown): () => unknown {
  return () => createRule(rewrite === undefined ? BASE : { ...BASE, rewrite });
}

describe('eslint-rule-factory rewrite declaration', () => {
  it.each([
    ['omitted', undefined],
    ["the string 'suggest'", 'suggest'],
    ['an empty object', {}],
    ['appendArgument with no suggestion', { appendArgument: 'X' }],
    ['a non-string suggestion', { appendArgument: 'X', suggestion: 3, seamMessage: 'm' }],
    ['appendArgument with no seamMessage', { appendArgument: 'X', suggestion: 's' }],
    ['autofixAsStatement with no suggestion', { autofixAsStatement: true }],
    ['both appendArgument and autofixAsStatement', { appendArgument: 'X', autofixAsStatement: true, suggestion: 's' }],
  ])('refuses %s', (_label, rewrite) => {
    expect(build(rewrite)).toThrow(TypeError);
  });

  it.each([
    ["'fix'", 'fix'],
    ['appendArgument + suggestion + seamMessage', { appendArgument: 'X', suggestion: 's', seamMessage: 'm' }],
    ['autofixAsStatement + suggestion', { autofixAsStatement: true, suggestion: 's' }],
  ])('builds %s', (_label, rewrite) => {
    expect(build(rewrite)).not.toThrow();
  });
});

/**
 * A CommonJS file cannot take an `import` declaration: a rewrite that inserts one
 * leaves the file unparsable. In script mode every rule whose fix needs an import
 * reports the call and rewrites nothing — neither by `--fix` nor through a suggestion.
 */
describe('an import-inserting rule in a CommonJS file', () => {
  const commonjs = { ...LANGUAGE_OPTIONS, sourceType: 'commonjs' } as const;
  const script = (name: string): Linter.Config[] =>
    ruleConfig(name).map((block) => ({ ...block, languageOptions: commonjs }));

  it.each([
    [RULE.mkdir, "'use strict';\nconst fs = require('fs');\nfs.mkdirSync('x');\n"],
    [RULE.tmpdir, "'use strict';\nconst os = require('os');\nmodule.exports = os.tmpdir();\n"],
    [RULE.realpath, "const fs = require('node:fs');\nmodule.exports = fs.realpathSync('x');\n"],
    [RULE.execSync, "const cp = require('child_process');\nmodule.exports = cp.execSync('ls');\n"],
    [RULE.rawPath, "module.exports = [safePath.join('b'), join('x')];\n"],
    [RULE.normalize, "const path = require('path');\nmodule.exports = 'a'.split(path.sep).join('/');\n"],
  ])('%s reports and leaves the file unchanged', (name, code) => {
    const fixed = new Linter().verifyAndFix(code, script(name), { filename: 'file.ts' });

    expect(fixed.output).toBe(code);
    expect(fixed.messages.map((m) => [m.ruleId, m.suggestions ?? []])).toEqual([[`local/${name}`, []]]);
  });

  it('rewrites the call when the replacement is already bound in the file', () => {
    const code = "const { normalizedTmpdir } = require('@vibe-agent-toolkit/utils/fs');\nconst os = require('os');\nmodule.exports = os.tmpdir();\n";
    const fixed = new Linter().verifyAndFix(code, script(RULE.tmpdir), { filename: 'file.ts' });

    expect(fixed.output).toContain('module.exports = normalizedTmpdir();');
  });
});

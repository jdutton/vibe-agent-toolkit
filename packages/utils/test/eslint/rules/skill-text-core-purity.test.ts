/**
 * `skill-text-core-purity` — the skill-text core takes every regex and constant
 * from its declaration, so the declaration's digest covers everything its output
 * depends on but control flow. Each literal KIND, each way of reaching `RegExp`
 * and each import shape the rule refuses has its own invalid case; the valid
 * cases pin what it must let through.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'skill-text-core-purity';
const FILE = '/repo/packages/resources/src/skill-text/core.ts';
const OPTIONS = [{ declaration: './declaration.js', declarationExports: ['SKILL_TEXT_DECLARATION'] }];

function invalid(code: string, messageId: string): RuleCases['invalid'][number] {
  return { code, filename: FILE, options: OPTIONS, errors: [{ messageId }] };
}

const CASES: RuleCases = {
  valid: [
    'export const a = 0;',
    'export const a = 1;',
    'export const a = -1;',
    "export const a = '';",
    'export const a = ``;',
    'export const a = `${String(1)}${String(0)}`;',
    'export const a = true || false || null;',
    "import type { X } from './other.js';\nexport type Y = X;",
    "import { type X } from './other.js';\nexport type Y = X;",
    "import type { SkillTextDeclaration } from './declaration.js';\nexport type D = SkillTextDeclaration;",
    "import { type PatternId, SKILL_TEXT_DECLARATION } from './declaration.js';\nexport const a: PatternId | typeof SKILL_TEXT_DECLARATION = SKILL_TEXT_DECLARATION;",
    "import { helper } from './helper.js';\nexport const a = helper;",
    "import { helper } from './nested/helper.js';\nexport const a = helper;",
    "export { helper } from './helper.js';",
    "export * from './helper.js';",
    "import './side-effect.js';",
    "export type Family = 'a' | 'b';",
    "export function f(x: unknown): 'a' | undefined { return x as 'a' | undefined; }",
    'export const f = (d: { re: RegExp }, s: string): boolean => d.re.test(s);',
    'export type R = typeof RegExp;',
    'export interface Holder { RegExp: number }',
    'export const f = (d: { RegExp: number }): number => d.RegExp;',
    "export type { X } from './other.js';",
  ].map((code) => ({ code, filename: FILE, options: OPTIONS })),
  invalid: [
    invalid('export const a = /x/u;', 'regexLiteral'),
    invalid('export const a = new RegExp(String(1));', 'regexReference'),
    invalid('export const a = RegExp(String(1));', 'regexReference'),
    invalid('export const a = new globalThis.RegExp(String(1));', 'regexReference'),
    invalid('const R = RegExp;\nexport const a = new R(String(1));', 'regexReference'),
    invalid('const { RegExp: R } = globalThis;\nexport const a = new R(String(1));', 'regexReference'),
    invalid('export const a = Reflect.construct(RegExp, [String(1)]);', 'regexReference'),
    invalid('export const a = [RegExp];', 'regexReference'),
    invalid('export const a = { RegExp };', 'regexReference'),
    invalid('export const f = (d: { re: RegExp }): void => { d.re.lastIndex = 0; };', 'lastIndex'),
    invalid('export const f = (d: { re: RegExp }): void => { const r = d.re; r.lastIndex = 0; };', 'lastIndex'),
    invalid('export const f = (d: { re: RegExp }): void => { const { re: alias } = d; alias.lastIndex += 1; };', 'lastIndex'),
    invalid('export const f = (r: RegExp): number => r.lastIndex;', 'lastIndex'),
    invalid('export const f = (r: RegExp): number => r?.lastIndex;', 'lastIndex'),
    invalid('export const f = ({ lastIndex: at }: RegExp): number => at;', 'lastIndex'),
    {
      code: 'export const f = ({ lastIndex }: RegExp): number => lastIndex + 1;',
      filename: FILE,
      options: OPTIONS,
      errors: [{ messageId: 'lastIndex', column: 21 }, { messageId: 'lastIndex', column: 53 }],
    },
    invalid('export const f = (r: RegExp): void => { Object.assign(r, { lastIndex: 0 }); };', 'lastIndex'),
    invalid("export const a = 'x';", 'literal'),
    invalid(String.raw`export const a = "\n";`, 'literal'),
    invalid('export const a = 2;', 'literal'),
    invalid('export const a = -2;', 'literal'),
    invalid('export const a = 0.5;', 'literal'),
    invalid('export const a = 10n;', 'literal'),
    invalid('export const a = `x`;', 'literal'),
    invalid('export const a = `${String(1)}-`;', 'literal'),
    invalid('export const a = String.raw`x`;', 'literal'),
    invalid("export const a = { 'key': 1 };", 'literal'),
    invalid("import { SKILL_TEXT_FAMILIES } from './declaration.js';\nexport const a = SKILL_TEXT_FAMILIES;", 'valueImport'),
    invalid("import { SKILL_TEXT_DECLARATION, skillTextDeclarationDigest } from './declaration.js';\nexport const a = [SKILL_TEXT_DECLARATION, skillTextDeclarationDigest];", 'valueImport'),
    invalid("import { SKILL_TEXT_DECLARATION as D, EXTERNAL_CLI_BINARIES } from './declaration.js';\nexport const a = [D, EXTERNAL_CLI_BINARIES];", 'valueImport'),
    invalid("import * as declared from './declaration.js';\nexport const a = declared;", 'valueImport'),
    invalid("import declared from './declaration.js';\nexport const a = declared;", 'valueImport'),
    invalid("import { SKILL_TEXT_FAMILIES } from './declaration';\nexport const a = SKILL_TEXT_FAMILIES;", 'valueImport'),
    invalid("import { SKILL_TEXT_FAMILIES } from './declaration.ts';\nexport const a = SKILL_TEXT_FAMILIES;", 'valueImport'),
    invalid("export { SKILL_TEXT_FAMILIES } from './declaration.js';", 'valueImport'),
    invalid("export * from './declaration.js';", 'valueImport'),
    invalid("import { helper } from '../helper.js';\nexport const a = helper;", 'valueImport'),
    invalid("import { helper } from './nested/../../helper.js';\nexport const a = helper;", 'valueImport'),
    invalid("import { helper } from './nested/../helper.js';\nexport const a = helper;", 'valueImport'),
    invalid("import { helper } from './nested/./helper.js';\nexport const a = helper;", 'valueImport'),
    invalid("import { helper } from './nested//helper.js';\nexport const a = helper;", 'valueImport'),
    invalid("import { SKILL_TEXT_FAMILIES } from './nested/../declaration.js';\nexport const a = SKILL_TEXT_FAMILIES;", 'valueImport'),
    invalid("import { createHash } from 'node:crypto';\nexport const a = createHash;", 'valueImport'),
    invalid("export * from '../helper.js';", 'valueImport'),
    invalid("export const a = import('./helper.js');", 'valueImport'),
    invalid("export const a: unknown = require('./helper.js');", 'valueImport'),
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(RULE, CASES); });
});

/**
 * `explicit-zod-strictness` — every `z.object({...})` must say what it does
 * with an unknown key. The VALID cases pin the chain shapes the repo already
 * writes (`.strict()` first, `.strict()` after `.describe()`, `.strict()`
 * before `.optional()`); the INVALID ones pin the default-strip shapes that
 * look finished but silently drop keys.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'explicit-zod-strictness';
const LINTED = '/repo/packages/resources/src/schemas/thing.ts';
const PERMISSIVE = 'packages/resources/src/schemas/project-config.ts';
const ALLOW_PERMISSIVE = [{ allowDefaultStripIn: [PERMISSIVE] }];

const CASES: RuleCases = {
  valid: [
    { code: 'const S = z.object({ a: z.string() }).strict();', filename: LINTED },
    { code: 'const S = z.object({ a: z.string() }).passthrough();', filename: LINTED },
    { code: 'const S = z.object({ a: z.string() }).loose();', filename: LINTED },
    // An explicit `.strip()` is the default said out loud — a write-side whitelist.
    { code: 'const S = z.object({ a: z.string() }).strip();', filename: LINTED },
    // Zod 4 spellings are explicit by construction.
    { code: 'const S = z.strictObject({ a: z.string() });', filename: LINTED },
    { code: 'const S = z.looseObject({ a: z.string() });', filename: LINTED },
    // The marker may sit anywhere in the same chain.
    { code: "const S = z.object({ a: z.string() }).describe('x').strict();", filename: LINTED },
    { code: 'const S = z.object({ a: z.string() }).strict().optional();', filename: LINTED },
    { code: 'const S = z.object({ a: z.string() }).strict().refine((v) => v.a.length > 0);', filename: LINTED },
    { code: 'const S = z.object({ a: z.string() }).extend({ b: z.number() }).strict();', filename: LINTED },
    // Nested: each object declares for itself.
    { code: 'const S = z.object({ inner: z.object({ a: z.string() }).strict() }).strict();', filename: LINTED },
    { code: 'const S = z.array(z.object(shape).strict());', filename: LINTED },
    // Not zod's `object` at all.
    { code: 'const S = schema.object({ a: 1 });', filename: LINTED },
    { code: 'const S = z.string();', filename: LINTED },
    // The declared permissive file, matched by repo-relative path.
    { code: 'const S = z.object({ a: z.string() });', filename: `/repo/${PERMISSIVE}`, options: ALLOW_PERMISSIVE },
  ],
  invalid: [
    { code: 'const S = z.object({ a: z.string() });', filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    { code: 'export const S = z.object({});', filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    // A chain that never reaches a marker is still default-strip.
    { code: "const S = z.object({ a: z.string() }).describe('x');", filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    { code: 'const S = z.object({ a: z.string() }).optional();', filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    { code: 'const S = z.object({ a: z.string() }).partial();', filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    { code: 'const S = z.object({ a: z.string() }).extend({ b: z.number() });', filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    { code: 'const S = z.object({ a: z.string() }).refine((v) => v.a.length > 0);', filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    // The outer object is explicit; the inner one is not.
    {
      code: 'const S = z.object({ inner: z.object({ a: z.string() }) }).strict();',
      filename: LINTED,
      errors: [{ messageId: 'defaultStrip' }],
    },
    // Both are missing: two reports, one per object.
    {
      code: 'const S = z.object({ inner: z.object({ a: z.string() }) });',
      filename: LINTED,
      errors: [{ messageId: 'defaultStrip' }, { messageId: 'defaultStrip' }],
    },
    { code: 'const S = z.array(z.object(shape));', filename: LINTED, errors: [{ messageId: 'defaultStrip' }] },
    // A different file with the permissive file's basename is not the permissive file.
    {
      code: 'const S = z.object({ a: z.string() });',
      filename: '/repo/packages/other/src/project-config.ts',
      options: ALLOW_PERMISSIVE,
      errors: [{ messageId: 'defaultStrip' }],
    },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});

/**
 * `no-version-literal` — the mechanical half of CLAUDE.md's "NO VERSIONS"
 * rule. The VALID cases pin the documented non-offenders (a string header
 * value, a real list, a regex that parses versions, a string in a fixture);
 * the INVALID ones pin the two shapes an integer-deciding-validity takes.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-version-literal';

const CASES: RuleCases = {
  valid: [
    // Documented non-offenders: a string is an external fact, a list is a list.
    { code: "const ANTHROPIC_VERSION = '2023-06-01';" },
    { code: "const SUPPORTED_PYTHON_VERSIONS = ['3.11', '3.12'];" },
    { code: "const VERSION = '0.2.0-rc.6';" },
    { code: String.raw`const VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/u;` },
    // A version that is READ, not decided: the package's own.
    { code: 'const version = pkg.version;' },
    { code: 'const CACHE_VERSION = readPackageVersion();' },
    // Schema fields named version that carry a real value, not a pinned integer.
    { code: 'const S = z.object({ version: z.string() }).strict();' },
    { code: 'const S = z.object({ version: z.number().int() }).strict();' },
    { code: "const S = z.object({ version: z.literal('1.0') }).strict();" },
    // A literal on a field not named like a version.
    { code: 'const S = z.object({ kind: z.literal(1) }).strict();' },
    // A name that is not a version constant.
    { code: 'const MAX_VERSIONS_KEPT = 3;' },
    { code: 'const versionCount = 2;' },
    // An explicit allow entry.
    { code: 'const WIRE_VERSION = 1;', options: [{ allowNames: ['WIRE_VERSION'] }] },
  ],
  invalid: [
    { code: 'const CACHE_VERSION = 1;', errors: [{ messageId: 'versionConstant', data: { name: 'CACHE_VERSION' } }] },
    { code: 'const SCHEMA_VERSION = 3;', errors: [{ messageId: 'versionConstant' }] },
    { code: 'const DUMP_VERSION = 2;', errors: [{ messageId: 'versionConstant' }] },
    { code: 'const PARSE_FACTS_REVISION = 4;', errors: [{ messageId: 'versionConstant' }] },
    { code: 'export const VERSION = 1;', errors: [{ messageId: 'versionConstant' }] },
    { code: 'let formatVersion = 2;', errors: [{ messageId: 'versionConstant' }] },
    { code: 'const CACHE_VERSION = 1 as const;', errors: [{ messageId: 'versionConstant' }] },
    { code: 'class Store { static VERSION = 2; }', errors: [{ messageId: 'versionConstant' }] },
    { code: 'const S = z.object({ version: z.literal(1) });', errors: [{ messageId: 'versionLiteralField', data: { name: 'version' } }] },
    { code: 'const S = z.object({ schemaVersion: z.literal(2) }).strict();', errors: [{ messageId: 'versionLiteralField' }] },
    { code: 'const S = z.object({ formatVersion: z.literal(1).optional() }).strict();', errors: [{ messageId: 'versionLiteralField' }] },
    { code: "const S = z.object({ formatVersion: z.literal(1).describe('x') }).strict();", errors: [{ messageId: 'versionLiteralField' }] },
    // The allow list names ONE identifier.
    { code: 'const CACHE_VERSION = 1;', options: [{ allowNames: ['WIRE_VERSION'] }], errors: [{ messageId: 'versionConstant' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});

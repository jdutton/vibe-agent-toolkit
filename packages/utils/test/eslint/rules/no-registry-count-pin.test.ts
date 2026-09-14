/**
 * `no-registry-count-pin` — a test may not pin the SIZE of something it
 * imported from src. The VALID cases are the ones that must stay silent for
 * the rule to be usable at all: counts of locally built fixtures, counts of
 * what an imported function produced from LOCAL input, small literals, and
 * non-test files. The INVALID ones pin the registry shapes the audit found.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-registry-count-pin';
const TEST = '/repo/packages/resources/test/registry.test.ts';
const SRC = '/repo/packages/resources/src/registry.ts';
const REGISTRY_IMPORT = "import { REGISTRY, allSpecs, parse } from '../src/index.js';";

const CASES: RuleCases = {
  valid: [
    // A locally built fixture: the count is the fixture's, not the repo's.
    { code: 'const items = [1, 2, 3, 4, 5, 6]; expect(items).toHaveLength(6);', filename: TEST },
    { code: 'const items = build(); expect(items).toHaveLength(6);', filename: TEST },
    // An imported FUNCTION applied to local data: the count is the data's.
    { code: `${REGISTRY_IMPORT} const text = fixture(); expect(parse(text).links).toHaveLength(6);`, filename: TEST },
    { code: `${REGISTRY_IMPORT} expect(parse('# a [x](y)').links).toHaveLength(6);`, filename: TEST },
    { code: `${REGISTRY_IMPORT} const doc = parse(localText); expect(doc.links).toHaveLength(6);`, filename: TEST },
    // A method on an imported NAMESPACE fed local data yields local data (measured: `safePath.join`).
    { code: "import { safePath } from '@vibe-agent-toolkit/utils'; const p = safePath.join(tempDir, 'len.txt'); expect(hashOf(p)).toHaveLength(64);", filename: TEST },
    { code: "import { fileContentHash, safePath } from '../src/index.js'; const hash = fileContentHash(safePath.join(tempDir, 'x')); expect(hash).toHaveLength(64);", filename: TEST },
    { code: `${REGISTRY_IMPORT} const agent = REGISTRY.build(localConfig); expect(agent.run({ a: 2 })).toBe(5);`, filename: TEST },
    // Below the threshold: a small count reads as a shape assertion.
    { code: `${REGISTRY_IMPORT} expect(REGISTRY).toHaveLength(4);`, filename: TEST },
    { code: `${REGISTRY_IMPORT} expect(REGISTRY.length).toBe(2);`, filename: TEST },
    // A raised threshold.
    { code: `${REGISTRY_IMPORT} expect(REGISTRY).toHaveLength(9);`, filename: TEST, options: [{ minLiteral: 10 }] },
    // Not a count matcher.
    { code: `${REGISTRY_IMPORT} expect(REGISTRY).toEqual(expected);`, filename: TEST },
    { code: `${REGISTRY_IMPORT} expect(REGISTRY.length).toBe(expected.length);`, filename: TEST },
    // Not a test file.
    { code: `${REGISTRY_IMPORT} expect(REGISTRY).toHaveLength(12);`, filename: SRC },
    // A parameter is local by definition.
    { code: 'function check(list) { expect(list).toHaveLength(12); }', filename: TEST },
  ],
  invalid: [
    // The imported value itself.
    { code: `${REGISTRY_IMPORT} expect(REGISTRY).toHaveLength(23);`, filename: TEST, errors: [{ messageId: 'registryCountPin', data: { literal: '23' } }] },
    { code: `${REGISTRY_IMPORT} expect(REGISTRY.length).toBe(23);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    { code: `${REGISTRY_IMPORT} expect(REGISTRY.size).toBe(23);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    // Through a global transform.
    { code: `${REGISTRY_IMPORT} expect(Object.keys(REGISTRY)).toHaveLength(27);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    { code: `${REGISTRY_IMPORT} expect(Object.values(REGISTRY.rules)).toHaveLength(19);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    { code: `${REGISTRY_IMPORT} expect([...REGISTRY]).toHaveLength(12);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    { code: `${REGISTRY_IMPORT} expect(new Set(REGISTRY).size).toBe(12);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    // Through a method on the imported value.
    { code: `${REGISTRY_IMPORT} expect(REGISTRY.filter((r) => r.scope === 'extent')).toHaveLength(8);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    // A zero-argument imported accessor IS the registry.
    { code: `${REGISTRY_IMPORT} expect(allSpecs()).toHaveLength(12);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    { code: `${REGISTRY_IMPORT} expect(allSpecs().filter((s) => s.scope === 'extent')).toHaveLength(8);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    // Through a local const that merely renames the import.
    { code: `${REGISTRY_IMPORT} const rules = Object.keys(REGISTRY); expect(rules).toHaveLength(33);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    { code: `${REGISTRY_IMPORT} const specs = allSpecs(); const extent = specs.filter((s) => s.scope); expect(extent).toHaveLength(8);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    // A namespace import.
    { code: "import * as reg from '../src/index.js'; expect(reg.REGISTRY).toHaveLength(23);", filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    // `expect.soft` and a message argument change nothing.
    { code: `${REGISTRY_IMPORT} expect.soft(REGISTRY).toHaveLength(23);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    { code: `${REGISTRY_IMPORT} expect(REGISTRY, 'must stay').toHaveLength(23);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
    // Exactly the threshold.
    { code: `${REGISTRY_IMPORT} expect(REGISTRY).toHaveLength(5);`, filename: TEST, errors: [{ messageId: 'registryCountPin' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});

/**
 * `no-literal-test-timeout` — a per-test or per-hook timeout written as a number
 * overrides the tier's platform-scaled default with one value for every machine,
 * so a literal that is generous on a fast runner is the failure on a slow one.
 * The VALID cases that matter most are the derived ones: a rule that fired on
 * them would leave no way to ask for more time at all.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-literal-test-timeout';
const LITERAL = [{ messageId: 'literalTimeout' }] as const;

const CASES: RuleCases = {
  valid: [
    // Omitted: the tier's default applies.
    "it('x', () => {});",
    "beforeAll(async () => {});",
    // Derived from the value the tier's config provides.
    "it('x', () => {}, inject('tierTestTimeout') * 4);",
    "beforeAll(() => {}, inject('tierHookTimeout') * 2);",
    "it('x', { timeout: inject('tierTestTimeout') * 3 }, () => {});",
    "const SLOW = inject('tierTestTimeout') * 2;\nit('x', () => {}, SLOW);",
    // A parameter or an import is not a literal this file decides.
    "function suite(t) { it('x', () => {}, t); }",
    "import { T } from './t.js';\nit('x', () => {}, T);",
    // Numbers that are not a timeout: a table, a condition, a call to something else.
    "it.each([1, 2, 3])('n=%i', (n) => {});",
    "it.for([[1, 2]])('pair', ([a, b]) => {});",
    "it.skipIf(1 > 0)('x', () => {});",
    "setTimeout(() => {}, 5000);",
    "vi.waitFor(() => {}, { timeout: 5000 });",
    "run('x', () => {}, 60_000);",
    // An options object without a timeout.
    "it('x', { retry: 2 }, () => {});",
  ],
  invalid: [
    // The shape that went red on Windows.
    { code: "it('x', async () => {}, 60_000);", errors: LITERAL },
    { code: "test('x', () => {}, 30000);", errors: LITERAL },
    { code: "describe('x', () => {}, 20_000);", errors: LITERAL },
    { code: "beforeAll(async () => {}, 3_600_000);", errors: LITERAL },
    { code: "afterAll(() => {}, 120_000);", errors: LITERAL },
    { code: "beforeEach(() => {}, 1000);", errors: LITERAL },
    { code: "afterEach(() => {}, 1000);", errors: LITERAL },
    // Arithmetic over literals is still a literal.
    { code: "it('x', () => {}, 5 * 60 * 1000);", errors: LITERAL },
    { code: "it('x', () => {}, (60_000));", errors: LITERAL },
    { code: "it('x', () => {}, 60_000 as number);", errors: LITERAL },
    // Through a modifier, a condition or a table.
    { code: "it.concurrent('x', () => {}, 60_000);", errors: LITERAL },
    { code: "test.sequential('x', () => {}, 60_000);", errors: LITERAL },
    { code: "it.skipIf(isWindows)('x', () => {}, 60_000);", errors: LITERAL },
    { code: "it.each([1])('n=%i', (n) => {}, 60_000);", errors: LITERAL },
    { code: "describe.runIf(ok)('x', () => {}, 60_000);", errors: LITERAL },
    // The options-object spellings, in either position.
    { code: "it('x', { timeout: 60_000 }, () => {});", errors: LITERAL },
    { code: "it('x', () => {}, { timeout: 60_000 });", errors: LITERAL },
    { code: "it.for(cases)('x', { timeout: 60_000 }, (c) => {});", errors: LITERAL },
    // A number as the options argument.
    { code: "it('x', 60_000, () => {});", errors: LITERAL },
    // A same-file constant is the literal under a name.
    { code: "const TIMEOUT_MS = 90_000;\nbeforeAll(() => {}, TIMEOUT_MS);", errors: LITERAL },
    { code: "const BASE = 1000;\nconst T = BASE * 60;\nit('x', () => {}, T);", errors: LITERAL },
    { code: "const T = 60_000;\nit('x', { timeout: T }, () => {});", errors: LITERAL },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(RULE, CASES); });
});

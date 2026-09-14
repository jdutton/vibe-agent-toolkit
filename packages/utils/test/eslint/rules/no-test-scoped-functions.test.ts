/**
 * `no-test-scoped-functions` — a `function` DECLARATION inside a test block is
 * a helper hidden where nothing else can reuse it (SonarQube S1515).
 *
 * The VALID rows carry the weight: the rule keys on the enclosing CALL being a
 * test block, and a rule that also fired on arrow helpers, on module-scope
 * declarations that merely sit between two `describe`s, or on a `describe`
 * method of some unrelated object would be disabled by the first file it hit.
 */

import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const NAME = 'no-test-scoped-functions';
const ERR = [{ messageId: 'moveToModuleScope' }];

const CASES: RuleCases = {
  valid: [
    // Module scope, before and between test blocks.
    { code: "function setup() {}\ndescribe('x', () => { it('y', () => { setup(); }); });" },
    { code: "describe('a', () => {});\nfunction between() {}\ndescribe('b', () => {});" },
    // Arrow and function EXPRESSIONS are not declarations; the rule is about
    // the hoisted `function` statement a reader expects at module scope.
    { code: "describe('x', () => { const helper = () => 1; it('y', () => { helper(); }); });" },
    { code: "describe('x', () => { const helper = function () { return 1; }; it('y', helper); });" },
    // A declaration inside a NON-test call is not this rule's business.
    { code: "run(() => { function inner() {} inner(); });" },
    { code: "app.get('/x', () => { function handler() {} handler(); });" },
    // A method merely NAMED like a test block on an unrelated object still
    // counts — the rule matches Playwright's `test.describe` by property name —
    // so the negative here is a property that is not one of the names.
    { code: "suite.run(() => { function inner() {} inner(); });" },
    // Allowlisted by name.
    {
      code: "describe('x', () => { function allowed() {} it('y', () => { allowed(); }); });",
      options: [{ allowedFunctionNames: ['allowed'] }],
    },
    // Nested functions inside a module-scope helper are fine: depth is
    // measured in TEST BLOCKS, not in functions.
    { code: 'function outer() { function inner() {} return inner; }' },
  ],
  invalid: [
    { code: "describe('x', () => { function helper() {} });", errors: ERR },
    { code: "it('x', () => { function helper() {} });", errors: ERR },
    { code: "test('x', () => { function helper() {} });", errors: ERR },
    { code: 'beforeEach(() => { function helper() {} });', errors: ERR },
    { code: 'afterAll(() => { function helper() {} });', errors: ERR },
    // Playwright / member-call spelling.
    { code: "test.describe('x', () => { function helper() {} });", errors: ERR },
    // Nested two blocks deep — still inside a test block.
    { code: "describe('x', () => { it('y', () => { function helper() {} }); });", errors: ERR },
    // The allowlist is by NAME, so a sibling not on it still reports.
    {
      code: "describe('x', () => { function allowed() {} function other() {} });",
      options: [{ allowedFunctionNames: ['allowed'] }],
      errors: ERR,
    },
    // Two declarations, two reports — one per function, not one per block.
    { code: "describe('x', () => { function a() {} function b() {} });", errors: [...ERR, ...ERR] },
    // Depth is restored on exit: a declaration AFTER a test block that closed
    // is module scope, but one inside a later block is not.
    { code: "describe('a', () => {});\nfunction fine() {}\ndescribe('b', () => { function bad() {} });", errors: ERR },
  ],
};

describe(NAME, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(NAME, CASES); });
});

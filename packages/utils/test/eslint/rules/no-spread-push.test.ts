/**
 * `no-spread-push` — an array spread into `push`/`unshift` is an argument list,
 * which overflows the call stack past ~125,000 items. VALID pins what is not an
 * argument-list spread (an array literal spread in place, a spread into an array
 * literal, a plain push, a computed or non-array method); INVALID pins each shape
 * that reaches the limit: a variable, a call result, an awaited call, a spread
 * beside other arguments, and `unshift`.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-spread-push';
const SPREAD = [{ messageId: 'spread' }];

const CASES: RuleCases = {
  valid: [
    { code: 'out.push(item);' },
    { code: 'appendAll(out, walked);' },
    { code: "appendAll(lines, ['[header]', ...rows]);" },
    // A literal written in place is bounded by its own text.
    { code: 'out.push(...[a, b]);' },
    { code: 'const all = [...left, ...right];' },
    { code: 'out.push({ ...entry, path });' },
    { code: 'out[method](...walked);' },
    { code: 'out.concat(...walked);' },
  ],
  invalid: [
    { code: 'candidates.push(...walked);', errors: SPREAD },
    { code: 'issues.push(...validate(file));', errors: SPREAD },
    { code: 'async function f() { leftovers.push(...await removeAll(dir)); }', errors: SPREAD },
    { code: "lines.push('[header]', ...rows.map(String));", errors: SPREAD },
    { code: 'queue.unshift(...pending);', errors: SPREAD },
    { code: 'this.#items.push(...more);', errors: SPREAD },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});

/**
 * `no-path-operations-in-comparisons` — a raw `path.<method>()` result (or a
 * variable holding one) handed to a string comparison. It reports the ARGUMENT
 * position only: `base.startsWith(path.relative(a, b))` is a finding, while
 * `path.relative(a, b).startsWith(base)` is not — that receiver shape belongs
 * to `no-path-startswith`, and a rule reporting both would double-count.
 */

import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const NAME = 'no-path-operations-in-comparisons';
const ERR = [{ messageId: 'normalizePathOperation' }];

const CASES: RuleCases = {
  valid: [
    // Wrapped inline, or through a variable that was.
    { code: 'if (content.includes(toForwardSlash(path.relative(a, b)))) {}' },
    { code: 'const rel = toForwardSlash(path.relative(a, b)); if (content.includes(rel)) {}' },
    // Receiver position is not this rule's.
    { code: 'if (path.relative(a, b).startsWith(base)) {}' },
    // Not a comparison method.
    { code: 'const parts = path.relative(a, b).toUpperCase();' },
    { code: 'log(path.relative(a, b));' },
    // A `path` method that returns something other than a path.
    { code: 'if (content.includes(path.extname(f))) {}' },
    { code: 'if (content.includes(path.isAbsolute(f))) {}' },
    // A different `path`-named receiver's method is not `node:path`.
    { code: "if (content.includes(route.relative(a, b))) {}" },
    // A variable holding an unrelated value.
    { code: "const rel = other(a, b); if (content.includes(rel)) {}" },
    // A template literal whose expressions are not path calls.
    { code: 'if (content.includes(`${a}/${b}`)) {}' },
  ],
  invalid: [
    { code: 'if (content.includes(path.relative(a, b))) {}', errors: ERR },
    { code: 'const i = content.indexOf(path.dirname(f));', errors: ERR },
    { code: 'if (content.startsWith(path.join(a, b))) {}', errors: ERR },
    { code: 'if (content.endsWith(path.basename(f))) {}', errors: ERR },
    { code: "const parts = content.split(path.resolve(a));", errors: ERR },
    { code: "const s = content.replace(path.normalize(p), '');", errors: ERR },
    { code: 'const m = content.match(path.relative(a, b));', errors: ERR },
    // Through a variable that was assigned the raw result.
    { code: 'const rel = path.relative(a, b); if (content.includes(rel)) {}', errors: ERR },
    // Inside a template-literal argument.
    { code: 'if (content.includes(`[${path.relative(a, b)}]`)) {}', errors: ERR },
    // Two raw arguments, two reports.
    { code: "const s = content.replace(path.join(a, b), path.join(c, d));", errors: [...ERR, ...ERR] },
  ],
};

describe(NAME, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(NAME, CASES); });
});

/**
 * `no-hardcoded-path-split` — `.split('/')` / `.split('\\')` on something that
 * may be a native path. It is a HEURISTIC: it cannot see the operand's type, so
 * the VALID rows pin every shape it has to let through for the rule to survive
 * contact with a real tree — the inline `toForwardSlash()` wrap, a variable
 * assigned from one, and the naming hints (`normalized…`, `unix…`, `forward…`).
 */

import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const NAME = 'no-hardcoded-path-split';
const ERR = [{ messageId: 'noHardcodedSplit' }];

const CASES: RuleCases = {
  valid: [
    // Normalized inline, or through a variable that was.
    { code: "const parts = toForwardSlash(p).split('/');" },
    { code: "const n = toForwardSlash(p); const parts = n.split('/');" },
    // Naming hints the rule honours.
    { code: "const parts = normalizedPath.split('/');" },
    { code: "const parts = unixPath.split('/');" },
    { code: "const parts = forwardSlashed.split('/');" },
    // Not a path separator.
    { code: "const parts = csv.split(',');" },
    { code: String.raw`const parts = line.split(/\s+/);` },
    // A different method, or no argument.
    { code: "const i = p.indexOf('/');" },
    { code: 'const parts = p.split();' },
    // Regex with no slash or backslash.
    { code: 'const parts = p.split(/[,;]/);' },
  ],
  invalid: [
    { code: "const parts = filePath.split('/');", errors: ERR },
    { code: String.raw`const parts = filePath.split('\\');`, errors: ERR },
    { code: "const name = p.split('/').pop();", errors: ERR },
    // Regex spellings of the same split.
    { code: String.raw`const parts = p.split(/[/\\]/);`, errors: ERR },
    { code: String.raw`const parts = p.split(/\//);`, errors: ERR },
    // A member, not just an identifier.
    { code: "const parts = resource.path.split('/');", errors: ERR },
    // Normalized SOMEWHERE ELSE does not launder this variable.
    { code: "const n = toForwardSlash(q); const parts = p.split('/');", errors: ERR },
    // The naming hint is on the receiver, not on the result.
    { code: "const normalized = raw.split('/');", errors: ERR },
  ],
};

describe(NAME, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(NAME, CASES); });
});

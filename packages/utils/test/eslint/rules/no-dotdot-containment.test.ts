/**
 * `no-dotdot-containment` — a `..` string test on a path is not a containment
 * check. The VALID cases pin the receivers the rule must leave alone (a
 * segment walker's `segment === '..'`, a `startsWith('./')`, a non-path
 * string) and the INVALID ones pin every spelling the sweep found in the tree.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-dotdot-containment';
const ERR = [{ messageId: 'dotdotContainment' }];

const CASES: RuleCases = {
  valid: [
    // The right answer.
    { code: 'if (!isUnderRoot(root, candidate)) { refuse(); }' },
    // A segment normaliser compares one segment; it is not asking "is this inside?".
    { code: "for (const segment of parts) { if (segment === '..') { out.pop(); } }" },
    { code: "if (part === '..') { depth -= 1; }" },
    // A different prefix.
    { code: "if (relPath.startsWith('./')) { x(); }" },
    { code: "if (relPath.startsWith('/')) { x(); }" },
    { code: "if (relPath.includes('node_modules')) { x(); }" },
    // Not a path-typed receiver.
    { code: "if (message.includes('..')) { x(); }" },
    { code: "if (line.startsWith('...')) { x(); }" },
    { code: "const ellipsis = text.includes('...');" },
    // A split with no membership test after it.
    { code: "const parts = relPath.split('/');" },
    { code: "const depth = relPath.split('/').length;" },
    // Splitting and filtering for something OTHER than `..` is not a hunt.
    { code: "const parts = path.split('/').filter(Boolean);" },
    { code: "const hasDot = relPath.split('/').some((s) => s === '.');" },
  ],
  invalid: [
    { code: "if (rel.startsWith('..')) { refuse(); }", errors: ERR },
    { code: "if (rel.startsWith('../')) { refuse(); }", errors: ERR },
    { code: String.raw`if (rel.startsWith('..\\')) { refuse(); }`, errors: ERR },
    { code: "const escapes = relativeToBoundary.startsWith('..');", errors: ERR },
    { code: "return rel !== '' && !rel.startsWith('../') && !isAbsolutePath(rel);", errors: ERR },
    { code: "if (normalizedRelative.startsWith('../')) { x(); }", errors: ERR },
    { code: "if (name.includes('..')) { refuse(); }", errors: ERR },
    { code: "if (sessionId.includes('/') || sessionId.includes('..')) { refuse(); }", errors: ERR },
    { code: "if (targetPath.includes('../')) { refuse(); }", errors: ERR },
    // A member receiver.
    { code: "if (entry.filePath.startsWith('..')) { refuse(); }", errors: ERR },
    // The receiver is a call result — a relative() is a path by construction.
    { code: "if (safePath.relative(root, p).startsWith('..')) { refuse(); }", errors: ERR },
    { code: "if (relative(root, p).startsWith('../')) { refuse(); }", errors: ERR },
    // Splitting a path and hunting for the segment: one report, on the chain.
    { code: "if (forward.split('/').includes('..')) { refuse(); }", errors: ERR },
    { code: "if (relDir.split(sep).some((s) => s === '..')) { refuse(); }", errors: ERR },
    { code: String.raw`if (filePath.split(/[\\/]/u).indexOf('..') !== -1) { refuse(); }`, errors: ERR },
    // Two tests on one line are two reports.
    { code: "return rel.startsWith('..') || rel.includes('/../');", errors: [...ERR, ...ERR] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});

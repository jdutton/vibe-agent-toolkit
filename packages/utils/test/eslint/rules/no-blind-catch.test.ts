import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/**
 * `no-blind-catch` — a `catch` that never looks at its error and never throws.
 *
 * The VALID rows are the load-bearing ones: every legitimate way of HANDLING an
 * error references the binding (narrowing on it, carrying it into a report,
 * logging it) or throws, and the rule must let each of those through. The
 * INVALID rows are the shapes seven review rounds kept finding: a sentinel
 * return, a `continue`, an empty body, a fallback assignment — each of which
 * absorbs a bug, a permission refusal, or a corrupt artifact into the same
 * answer as the case it was written for.
 */
const CASES: RuleCases = {
  valid: [
    // Narrowed, then rethrown.
    { code: 'function f() { try { f(); } catch (e) { if (isAbsent(e)) { return null; } throw e; } }' },
    { code: 'function f() { try { f(); } catch (e) { if (e instanceof NotFound) { return []; } throw e; } }' },
    { code: "function f() { try { f(); } catch (e) { if (e.code === 'ENOENT') { return undefined; } throw e; } }" },
    // Carried into the report / the result.
    { code: 'function f() { try { f(); } catch (e) { errors.push(String(e)); } }' },
    { code: 'function f() { try { f(); } catch (e) { return { ok: false, error: e }; } }' },
    { code: 'function f() { try { f(); } catch (error) { log.warn(error); return null; } }' },
    // Destructured binding that is read.
    { code: 'function f() { try { f(); } catch ({ code }) { if (code === "ENOENT") { return null; } } }' },
    // Translated: the error is discarded but the failure is still loud.
    { code: "function f() { try { f(); } catch { throw new Error('config unreadable'); } }" },
    { code: 'function f() { try { f(); } catch (e) { throw wrap(e); } }' },
    // Rethrown from inside a branch.
    { code: 'function f() { try { f(); } catch (e) { if (retryable(e)) { retry(); } else { throw e; } } }' },
    // A `try` with no `catch` at all is not this rule's business.
    { code: 'function f() { try { f(); } finally { cleanup(); } }' },
  ],
  invalid: [
    // The shapes that shipped: sentinel returns.
    { code: 'function f() { try { f(); } catch { return null; } }', errors: [{ messageId: 'blindCatch' }] },
    { code: 'function f() { try { f(); } catch (e) { return null; } }', errors: [{ messageId: 'blindCatch' }] },
    { code: 'function f() { try { f(); } catch { return []; } }', errors: [{ messageId: 'blindCatch' }] },
    { code: 'function f() { try { f(); } catch { return false; } }', errors: [{ messageId: 'blindCatch' }] },
    { code: 'function f() { try { f(); } catch { return undefined; } }', errors: [{ messageId: 'blindCatch' }] },
    { code: 'function f() { for (const x of xs) { try { f(x); } catch { continue; } } }', errors: [{ messageId: 'blindCatch' }] },
    // Empty body, comment or not.
    { code: 'function f() { try { f(); } catch {} }', errors: [{ messageId: 'blindCatch' }] },
    { code: 'function f() { try { f(); } catch (e) { /* ignore */ } }', errors: [{ messageId: 'blindCatch' }] },
    // A fallback assignment — the same absorption, wearing a value.
    { code: 'function f() { let v; try { v = f(); } catch { v = DEFAULT; } }', errors: [{ messageId: 'blindCatch' }] },
    // A throw inside a nested function is not a rethrow from this catch.
    { code: "function f() { try { f(); } catch { later(() => { throw new Error('x'); }); return null; } }", errors: [{ messageId: 'blindCatch' }] },
    // Unused `_`-prefixed binding is still a discard.
    { code: 'function f() { try { f(); } catch (_error) { return null; } }', errors: [{ messageId: 'blindCatch' }] },
  ],
};

describe('no-blind-catch', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-blind-catch', CASES); });
});

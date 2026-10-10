import { constants } from 'node:os';

import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/**
 * `no-adhoc-errno` has two reports. `literal` fires on an errno name written as a
 * string in a classifying position (comparison, `case`, a Set/const array, a
 * `.has()`/`.includes()` argument). `adhocRefusal` fires on a catch that both
 * inspects the error's errno and wraps it as a refusal's `cause` by hand.
 *
 * The exempt entries are the files that must name errnos. The decoys share a
 * basename with an exempt entry but live in another directory, so they prove the
 * exemption is anchored to the path and not to the name.
 */
const SRC_FILE = 'packages/cli/src/example.ts';
const EXEMPT = 'packages/utils/src/errors/fs-fault.ts';
const FAULT_FS = 'packages/utils/src/testing/fault-fs.ts';
const OPTIONS = [{ exemptFiles: [EXEMPT, FAULT_FS] }];
const ENOENT_CHECK = "if (e.code === 'ENOENT') { stop(); }";

const CASES: RuleCases = {
  valid: [
    { code: "if (fsFaultOf(e)?.faultClass === 'refused') { throw e; }", filename: SRC_FILE, options: OPTIONS },
    { code: 'if (isPathAbsentError(e)) { return; }', filename: SRC_FILE, options: OPTIONS },
    // Not an errno: the name SET decides, so a short or underscored token passes.
    { code: "if (token === 'EOF') { stop(); }", filename: SRC_FILE, options: OPTIONS },
    { code: "if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') { stop(); }", filename: SRC_FILE, options: OPTIONS },
    // Errno-shaped, yet not an errno: a regex would have flagged it.
    { code: "if (name === 'EXAMPLE') { stop(); }", filename: SRC_FILE, options: OPTIONS },
    // A string in a non-classifying position is a message, not a check.
    { code: "const text = 'ENOENT';\nlog(text);", filename: SRC_FILE, options: OPTIONS },
    { code: ENOENT_CHECK, filename: EXEMPT, options: OPTIONS },
    { code: "if (code === 'ENOSPC') { stop(); }", filename: `/Users/dev/vat/${FAULT_FS}`, options: OPTIONS },
    { code: ENOENT_CHECK, filename: 'packages/cli/test/example.test.ts', options: OPTIONS },
    // A catch that classifies without hand-wrapping the cause.
    {
      code: 'try { run(); } catch (e) { if (isPathAbsentError(e)) { throw classifyFsFault(e); } throw e; }',
      filename: SRC_FILE,
      options: OPTIONS,
    },
    // Aliases and templates that are not errnos stay quiet.
    { code: "const C = 'EXAMPLE';\nif (e.code === C) { stop(); }", filename: SRC_FILE, options: OPTIONS },
    { code: 'if (e.code === `E${suffix}`) { stop(); }', filename: SRC_FILE, options: OPTIONS },
    // A wrap inside a nested function does not make the outer catch a re-wrap.
    {
      code: "try { a(); } catch (e) { if (fsFaultOf(e)) { run(() => { throw new VatError('X', 'bad', { cause: e }); }); } }",
      filename: SRC_FILE,
      options: OPTIONS,
    },
    // A catch that wraps the cause but never inspects the errno.
    {
      code: "try { run(); } catch (e) { throw new VatError('X', 'failed', { cause: e }); }",
      filename: SRC_FILE,
      options: OPTIONS,
    },
  ],
  invalid: [
    { code: ENOENT_CHECK, filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "if ('EACCES' !== e.code) { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "if (e.code == 'EPERM') { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "if (e.code != 'EEXIST') { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "switch (e.code) { case 'ENOTDIR': stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    {
      code: "const ABSENT = new Set(['ENOENT', 'ENOTDIR']);",
      filename: SRC_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'literal' }, { messageId: 'literal' }],
    },
    { code: "const ABSENT = ['ENOENT'] as const;", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "ABSENT.has('EBUSY');", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "TRANSIENT.includes('EAGAIN');", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    // The message match that hides an errno in prose.
    { code: "if (errorMessage.includes('ENOENT')) { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    // Names Node on some platforms omits from os.constants.errno, and the non-libuv ones.
    { code: "if (e.code === 'EFTYPE') { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "if (e.code === 'EHOSTDOWN') { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "if (e.code === 'UNKNOWN') { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    // DECOYS: same basename as an exempt entry, different directory, still linted.
    { code: ENOENT_CHECK, filename: 'packages/other/src/fs-fault.ts', options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "if (e.code === 'ENOSPC') { stop(); }", filename: 'packages/other/src/testing/fault-fs.ts', options: OPTIONS, errors: [{ messageId: 'literal' }] },
    // adhocRefusal: inspects the errno via a predicate, then wraps by hand.
    {
      code: "try { run(); } catch (e) { if (fsFaultOf(e)) { throw new CommandRefusalError('X', 'bad', { cause: e }); } throw e; }",
      filename: SRC_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'adhocRefusal' }],
    },
    {
      code: "try { run(); } catch (err) { if (isPathAbsentError(err)) { throw new VatError('X', 'bad', { cause: err }); } }",
      filename: SRC_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'adhocRefusal' }],
    },
    // Inline array lookups: the most common private errno table.
    ...['includes', 'some', 'indexOf', 'find', 'findIndex', 'every'].map((method) => ({
      code: `['ENOENT', 'EACCES'].${method}(e.code);`,
      filename: SRC_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'literal' as const }, { messageId: 'literal' as const }],
    })),
    { code: "(['ENOENT'] as const).includes(e.code);", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    // A template literal with no expressions is the literal it spells.
    { code: 'if (e.code === `ENOENT`) { stop(); }', filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    // A const alias is flagged at its use.
    { code: "const C = 'ENOENT';\nif (e.code === C) { stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    { code: "const C = 'ENOENT' as const;\nswitch (e.code) { case C: stop(); }", filename: SRC_FILE, options: OPTIONS, errors: [{ messageId: 'literal' }] },
    // A nested catch is judged on its own: one re-wrap, one report.
    {
      code:
        "try { a(); } catch (e) { if (fsFaultOf(e)) { try { b(); } catch (e) { if (isPathAbsentError(e)) { throw new VatError('X', 'bad', { cause: e }); } } } }",
      filename: SRC_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'adhocRefusal' }],
    },
    // adhocRefusal: reads e.code (no literal here, so only this report fires).
    {
      code: "try { run(); } catch (e) { const c = e.code; throw new VatError(c, 'bad', { cause: e }); }",
      filename: SRC_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'adhocRefusal' }],
    },
  ],
};

// The rule spells its errno set out (a rule module may require nothing external),
// so this is what stops the list drifting from the host's own table. On Windows that table also
// carries the Winsock constants (`WSAEINTR`, …): numbers Node translates before it reports an
// error, so no `error.code` is ever one of those names and the rule does not list them.
const isErrorCodeName = (name: string): boolean => !name.startsWith('WSA');

const HOST_ERRNOS: RuleCases = {
  valid: [],
  invalid: Object.keys(constants.errno).filter(isErrorCodeName).map((name) => ({
    code: `if (e.code === '${name}') { stop(); }`,
    filename: SRC_FILE,
    options: OPTIONS,
    errors: [{ messageId: 'literal' }],
  })),
};

describe('no-adhoc-errno', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-adhoc-errno', CASES); });
  it('flags every errno this host exports', () => { expectRulePasses('no-adhoc-errno', HOST_ERRNOS); });
});

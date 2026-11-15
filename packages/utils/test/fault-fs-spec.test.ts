/**
 * The fault spec a spawned process carries in `VAT_FAULT_FS`: JSON in, the same rules the
 * in-process injector takes out — a path is matched by a substring, since a function cannot cross
 * a process boundary.
 */
import { describe, expect, it } from 'vitest';

import { faultFsSpecOf, faultRuleOf, injectedErrnoError } from '../src/testing/fault-spec.js';

describe('faultRuleOf', () => {
  it('keeps family, op, nth and errno, and matches a path by the substring it names', () => {
    const rule = faultRuleOf({ family: 'write', op: 'write', pathIncludes: '/tmp/vat-install-tgz-', nth: 2, errno: 'ENOSPC' });
    expect(rule).toMatchObject({ family: 'write', op: 'write', nth: 2, errno: 'ENOSPC' });
    expect(rule.path('/c/tmp/vat-install-tgz-a1b2c3/package/x.json')).toBe(true);
    expect(rule.path('/c/home/.claude/plugins/x.json')).toBe(false);
  });

  it('leaves out what the spec leaves out, so the injector applies its own defaults', () => {
    expect(Object.keys(faultRuleOf({ pathIncludes: '/x', errno: 'EMFILE' })).toSorted((a, b) => a.localeCompare(b))).toEqual(['errno', 'path']);
  });
});

describe('faultFsSpecOf', () => {
  it('takes an open of either family, since its flags decide which', () => {
    const text = JSON.stringify({ within: '/c', faults: [{ family: 'read', op: 'open', pathIncludes: '/c', errno: 'EACCES' }, { family: 'write', op: 'open', pathIncludes: '/c', errno: 'EMFILE' }] });
    expect(faultFsSpecOf(text).faults).toHaveLength(2);
  });

  it('reads the JSON a spawned process is handed', () => {
    const spec = { within: '/c', faults: [{ family: 'write', op: 'open', pathIncludes: '/c/tmp/', nth: 1, errno: 'EMFILE' }] };
    expect(faultFsSpecOf(JSON.stringify(spec))).toEqual(spec);
  });

  it.each([
    ['not JSON', '{within'],
    ['no within', JSON.stringify({ faults: [] })],
    ['faults not a list', JSON.stringify({ within: '/c', faults: {} })],
    ['a fault with no pathIncludes', JSON.stringify({ within: '/c', faults: [{ errno: 'EMFILE' }] })],
    ['a fault with no errno', JSON.stringify({ within: '/c', faults: [{ pathIncludes: '/c' }] })],
    ['an errno the injector cannot raise', JSON.stringify({ within: '/c', faults: [{ pathIncludes: '/c', errno: 'ENOSPACE' }] })],
    ['a family no op belongs to', JSON.stringify({ within: '/c', faults: [{ family: 'wirte', pathIncludes: '/c', errno: 'ENOSPC' }] })],
    ['an op the harness does not trace', JSON.stringify({ within: '/c', faults: [{ op: 'wrte', pathIncludes: '/c', errno: 'ENOSPC' }] })],
    ['an op of another family', JSON.stringify({ within: '/c', faults: [{ family: 'read', op: 'rename', pathIncludes: '/c', errno: 'EPERM' }] })],
    ['an nth that is not a positive integer', JSON.stringify({ within: '/c', faults: [{ pathIncludes: '/c', nth: 0, errno: 'EMFILE' }] })],
  ])('refuses %s, naming the variable', (_label, text) => {
    expect(() => faultFsSpecOf(text)).toThrow(/VAT_FAULT_FS/);
  });
});

describe('injectedErrnoError', () => {
  it('is shaped like the error Node throws: the code, a negative errno number, the syscall and the path', () => {
    const error = injectedErrnoError('ENOENT', 'open', '/c/tmp/x.json');
    expect(error).toMatchObject({ code: 'ENOENT', syscall: 'open', path: '/c/tmp/x.json' });
    expect(error.errno).toBeLessThan(0);
    expect(error.message).toBe("ENOENT: injected, open '/c/tmp/x.json'");
  });

  it('gives two different errnos two different numbers, so a reader of `errno` can tell them apart', () => {
    expect(injectedErrnoError('ENOSPC', 'write', '/x').errno).not.toBe(injectedErrnoError('EACCES', 'write', '/x').errno);
  });
});

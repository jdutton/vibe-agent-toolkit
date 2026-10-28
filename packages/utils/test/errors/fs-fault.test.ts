/**
 * The errno classifier: every errno has exactly one class, the side is decided by
 * the path the OS named (not by the wrapper that caught it), and anything that is
 * not a filesystem errno passes through untouched.
 */

import { describe, expect, it } from 'vitest';

import {
  FS_FAULT_ERRNOS_BY_CLASS,
  fsFaultOf,
  isAccessRefusedError,
  isAlreadyExistsError,
  isFileInTheWayError,
  isFinalPathUnanswerableError,
  isInvalidArgumentError,
  isNameTooLongError,
  isNoSuchEntryError,
  isNotARegularFileError,
  isOccupiedError,
  isPathAbsentError,
  isProcessGoneError,
  isRenameContentionError,
  isRetryableShortageError,
  isSymlinkUnsupportedError,
  isTimedOutError,
  isUnresolvableLinkError,
  isWouldBlockError,
  pathsActedOn,
  type FsFaultClass,
} from '../../src/errors/errno-table.js';
import {
  assertUnresolvableLink,
  classifyFsFault,
  FS_FAULT_CODE,
  FsFaultError,
  isCapacityFault,
  isFsFaultError,
  isLayoutFault,
  linkResolutionFault,
  withFsFault,
  withFsFaultSync,
} from '../../src/errors/fs-fault.js';
import { VatError } from '../../src/errors/vat-error.js';
import { INJECTED_ERRNOS, injectedErrnoError } from '../../src/testing/fault-spec.js';

function errno(code: string, fields: Record<string, string> = {}): Error & { code: string } {
  return Object.assign(new Error(`${code}: simulated`), { code }, fields);
}

const TABLE: ReadonlyArray<readonly [FsFaultClass, readonly string[]]> = [
  ['absent', ['ENOENT', 'ENOTDIR']],
  ['refused', ['EACCES', 'EPERM']],
  ['exhausted', ['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE']],
  ['wrong-type', ['EISDIR', 'EFTYPE', 'ELOOP', 'ENAMETOOLONG']],
  ['occupied', ['EEXIST', 'ENOTEMPTY']],
  ['busy', ['EBUSY', 'ETXTBSY', 'EAGAIN']],
  ['unsupported', ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'EROFS']],
  ['device', ['EIO', 'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ENOTCONN', 'UNKNOWN']],
];
const CASES = TABLE.flatMap(([faultClass, errnos]) => errnos.map((code) => ({ code, faultClass })));

describe('the errno table', () => {
  // Shaped as a file call's error (a path it acted on): a network errno is the filesystem's only then.
  it.each(CASES)('$code from a file call is $faultClass, directly and through a 2-deep cause chain', ({ code, faultClass }) => {
    expect(fsFaultOf(errno(code, { syscall: 'open', path: '/p' }))?.faultClass).toBe(faultClass);
    const wrapped = new Error('outer', { cause: new Error('middle', { cause: errno(code, { path: '/p' }) }) });
    expect(fsFaultOf(wrapped)).toMatchObject({ errno: code, faultClass, path: '/p' });
  });

  // The classifier's lookup is built from the exported table once: a list a consumer could push to
  // would then name an errno the classifier does not know.
  it('exports the table it classifies by, and nobody can change it', () => {
    expect(Object.entries(FS_FAULT_ERRNOS_BY_CLASS)).toEqual(TABLE);
    expect(Object.isFrozen(FS_FAULT_ERRNOS_BY_CLASS)).toBe(true);
    expect(Object.values(FS_FAULT_ERRNOS_BY_CLASS).every((errnos) => Object.isFrozen(errnos))).toBe(true);
  });

  it('gives no errno two classes', () => {
    const all = TABLE.flatMap(([, errnos]) => errnos);
    expect(new Set(all).size).toBe(all.length);
  });

  it('classifies every errno the fault injector can raise', () => {
    for (const code of INJECTED_ERRNOS) expect(fsFaultOf(injectedErrnoError(code, 'stat', '/p')), code).toBeDefined();
  });

  it('keeps EROFS out of refused: no permission would change it', () => {
    expect(fsFaultOf(errno('EROFS'))?.faultClass).toBe('unsupported');
  });

  it('does not classify a non-filesystem error', () => {
    expect(fsFaultOf(new TypeError('x'))).toBeUndefined();
    expect(fsFaultOf(errno('ESRCH'))).toBeUndefined();
    expect(fsFaultOf('EACCES')).toBeUndefined();
    expect(fsFaultOf(undefined)).toBeUndefined();
  });

  it('reads path, dest and syscall off the error that carried the errno', () => {
    expect(fsFaultOf(errno('EXDEV', { path: '/a', dest: '/b', syscall: 'rename' }))).toEqual({
      errno: 'EXDEV', faultClass: 'unsupported', path: '/a', dest: '/b', syscall: 'rename',
    });
  });

  // Read once, here: what a fault displays, how it is sided and which parent walk it stops are all
  // judged on the same path — never `\\?\C:\…` in one and `C:\…` in another.
  it('reads path and dest without the win32 namespace prefix Node may report them with, so every consumer sees one path', () => {
    const B = String.fromCodePoint(0x5c);
    const namespace = `${B}${B}?${B}`;
    const facts = fsFaultOf(errno('EPERM', { path: `${namespace}C:${B}staged`, dest: `${namespace}UNC${B}host${B}share${B}x.md`, syscall: 'rename' }));

    expect(facts).toMatchObject({ path: `C:${B}staged`, dest: `${B}${B}host${B}share${B}x.md` });
    expect(facts === undefined ? [] : pathsActedOn(facts)).toEqual([`${B}${B}host${B}share${B}x.md`, `C:${B}staged`]);
  });

  it('bounds a cyclic cause chain', () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(fsFaultOf(loop)).toBeUndefined();
    expect(isPathAbsentError(loop)).toBe(false);
  });
});

describe('the single-errno questions', () => {
  it.each([
    ['isPathAbsentError', isPathAbsentError, ['ENOENT', 'ENOTDIR'], ['EACCES', 'ELOOP']],
    ['isAlreadyExistsError', isAlreadyExistsError, ['EEXIST'], ['ENOTEMPTY']],
    ['isNoSuchEntryError', isNoSuchEntryError, ['ENOENT'], ['ENOTDIR', 'EACCES']],
    ['isNameTooLongError', isNameTooLongError, ['ENAMETOOLONG'], ['ELOOP', 'EISDIR']],
    ['isInvalidArgumentError', isInvalidArgumentError, ['EINVAL'], ['ENOTSUP']],
    ['isNotARegularFileError', isNotARegularFileError, ['EFTYPE'], ['EISDIR']],
    ['isWouldBlockError', isWouldBlockError, ['EAGAIN'], ['EBUSY']],
    ['isProcessGoneError', isProcessGoneError, ['ESRCH', 'EPERM'], ['ENOENT']],
    ['isSymlinkUnsupportedError', isSymlinkUnsupportedError, ['EPERM', 'ENOTSUP', 'EOPNOTSUPP'], ['EACCES']],
    ['isRetryableShortageError', isRetryableShortageError, ['EBUSY', 'ETXTBSY', 'EAGAIN', 'EMFILE', 'ENFILE'], ['ENOSPC', 'EDQUOT', 'EACCES', 'ESTALE']],
    ['isRenameContentionError', isRenameContentionError, ['EPERM', 'EBUSY', 'EACCES'], ['ENOENT', 'EXDEV', 'ENOSPC']],
    ['isAccessRefusedError', isAccessRefusedError, ['EACCES', 'EPERM'], ['EBUSY', 'EROFS', 'ENOENT']],
    ['isOccupiedError', isOccupiedError, ['EEXIST', 'ENOTEMPTY'], ['EACCES', 'ENOENT', 'EBUSY']],
    // A native realpath on a volume that cannot answer a final-path query (Windows' ERROR_INVALID_FUNCTION is EISDIR).
    ['isFinalPathUnanswerableError', isFinalPathUnanswerableError, ['EISDIR', 'ENOTSUP', 'EOPNOTSUPP'], ['EACCES', 'ENOENT', 'UNKNOWN']],
    // The OS looked and found nothing to resolve to; declined, exhausted, busy and the device class
    // are faults — and so are the AMBIGUOUS answers: libuv `src/win/error.c` reports four Win32
    // errors as EINVAL (:102-105), ERROR_BUFFER_OVERFLOW as ENAMETOOLONG (:129), and a missing share
    // AND refused credentials alike as UNKNOWN (:172), so none can mean "nothing there".
    [
      'isUnresolvableLinkError',
      isUnresolvableLinkError,
      ['ENOENT', 'ENOTDIR', 'ELOOP'],
      ['EINVAL', 'ENAMETOOLONG', 'UNKNOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ENOTCONN', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EBUSY', 'ETXTBSY', 'EAGAIN', 'EIO', 'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN', 'EISDIR', 'EEXIST', 'ENOTSUP', 'EXDEV', 'EROFS'],
    ],
  ] as const)('%s', (_name, predicate, yes, no) => {
    for (const code of yes) expect(predicate(errno(code)), code).toBe(true);
    for (const code of no) expect(predicate(errno(code)), code).toBe(false);
    expect(predicate(new TypeError('x'))).toBe(false);
    expect(predicate(new Error('outer', { cause: errno(yes[0]) }))).toBe(true);
  });
});

describe('assertUnresolvableLink', () => {
  const ctx = { side: 'source', origin: 'content', action: 'resolve /r/link', path: '/r/link' } as const;

  it('returns for a link that resolves to nothing, and throws every other filesystem errno classified on ctx', () => {
    for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP']) expect(() => { assertUnresolvableLink(errno(code), ctx); }, code).not.toThrow();
    for (const code of ['EACCES', 'EPERM', 'EIO', 'UNKNOWN', 'EINVAL', 'ENAMETOOLONG', 'ENETUNREACH']) {
      expect(() => { assertUnresolvableLink(errno(code, { syscall: 'realpath', path: '/r/link' }), ctx); }, code).toThrow(expect.objectContaining({ code: FS_FAULT_CODE, errno: code, side: 'source', origin: 'content', path: '/r/link' }));
    }
  });

  it('throws a non-filesystem error as it was', () => {
    const bug = new TypeError('x');
    expect(() => { assertUnresolvableLink(bug, ctx); }).toThrow(bug);
  });

  // The table is not the guarantee: an errno it does not list, from a system call, is still a fault.
  it('throws an errno no table lists classified, never raw', () => {
    expect(() => { assertUnresolvableLink(errno('EWHATEVER', { syscall: 'stat', path: '/r/link' }), ctx); }).toThrow(expect.objectContaining({ code: FS_FAULT_CODE, errno: 'EWHATEVER', faultClass: 'device' }));
  });
});

// The read lane's twin: the same predicate, a fault handed back for that one target, nothing thrown.
describe('linkResolutionFault', () => {
  it('answers undefined for a link that resolves to nothing, and the facts of every other filesystem errno', () => {
    for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP']) expect(linkResolutionFault(errno(code)), code).toBeUndefined();
    expect(linkResolutionFault(errno('EINVAL'))).toMatchObject({ errno: 'EINVAL', faultClass: 'unsupported' });
    expect(linkResolutionFault(errno('ENAMETOOLONG'))).toMatchObject({ errno: 'ENAMETOOLONG', faultClass: 'wrong-type' });
    expect(linkResolutionFault(errno('EWHATEVER', { syscall: 'realpath', path: '/r/link' }))).toMatchObject({ errno: 'EWHATEVER', faultClass: 'device' });
    expect(linkResolutionFault(errno('UNKNOWN'))).toMatchObject({ errno: 'UNKNOWN', faultClass: 'device' });
    expect(linkResolutionFault(errno('EACCES'))).toMatchObject({ errno: 'EACCES', faultClass: 'refused' });
    expect(linkResolutionFault(errno('EPERM'))).toMatchObject({ errno: 'EPERM', faultClass: 'refused' });
    expect(linkResolutionFault(errno('EIO'))).toMatchObject({ errno: 'EIO', faultClass: 'device' });
  });

  it('throws a non-filesystem error, and a VAT error, as it was', () => {
    const bug = new TypeError('x');
    expect(() => linkResolutionFault(bug)).toThrow(bug);
    const refusal = new FsFaultError({ side: 'source', faultClass: 'refused', errno: 'EACCES', path: '/r', movedFrom: undefined, origin: 'content', action: 'read /r', cause: errno('EACCES') });
    expect(() => linkResolutionFault(refusal)).toThrow(refusal);
  });
});

describe('classifyFsFault', () => {
  it('builds an FsFaultError with the facts and a remedy-free message', () => {
    const raw = errno('ENOSPC', { path: '/tmp/stage/a' });
    const out = classifyFsFault(raw, { side: 'environment', action: 'stage the plugin' });
    expect(isFsFaultError(out)).toBe(true);
    expect(out).toBeInstanceOf(FsFaultError);
    expect(out).toMatchObject({
      code: FS_FAULT_CODE, side: 'environment', faultClass: 'exhausted', errno: 'ENOSPC',
      path: '/tmp/stage/a', origin: 'argument', action: 'stage the plugin', cause: raw,
      message: 'Could not stage the plugin (ENOSPC): /tmp/stage/a',
    });
  });

  it('names dest when the error has no path, then the context path', () => {
    expect(classifyFsFault(errno('EXDEV', { dest: '/d' }), { side: 'destination', action: 'x', path: '/c' })).toMatchObject({ path: '/d' });
    expect(classifyFsFault(errno('EIO'), { side: 'source', action: 'x', path: '/c' })).toMatchObject({ path: '/c' });
  });

  it('passes a TypeError through untouched', () => {
    const bug = new TypeError('x is not a function');
    expect(classifyFsFault(bug, { side: 'source', action: 'read' })).toBe(bug);
  });

  it('passes an existing VatError through untouched, even one that carries an errno cause', () => {
    const coded = new VatError('SOMETHING', 'already said', { cause: errno('EACCES') });
    expect(classifyFsFault(coded, { side: 'source', action: 'read' })).toBe(coded);
  });

  it('shapeFromSource moves only the layout classes to source; every other class keeps the side', () => {
    const ctx = { side: 'environment', action: 'extract', shapeFromSource: true } as const;
    expect(classifyFsFault(errno('EEXIST'), ctx)).toMatchObject({ side: 'source', origin: 'content', faultClass: 'occupied' });
    expect(classifyFsFault(errno('EISDIR'), ctx)).toMatchObject({ side: 'source', origin: 'content', faultClass: 'wrong-type' });
    // A refused or vanished write target says nothing about the layout an input decided.
    expect(classifyFsFault(errno('EACCES'), ctx)).toMatchObject({ side: 'environment', faultClass: 'refused' });
    expect(classifyFsFault(errno('ENOENT'), ctx)).toMatchObject({ side: 'environment', faultClass: 'absent' });
    // ENOTDIR on a write is a file in the way of a directory the layout needs, at any depth: keyed on the errno.
    expect(classifyFsFault(errno('ENOTDIR'), ctx)).toMatchObject({ side: 'source', origin: 'content', faultClass: 'absent', errno: 'ENOTDIR' });
    expect(classifyFsFault(errno('ENOSPC'), ctx)).toMatchObject({ side: 'environment', faultClass: 'exhausted' });
    expect(classifyFsFault(errno('EBUSY'), ctx)).toMatchObject({ side: 'environment' });
  });

  it('origin is content for any source fault of a shapeFromSource write, promoted or not', () => {
    const asSource = { side: 'source', action: 'extract', shapeFromSource: true } as const;
    expect(classifyFsFault(errno('EACCES'), asSource)).toMatchObject({ side: 'source', origin: 'content' });
    expect(classifyFsFault(errno('EACCES'), { ...asSource, origin: 'config' })).toMatchObject({ origin: 'config' });
    expect(classifyFsFault(errno('EACCES'), { side: 'source', action: 'read' })).toMatchObject({ origin: 'argument' });
  });

  it('does not promote without the option', () => {
    expect(classifyFsFault(errno('EEXIST'), { side: 'environment', action: 'x' })).toMatchObject({ side: 'environment' });
  });

  it('isFsFaultError rejects a foreign error that merely carries a code', () => {
    expect(isFsFaultError(errno('FS_FAULT'))).toBe(false);
    expect(isFsFaultError(new VatError(FS_FAULT_CODE, 'no fields'))).toBe(false);
  });
});

describe('withFsFault / withFsFaultSync', () => {
  it('classifies a rejection and a throw, and returns a value untouched', async () => {
    await expect(withFsFault({ side: 'source', action: 'read' }, () => Promise.reject(errno('EACCES')))).rejects.toMatchObject({ code: FS_FAULT_CODE });
    expect(() => withFsFaultSync({ side: 'source', action: 'read' }, () => { throw errno('EIO'); })).toThrow(FsFaultError);
    await expect(withFsFault({ side: 'source', action: 'read' }, () => Promise.resolve(7))).resolves.toBe(7);
    expect(withFsFaultSync({ side: 'source', action: 'read' }, () => 8)).toBe(8);
  });

  it('rethrows a non-fs error as it was', () => {
    const bug = new RangeError('x');
    expect(() => withFsFaultSync({ side: 'source', action: 'read' }, () => { throw bug; })).toThrow(bug);
  });
});

describe('isLayoutFault', () => {
  it('is a layout class, or ENOTDIR (a file in the way), and nothing else', () => {
    expect(isLayoutFault({ faultClass: 'wrong-type', errno: 'EISDIR' })).toBe(true);
    expect(isLayoutFault({ faultClass: 'occupied', errno: 'EEXIST' })).toBe(true);
    expect(isLayoutFault({ faultClass: 'absent', errno: 'ENOTDIR' })).toBe(true);
    expect(isLayoutFault({ faultClass: 'absent', errno: 'ENOENT' })).toBe(false);
    expect(isLayoutFault({ faultClass: 'refused', errno: 'EACCES' })).toBe(false);
    expect(isLayoutFault({ faultClass: 'exhausted', errno: 'ENOSPC' })).toBe(false);
  });

  it('isCapacityFault is the machine and the filesystem giving out, never the input or the output', () => {
    for (const faultClass of ['exhausted', 'busy', 'unsupported', 'device'] as const) expect(isCapacityFault({ faultClass })).toBe(true);
    for (const faultClass of ['absent', 'refused', 'wrong-type', 'occupied'] as const) expect(isCapacityFault({ faultClass })).toBe(false);
  });

  it('isTimedOutError is ETIMEDOUT alone', () => {
    expect(isTimedOutError(errno('ETIMEDOUT'))).toBe(true);
    expect(isTimedOutError(errno('EAGAIN'))).toBe(false);
  });

  it('isFileInTheWayError is ENOTDIR alone', () => {
    expect(isFileInTheWayError(errno('ENOTDIR'))).toBe(true);
    expect(isFileInTheWayError(errno('ENOENT'))).toBe(false);
  });
});

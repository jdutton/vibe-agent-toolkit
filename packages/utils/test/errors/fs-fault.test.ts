/**
 * The errno classifier: every errno has exactly one class, the side is decided by
 * the path the OS named (not by the wrapper that caught it), and anything that is
 * not a filesystem errno passes through untouched.
 */

import { describe, expect, it } from 'vitest';

import {
  fsFaultOf,
  isAccessRefusedError,
  isAlreadyExistsError,
  isFileInTheWayError,
  isInvalidArgumentError,
  isLinkLoopError,
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
  isWouldBlockError,
  type FsFaultClass,
} from '../../src/errors/errno-table.js';
import {
  classifyFsFault,
  FS_FAULT_CODE,
  FsFaultError,
  isCapacityFault,
  isFsFaultError,
  isLayoutFault,
  withFsFault,
  withFsFaultSync,
} from '../../src/errors/fs-fault.js';
import { VatError } from '../../src/errors/vat-error.js';
import { INJECTED_ERRNOS } from '../../src/testing/fault-spec.js';

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
  ['device', ['EIO', 'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN', 'UNKNOWN']],
];
const CASES = TABLE.flatMap(([faultClass, errnos]) => errnos.map((code) => ({ code, faultClass })));

describe('the errno table', () => {
  it.each(CASES)('$code is $faultClass, directly and through a 2-deep cause chain', ({ code, faultClass }) => {
    expect(fsFaultOf(errno(code))?.faultClass).toBe(faultClass);
    const wrapped = new Error('outer', { cause: new Error('middle', { cause: errno(code, { path: '/p' }) }) });
    expect(fsFaultOf(wrapped)).toMatchObject({ errno: code, faultClass, path: '/p' });
  });

  it('gives no errno two classes', () => {
    const all = TABLE.flatMap(([, errnos]) => errnos);
    expect(new Set(all).size).toBe(all.length);
  });

  it('classifies every errno the fault injector can raise', () => {
    for (const code of INJECTED_ERRNOS) expect(fsFaultOf(errno(code)), code).toBeDefined();
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
    ['isLinkLoopError', isLinkLoopError, ['ELOOP'], ['ENOENT']],
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
  ] as const)('%s', (_name, predicate, yes, no) => {
    for (const code of yes) expect(predicate(errno(code)), code).toBe(true);
    for (const code of no) expect(predicate(errno(code)), code).toBe(false);
    expect(predicate(new TypeError('x'))).toBe(false);
    expect(predicate(new Error('outer', { cause: errno(yes[0]) }))).toBe(true);
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

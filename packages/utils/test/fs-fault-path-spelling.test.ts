/**
 * A classified fault's `path` is spelled with forward slashes, as every path VAT displays or
 * compares — whichever spelling the errno carried. On Windows Node reports an errno's `path` in the
 * backslash form whatever the caller passed, so a fault built from the errno carried the host's
 * spelling while one built from its context carried VAT's.
 *
 * `node:path`'s separator is replaced here so the win32 conversion runs on every host: `path-core`
 * reads it once, when it is first loaded, which is why the module under test is imported after.
 */
import type nodePath from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (importOriginal) => {
  const real = await importOriginal<typeof nodePath>();
  const win32Separated = { ...real, sep: '\\' };
  return { ...win32Separated, default: win32Separated };
});

const { classifyFsFault, FsFaultError } = await import('../src/errors/fs-fault.js');

const NATIVE = String.raw`C:\Users\dev\project\vibe-agent-toolkit.config.yaml`;
const FORWARD = 'C:/Users/dev/project/vibe-agent-toolkit.config.yaml';

describe('FsFaultError.path where the separator is a backslash', () => {
  it('a fault built from an errno that names the path natively carries the forward-slash spelling, in `path` and in the message', () => {
    const errno = Object.assign(new Error(`ENOENT: no such file or directory, stat '${NATIVE}'`), { code: 'ENOENT', path: NATIVE });

    const fault = classifyFsFault(errno, { side: 'destination', origin: 'config', action: 'find the project config', path: FORWARD });

    expect(fault).toMatchObject({ code: 'FS_FAULT', faultClass: 'absent', path: FORWARD });
    expect((fault as Error).message).toBe(`Could not find the project config (ENOENT): ${FORWARD}`);
  });

  it('a fault constructed directly is spelled the same way, and one with no path has none', () => {
    const facts = { side: 'source', faultClass: 'occupied', errno: 'EEXIST', origin: 'content', action: 'write the marker', cause: undefined } as const;

    expect(new FsFaultError({ ...facts, path: NATIVE }).path).toBe(FORWARD);
    expect(new FsFaultError({ ...facts, path: FORWARD }).path).toBe(FORWARD);
    expect(new FsFaultError({ ...facts, path: undefined })).toMatchObject({ path: undefined, message: 'Could not write the marker (EEXIST)' });
  });
});

// Node namespaces the paths it hands a win32 syscall and reports them back so: `\\?\C:\…` and
// `\\?\UNC\host\share\…`. A fault names the path the caller's own paths spell, never `//?/C:/…`.
describe('FsFaultError.path when the errno carries a win32 namespace prefix', () => {
  const BACKSLASH = String.fromCodePoint(0x5c);
  const NAMESPACE = `${BACKSLASH.repeat(2)}?${BACKSLASH}`;
  const context = { side: 'destination', origin: 'content', action: 'move the entry' } as const;

  it('strips it from the path and from where a rename moved the entry from', () => {
    const errno = Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'rename', path: String.raw`${NAMESPACE}C:\Users\dev\staged`, dest: `${NAMESPACE}${NATIVE}` });

    const fault = classifyFsFault(errno, context) as InstanceType<typeof FsFaultError>;

    expect(fault.path).toBe(FORWARD);
    expect(fault.movedFrom).toBe('C:/Users/dev/staged');
    expect(fault.message).toBe(`Could not move the entry (EPERM): C:/Users/dev/staged -> ${FORWARD}`);
  });

  it('reads a namespaced UNC path as the UNC path it is', () => {
    const errno = Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'open', path: `${NAMESPACE}UNC${BACKSLASH}host${BACKSLASH}share${BACKSLASH}x.md` });

    expect(classifyFsFault(errno, context)).toMatchObject({ path: '//host/share/x.md' });
  });

  it('strips it from an errno a classified fault is built from', () => {
    const errno = Object.assign(new Error('EACCES'), { code: 'EACCES', syscall: 'symlink', path: String.raw`..\x`, dest: `${NAMESPACE}${NATIVE}` });

    expect(classifyFsFault(errno, { side: 'destination', origin: 'content', action: 'make the link' })).toMatchObject({ path: FORWARD });
  });
});


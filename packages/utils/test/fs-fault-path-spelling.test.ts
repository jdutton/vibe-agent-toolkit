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

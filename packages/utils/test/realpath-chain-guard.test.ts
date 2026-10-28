/**
 * Every `realpath` VAT asks the kernel is behind the one link-chain resolver: the chain to the path
 * is read hop by hop (`lstat` + `readlink`) and a network hop is refused BEFORE the kernel is asked
 * — on Windows the kernel's resolution of `\\host\share` is itself the leak (an SMB session that
 * offers the operator's NTLM credentials). The host flavor is bound to `win32` here so the guard
 * runs Windows semantics on every host, over a real tree whose link's text is a UNC path (on POSIX
 * a legal file name, which no POSIX kernel would ever send anywhere). A spy on the native and JS
 * realpath records every path the kernel was asked about.
 */
import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINK_CHAIN_REFUSED_CODE } from '../src/errors/errno-table.js';
import { linkResolutionFault } from '../src/errors/fs-fault.js';
import { FsLookupCache } from '../src/fs-utils.js';
import { canonicalPath } from '../src/path-containment.js';
import { normalizePath, realpathNative, realpathNativeSync, safePath, toForwardSlash } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { installFaultFs } from '../src/testing/fault-fs.js';
import { setupSyncTempDirSuite } from '../src/testing/temp-dir.js';
import { assertLocalChain } from '../src/tree-change/host-chain.js';

vi.mock('../src/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const UNC = String.raw`\\attacker\share`;

/** Every path a realpath (native or JS, sync or async) was asked about, while the spies are on. */
function spyOnTheKernel(): { asked: string[]; restore: () => void } {
  const asked: string[] = [];
  const record = (path: fs.PathLike): void => {
    asked.push(toForwardSlash(String(path)));
  };
  const spies = [
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((path: fs.PathLike) => (record(path), path)) as typeof fs.realpathSync.native),
    vi.spyOn(fs.realpath, 'native').mockImplementation(((path: fs.PathLike, callback: (error: null, real: string) => void) => {
      record(path);
      callback(null, String(path));
    }) as unknown as typeof fs.realpath.native),
    vi.spyOn(fs, 'realpath').mockImplementation(((path: fs.PathLike, callback: (error: null, real: string) => void) => {
      record(path);
      callback(null, String(path));
    }) as unknown as typeof fs.realpath),
  ];
  return { asked, restore: () => { for (const spy of spies) spy.mockRestore() } };
}

/** Under `root`: `smb -> \\attacker\share`, `a -> b -> smb`, `ok -> docs`; then the kernel spied on. */
function planted(root: string, skip: () => never): ReturnType<typeof spyOnTheKernel> {
  const cap = symlinkCapability() ?? skip();
  fs.mkdirSync(safePath.join(root, 'docs'));
  createSymlink(cap, UNC, safePath.join(root, 'smb'), 'dir');
  createSymlink(cap, 'smb', safePath.join(root, 'b'), 'dir');
  createSymlink(cap, 'b', safePath.join(root, 'a'), 'dir');
  createSymlink(cap, 'docs', safePath.join(root, 'ok'), 'dir');
  return spyOnTheKernel();
}

describe('the realpath primitives ask the kernel only about a chain read and shown local (win32 semantics)', () => {
  const suite = setupSyncTempDirSuite('realpath-chain-guard');
  let root: string;
  let kernel: ReturnType<typeof spyOnTheKernel> | undefined;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = toForwardSlash(fs.realpathSync(suite.getTempDir()));
  });
  afterEach(() => {
    kernel?.restore();
    kernel = undefined;
  });

  const refused = { code: LINK_CHAIN_REFUSED_CODE, refusal: expect.objectContaining({ why: 'network', text: UNC }) };

  it.for(['smb', 'a', 'a/inner.md'])('refuses %s in every sync primitive before the kernel is asked', (start, { skip }) => {
    kernel = planted(root, skip);
    const path = safePath.join(root, start);

    expect(() => realpathNativeSync(path)).toThrow(expect.objectContaining(refused));
    expect(() => normalizePath(path)).toThrow(expect.objectContaining(refused));
    expect(() => canonicalPath(path)).toThrow(expect.objectContaining(refused));
    expect(kernel?.asked.filter((asked) => asked.startsWith(path))).toEqual([]);
  });

  it('refuses in the async primitive before the kernel is asked', async ({ skip }) => {
    kernel = planted(root, skip);

    await expect(realpathNative(safePath.join(root, 'a'))).rejects.toMatchObject(refused);
    expect(kernel?.asked).toEqual([]);
  });

  // The read lanes' realpath table: one target VAT declined to resolve is that target's fault row.
  it('records the refusal as the one target\'s fault in the realpath table, never resolving it', async ({ skip }) => {
    kernel = planted(root, skip);
    const target = safePath.join(root, 'a');

    const row = await new FsLookupCache().realpath(target);

    expect(row.fault).toMatchObject({ errno: LINK_CHAIN_REFUSED_CODE, faultClass: 'refused' });
    expect(kernel?.asked.filter((asked) => asked.startsWith(target))).toEqual([]);
  });

  it('hands a read lane the refusal as a fault, carrying class and reason, never a throw', ({ skip }) => {
    kernel = planted(root, skip);
    let error: unknown;
    try {
      realpathNativeSync(safePath.join(root, 'smb'));
    } catch (caught) {
      error = caught;
    }

    expect(linkResolutionFault(error)).toMatchObject({ errno: LINK_CHAIN_REFUSED_CODE, faultClass: 'refused', syscall: 'readlink' });
  });

  it('asks the kernel about a local chain (positive control)', ({ skip }) => {
    kernel = planted(root, skip);
    const path = safePath.join(root, 'ok');

    expect(realpathNativeSync(path)).toBe(path);
    expect(kernel?.asked).toEqual([path]);
  });

  it('guards only a Windows kernel: under posix the chain is not walked at all', ({ skip }) => {
    kernel = planted(root, skip);
    kernel.restore();
    const session = installFaultFs({ within: root });
    try {
      expect(() => assertLocalChain(safePath.join(root, 'a'), 'posix')).not.toThrow();
      expect(session.calls.filter((call) => call.op === 'lstat' || call.op === 'readlink')).toEqual([]);
    } finally {
      session.restore();
    }
  });

  it('leaves the answer to the kernel when it may not look at a place on the way', ({ skip }) => {
    kernel = planted(root, skip);
    kernel.restore();
    const session = installFaultFs({ within: root, faults: [{ op: 'lstat', path: (path) => path.endsWith('/a'), errno: 'EACCES' }] });
    try {
      expect(() => assertLocalChain(safePath.join(root, 'a'), 'win32')).not.toThrow();
      expect(session.fired.length).toBeGreaterThan(0);
    } finally {
      session.restore();
    }
  });
});

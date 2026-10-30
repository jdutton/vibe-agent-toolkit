/**
 * Every link-FOLLOWING call VAT asks the kernel (`realpath`, `stat`) is behind the one link-chain
 * resolver: the chain to the path is read hop by hop (`lstat` + `readlink`) and a network hop is
 * refused BEFORE the kernel is asked — on Windows the kernel's resolution of `\\host\share` is itself
 * the leak (an SMB session that offers the operator's NTLM credentials). The host flavor is bound to
 * `win32` here so the guard runs Windows semantics on every host, over a real tree whose link's text
 * is a UNC path (on POSIX a legal file name, which no POSIX kernel would ever send anywhere). Spies on
 * the native and JS realpath, and on `stat`, record every path the kernel was asked about.
 */
import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINK_CHAIN_REFUSED_CODE } from '../src/errors/errno-table.js';
import { linkResolutionFault } from '../src/errors/fs-fault.js';
import { FsLookupCache } from '../src/fs-utils.js';
import { assertLocalChain, followedKindSync, followedStatSync, realpathNative, realpathNativeSync } from '../src/link-following.js';
import { canonicalPath } from '../src/path-containment.js';
import { normalizePath, safePath, toForwardSlash } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { installFaultFs } from '../src/testing/fault-fs.js';
import { setupSyncTempDirSuite } from '../src/testing/temp-dir.js';

vi.mock('../src/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const UNC = String.raw`\\attacker\share`;

/** Every path a realpath (native or JS, sync or async) or a `stat` was asked about, while the spies are on. */
function spyOnTheKernel(): { asked: string[]; restore: () => void } {
  const asked: string[] = [];
  const record = (path: fs.PathLike): void => {
    asked.push(toForwardSlash(String(path)));
  };
  const realStatSync = fs.statSync;
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
    vi.spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      record(path);
      return (realStatSync as (path: fs.PathLike, ...rest: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.statSync),
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

describe('the link-following primitives ask the kernel only about a chain read and shown local (win32 semantics)', () => {
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

  // A Windows kernel hands a UNC link's text back with a trailing separator (`\\attacker\share\`).
  const refused = { code: LINK_CHAIN_REFUSED_CODE, refusal: expect.objectContaining({ why: 'network', text: expect.stringMatching(/^\\\\attacker\\share\\?$/) }) };

  it.for(['smb', 'a', 'a/inner.md'])('refuses %s in every sync primitive before the kernel is asked', (start, { skip }) => {
    kernel = planted(root, skip);
    const path = safePath.join(root, start);

    expect(() => realpathNativeSync(path, root)).toThrow(expect.objectContaining(refused));
    expect(() => normalizePath(path, root)).toThrow(expect.objectContaining(refused));
    expect(() => canonicalPath(path, root)).toThrow(expect.objectContaining(refused));
    expect(() => followedStatSync(path, root)).toThrow(expect.objectContaining(refused));
    expect(() => followedKindSync(path, root)).toThrow(expect.objectContaining(refused));
    expect(kernel?.asked.filter((asked) => asked.startsWith(path))).toEqual([]);
  });

  it('refuses in the async primitive before the kernel is asked', async ({ skip }) => {
    kernel = planted(root, skip);

    await expect(realpathNative(safePath.join(root, 'a'), root)).rejects.toMatchObject(refused);
    expect(kernel?.asked.filter((asked) => asked !== root)).toEqual([]);
  });

  // The read lanes' realpath table: one target VAT declined to resolve is that target's fault row.
  it('records the refusal as the one target\'s fault in the realpath table, never resolving it', async ({ skip }) => {
    kernel = planted(root, skip);
    const target = safePath.join(root, 'a');

    const row = await new FsLookupCache(root).realpath(target);

    expect(row.fault).toMatchObject({ errno: LINK_CHAIN_REFUSED_CODE, faultClass: 'refused' });
    expect(kernel?.asked.filter((asked) => asked.startsWith(target))).toEqual([]);
  });

  it('records the refusal as the one target\'s probe in the lookup cache, never stat-ing it', ({ skip }) => {
    kernel = planted(root, skip);
    const target = safePath.join(root, 'a');

    // A refused chain has no answer: present, its kind unknown — never "absent", never followed.
    expect(new FsLookupCache(root).probe(target)).toEqual({ exists: true, isDirectory: null });
    expect(kernel?.asked.filter((asked) => asked.startsWith(target))).toEqual([]);
  });

  it('hands a read lane the refusal as a fault, carrying class and reason, never a throw', ({ skip }) => {
    kernel = planted(root, skip);
    let error: unknown;
    try {
      realpathNativeSync(safePath.join(root, 'smb'), root);
    } catch (caught) {
      error = caught;
    }

    expect(linkResolutionFault(error)).toMatchObject({ errno: LINK_CHAIN_REFUSED_CODE, faultClass: 'refused' });
  });

  it('asks the kernel about a local chain (positive control)', ({ skip }) => {
    kernel = planted(root, skip);
    const path = safePath.join(root, 'ok');

    expect(realpathNativeSync(path, root)).toBe(path);
    expect(followedKindSync(path, root)).toBe('directory');
    expect(kernel?.asked).toContain(path);
  });

  // An `lstat` follows every component but the last: through `a` it reaches `\\attacker\share`.
  it('canonicalPath never asks the kernel about a path through a link the walk has not read', ({ skip }) => {
    kernel = planted(root, skip);
    kernel.restore();
    const session = installFaultFs({ within: root });
    try {
      expect(() => canonicalPath(safePath.join(root, 'a', 'inner.md'), root)).toThrow(expect.objectContaining(refused));
      const through = session.calls.filter((call) => /\/(?:a|b|smb)\//.test(toForwardSlash(call.path))).map((call) => `${call.op} ${call.path}`);
      expect(through).toEqual([]);
    } finally {
      session.restore();
    }
  });

  it('answers the operator\'s own path (passed as its own tree) by the kernel, with no walk', ({ skip }) => {
    kernel = planted(root, skip);
    kernel.restore();
    const session = installFaultFs({ within: root });
    try {
      const own = safePath.join(root, 'ok');
      expect(assertLocalChain(own, own, 'win32')).toBe('local');
      expect(session.calls.filter((call) => call.op === 'lstat' || call.op === 'readlink')).toEqual([]);
    } finally {
      session.restore();
    }
  });

  // A Windows host's temp root carries a drive, which no POSIX walk can be rooted at: POSIX hosts only.
  it.skipIf(process.platform === 'win32')('guards every host: under posix the chain is walked too', ({ skip }) => {
    kernel = planted(root, skip);
    kernel.restore();
    const session = installFaultFs({ within: root });
    try {
      // POSIX reads `\\attacker\share` as one relative name — a dangle, read hop by hop.
      expect(assertLocalChain(safePath.join(root, 'a'), root, 'posix')).toBe('nothing');
      expect(session.calls.filter((call) => call.op === 'readlink').map((call) => call.path)).toEqual(
        expect.arrayContaining([safePath.join(root, 'a'), safePath.join(root, 'b'), safePath.join(root, 'smb')]),
      );
    } finally {
      session.restore();
    }
  });

  it.for([
    ['assertLocalChain', (path: string, within: string) => assertLocalChain(path, within, 'win32')],
    ['followedStatSync', followedStatSync],
    ['realpathNativeSync', realpathNativeSync],
  ] as const)('%s throws a probe the OS refuses on the way, never leaving the answer to the kernel', ([, follow], { skip }) => {
    kernel = planted(root, skip);
    kernel.restore();
    const session = installFaultFs({ within: root, faults: [{ op: 'lstat', path: (path) => path.endsWith('/a'), errno: 'EACCES' }] });
    try {
      expect(() => follow(safePath.join(root, 'a'), root)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      expect(session.fired.length).toBeGreaterThan(0);
    } finally {
      session.restore();
    }
  });

  it('starts the walk at the tree\'s real path: the tree\'s own ancestors are never probed', ({ skip }) => {
    kernel = planted(root, skip);
    kernel.restore();
    const tree = safePath.join(root, 'docs');
    fs.writeFileSync(safePath.join(tree, 'x.md'), '');
    // Every ancestor of the tree (here: `root` itself) refuses an `lstat`: a walk that probed one would throw.
    const session = installFaultFs({ within: root, faults: [{ op: 'lstat', path: (path) => path === root, errno: 'EACCES' }] });
    try {
      expect(assertLocalChain(safePath.join(tree, 'x.md'), tree, 'win32')).toBe('local');
      expect(session.calls.filter((call) => call.op === 'lstat').map((call) => call.path)).toEqual([safePath.join(tree, 'x.md')]);
      expect(session.fired).toEqual([]);
    } finally {
      session.restore();
    }
  });
});

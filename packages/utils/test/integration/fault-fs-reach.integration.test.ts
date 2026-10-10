import * as nodeFs from 'node:fs';
import { realpathSync as namedRealpathSync, rmSync as namedRmSync, writeFileSync as namedWriteFileSync } from 'node:fs';
import { writeFile as namedWriteFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { relativeEscapesRoot, safePath } from '../../src/path-core.js';
import { installFaultFs, type FaultFsSession, type StatRewrite } from '../../src/testing/fault-fs.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';

const scratch = tempDirTracker('fault-fs-reach-');
let session: FaultFsSession | undefined;
afterEach(() => {
  session?.restore();
  session = undefined;
  scratch.cleanupAll();
});

const under = (root: string) => (p: string): boolean => !relativeEscapesRoot(safePath.relative(root, p));

const failWritesUnder = (root: string): FaultFsSession =>
  (session = installFaultFs({ within: root, faults: [{ family: 'write', path: under(root), errno: 'ENOSPC' }] }));

const enospc = expect.objectContaining({ code: 'ENOSPC' });

describe('installFaultFs reaches every way VAT and its dependencies call fs', () => {
  it('a named sync import', () => {
    const root = scratch.create();
    failWritesUnder(root);
    expect(() => namedWriteFileSync(safePath.join(root, 'a'), 'x')).toThrow(enospc);
    expect(session?.fired).toHaveLength(1);
  });

  it('a named fs/promises import', async () => {
    const root = scratch.create();
    failWritesUnder(root);
    await expect(namedWriteFile(safePath.join(root, 'a'), 'x')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(session?.fired).toHaveLength(1);
  });

  it('the callback API', async () => {
    const root = scratch.create();
    failWritesUnder(root);
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      nodeFs.writeFile(safePath.join(root, 'a'), 'x', resolve);
    });
    expect(error).toMatchObject({ code: 'ENOSPC' });
  });

  it('a FileHandle method, on a handle opened after the install', async () => {
    const root = scratch.create();
    session = installFaultFs({ within: root, faults: [{ family: 'write', op: 'write', path: under(root), errno: 'ENOSPC' }] });
    const handle = await nodeFs.promises.open(safePath.join(root, 'a'), 'w');
    try {
      await expect(handle.write('x')).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(session.fired.map((c) => [c.op, c.api])).toEqual([['write', 'handle']]);
    } finally {
      await handle.close();
    }
  });

  // `readFile` / `writeFile` / `appendFile` take a PATH on the module and act on the handle's fd as
  // methods: VAT's own text reader (`readDecodableBytes`) reads every decodable file this way.
  it('a FileHandle method whose module twin takes a path (readFile)', async () => {
    const root = scratch.create();
    nodeFs.writeFileSync(safePath.join(root, 'a'), 'x');
    session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'readFile', path: under(root), errno: 'EACCES' }] });
    const handle = await nodeFs.promises.open(safePath.join(root, 'a'), 'r');
    try {
      await expect(handle.readFile()).rejects.toMatchObject({ code: 'EACCES' });
      expect(session.fired.map((c) => [c.op, c.api])).toEqual([['readFile', 'handle']]);
    } finally {
      await handle.close();
    }
  });

  // Node defines `close` on each handle (a class field), not on FileHandle.prototype.
  it('a FileHandle close, which each handle carries as its own property', async () => {
    const root = scratch.create();
    nodeFs.writeFileSync(safePath.join(root, 'a'), 'x');
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'close', path: under(root), errno: 'EBUSY' }] });
    const handle = await nodeFs.promises.open(safePath.join(root, 'a'), 'r');
    await expect(handle.close()).rejects.toMatchObject({ code: 'EBUSY' });
    expect(session.fired.map((c) => [c.op, c.api])).toEqual([['close', 'handle']]);
    // close(2) releases the descriptor even when it reports an error: a handle the fault left
    // open would be closed by garbage collection, which Node raises as an uncaught error.
    expect(handle.fd).toBe(-1);
  });

  it('an injected closeSync fault still releases the descriptor, as close(2) does', () => {
    const root = scratch.create();
    nodeFs.writeFileSync(safePath.join(root, 'a'), 'x');
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'close', path: under(root), errno: 'EBUSY' }] });
    const traced = nodeFs.openSync(safePath.join(root, 'a'), 'r');
    expect(() => nodeFs.closeSync(traced)).toThrow(expect.objectContaining({ code: 'EBUSY' }));
    session.restore();
    expect(() => nodeFs.fstatSync(traced)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  it('a write stream', async () => {
    const root = scratch.create();
    failWritesUnder(root);
    await expect(pipeline(Readable.from(['x']), nodeFs.createWriteStream(safePath.join(root, 'a')))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(session?.fired.length).toBeGreaterThanOrEqual(1);
  });

  it('a CommonJS require of fs (the shape adm-zip uses)', () => {
    const root = scratch.create();
    failWritesUnder(root);
    const cjsFs = createRequire(import.meta.url)('fs') as typeof nodeFs;
    expect(() => cjsFs.writeFileSync(safePath.join(root, 'a'), 'x')).toThrow(enospc);
  });

  it('a path outside `within` is untouched (positive control for the predicate)', () => {
    const root = scratch.create();
    const other = scratch.create();
    failWritesUnder(root);
    namedWriteFileSync(safePath.join(other, 'a'), 'x');
    expect(session?.calls.some((c) => under(other)(c.path))).toBe(false);
    expect(session?.fired).toHaveLength(0);
  });

  it('restore() puts every binding back and stops tracing', () => {
    const root = scratch.create();
    failWritesUnder(root);
    const live = session as FaultFsSession;
    live.restore();
    session = undefined;
    const firedBefore = live.fired.length;
    const callsBefore = live.calls.length;
    namedWriteFileSync(safePath.join(root, 'a'), 'x');
    namedRmSync(safePath.join(root, 'a'));
    expect(nodeFs.existsSync(safePath.join(root, 'a'))).toBe(false);
    expect(live.fired).toHaveLength(firedBefore);
    expect(live.calls).toHaveLength(callsBefore);
  });

  // Node's own `fs.promises.rm` looks `fs.lstat` / `fs.rmdir` up ONCE, the first time it runs, and
  // keeps them: whichever session was active then owns those references forever after.
  it('a reference captured during an earlier session is traced and faulted by the session active now', () => {
    const root = scratch.create();
    session = installFaultFs({ within: root });
    const captured = nodeFs.writeFileSync;
    session.restore();
    failWritesUnder(root);
    expect(() => captured(safePath.join(root, 'a'), 'x')).toThrow(enospc);
    expect(session.fired.map((c) => c.op)).toEqual(['writeFile']);
  });

  // `.native` hangs off `realpathSync` / `realpath` as a property, and VAT's own `normalizePath`
  // calls it first: an unwrapped copy left the matrix blind to every product realpath fault.
  it('realpathSync.native, through a named import', () => {
    const root = scratch.create();
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'realpath', path: under(root), errno: 'EACCES' }] });
    expect(() => namedRealpathSync.native(root)).toThrow(expect.objectContaining({ code: 'EACCES', path: root }));
    expect(session.fired.map((c) => [c.op, c.api])).toEqual([['realpath', 'sync']]);
  });

  it('realpath.native, the callback API', async () => {
    const root = scratch.create();
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'realpath', path: under(root), errno: 'EACCES' }] });
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      nodeFs.realpath.native(root, (failure) => resolve(failure));
    });
    expect(error).toMatchObject({ code: 'EACCES' });
    expect(session.fired.map((c) => [c.op, c.api])).toEqual([['realpath', 'callback']]);
  });

  it('restore() puts realpathSync.native and realpath.native back', () => {
    const syncNative = nodeFs.realpathSync.native;
    const callbackNative = nodeFs.realpath.native;
    const root = scratch.create();
    session = installFaultFs({ within: root, faults: [{ family: 'meta', op: 'realpath', path: under(root), errno: 'EACCES' }] });
    expect(nodeFs.realpathSync.native).not.toBe(syncNative);
    session.restore();
    session = undefined;
    expect(nodeFs.realpathSync.native).toBe(syncNative);
    expect(nodeFs.realpath.native).toBe(callbackNative);
    expect(namedRealpathSync.native(root)).toBe(syncNative(root));
  });

  // Node's rm rejects on the FIRST child that fails while the siblings it started keep going. A
  // session restored at that rejection hands the rest of that work to the next session, on its own
  // tree when the root path is reused: the fault matrix saw an injection that never fired.
  it('settled() resolves only once the fs work started under the session has stopped', async () => {
    const root = scratch.create();
    for (const dir of ['a', 'b', 'c', 'd']) {
      nodeFs.mkdirSync(safePath.join(root, 'tree', dir, 'x', 'y'), { recursive: true });
      nodeFs.writeFileSync(safePath.join(root, 'tree', dir, 'x', 'y', 'f'), 'f');
    }
    const failing = safePath.join(root, 'tree', 'a');
    session = installFaultFs({ within: root, faults: [{ family: 'list', op: 'readdir', path: (p) => p === failing, errno: 'ENOTDIR' }] });
    await expect(nodeFs.promises.rm(safePath.join(root, 'tree'), { recursive: true })).rejects.toMatchObject({ code: 'ENOTDIR' });
    await session.settled();
    const atSettle = session.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.calls).toHaveLength(atSettle);
  });

  it('refuses a second install while one is active', () => {
    const root = scratch.create();
    failWritesUnder(root);
    expect(() => installFaultFs({ within: root })).toThrow(/already active/);
  });
});

/** A clone that keeps the Stats prototype (`isFile()` etc.) with `ino` replaced. */
const withIno = (ino: number | bigint): StatRewrite['rewrite'] => (stats) =>
  Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as typeof stats, stats, { ino });

describe('installFaultFs rewrites stat results and counts nth', () => {
  it('lstat reports ino 0n for a bigint stat and 0 for a number stat', () => {
    const root = scratch.create();
    const file = safePath.join(root, 'a');
    namedWriteFileSync(file, 'x');
    const real = nodeFs.lstatSync(file);
    expect(real.ino).not.toBe(0);
    session = installFaultFs({
      within: root,
      rewrites: [
        { op: 'lstat', path: (p) => p === file, rewrite: (s) => withIno(typeof s.ino === 'bigint' ? 0n : 0)(s) },
      ],
    });
    expect(nodeFs.lstatSync(file, { bigint: true }).ino).toBe(0n);
    expect(nodeFs.lstatSync(file).ino).toBe(0);
    expect(nodeFs.lstatSync(file).isFile()).toBe(true);
    expect(nodeFs.statSync(file).ino).toBe(real.ino);
  });

  it('nth: 2 fails the second matching call only', () => {
    const root = scratch.create();
    session = installFaultFs({ within: root, faults: [{ family: 'write', nth: 2, path: () => true, errno: 'EACCES' }] });
    namedWriteFileSync(safePath.join(root, 'a'), '1');
    expect(() => namedWriteFileSync(safePath.join(root, 'b'), '2')).toThrow(expect.objectContaining({ code: 'EACCES' }));
    namedWriteFileSync(safePath.join(root, 'c'), '3');
    expect(session.fired.map((c) => safePath.relative(root, c.path))).toEqual(['b']);
  });

  // A caller that retries (a rename under win32, on contention) turns ONE injected refusal into a
  // success. `everyTry` is how a test says "this call is refused", whoever retries it.
  describe('everyTry', () => {
    const refusedRename = expect.objectContaining({ code: 'EBUSY' });
    /** Files `a` and `c` (no `b`) in a fresh root, with one rule refusing a rename `EBUSY` installed. */
    const refusingRename = (rule: { nth?: number; everyTry?: boolean }): { a: string; b: string; c: string } => {
      const root = scratch.create();
      const paths = { a: safePath.join(root, 'a'), b: safePath.join(root, 'b'), c: safePath.join(root, 'c') };
      namedWriteFileSync(paths.a, '1');
      namedWriteFileSync(paths.c, '3');
      session = installFaultFs({ within: root, faults: [{ family: 'rename', path: () => true, errno: 'EBUSY', ...rule }] });
      return paths;
    };

    it('fails every immediate repeat of the call it failed, and counts them as the one match', () => {
      const { a, b, c } = refusingRename({ everyTry: true });

      for (let attempt = 0; attempt < 6; attempt++) expect(() => nodeFs.renameSync(a, b)).toThrow(refusedRename);
      // A different call ends the run: the rule has fired, and fails nothing else.
      nodeFs.renameSync(c, b);
      nodeFs.renameSync(a, c);

      expect(session?.fired).toHaveLength(6);
      expect(nodeFs.readFileSync(c, 'utf8')).toBe('1');
    });

    it('a traced call between two tries ends the run: the second try is a new call', () => {
      const { a, b, c } = refusingRename({ everyTry: true });

      expect(() => nodeFs.renameSync(a, b)).toThrow(refusedRename);
      nodeFs.statSync(c);
      nodeFs.renameSync(a, b);

      expect(session?.fired).toHaveLength(1);
    });

    it('holds nth numbering still: the retries of the failed call are not matches of their own', () => {
      const { a, b, c } = refusingRename({ nth: 2, everyTry: true });

      nodeFs.renameSync(a, b);
      expect(() => nodeFs.renameSync(c, a)).toThrow(refusedRename);
      expect(() => nodeFs.renameSync(c, a)).toThrow(refusedRename);
      nodeFs.renameSync(b, a);
    });

    it('without it, a rule fails exactly one call', () => {
      const { a, b } = refusingRename({});

      expect(() => nodeFs.renameSync(a, b)).toThrow(refusedRename);
      nodeFs.renameSync(a, b);
    });
  });
});

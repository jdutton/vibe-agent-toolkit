/**
 * The `io` counter injected into a REAL node process — the end-to-end half of
 * `../io-counter.test.ts`, whose header names the four properties pinned. This
 * half spawns a child (and two grandchildren) under `NODE_OPTIONS=--require`,
 * so it belongs in the system tier: anything that spawns a process does.
 *
 * The end-to-end tests run against the BUILT `dist/facets/io/counter.cjs` —
 * `--require` only accepts CommonJS, and the emitted `.cjs` is the artifact that
 * actually ships. Testing the `.cts` source would test something that is never
 * loaded.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IoDumpSchema } from '../../src/facets/io/dump.js';
import {
  COUNTER_PRELOAD,
  CP_SPAWN_SYNC,
  type Dump,
  type DumpRow,
  FS_OPEN_SYNC,
  FS_PROMISES_READ_FILE,
  FS_READ_FILE_SYNC,
  FS_REALPATH_SYNC,
  internals,
} from '../io-counter-fixtures.js';

/* ------------------------------------------------------------------ */
/* End to end: a real node child, a known exact number of operations.  */
/* ------------------------------------------------------------------ */

/** What the child reports about its own environment, as a control on the dump. */
interface ChildReport {
  /** Whether `require('fs/promises') === require('fs').promises` still holds. */
  promisesAreOneObject: boolean;
  /** `fsPromises.realpath.native` does not exist; `fs.realpathSync.native` does. */
  fspRealpathNative: string;
  /** Whether this process's `fs.readFileSync` carries the counter's tag. */
  fsIsPatched: boolean;
}

const CHILD_SOURCE = `'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
const TAG = Symbol.for('vat.lab.io.counter.wrapped');
const [a, b, c] = process.argv.slice(2);

function readAllSync(list) {
  for (const file of list) { fs.readFileSync(file); }
}

async function readAllAsync(list) {
  for (const file of list) { await fsp.readFile(file); }
}

function spawnAll(list) {
  // One call site, one binary, DIFFERENT work each time — the shape that makes
  // a first-argument distinct set meaningless.
  return list.map((code) => cp.spawnSync(process.execPath, ['-e', code]));
}

async function main() {
  // A call with no frame in this program: Node's timers invoke the fs function
  // directly, which is what loader traffic looks like to the counter. Node's own
  // CJS loader stopped reaching the public fs API on Windows at 24.21, so the
  // loader bucket is exercised on purpose rather than left to the Node version.
  setImmediate(fs.statSync, a);
  readAllSync([a, a, a, b, c]);
  await readAllAsync([a, a, b]);
  await fs.promises.readFile(c);
  fs.realpathSync(a);
  fs.realpathSync.native(a);
  const [grandchild] = spawnAll(['0', 'process.exitCode = 0']);
  process.stdout.write(JSON.stringify({
    promisesAreOneObject: require('node:fs').promises === require('node:fs/promises'),
    fspRealpathNative: typeof fsp.realpath.native,
    fsIsPatched: fs.readFileSync[TAG] === true,
    grandchildPid: grandchild.pid,
  }));
}

main();
`;

/** Scratch tree for the end-to-end runs, created once in `beforeAll`. */
let scratch = '';
/** Where the activated runs write their dumps. */
let logDir = '';
/** The child program, written to the scratch tree. */
let childScript = '';
/** The three markdown files the child reads. */
let files: string[] = [];

/**
 * Run the child under `NODE_OPTIONS=--require <counter>`.
 *
 * NODE_OPTIONS rather than a direct `--require` argv, because NODE_OPTIONS is
 * what the harness uses and is what propagates to descendants.
 *
 * @param activate - Whether to set `VAT_LAB_IO_LOG`
 * @param dir - Where dumps should land
 * @returns The child's stdout report and its pid
 */
function runChild(activate: boolean, dir: string): { report: ChildReport; pid: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `--require "${COUNTER_PRELOAD}"`,
  };
  if (activate) {
    env[internals.LOG_DIR_ENV] = dir;
  } else {
    delete env[internals.LOG_DIR_ENV];
  }

  const result = spawnSync(process.execPath, [childScript, ...files], {
    encoding: 'utf8',
    env,
  });

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return { report: JSON.parse(result.stdout) as ChildReport, pid: result.pid ?? -1 };
}

/**
 * Read the dump belonging to one pid.
 *
 * @param dir - The log directory
 * @param pid - The process whose dump is wanted
 * @returns Its dump
 */
function readDump(dir: string, pid: number): Dump {
  const dumps = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(safePath.join(dir, name), 'utf8')) as Dump);
  const mine = dumps.find((dump) => dump.pid === pid);
  if (mine === undefined) {
    throw new Error(`no dump for pid ${pid}; found ${dumps.map((d) => d.pid).join(', ')}`);
  }
  return mine;
}

/**
 * All user rows for one method.
 *
 * @param dump - The dump
 * @param method - Method label
 * @returns Matching rows
 */
function userRows(dump: Dump, method: string): DumpRow[] {
  return dump.rows.filter((row) => row.cls === 'user' && row.method === method);
}

describe('end to end: injected into a real node process', () => {
  beforeAll(() => {
    scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-io-counter-'));
    logDir = safePath.join(scratch, 'logs');
    childScript = safePath.join(scratch, 'child.cjs');
    writeFileSync(childScript, CHILD_SOURCE, 'utf8');
    files = ['a.md', 'b.md', 'c.md'].map((name) => safePath.join(scratch, name));
    for (const file of files) {
      writeFileSync(file, `# ${file}\n`, 'utf8');
    }
  });

  afterAll(() => {
    if (scratch !== '') {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('is inert without VAT_LAB_IO_LOG: no dump, and the child fs is unpatched', () => {
    const inertDir = safePath.join(scratch, 'inert-logs');
    const { report } = runChild(false, inertDir);

    expect(report.fsIsPatched).toBe(false);
    expect(existsSync(inertDir)).toBe(false);
  });

  it('counts sync, promise and child_process work with exact known totals', () => {
    const { report, pid } = runChild(true, logDir);

    // Controls. If Node ever split these two objects, the promise counts below
    // would change for a reason that has nothing to do with the counter.
    expect(report.promisesAreOneObject).toBe(true);
    expect(report.fspRealpathNative).toBe('undefined');
    expect(report.fsIsPatched).toBe(true);

    const dump = readDump(logDir, pid);
    // The cross-module contract, asserted against a GENUINE artifact rather than
    // against a drawing of one: what the injected counter writes is what
    // `dump.ts` reads. Two hand-maintained `dumpVersion` integers used to be
    // compared here instead — a proxy that could pass while both were wrong
    // together, and that only ever caught a change somebody remembered to
    // announce. This fails the moment either side's field set moves.
    expect(IoDumpSchema.safeParse(dump).success).toBe(true);

    // 5 reads at one site, of 3 distinct files: necessary work, not an N+1.
    const syncRows = userRows(dump, FS_READ_FILE_SYNC);
    expect(syncRows).toHaveLength(1);
    expect(syncRows[0]?.count).toBe(5);
    expect(syncRows[0]?.distinctArgs).toBe(3);
    expect(syncRows[0]?.argsCapped).toBe(false);
    expect(toForwardSlash(syncRows[0]?.site ?? '')).toContain(toForwardSlash(childScript));

    // TRAP 1 (sync-only attribution) and TRAP 2 (double counting) both live
    // here. 4 real promise-API reads: 3 through `fs/promises`, 1 through
    // `fs.promises` — the SAME function object. A sync-only counter reports 0;
    // a counter without identity dedupe reports 8.
    const promiseRows = userRows(dump, FS_PROMISES_READ_FILE);
    expect(promiseRows).toHaveLength(2);
    expect(promiseRows.reduce((sum, row) => sum + row.count, 0)).toBe(4);
    const loopRow = promiseRows.find((row) => row.count === 3);
    expect(loopRow?.distinctArgs).toBe(2);
    // Two different call sites, so they are two rows rather than one.
    expect(promiseRows[0]?.site).not.toBe(promiseRows[1]?.site);

    // `.native` is a different implementation with different casing behaviour.
    expect(userRows(dump, FS_REALPATH_SYNC).map((row) => row.count)).toEqual([1]);
    expect(userRows(dump, 'fs.realpathSync.native').map((row) => row.count)).toEqual([1]);

    // TRAP 3: two spawns of the SAME binary doing DIFFERENT work. Argument 0 is
    // `process.execPath` both times, so a first-argument distinct set reports
    // `2 calls / 1 distinct` — a 2.00x redundancy claim that is structurally
    // guaranteed for every spawn site and says nothing about these two spawns.
    // No reading is taken instead, and `null` says that rather than implying a
    // measurement.
    const spawnRows = userRows(dump, CP_SPAWN_SYNC);
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]?.count).toBe(2);
    expect(spawnRows[0]?.distinctArgs).toBeNull();
    expect(spawnRows[0]?.argsCapped).toBe(false);
  });

  it('counts the descriptor-level work a high-level read decomposes into', () => {
    // MEASURED, and a contract the dump reader must not sum across: Node's own
    // `fs.readFileSync` calls the PUBLIC `fs.openSync` / `fs.readSync` /
    // `fs.closeSync`, so those are wrapped too and each logical read shows up on
    // four rows at ONE site. That is a more truthful picture of the syscalls
    // than a single row — and it means "total fs calls" is a sum over one
    // method, never over all of them.
    const dump = readDump(logDir, runChild(true, logDir).pid);
    const at = (method: string): DumpRow | undefined => userRows(dump, method)[0];

    expect(at(FS_READ_FILE_SYNC)?.count).toBe(5);
    expect(at(FS_OPEN_SYNC)?.count).toBe(5);
    expect(at('fs.readSync')?.count).toBe(5);
    expect(at('fs.closeSync')?.count).toBe(5);

    // The descriptor rows share the read's site, so the N+1 question is still
    // answerable at every level: 5 opens of 3 distinct paths, 5 reads of an fd
    // (no string argument, hence no distinct-arg claim).
    expect(at(FS_OPEN_SYNC)?.site).toBe(at(FS_READ_FILE_SYNC)?.site);
    expect(at(FS_OPEN_SYNC)?.distinctArgs).toBe(3);
    expect(at('fs.readSync')?.distinctArgs).toBe(0);
  });

  it('never counts its own dump write', () => {
    // The counter captures `writeFileSync`, `mkdirSync` and `existsSync` BEFORE
    // patching, so the exit-time dump is invisible to itself. The child calls
    // none of the three, so any row naming them came from the counter.
    //
    // This test is sensitive by construction: `nextDumpPath` probes with
    // `existsSync` and `writeDump` calls `mkdirSync` BEFORE the rows are
    // serialised, so a counter using the patched functions would record them in
    // the very dump it is writing.
    const dump = readDump(logDir, runChild(true, logDir).pid);
    const selfInflicted = dump.rows.filter((row) =>
      ['fs.existsSync', 'fs.mkdirSync', 'fs.writeFileSync'].includes(row.method),
    );

    expect(selfInflicted).toEqual([]);
  });

  it('reports loader traffic in its own bucket rather than dropping or attributing it', () => {
    const dump = readDump(logDir, runChild(true, logDir).pid);
    const loaderRows = dump.rows.filter((row) => row.cls === 'loader');

    // There IS loader traffic — the child's `setImmediate(fs.statSync, …)` has no
    // frame in the program, and on most Node versions the CJS loader's own reads
    // add more — and the dump says so out loud. Two mutations die here:
    // classifying everything as `user` (this drops to 0), and dropping loader
    // rows entirely (same).
    expect(loaderRows.some((row) => row.method === 'fs.statSync')).toBe(true);

    // Every loader row aggregates per method (empty site) and takes no
    // distinct-argument reading at all — `null`, not the `0` that would read as
    // "a reading was taken and nothing was distinct".
    expect(loaderRows.every((row) => row.site === '')).toBe(true);
    expect(loaderRows.every((row) => row.distinctArgs === null)).toBe(true);
    expect(loaderRows.every((row) => row.argsCapped === false)).toBe(true);
    expect(new Set(loaderRows.map((row) => row.method)).size).toBe(loaderRows.length);

    // The rows are sorted, so two dumps of the same work diff cleanly rather
    // than reporting a difference that belongs to Map insertion order. Strictly
    // ascending in code-unit order — the same ordering the counter uses, and
    // strictness also proves uniqueness. `localeCompare` would impose a
    // DIFFERENT order over these NUL-separated keys, so asserting with it would
    // be asserting the wrong contract.
    const keys = dump.rows.map((row) => `${row.cls}\u0000${row.method}\u0000${row.site}`);
    const ascending = keys.every((key, index) => index === 0 || (keys[index - 1] ?? '') < key);
    expect(keys.length).toBeGreaterThan(1);
    expect(ascending).toBe(true);
  });

  it('propagates to descendants, and each process writes its own dump', () => {
    const dir = safePath.join(scratch, 'descendant-logs');
    const { pid } = runChild(true, dir);

    // The child spawns two grandchildren, both of which inherit NODE_OPTIONS.
    // All three dump. The harness doc claims propagation; here it is measured.
    const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(names).toHaveLength(3);
    expect(names.some((name) => name.startsWith(`io-${pid}-`))).toBe(true);
  });
});

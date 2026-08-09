/**
 * The `io` facet's counter — the piece that is injected into the *measured*
 * process, so every property it has is a property nothing else can restore.
 *
 * Four things are pinned here, each because getting it wrong yields a number
 * that looks authoritative and is not:
 *
 * 1. **Dependency purity.** The counter is loaded by `--require` inside a vat
 *    that may be running from a temp dir via `npx`, where nothing of the lab's
 *    is installed. One non-builtin `require` makes it crash the process it was
 *    supposed to observe. Scanned, on the *emitted* file, not asserted by
 *    convention.
 * 2. **Identity dedupe.** `require('fs/promises') === require('fs').promises`.
 *    Wrapping "both" wraps one function twice, and every promise-API number
 *    doubles. The fixture below reaches one function object through two names
 *    and carries its own positive control: it shows the un-deduped answer is
 *    *2* before asserting the real one is *1*, so it cannot pass vacuously.
 * 3. **The promise API is patched at all.** Measured on `vat resources scan
 *    docs/`: sync-only attribution reported 40 calls where the truth was 436.
 *    The end-to-end child below reads through `fs/promises` and through
 *    `fs.promises`, and asserts a total that is 0 under a sync-only counter.
 * 4. **Attribution.** 6,371 of 6,411 fs calls on a real run came from Node's own
 *    module loader. A raw total is not a measurement of vat. Loader rows are
 *    bucketed separately, keep an empty site, and are never dropped.
 *
 * The end-to-end tests run against the BUILT `dist/facets/io/counter.cjs` —
 * `--require` only accepts CommonJS, and the emitted `.cjs` is the artifact that
 * actually ships. Testing the `.cts` source would test something that is never
 * loaded.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is derived from a controlled mkdtemp scratch dir */

/** One aggregated row of a dump, as the dump reader consumes it. */
interface DumpRow {
  cls: 'user' | 'loader';
  method: string;
  site: string;
  count: number;
  distinctArgs: number;
  argsCapped: boolean;
}

/** The whole dump file. */
interface Dump {
  dumpVersion: number;
  pid: number;
  rows: DumpRow[];
}

/** A function the counter has wrapped, or is about to. */
type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** Mutable counter state — buckets plus the re-entrancy flag. */
interface CounterState {
  readonly logDir: string;
  readonly selfFile: string;
  readonly buckets: Map<string, unknown>;
  inside: boolean;
}

/** What the counter exposes for testing. It activates only on the env var. */
interface CounterInternals {
  readonly DUMP_VERSION: number;
  readonly ARG_CAP: number;
  readonly WRAPPED_TAG: symbol;
  readonly LOG_DIR_ENV: string;
  readonly FS_SYNC_METHODS: readonly string[];
  readonly FS_CALLBACK_METHODS: readonly string[];
  readonly FS_PROMISE_METHODS: readonly string[];
  readonly CHILD_PROCESS_METHODS: readonly string[];
  createState(logDir: string, selfFile: string): CounterState;
  parseFrameLocation(frame: string): string | null;
  classifyStack(stack: string, selfFile: string): { cls: 'user' | 'loader'; site: string };
  nextDumpPath(dir: string, pid: number, exists: (file: string) => boolean): string;
  wrapFunction(state: CounterState, owner: object, key: string, label: string): void;
  toRows(state: CounterState): DumpRow[];
}

const requireCjs = createRequire(import.meta.url);

const COUNTER_SRC = fileURLToPath(new URL('../src/facets/io/counter.cts', import.meta.url));
const COUNTER_DIST = fileURLToPath(new URL('../dist/facets/io/counter.cjs', import.meta.url));

/**
 * Load the built counter.
 *
 * It is inert without `VAT_LAB_IO_LOG`, and `vitest.setup.js` deletes every
 * `VAT_*` variable from the worker before any test file loads — so requiring it
 * here provably cannot patch this process's `fs`. The inertness test below
 * asserts that rather than assuming it.
 *
 * @returns The counter's testing surface
 */
function loadCounter(): CounterInternals {
  if (!existsSync(COUNTER_DIST)) {
    throw new Error(
      `The io counter is not built: ${COUNTER_DIST}\n` +
        'Run `bunx tsc --build packages/lab/tsconfig.json` (the repo `bun run build` does this).',
    );
  }
  const loaded = requireCjs(COUNTER_DIST) as { __internals: CounterInternals };
  return loaded.__internals;
}

const internals = loadCounter();

/**
 * Method labels, shared between the fixtures and the end-to-end assertions.
 *
 * The label is the counter's stable name for one entry point and is part of the
 * dump's contract with the reader, so it is named once here rather than retyped
 * at each assertion.
 */
const FS_READ_FILE = 'fs.readFile';
const FS_READ_FILE_SYNC = 'fs.readFileSync';
const FS_OPEN_SYNC = 'fs.openSync';
const FS_REALPATH_SYNC = 'fs.realpathSync';
const FS_PROMISES_READ_FILE = 'fs.promises.readFile';

/** A stand-in for the real `fs` surface, so unit tests never patch this process. */
function makeFixtureObject(): { readFile: AnyFunction; calls: string[] } {
  const calls: string[] = [];
  const readFile: AnyFunction = (...args: unknown[]) => {
    calls.push(String(args[0]));
    return 'contents';
  };
  return { readFile, calls };
}

/**
 * Source text with comments removed.
 *
 * Mandatory before scanning for `require`: the counter's own documentation
 * *quotes* `require('fs/promises')` while explaining why the two objects are
 * one, and `tsc` copies JSDoc into the emitted `.cjs` verbatim. A scan over raw
 * text reads those quotations as dependencies and reports a violation that does
 * not exist — the same false-reading class that has bitten import-graph
 * analysis in this repo before.
 *
 * @param source - File contents
 * @returns The same text with block and line comments blanked out
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\S\s]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/**
 * Every `require(...)` literal in a source text.
 *
 * @param source - File contents, comments already stripped
 * @returns The specifier of each `require` call with a literal argument
 */
function requireSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /require\(\s*(["'])([^"']*)\1\s*\)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    found.push(match[2] ?? '');
    match = pattern.exec(source);
  }
  return found;
}

/**
 * Every module specifier the authored `.cts` imports.
 *
 * Line-oriented rather than one multi-line regex: an `import\s+[^;]*?["']`
 * pattern backtracks super-linearly, and the whole point of this file is that
 * an instrument must not be the expensive part of the thing it measures.
 *
 * @param source - `.cts` contents, comments already stripped
 * @returns Specifiers, from both `import x from '…'` and `import x = require('…')`
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    if (!line.trimStart().startsWith('import ')) {
      continue;
    }
    const quoted = /["']([^"']+)["']/.exec(line);
    if (quoted !== null) {
      found.push(quoted[1] ?? '');
    }
  }
  return found;
}

describe('dependency purity — the counter runs where nothing of ours is installed', () => {
  it('the EMITTED .cjs requires only node: builtins', () => {
    const code = stripComments(readFileSync(COUNTER_DIST, 'utf8'));
    const specifiers = requireSpecifiers(code);

    // Control: a regex that matched nothing would pass the assertion below
    // while proving nothing. The counter genuinely requires several builtins.
    expect(specifiers.length).toBeGreaterThanOrEqual(3);
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });

  it('CONTROL: the same scan over the un-stripped file would misread the prose', () => {
    // Proof that the stripping above is load-bearing rather than decorative:
    // the raw file really does contain non-builtin `require(...)` text, all of
    // it inside documentation.
    const raw = readFileSync(COUNTER_DIST, 'utf8');
    expect(requireSpecifiers(raw).some((s) => !s.startsWith('node:'))).toBe(true);
  });

  it('the emitted .cjs has no dynamic require and no bundler-style interop copy', () => {
    const code = stripComments(readFileSync(COUNTER_DIST, 'utf8'));

    // Every `require(` occurrence must be one of the literal ones counted above
    // — a computed specifier would escape the check entirely.
    const total = (code.match(/require\(/g) ?? []).length;
    expect(total).toBe(requireSpecifiers(code).length);

    // `import * as fs from 'node:fs'` emits `__importStar(require('node:fs'))`,
    // which hands back a COPY whose properties are getters onto the original.
    // Patching that copy patches nothing, silently, and every count becomes 0.
    // The counter uses `import fs = require('node:fs')` to avoid it.
    expect(code).not.toContain('__importStar');
  });

  it('the AUTHORED .cts imports nothing outside node:', () => {
    const imports = importSpecifiers(stripComments(readFileSync(COUNTER_SRC, 'utf8')));

    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });
});

describe('inertness — a stray NODE_OPTIONS must not perturb an unrelated process', () => {
  it('requiring the counter without VAT_LAB_IO_LOG leaves this process fs untouched', () => {
    // `internals` was produced by requiring the built counter at module load.
    // If it had activated, it would have replaced fs.readFileSync with a tagged
    // wrapper — in the very process running this assertion.
    expect(process.env[internals.LOG_DIR_ENV]).toBeUndefined();
    const tagged = Reflect.get(readFileSync as unknown as object, internals.WRAPPED_TAG);
    expect(tagged).toBeUndefined();
  });
});

describe('parseFrameLocation', () => {
  const cases = [
    {
      name: 'a named CJS frame, dropping the column',
      frame: '    at Object.readFileSync (/repo/packages/cli/dist/scan.js:141:22)',
      expected: '/repo/packages/cli/dist/scan.js:141',
    },
    {
      name: 'an anonymous frame with no parentheses',
      frame: '    at /repo/packages/cli/dist/scan.js:12:3',
      expected: '/repo/packages/cli/dist/scan.js:12',
    },
    {
      name: 'an async frame',
      frame: '    at async ModuleJob.run (/repo/a.js:7:9)',
      expected: '/repo/a.js:7',
    },
    {
      name: 'a node: internal frame, left recognisable as internal',
      frame: '    at ModuleLoader.load (node:internal/modules/esm/loader:540:12)',
      expected: 'node:internal/modules/esm/loader:540',
    },
    {
      name: 'a file:// URL frame, normalised to a filesystem path',
      frame: '    at file:///repo/packages/cli/dist/scan.js:3:1',
      expected: '/repo/packages/cli/dist/scan.js:3',
    },
    {
      name: 'a Windows path, keeping the drive colon and dropping only the column',
      frame: String.raw`    at Object.<anonymous> (C:\repo\packages\cli\scan.js:99:4)`,
      expected: String.raw`C:\repo\packages\cli\scan.js:99`,
    },
  ] as const;

  it.for(cases)('parses $name', ({ frame, expected }) => {
    const parsed = internals.parseFrameLocation(frame);
    expect(parsed === null ? null : toForwardSlash(parsed)).toBe(toForwardSlash(expected));
  });

  it.for([
    { name: 'a stack header line', frame: 'Error' },
    { name: 'a native frame with no location', frame: '    at native' },
    { name: 'an empty line', frame: '' },
  ] as const)('returns null for $name', ({ frame }) => {
    expect(internals.parseFrameLocation(frame)).toBeNull();
  });
});

describe('classifyStack — the loader is bucketed out, never dropped', () => {
  const SELF = '/repo/packages/lab/dist/facets/io/counter.cjs';

  it('attributes to the first frame that is neither node: nor the counter itself', () => {
    const stack = [
      'Error',
      `    at wrapper (${SELF}:88:19)`,
      `    at record (${SELF}:60:5)`,
      '    at ESMLoader.load (node:internal/modules/esm/loader:540:12)',
      '    at readDoc (/repo/packages/resources/dist/read.js:141:22)',
      '    at scan (/repo/packages/cli/dist/scan.js:12:3)',
    ].join('\n');

    const result = internals.classifyStack(stack, SELF);

    expect(result.cls).toBe('user');
    // The three frames ahead of it were ALL skippable, and each for a different
    // reason. If self-skipping were removed the site would be the counter; if
    // node:-skipping were removed it would be the ESM loader. It is neither.
    expect(result.site).toBe('/repo/packages/resources/dist/read.js:141');
  });

  it('classifies a stack of nothing but node: frames as loader, with an empty site', () => {
    const stack = [
      'Error',
      `    at wrapper (${SELF}:88:19)`,
      '    at ModuleLoader.load (node:internal/modules/esm/loader:540:12)',
      '    at node:internal/modules/run_main:91:12',
    ].join('\n');

    expect(internals.classifyStack(stack, SELF)).toEqual({ cls: 'loader', site: '' });
  });

  it('classifies an empty stack as loader rather than guessing a site', () => {
    expect(internals.classifyStack('', SELF)).toEqual({ cls: 'loader', site: '' });
  });
});

describe('wrapFunction — identity dedupe (fs/promises IS fs.promises)', () => {
  it('records ONE call when one function object is wrapped under two names', () => {
    const shared = makeFixtureObject();
    const state = internals.createState('/unused', COUNTER_DIST);

    // The production shape exactly: `require('fs/promises')` and
    // `require('fs').promises` are the SAME object, so the counter walks it
    // twice under one label.
    internals.wrapFunction(state, shared, 'readFile', FS_PROMISES_READ_FILE);
    internals.wrapFunction(state, shared, 'readFile', FS_PROMISES_READ_FILE);

    shared.readFile('/a.md');

    const rows = internals.toRows(state);
    expect(shared.calls).toEqual(['/a.md']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });

  it('POSITIVE CONTROL: the same fixture records TWO without the tag, so the test above can fail', () => {
    const shared = makeFixtureObject();
    const state = internals.createState('/unused', COUNTER_DIST);

    internals.wrapFunction(state, shared, 'readFile', FS_PROMISES_READ_FILE);
    // Strip the tag the dedupe relies on — this is precisely the mutation
    // "remove the identity check", applied to the fixture rather than the code.
    Reflect.deleteProperty(shared.readFile as unknown as object, internals.WRAPPED_TAG);
    internals.wrapFunction(state, shared, 'readFile', FS_PROMISES_READ_FILE);

    shared.readFile('/a.md');

    // ONE real call, and the double wrapper records it twice.
    expect(shared.calls).toEqual(['/a.md']);
    expect(internals.toRows(state).reduce((sum, row) => sum + row.count, 0)).toBe(2);
  });

  it('leaves a non-function property alone', () => {
    const owner = { notAFunction: 42 };
    const state = internals.createState('/unused', COUNTER_DIST);

    internals.wrapFunction(state, owner, 'notAFunction', 'fs.nope');

    expect(owner.notAFunction).toBe(42);
    expect(internals.toRows(state)).toEqual([]);
  });

  it('preserves a sub-function like realpathSync.native and gives it its own label', () => {
    // The two implementations differ in path-casing behaviour on macOS and
    // Windows, so a shared bucket would hide a real difference. And a wrapper
    // that dropped `.native` would make the measured process throw.
    const calls: string[] = [];
    const base: AnyFunction & { native?: AnyFunction } = (...args) => {
      calls.push(`base:${String(args[0])}`);
      return '/resolved';
    };
    base.native = (...args) => {
      calls.push(`native:${String(args[0])}`);
      return '/resolved-native';
    };
    const owner = { realpathSync: base as AnyFunction };
    const state = internals.createState('/unused', COUNTER_DIST);

    internals.wrapFunction(state, owner, 'realpathSync', FS_REALPATH_SYNC);

    const wrapped = owner.realpathSync as AnyFunction & { native: AnyFunction };
    wrapped('/a');
    wrapped.native('/a');

    expect(calls).toEqual(['base:/a', 'native:/a']);
    const methods = internals.toRows(state).map((row) => row.method);
    expect(methods).toEqual([FS_REALPATH_SYNC, 'fs.realpathSync.native']);
  });

  it('does not recurse when capturing a stack itself touches the filesystem', () => {
    // The real instance of this is `--enable-source-maps`: formatting a stack
    // reads `.map` files, through the very functions the counter wrapped. A
    // counter without a re-entrancy guard captures a stack to record that read,
    // which formats a stack, which reads a map, forever.
    const shared = makeFixtureObject();
    const state = internals.createState('/unused', COUNTER_DIST);
    internals.wrapFunction(state, shared, 'readFile', FS_READ_FILE);

    const previous = Error.prepareStackTrace;
    let formatterCalls = 0;
    try {
      Error.prepareStackTrace = (_error, frames): string => {
        formatterCalls += 1;
        shared.readFile('/bundle.js.map');
        return frames
          .map((frame) => `    at ${String(frame.getFileName())}:${frame.getLineNumber() ?? 0}:1`)
          .join('\n');
      };
      shared.readFile('/a.md');
    } finally {
      Error.prepareStackTrace = previous;
    }

    // Two real calls reached the underlying function (the inner one first: the
    // counter records BEFORE delegating, so the capture happens first)…
    expect(shared.calls).toEqual(['/bundle.js.map', '/a.md']);
    // ...and exactly one was recorded. The inner one arrived while the counter
    // was mid-capture; recording it would have re-entered capture without end.
    expect(internals.toRows(state).reduce((sum, row) => sum + row.count, 0)).toBe(1);
    expect(formatterCalls).toBe(1);
  });

  it('preserves own symbol properties, so util.promisify.custom survives wrapping', () => {
    const custom = Symbol.for('nodejs.util.promisify.custom');
    const base: AnyFunction = () => undefined;
    Reflect.set(base as unknown as object, custom, () => 'promisified');
    const owner = { exists: base };
    const state = internals.createState('/unused', COUNTER_DIST);

    internals.wrapFunction(state, owner, 'exists', 'fs.exists');

    expect(typeof Reflect.get(owner.exists as unknown as object, custom)).toBe('function');
  });
});

describe('distinctArgs — the N+1 detector', () => {
  it('separates 5 reads of 3 files from 5 reads of the same file', () => {
    const shared = makeFixtureObject();
    const state = internals.createState('/unused', COUNTER_DIST);
    internals.wrapFunction(state, shared, 'readFile', FS_READ_FILE);

    // One call site (a loop), so all five land in one bucket.
    for (const file of ['/a.md', '/a.md', '/a.md', '/b.md', '/c.md']) {
      shared.readFile(file);
    }

    const rows = internals.toRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(5);
    expect(rows[0]?.distinctArgs).toBe(3);
    expect(rows[0]?.argsCapped).toBe(false);
  });

  it('never stores the argument values themselves — only how many were distinct', () => {
    const shared = makeFixtureObject();
    const state = internals.createState('/unused', COUNTER_DIST);
    internals.wrapFunction(state, shared, 'readFile', FS_READ_FILE);
    shared.readFile('/Users/somebody/private/secret-path.md');

    // Machine-specific absolute paths would make two reports incomparable.
    // The serialized row is the whole contract with the dump reader.
    expect(JSON.stringify(internals.toRows(state))).not.toContain('secret-path');
  });

  it('does not count a non-string first argument as a distinct arg', () => {
    const shared = makeFixtureObject();
    const state = internals.createState('/unused', COUNTER_DIST);
    internals.wrapFunction(state, shared, 'readFile', 'fs.read');

    for (const fd of [3, 4, 5]) {
      shared.readFile(fd);
    }

    const rows = internals.toRows(state);
    expect(rows[0]?.count).toBe(3);
    // A count of 3 with 0 distinct args reads as "fd-based, not path-based" —
    // which is true, and is not the same claim as "3 reads of one file".
    expect(rows[0]?.distinctArgs).toBe(0);
  });

  it('caps the distinct set and says so, making distinctArgs a floor', () => {
    const shared = makeFixtureObject();
    const state = internals.createState('/unused', COUNTER_DIST);
    internals.wrapFunction(state, shared, 'readFile', FS_READ_FILE);

    const total = internals.ARG_CAP + 5;
    for (let index = 0; index < total; index++) {
      shared.readFile(`/file-${index}.md`);
    }

    const rows = internals.toRows(state);
    expect(rows[0]?.count).toBe(total);
    expect(rows[0]?.distinctArgs).toBe(internals.ARG_CAP);
    expect(rows[0]?.argsCapped).toBe(true);
  });
});

describe('nextDumpPath', () => {
  it('takes the first free index so a recycled pid cannot clobber an earlier dump', () => {
    const taken = new Set(['io-77-0.json', 'io-77-1.json']);
    const chosen = internals.nextDumpPath('/logs', 77, (file) =>
      taken.has(toForwardSlash(file).split('/').pop() ?? ''),
    );

    expect(toForwardSlash(chosen)).toBe('/logs/io-77-2.json');
  });

  it('uses index 0 in an empty directory', () => {
    expect(toForwardSlash(internals.nextDumpPath('/logs', 5, () => false))).toBe(
      '/logs/io-5-0.json',
    );
  });
});

describe('the method lists cover both halves of the API', () => {
  it('patches the promise API, not only the sync one', () => {
    // Measured: sync-only attribution on `vat resources scan docs/` reported 40
    // calls where the truth was 436. vat's document reading is `fs/promises`.
    expect(internals.FS_PROMISE_METHODS).toContain('readFile');
    expect(internals.FS_PROMISE_METHODS).toContain('readdir');
    expect(internals.FS_SYNC_METHODS).toContain('readFileSync');
    expect(internals.FS_CALLBACK_METHODS).toContain('readFile');
    expect(internals.CHILD_PROCESS_METHODS).toContain('spawnSync');
  });

  it('names no method twice within a list', () => {
    for (const list of [
      internals.FS_SYNC_METHODS,
      internals.FS_CALLBACK_METHODS,
      internals.FS_PROMISE_METHODS,
      internals.CHILD_PROCESS_METHODS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

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

async function main() {
  readAllSync([a, a, a, b, c]);
  await readAllAsync([a, a, b]);
  await fs.promises.readFile(c);
  fs.realpathSync(a);
  fs.realpathSync.native(a);
  const grandchild = cp.spawnSync(process.execPath, ['-e', '0']);
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
    NODE_OPTIONS: `--require "${COUNTER_DIST}"`,
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
    expect(dump.dumpVersion).toBe(internals.DUMP_VERSION);

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

    const spawnRows = userRows(dump, 'child_process.spawnSync');
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]?.count).toBe(1);
    expect(spawnRows[0]?.distinctArgs).toBe(1);
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

    // There IS loader traffic — Node's CJS loader reads and realpaths the child
    // script through the public fs API — and the dump says so out loud. Two
    // mutations die here: classifying everything as `user` (this drops to 0),
    // and dropping loader rows entirely (same). If a future Node routes all
    // loader I/O through internal bindings this goes to 0 legitimately, and the
    // right response is to say so in the facet docs, not to delete the gate.
    expect(loaderRows.length).toBeGreaterThan(0);

    // Every loader row aggregates per method (empty site) and tracks no args.
    expect(loaderRows.every((row) => row.site === '')).toBe(true);
    expect(loaderRows.every((row) => row.distinctArgs === 0)).toBe(true);
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

    // The child spawns one grandchild, which inherits NODE_OPTIONS. Both dump.
    // The harness doc claims this; here it is measured.
    const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(names.length).toBe(2);
    expect(names.some((name) => name.startsWith(`io-${pid}-`))).toBe(true);
  });
});

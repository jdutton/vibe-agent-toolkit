/**
 * What the `io` counter's unit and integration tests share: the built counter's
 * testing surface, the dump's row shape, and the method labels both halves
 * assert on. The unit half (`io-counter.test.ts`) drives the counter's
 * internals in-process; the integration half
 * (`integration/io-counter.integration.test.ts`) injects it into real node
 * children.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/** One aggregated row of a dump, as the dump reader consumes it. */
export interface DumpRow {
  cls: 'user' | 'loader';
  method: string;
  site: string;
  count: number;
  /** `null` when no distinct set was kept — see the counter's own docs. */
  distinctArgs: number | null;
  argsCapped: boolean;
}

/** The whole dump file. */
export interface Dump {
  pid: number;
  rows: DumpRow[];
}

/** Mutable counter state — buckets plus the re-entrancy flag. */
interface CounterState {
  readonly logDir: string;
  readonly selfFile: string;
  readonly buckets: Map<string, unknown>;
  inside: boolean;
}

/** What the counter exposes for testing. It activates only on the env var. */
interface CounterInternals {
  readonly ARG_CAP: number;
  readonly WRAPPED_TAG: symbol;
  readonly LOG_DIR_ENV: string;
  readonly FS_SYNC_METHODS: readonly string[];
  readonly FS_CALLBACK_METHODS: readonly string[];
  readonly FS_PROMISE_METHODS: readonly string[];
  readonly CHILD_PROCESS_METHODS: readonly string[];
  readonly FS_OPS_WITHOUT_ARG_IDENTITY: readonly string[];
  readonly UNTRACKED_ARG_LABELS: ReadonlySet<string>;
  createState(logDir: string, selfFile: string): CounterState;
  parseFrameLocation(frame: string): string | null;
  classifyStack(stack: string, selfFile: string): { cls: 'user' | 'loader'; site: string };
  nextDumpPath(dir: string, pid: number, exists: (file: string) => boolean): string;
  wrapFunction(state: CounterState, owner: object, key: string, label: string): void;
  toRows(state: CounterState): DumpRow[];
}

const requireCjs = createRequire(import.meta.url);

export const COUNTER_DIST = fileURLToPath(new URL('../dist/facets/io/counter.cjs', import.meta.url));

/**
 * The counter as `NODE_OPTIONS` must spell it — forward-slashed, and *only*
 * here.
 *
 * `fileURLToPath` yields native separators, so on Windows this path arrives as
 * `C:\...\counter.cjs`. Node's `NODE_OPTIONS` parser treats a backslash inside
 * double quotes as an escape, and the quotes are not optional either — an
 * unquoted path containing a space parses as two arguments. So the quoted
 * native path is silently rewritten to one that does not exist and the measured
 * child dies in the CJS loader before it runs a line: reproduced on macOS,
 * where a backslash is a legal filename character, as
 * `--require "/tmp/bsprobe/back\dir/counter.cjs"` → `Cannot find module
 * '/tmp/bsprobe/backdir/counter.cjs'`. It is the same trap `capture.ts`
 * documents on `nodeOptionsWith`, which production avoids because
 * `resolveCounterPath` runs the path through `safePath.resolve`; this file
 * resolved its own and so did not.
 *
 * `COUNTER_DIST` itself stays native on purpose. It is also the `selfFile` fed
 * to `createState`, and the counter matches that against V8 stack frames on the
 * documented invariant that both sides come from V8 and their separators are
 * therefore identical by construction. Forward-slashing it globally would fix
 * the preload and break the frame matching, on Windows only.
 */
export const COUNTER_PRELOAD = toForwardSlash(COUNTER_DIST);

/**
 * Load the built counter.
 *
 * It is inert without `VAT_LAB_IO_LOG`, and `vitest.setup.js` deletes every
 * `VAT_*` variable from the worker before any test file loads — so requiring it
 * here provably cannot patch this process's `fs`. The inertness test in `io-counter.test.ts`
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

export const internals = loadCounter();

/**
 * Method labels, shared between the fixtures and the end-to-end assertions.
 *
 * The label is the counter's stable name for one entry point and is part of the
 * dump's contract with the reader, so it is named once here rather than retyped
 * at each assertion.
 */
export const FS_READ_FILE = 'fs.readFile';
export const FS_READ_FILE_SYNC = 'fs.readFileSync';
export const FS_OPEN_SYNC = 'fs.openSync';
export const FS_REALPATH_SYNC = 'fs.realpathSync';
export const FS_PROMISES_READ_FILE = 'fs.promises.readFile';
export const CP_SPAWN_SYNC = 'child_process.spawnSync';

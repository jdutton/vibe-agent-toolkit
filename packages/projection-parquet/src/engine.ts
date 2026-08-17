/**
 * The parent half of the DuckDB engine: it never boots DuckDB, it spawns a
 * child that does.
 *
 * ## Why a child process, three measured reasons
 *
 * 1. **The hang is un-killable in-process.** On an extension cache miss the
 *    duckdb-wasm glue blocks the main thread in `Atomics.wait` while an eval'd
 *    worker fetches. No timer, `AbortController`, or in-process guard can end
 *    that wait — only killing the process does. `spawnSync`'s `timeout` +
 *    `killSignal` is therefore the *only* backstop that actually works, and a
 *    `SIGTERM` is enough (a thread parked in `Atomics.wait` runs no JS handler,
 *    so nothing can swallow it).
 * 2. **`HOME`/`USERPROFILE` is the only lever that moves the extension cache.**
 *    `SET extension_directory` was measured to be ignored — the glue reads
 *    `os.homedir()`. Setting it on a child avoids mutating this process's env,
 *    which would leak into every other child a CLI spawns.
 * 3. **The user's `~/.duckdb` must never be written to** — see
 *    `extension-seed.ts` for the poisoned-cache measurement.
 *
 * ## Why one child serves many writes
 *
 * Measured per child: ~51 ms node boot, ~100 ms module load, ~300 ms
 * `instantiate()`, ~70 ms `LOAD` — about 1.0 s before the first row is written,
 * and none of it scales with the work. Twelve tables through twelve children
 * measured 26.8 s; the same twelve through one child, 11.7 s. {@link runParquetSql}
 * therefore takes a *list* of batches, and callers are expected to hand it
 * everything they have rather than call it per table.
 *
 * ## The guard against the hang is TWO things, and both are required
 *
 * - The **precheck** in the child refuses `LOAD` unless the extension is
 *   actually on disk at the runtime-derived probe path (absence is the only
 *   condition that hangs; every corruption fails clean in ~500 ms).
 * - **`autoinstall_known_extensions=false` + `autoload_known_extensions=false`**,
 *   because a parquet precheck says nothing about the *other* extensions
 *   DuckDB will silently autoload: `SELECT '{"a":1}'::JSON`, `json_extract(…)`,
 *   `to_json({…})` and `SET TimeZone='…'` were each measured to hang on a
 *   plain connection **with parquet already loaded**. With autoload off they
 *   become ordinary Catalog Errors and attempt no network at all.
 *
 * Two settings are deliberately NOT used, both measured unusable:
 * `enable_external_access=false` (before `LOAD` it blocks even a
 * cache-satisfied load and then latches for the life of the database; after
 * `LOAD` it disables all filesystem access, so `COPY` fails), and
 * `custom_extension_repository` in production (it rewrites the URL and
 * therefore the probe path, invalidating the seeded bytes and returning you to
 * the hang — it is exposed here only as a test lever, see
 * {@link EngineOptions.extensionRepositoryForTests}).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';

import { parquetEngineHome, seedExtensionHome } from './extension-seed.js';

/**
 * Wall-clock ceiling for one engine child, when the caller names none.
 *
 * A hard literal, on purpose: `spawnSync({ timeout: 0 })` means **no timeout**,
 * and `Number('')` is `0`, so deriving this from an unset environment variable
 * would silently restore the un-killable hang this whole module exists to
 * prevent.
 */
const DEFAULT_ENGINE_TIMEOUT_MS = 120_000;

/** Signal used to end a child that overran. A parked `Atomics.wait` cannot catch it. */
const ENGINE_KILL_SIGNAL = 'SIGTERM';

/**
 * Rows to register before a batch's statements run.
 *
 * A **file path**, not bytes: the request crosses a process boundary as JSON,
 * and a multi-megabyte Arrow stream base64'd into an argv or a JSON string is
 * both slow and subject to platform argument limits. The encoder writes the
 * stream, the child reads it.
 */
export interface ArrowIpcInput {
  /** Table name to create in the child's in-memory database. */
  readonly table: string;
  /** Absolute path to an Arrow IPC **stream** file. */
  readonly path: string;
}

/** A unit of work for the engine: one label, optional rows, and the statements to run. */
export interface ParquetSqlBatch {
  /** Caller's name for this batch — echoed back in the outcome, usually a table name. */
  readonly label: string;
  /** Registered as a table before the statements run, when present. */
  readonly arrowIpc?: ArrowIpcInput;
  /** Statements, run in order. The first failure ends this batch, not the run. */
  readonly statements: readonly string[];
}

/** What became of one batch. */
export interface ParquetBatchOutcome {
  readonly label: string;
  readonly ok: boolean;
  /** Present when `ok` is false. */
  readonly error?: string;
}

/** What the engine reported about itself, straight from the running instance. */
export interface EngineReceipt {
  /** `pragma_version().library_version` — DuckDB's **core** version, not the npm one. */
  readonly coreVersion: string;
  /** `pragma_platform()` — the wasm ABI token. */
  readonly platform: string;
  /** `os.homedir()` as the child saw it, i.e. the cache root actually in force. */
  readonly home: string;
  /** Per extension, whether `duckdb_extensions()` reports it loaded. */
  readonly extensions: readonly { readonly name: string; readonly loaded: boolean; readonly probePath?: string }[];
}

export interface EngineOptions {
  /** Home directory for the child. Defaults to VAT's own cache home. */
  readonly home?: string;
  /** Ceiling for the child. Values `<= 0` are ignored — see {@link DEFAULT_ENGINE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * ⚠️ **Tests only.** Rewrites the extension repository URL, which also
   * rewrites the probe path. The one legitimate use is building an offline
   * harness on a networked machine: a dead host whose URL still *ends* with the
   * real repository host (e.g. `http://127.0.0.1:1/<host>`) yields an
   * identical probe path — DuckDB keys the cache on the last four URL segments
   * — so seeded bytes still hit while a miss can never reach the network.
   * Any other value silently invalidates the seed.
   */
  readonly extensionRepositoryForTests?: string;
  /** Seed the home from the shipped bytes first. Default true; tests that seed by hand pass false. */
  readonly seed?: boolean;
}

/** Everything the parent learned about one child run. */
export interface EngineOutcome {
  readonly ok: boolean;
  readonly batches: readonly ParquetBatchOutcome[];
  readonly receipt?: EngineReceipt;
  readonly error?: string;
  /** True when the child was killed for overrunning {@link EngineOptions.timeoutMs}. */
  readonly killed: boolean;
  readonly signal: string | null;
  readonly status: number | null;
  readonly durationMs: number;
  /** The child's stderr, trimmed — the only place a boot failure explains itself. */
  readonly stderr: string;
}

/** The child's on-disk protocol. Not exported: the child is an implementation detail. */
interface EngineChildRequest {
  readonly mode: 'warm' | 'write';
  readonly extensionRepository?: string;
  readonly extensions: readonly string[];
  readonly batches: readonly ParquetSqlBatch[];
  readonly resultPath: string;
}

interface EngineChildResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly receipt?: EngineReceipt;
  readonly batches: readonly ParquetBatchOutcome[];
}

/**
 * Locate the child entry point beside this module.
 *
 * `.js` is the shipped case. The `.ts` fallback is for running straight from
 * source under a loader (tsx): the child inherits this process's `execArgv`, so
 * whatever loader is compiling this file compiles the child too.
 */
function engineChildEntry(): string {
  const compiled = resolveFromImportMeta(import.meta.url, 'engine-child.js');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this module's own location
  if (existsSync(compiled)) return compiled;
  const source = resolveFromImportMeta(import.meta.url, 'engine-child.ts');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this module's own location
  if (existsSync(source)) return source;
  throw new Error(`Engine child entry point not found beside ${compiled}; the package is built wrong.`);
}

/**
 * Build the child's environment with `HOME` **and** `USERPROFILE` pointing at
 * `home`.
 *
 * Both, never a `process.platform` branch: Node reads `$HOME` on POSIX and
 * `USERPROFILE` on Windows (where it ignores `HOME` entirely). Existing keys
 * are dropped case-insensitively first — on Windows `process.env` may already
 * carry `Home`-style casing, and passing two spellings of one variable to
 * `CreateProcess` has undefined precedence.
 *
 * Exported because this is one half of the mechanism that keeps DuckDB out of
 * the user's `~/.duckdb`; a test has to be able to see it without spawning.
 *
 * @param home - Absolute path the child should treat as its home directory
 * @param base - Environment to derive from; defaults to this process's
 */
export function engineChildEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (upper === 'HOME' || upper === 'USERPROFILE') continue;
    env[key] = value;
  }
  env['HOME'] = home;
  env['USERPROFILE'] = home;
  return env;
}

/** Read the child's result file, or explain why there isn't one. */
function readChildResult(resultPath: string): EngineChildResult | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path created by this function's caller inside a fresh mkdtemp directory
    return JSON.parse(readFileSync(resultPath, 'utf8')) as EngineChildResult;
  } catch {
    return undefined;
  }
}

/** Compose the outcome for a child that produced no result file. */
function failedOutcome(
  request: EngineChildRequest,
  spawned: { status: number | null; signal: NodeJS.Signals | null; stderr: string },
  durationMs: number,
): EngineOutcome {
  const killed = spawned.signal !== null;
  const reason = killed
    ? `engine child was killed (${String(spawned.signal)}) — it overran its timeout, which is what a DuckDB extension cache miss looks like`
    : `engine child exited ${String(spawned.status)} without writing a result`;
  return {
    ok: false,
    batches: request.batches.map((batch) => ({ label: batch.label, ok: false, error: reason })),
    error: reason,
    killed,
    signal: spawned.signal,
    status: spawned.status,
    durationMs,
    stderr: spawned.stderr,
  };
}

/** Spawn one engine child and collect everything it reported. */
function runEngineChild(
  request: Omit<EngineChildRequest, 'resultPath'>,
  home: string,
  timeoutMs: number,
): EngineOutcome {
  if (home === '') {
    // An empty HOME makes os.homedir() return '' and the probe path go
    // CWD-relative — a miss, i.e. the hang. Refuse rather than discover that.
    throw new Error('Engine home directory must be a non-empty absolute path.');
  }
  const workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-parquet-engine-'));
  const requestPath = safePath.join(workDir, 'request.json');
  const resultPath = safePath.join(workDir, 'result.json');
  const full: EngineChildRequest = { ...request, resultPath };
  const started = Date.now();
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is inside a directory this function just created
    writeFileSync(requestPath, JSON.stringify(full), 'utf8');
    const spawned = spawnSync(
      process.execPath,
      // execArgv is forwarded so a loader-compiled parent (tsx) gets a
      // loader-compiled child; `--inspect*` is dropped because the child would
      // fight the parent for the debugger port.
      [...process.execArgv.filter((arg) => !arg.startsWith('--inspect')), engineChildEntry(), requestPath],
      {
        timeout: timeoutMs,
        killSignal: ENGINE_KILL_SIGNAL,
        env: engineChildEnv(home),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const durationMs = Date.now() - started;
    const stderr = (spawned.stderr ?? '').toString().trim();
    const result = readChildResult(resultPath);
    if (!result) {
      return failedOutcome(full, { status: spawned.status, signal: spawned.signal, stderr }, durationMs);
    }
    return {
      ok: result.ok,
      batches: result.batches,
      ...(result.receipt ? { receipt: result.receipt } : {}),
      ...(result.error === undefined ? {} : { error: result.error }),
      killed: false,
      signal: spawned.signal,
      status: spawned.status,
      durationMs,
      stderr,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Clamp a caller's timeout.
 *
 * `spawnSync({ timeout: 0 })` means **no timeout**, and `Number('')` is `0`, so
 * a value that arrived from an unset environment variable would silently
 * disable the only guard that can end a hung `LOAD`. Anything not strictly
 * positive falls back to {@link DEFAULT_ENGINE_TIMEOUT_MS}.
 */
export function effectiveEngineTimeout(requested: number | undefined): number {
  return requested !== undefined && requested > 0 ? requested : DEFAULT_ENGINE_TIMEOUT_MS;
}

/**
 * Run SQL against DuckDB with the parquet extension loaded, offline.
 *
 * Seeds the engine home from the bytes this package ships, then hands the whole
 * list of batches to a single child. See the module header for why both of
 * those are the way they are.
 *
 * @example
 * ```typescript
 * const outcome = runParquetSql([
 *   { label: 'resources', statements: [
 *     "COPY (SELECT * FROM read_json('/tmp/resources.json')) TO '/out/resources.parquet' (FORMAT parquet)",
 *   ] },
 * ]);
 * if (!outcome.ok) throw new Error(outcome.error);
 * ```
 */
export function runParquetSql(
  batches: readonly ParquetSqlBatch[],
  options: EngineOptions = {},
): EngineOutcome {
  const home = options.home ?? parquetEngineHome();

  if (options.seed !== false) {
    const seeded = seedExtensionHome({ home });
    if (seeded.failed.length > 0) {
      const reason = `could not seed the DuckDB parquet extension into ${home}: ${seeded.failed
        .map((failure) => `${failure.name}: ${failure.reason}`)
        .join('; ')}`;
      return {
        ok: false,
        batches: batches.map((batch) => ({ label: batch.label, ok: false, error: reason })),
        error: reason,
        killed: false,
        signal: null,
        status: null,
        durationMs: 0,
        stderr: '',
      };
    }
  }

  return runEngineChild(
    {
      mode: 'write',
      extensions: [],
      batches,
      ...(options.extensionRepositoryForTests === undefined
        ? {}
        : { extensionRepository: options.extensionRepositoryForTests }),
    },
    home,
    effectiveEngineTimeout(options.timeoutMs),
  );
}

export interface WarmOptions {
  /** Home the download must land under. Required — warming never touches the default cache. */
  readonly home: string;
  /** Extension names to download, e.g. `['parquet']`. */
  readonly extensions: readonly string[];
  readonly timeoutMs?: number;
  /** See {@link EngineOptions.extensionRepositoryForTests}. */
  readonly extensionRepositoryForTests?: string;
}

/**
 * ⚠️ **Build-time only.** Download extensions into `home` and report what the
 * engine says about itself.
 *
 * This is the one code path that is *allowed* to reach the network, and
 * therefore the one that can hang: it runs with autoload left at its defaults
 * and performs **no precheck**, because there is by definition nothing to
 * precheck yet. The timeout is the only guard, which is exactly why it is a
 * `spawnSync` child.
 *
 * The returned {@link EngineReceipt} is the gate a build script must check.
 * Asserting on the resulting file tree instead is not a gate: the glue creates
 * the directories before it looks for the file, so a build with the `LOAD`
 * deleted entirely still leaves a plausible-looking tree behind.
 */
export function warmExtensionDownload(options: WarmOptions): EngineOutcome {
  return runEngineChild(
    {
      mode: 'warm',
      extensions: options.extensions,
      batches: [],
      ...(options.extensionRepositoryForTests === undefined
        ? {}
        : { extensionRepository: options.extensionRepositoryForTests }),
    },
    options.home,
    effectiveEngineTimeout(options.timeoutMs),
  );
}

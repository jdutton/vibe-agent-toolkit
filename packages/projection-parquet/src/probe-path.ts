/**
 * Where duckdb-wasm looks for an extension on disk, and whether what is there
 * is worth handing to `LOAD`.
 *
 * ## The mechanism (read from the emscripten glue in `@duckdb/duckdb-wasm`, and
 * measured against it)
 *
 * When DuckDB resolves an extension it builds a URL and then takes the **last
 * four `/`-separated segments of that URL** to form a cache path under the
 * process's home directory:
 *
 * ```
 * os.homedir()/.duckdb/extensions/<repository-host>/<core-version>/<platform>/<name>.duckdb_extension.wasm
 * ```
 *
 * - **Hit** → `readFileSync`, no network at all.
 * - **Miss** → an eval'd `worker_threads.Worker` performs a `fetch` while the
 *   main thread blocks in **`Atomics.wait`**. That wait is uninterruptible: no
 *   timer, no `AbortController`, and no in-process guard can end it. A dead or
 *   captive-portal host does not make it fail — it makes it hang forever
 *   (measured: 15 s cap reached, killed externally).
 *
 * Two details make the naive checks useless, and both are measured:
 *
 * 1. The glue does `existsSync(dir) || mkdirSync(dir)` **before** it looks for
 *    the file, so **directory existence proves nothing** — a run that never
 *    loaded anything still leaves a complete-looking tree.
 * 2. The glue **never checks the HTTP status**; it writes the response body
 *    straight to the cache path. A 404 or proxy error page therefore *poisons*
 *    the cache permanently (measured: a 404 wrote a 15-byte file that then
 *    failed every subsequent load). That is why {@link MINIMUM_EXTENSION_BYTES}
 *    exists — `existsSync` alone would call that poisoned file a hit.
 *
 * ## Why the coordinates are never written down here
 *
 * `<core-version>` is DuckDB's **core** version (`pragma_version()`), not the
 * npm version of `@duckdb/duckdb-wasm`; an npm bump can move it with no signal
 * in our code. `<platform>` comes from `pragma_platform()` and names the **wasm
 * ABI** (`wasm_eh`), not the OS — which is why one captured file serves every
 * OS. Both are derived from the running engine and recorded, never declared:
 * a hardcoded version segment was measured to send the process straight back
 * into the un-killable wait.
 */

import { statSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/** Directory, relative to a home directory, that DuckDB caches extensions in. */
export const EXTENSION_CACHE_RELATIVE_DIR = '.duckdb/extensions';

/** Filename suffix every wasm extension carries in that cache. */
export const EXTENSION_FILE_SUFFIX = '.duckdb_extension.wasm';

/**
 * Size floor a seeded extension must clear before `LOAD` is allowed to see it.
 *
 * Not a guess: the genuine parquet extension measured 3,045,039 bytes, and the
 * failure this guards against — a cache poisoned by an unchecked HTTP error
 * body — measured 15 bytes. One megabyte sits far enough below the real file to
 * survive a future rebuild of it and far enough above an error page that no
 * error page can pass.
 */
export const MINIMUM_EXTENSION_BYTES = 1_048_576;

/**
 * The three URL segments that decide an extension's on-disk location.
 *
 * Every field is *discovered* — the host by walking the tree a real download
 * produced, the other two from the running engine — and then carried around as
 * data. Nothing in this package writes one down.
 */
export interface ExtensionCoordinates {
  /** Extension repository host, e.g. the segment a default download lands under. */
  readonly repositoryHost: string;
  /** DuckDB **core** version segment, from `pragma_version().library_version`. */
  readonly coreVersion: string;
  /** Wasm ABI token, from `pragma_platform()`. */
  readonly platform: string;
}

/**
 * Path of one extension relative to the `.duckdb/extensions` cache directory.
 *
 * @param coordinates - Discovered coordinates; see {@link ExtensionCoordinates}
 * @param extensionName - Bare extension name, e.g. `parquet`
 * @returns Forward-slashed relative path
 */
export function extensionRelativePath(
  coordinates: ExtensionCoordinates,
  extensionName: string,
): string {
  return safePath.join(
    coordinates.repositoryHost,
    coordinates.coreVersion,
    coordinates.platform,
    `${extensionName}${EXTENSION_FILE_SUFFIX}`,
  );
}

/**
 * The exact path duckdb-wasm will `readFileSync` for an extension.
 *
 * @param homeDir - What `os.homedir()` returns **in the process that will load**
 *   — not necessarily this process's home; the engine child runs with its own
 *   `HOME`/`USERPROFILE`
 * @param coordinates - Discovered coordinates
 * @param extensionName - Bare extension name, e.g. `parquet`
 */
export function extensionProbePath(
  homeDir: string,
  coordinates: ExtensionCoordinates,
  extensionName: string,
): string {
  return safePath.join(
    homeDir,
    EXTENSION_CACHE_RELATIVE_DIR,
    extensionRelativePath(coordinates, extensionName),
  );
}

/** What a seed check concluded. `ok: false` carries a reason fit for an error message. */
export type SeedVerdict = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly reason: string };

/** The subset of `fs.Stats` this check needs, so the decision itself stays pure. */
export interface SeedStat {
  readonly isFile: boolean;
  readonly size: number;
}

/**
 * Decide whether a stat result describes a usable seeded extension.
 *
 * Pure, and separated from the `stat` call on purpose: this is the rule that
 * keeps `LOAD` away from the un-killable wait, so it must be testable without a
 * filesystem. Absence is the only condition that hangs — every corruption
 * (zero-byte, truncated, one-bit-flipped, garbage, unreadable, a directory at
 * the path) was measured to fail clean through DuckDB's signature check in
 * ~500 ms. The size floor is here because a *poisoned* cache entry is neither
 * absent nor corrupt-looking: it is a small, perfectly readable error page.
 *
 * @param stat - `undefined` when the path could not be stat'ed at all
 */
export function classifyExtensionSeed(stat: SeedStat | undefined): SeedVerdict {
  if (stat === undefined) {
    return {
      ok: false,
      reason:
        'no extension file at the probe path — this is the ONE condition that makes ' +
        'LOAD block forever in Atomics.wait, so the load is refused instead',
    };
  }
  if (!stat.isFile) {
    return { ok: false, reason: 'probe path exists but is not a regular file' };
  }
  if (stat.size < MINIMUM_EXTENSION_BYTES) {
    return {
      ok: false,
      reason: `extension file is ${stat.size} bytes, below the ${MINIMUM_EXTENSION_BYTES}-byte floor (a poisoned cache entry written from an unchecked HTTP error body looks exactly like this)`,
    };
  }
  return { ok: true, bytes: stat.size };
}

/**
 * Stat a probe path and classify it. Thin I/O wrapper over
 * {@link classifyExtensionSeed} — all of the judgement lives there.
 */
export function verifyExtensionSeed(probePath: string): SeedVerdict {
  let stat: SeedStat | undefined;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from the engine's own coordinates, not from user input
    const stats = statSync(probePath);
    stat = { isFile: stats.isFile(), size: stats.size };
  } catch {
    stat = undefined;
  }
  return classifyExtensionSeed(stat);
}

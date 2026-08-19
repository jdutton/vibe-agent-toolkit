/**
 * Builds a package with tsc while keeping its `dist/` continuously readable.
 *
 * A package's `dist/` is read by other processes *while* it is being written.
 * Turbo runs `build` tasks concurrently; every package's build script itself
 * imports `@vibe-agent-toolkit/utils` out of `dist/` just to start up; and the
 * generated CLI binary that some build steps invoke loads a dozen packages'
 * `dist/`. Deleting `dist/` and re-emitting it therefore opens a window seconds
 * wide in which a reader sees no module at all (`ERR_MODULE_NOT_FOUND`) or a
 * barrel whose re-export target has not been written back yet ("does not
 * provide an export named X"). Both were observed in CI, naming a different
 * package and a different symbol each run — the signature of a schedule, not of
 * a broken export.
 *
 * So this script never deletes `dist/`, and it never lets the compiler write
 * into `dist/` either. Overwriting in place is not enough: `tsc` writes an
 * output file with a plain truncate-then-write, so between the truncate and the
 * write the file is **zero bytes on disk**, and a reader that imports it in that
 * instant gets the very "does not provide an export named X" this script exists
 * to prevent. Measured on a 12-module fixture, a sampler polling at
 * `setImmediate` cadence caught a zero-byte `dist/index.js` in 9 of 24 rebuilds;
 * the real barrels are 10-30x larger than that fixture's, so the production
 * window is wider still.
 *
 * Instead the compiler emits into a staging directory beside `dist/`, and each
 * emitted file is then `rename(2)`d into place. A rename within one filesystem
 * is atomic: a concurrent reader opens either the previous complete file or the
 * new complete file, never a half-written one. What a reader can still observe
 * is a *mixture* of old and new complete files while promotion runs — so
 * promotion orders the compiler's own barrels (`index.*`) last, deepest paths
 * first, which is the order that keeps a barrel from pointing at a re-export
 * target that has not landed yet.
 *
 * This is a per-FILE rename, never a swap of the `dist/` directory itself. A
 * directory swap looks equivalent and is not: a reader that already resolved a
 * path into the old directory keeps reading a detached inode and silently
 * diverges from the build, and on Windows renaming or removing a directory whose
 * files another process holds open fails outright with `EPERM`/`EBUSY`.
 *
 * Three properties of the staging directory are load-bearing, not incidental:
 *
 *   - It sits **beside `dist/`, inside the package** — same filesystem, because
 *     `rename(2)` is only atomic within one, and a temp-dir staging area may
 *     well be on another.
 *   - It sits at the **same depth as `dist/`**, so nothing about a file's
 *     contents depends on which of the two it was written to. `sources` inside
 *     `*.js.map`/`*.d.ts.map` are relative to the map file (`../src/x.ts` either
 *     way) — and `pruneStaleEmit` below reads exactly that field. Same depth also
 *     leaves the default `tsBuildInfoFile` where it already was: TypeScript
 *     derives it as `resolve(outDir, relative(rootDir, <config path minus
 *     extension>))`, which for every package here resolves to
 *     `<package>/tsconfig.tsbuildinfo` whether `outDir` is `dist` or the staging
 *     directory. That is the path turbo caches.
 *   - Its name **starts with a dot**, so TypeScript's wildcard `include`
 *     resolution — which skips dot-prefixed directories — cannot sweep the staged
 *     `.d.ts` files back into the program as sources.
 *
 * Because the compiler is incremental, a rebuild with no source change emits
 * nothing, staging stays empty, and not one file in `dist/` is touched. A
 * rebuild with one changed module emits only what that change invalidated. The
 * staging directory does not make a build less incremental; it only decides where
 * the emit lands first.
 *
 * Pruning is what the delete was really for. TypeScript's incremental build
 * (and even `tsc --build --clean`) cannot remove the emitted output of a source
 * file that has been deleted from the project, because the compiler only tracks
 * files still in its graph. Left alone, that orphan is captured verbatim into
 * turbo's `dist/**` cache, and no later `rm -rf dist` can dislodge it: the input
 * hash is unchanged, so turbo simply restores the poisoned entry.
 *
 * The orphan test is the declaration map rather than a guess about layout.
 * Every package compiles with `declarationMap`, so `dist/x/y.d.ts.map` records
 * the source it came from; if that source is gone, the whole
 * `y.{js,js.map,d.ts,d.ts.map}` group is dead. Output with no declaration map
 * is by construction not a compiler emit — the YAML assets `copy-yaml-assets.ts`
 * copies, the JSON schemas `generate:schemas` writes, the CLI's `dist/bin/vat`
 * shim from `prepare-bin.ts` — and is left alone. Those steps run *after* this
 * one and write into the same `dist/`, so anything that discarded their output
 * would break the build outright.
 *
 * `*.tsbuildinfo` is kept for the same reason: deleting it forces tsc to rewrite
 * every output file even when nothing changed, which is exactly the traffic that
 * makes the window above easy to hit. It is dropped only when `dist/` is missing,
 * because an incremental build trusts a leftover buildinfo and would then skip
 * re-emitting files that are not on disk.
 *
 * Invoked from a package's build script, run from the package directory:
 *   "build": "tsx ../dev-tools/src/tsc-clean-build.ts"
 *   "build": "tsx ../dev-tools/src/tsc-clean-build.ts --compiler=tspc"
 *
 * `--compiler=<name>` selects a PATH-resolved drop-in tsc replacement (e.g. `tspc`
 * for ts-patch-based transformers); it's stripped before the remaining args are
 * passed through to the compiler. Defaults to `tsc`.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { rimrafSync } from 'rimraf';

/* eslint-disable security/detect-non-literal-fs-filename -- every path is derived from the package root this script was invoked in */

const COMPILER_FLAG_PREFIX = '--compiler=';
const DECLARATION_MAP_SUFFIX = '.d.ts.map';

/**
 * Where the compiler is pointed instead of `dist/`. Beside `dist/`, same depth,
 * dot-prefixed — see this file's header for why each of those three is required.
 */
const STAGING_DIR_NAME = '.tsc-staging';

/** The four files tsc emits per source module in this repo's compiler settings. */
const EMIT_SUFFIXES = ['.js', '.js.map', '.d.ts', '.d.ts.map'] as const;

/**
 * Backoff schedule, in milliseconds, for a rename the OS refuses because the
 * destination is open elsewhere. See {@link replaceAtomically}. Six attempts
 * spanning ~93ms: long enough to outlast a reader that is merely reading a file,
 * short enough that a genuinely stuck destination does not stall the build.
 */
const RENAME_RETRY_BACKOFF_MS = [1, 2, 5, 10, 25, 50] as const;

/** The errno values Windows raises for "the destination is open in another process". */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function collectFiles(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = safePath.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, into);
    else if (entry.isFile()) into.push(full);
  }
}

/**
 * Absolute path of the source a declaration map was generated from, or
 * `undefined` when the map is unreadable or shaped unexpectedly — in which case
 * the caller must leave the output alone rather than guess.
 */
function declaredSource(mapPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mapPath, 'utf8'));
    const sources: unknown = (parsed as { sources?: unknown }).sources;
    const first: unknown = Array.isArray(sources) ? sources[0] : undefined;
    return typeof first === 'string' ? safePath.resolve(mapPath, '..', first) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deletes compiler output whose source file no longer exists.
 *
 * @returns The removed paths, in deletion order.
 */
export function pruneStaleEmit(packageRoot: string): string[] {
  const distDir = safePath.join(packageRoot, 'dist');
  if (!existsSync(distDir)) return [];

  const files: string[] = [];
  collectFiles(distDir, files);

  const removed: string[] = [];
  for (const mapPath of files) {
    if (!mapPath.endsWith(DECLARATION_MAP_SUFFIX)) continue;
    const source = declaredSource(mapPath);
    if (source === undefined || existsSync(source)) continue;

    const base = mapPath.slice(0, -DECLARATION_MAP_SUFFIX.length);
    for (const suffix of EMIT_SUFFIXES) {
      const victim = `${base}${suffix}`;
      if (!existsSync(victim)) continue;
      rmSync(victim);
      removed.push(victim);
    }
  }
  return removed;
}

/**
 * Brings `dist/` to a state tsc can emit into without ever making it
 * unreadable: dead output pruned, and the buildinfo dropped only when there is
 * no output for it to describe.
 *
 * @returns The removed paths, in deletion order.
 */
export function prepareForBuild(packageRoot: string): string[] {
  if (!existsSync(safePath.join(packageRoot, 'dist'))) {
    rimrafSync(safePath.join(packageRoot, '*.tsbuildinfo'), { glob: true });
    return [];
  }
  return pruneStaleEmit(packageRoot);
}

/** The directory the compiler emits into before anything is promoted into `dist/`. */
export function stagingDir(packageRoot: string): string {
  return safePath.join(packageRoot, STAGING_DIR_NAME);
}

/**
 * Removes the staging directory. Called before the compiler runs as well as
 * after: a build killed mid-promotion (Ctrl-C, an OOM, a turbo task cancelled
 * when a sibling fails) leaves staged files behind, and promoting *those* on the
 * next run would publish output the current sources never produced.
 */
export function discardStaging(packageRoot: string): void {
  rmSync(stagingDir(packageRoot), { recursive: true, force: true });
}

/**
 * Blocks the calling thread. Everything on the promotion path is synchronous —
 * a timer would never fire — so this waits on a `SharedArrayBuffer` nothing ever
 * notifies, which is the only synchronous sleep Node offers.
 */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Moves one emitted file onto its destination so no reader can ever observe the
 * destination incomplete.
 *
 * `rename(2)` gives that for free on POSIX. **Windows does not**, and that is the
 * whole reason this function is more than one line: `MoveFileEx` fails with
 * `EPERM`/`EBUSY` when the destination is open in another process, and Node's
 * `readFileSync` does not open with `FILE_SHARE_DELETE`, so every concurrent
 * reader this script exists to protect is also a reader that can make the rename
 * fail. That hazard is exactly why the previous design chose to overwrite in
 * place. A reader holds a `dist/` file open for microseconds, so the collision is
 * rare and self-clearing; the bounded backoff above rides it out.
 *
 * **When the retries are exhausted** the file is copied over the destination
 * instead — which is precisely the truncate-then-write the rest of this file
 * exists to avoid, and is therefore a deliberate, announced degradation to the
 * behaviour this script had before staging existed. It is the better of the two
 * bad options: trading a rare zero-byte read for a rare *hard build failure*
 * would be a worse trade on the platform carrying most of the risk. The warning
 * names the file so a repeat offender is diagnosable rather than invisible.
 */
function replaceAtomically(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RENAME_RETRY_CODES.has(code)) throw error;
      const backoff = RENAME_RETRY_BACKOFF_MS[attempt];
      if (backoff === undefined) {
        process.stderr.write(
          `tsc-clean-build: rename onto ${to} kept failing (${code}) after ` +
            `${String(RENAME_RETRY_BACKOFF_MS.length)} attempts; copying in place instead. ` +
            'A reader importing that file at this instant can see it empty.\n',
        );
        copyFileSync(from, to);
        rmSync(from, { force: true });
        return;
      }
      sleepSync(backoff);
    }
  }
}

/**
 * How many directories deep a relative path sits. `safePath.relative` returns
 * forward slashes on every platform, so counting them needs no `path` call.
 */
function depthOf(relativePath: string): number {
  return (relativePath.match(/\//gu) ?? []).length;
}

/** Whether an emitted file is one of the compiler's own barrels. */
function isBarrel(relativePath: string): boolean {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1).startsWith('index.');
}

/**
 * Promotion order: every non-barrel before any barrel, and deeper paths before
 * shallower ones. A barrel is the file whose re-export targets must already be
 * on disk — publishing it first is what produces "does not provide an export
 * named X" in a reader. Ties break on the path so the order is deterministic.
 */
function comparePromotionOrder(a: string, b: string): number {
  const barrelDelta = Number(isBarrel(a)) - Number(isBarrel(b));
  if (barrelDelta !== 0) return barrelDelta;
  const depthDelta = depthOf(b) - depthOf(a);
  if (depthDelta !== 0) return depthDelta;
  return a.localeCompare(b);
}

/**
 * Moves everything the compiler emitted into staging across into `dist/`.
 *
 * A staged `*.tsbuildinfo` is deliberately *not* promoted. Under every package's
 * settings the compiler writes it to the package root, not under `outDir` (see
 * the header) — but if a future TypeScript changed that derivation, promoting it
 * into `dist/` would put it where neither this script's `*.tsbuildinfo` handling
 * nor turbo's cache looks for it. Dropping it instead costs incrementality, which
 * is slow and correct, rather than correctness, which is neither.
 *
 * @returns The destination paths written, in promotion order.
 */
export function promoteStagedEmit(packageRoot: string): string[] {
  const staging = stagingDir(packageRoot);
  if (!existsSync(staging)) return [];

  const staged: string[] = [];
  collectFiles(staging, staged);

  const distDir = safePath.join(packageRoot, 'dist');
  const relativePaths = staged
    .map((file) => safePath.relative(staging, file))
    .filter((relativePath) => !relativePath.endsWith('.tsbuildinfo'))
    .sort(comparePromotionOrder);

  // Every parent directory up front: a `mkdirSync` between two renames is time
  // spent with `dist/` half-promoted, and it is the same handful of directories
  // over and over.
  const parents = new Set(
    relativePaths.map((relativePath) => safePath.join(distDir, relativePath, '..')),
  );
  for (const parent of parents) mkdirSyncReal(parent, { recursive: true });

  const promoted: string[] = [];
  for (const relativePath of relativePaths) {
    const destination = safePath.join(distDir, relativePath);
    replaceAtomically(safePath.join(staging, relativePath), destination);
    promoted.push(destination);
  }
  return promoted;
}

/**
 * Runs the compiler against staging and promotes what it emitted.
 *
 * Promotion runs even when the compiler exits non-zero, because that is what
 * already happened: no package sets `noEmitOnError`, so a build with type errors
 * emits its output *and* fails, and discarding that output here would be a
 * behaviour change smuggled in alongside an atomicity fix. If promotion itself
 * then throws, its error is the one that surfaces — the compiler's diagnostics
 * were already written straight to the terminal by `stdio: 'inherit'`, so nothing
 * is lost.
 */
export function buildPackage(packageRoot: string, compiler: string, compilerArgs: string[]): void {
  prepareForBuild(packageRoot);
  discardStaging(packageRoot);
  try {
    safeExecSync(compiler, [...compilerArgs, '--outDir', stagingDir(packageRoot)], {
      cwd: packageRoot,
      stdio: 'inherit',
    });
  } finally {
    try {
      promoteStagedEmit(packageRoot);
    } finally {
      discardStaging(packageRoot);
    }
  }
}

export function parseArgs(argv: string[]): { compiler: string; compilerArgs: string[] } {
  if (argv.includes('--build')) {
    throw new Error(
      "tsc-clean-build: `--build` is refused. In --build mode tsc follows tsconfig `references` and emits into *other* packages' dist/, " +
        "outside turbo's task ordering — two packages can then write the same dist/ at once, and a third can read it mid-write. " +
        'Turbo already builds dependencies first, so compile only this package.',
    );
  }
  const compilerFlag = argv.find((arg) => arg.startsWith(COMPILER_FLAG_PREFIX));
  const compiler = compilerFlag ? compilerFlag.slice(COMPILER_FLAG_PREFIX.length) : 'tsc';
  const compilerArgs = argv.filter((arg) => !arg.startsWith(COMPILER_FLAG_PREFIX));
  return { compiler, compilerArgs };
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageRoot = process.cwd();
  const { compiler, compilerArgs } = parseArgs(process.argv.slice(2));
  buildPackage(packageRoot, compiler, compilerArgs);
}

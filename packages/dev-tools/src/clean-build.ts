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
 * A fourth property is load-bearing and this design **cannot** preserve it:
 * `outDir` IDENTITY. While `outDir` is `dist`, TypeScript recognises
 * `dist/index.d.ts` as the running project's own declaration output and redirects
 * any import of it back to `src` — so a file that imports its OWN package by name
 * resolves with no `dist/` on disk at all. Overriding `--outDir` to the staging
 * directory moves the project's output path, the redirect is gone, tsc looks for
 * a literal `dist/index.d.ts`, and a tree that has never been built has none:
 *
 *   error TS2307: Cannot find module '@scope/foo' …            (plus knock-on TS2339s)
 *
 * Depth, filesystem and dot-prefix are all preserved above; this one is not, and
 * it cannot be — the whole point is that emit lands somewhere other than `dist`.
 * So the constraint lands on the SOURCES instead: no file may import the package
 * it lives in by that package's own name. `local/no-self-package-import` (in
 * `@vibe-agent-toolkit/utils/eslint`, scoped in `eslint.config.js` to every
 * package's compiled `src` tree) is what holds that line, and it exists because
 * this override exposed exactly two such imports that had been latent for as long
 * as they had been written.
 *
 * That failure is also invisible to any tree that has built before — a stale
 * `dist/` satisfies the literal lookup, so the build passes by typechecking
 * against the PREVIOUS build's declarations. In a worktree nested inside the main
 * checkout it is worse: resolution walks up past the worktree and satisfies the
 * lookup from the PARENT checkout's `dist/`. Neither tree can reproduce it. Only
 * a pristine clone, or CI, can.
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
 * Invoked through `tsc-clean-build.ts`, the thin CLI beside this module, from a
 * package's build script run in the package directory:
 *   "build": "tsx ../dev-tools/src/tsc-clean-build.ts"
 *   "build": "tsx ../dev-tools/src/tsc-clean-build.ts --compiler=tspc"
 *
 * `--compiler=<name>` selects a PATH-resolved drop-in tsc replacement (e.g. `tspc`
 * for ts-patch-based transformers); it's stripped before the remaining args are
 * passed through to the compiler. Defaults to `tsc`.
 *
 * 🔑 **Dependency-free on purpose.** `@vibe-agent-toolkit/utils` is built by this
 * script too, and on a clean clone its `dist/` does not exist until it has been —
 * so this module imports nothing from the workspace. While it did, `utils` alone
 * kept a `rimraf dist && tsc` build, which is precisely the delete-then-emit this
 * whole file exists to prevent, on the one package all twenty-four others read.
 */

/* eslint-disable local/no-raw-node-path, local/no-fs-mkdirSync -- Bootstrap: this is the build script of `@vibe-agent-toolkit/utils` itself, so it cannot import `safePath`/`mkdirSyncReal` from a `dist/` it has not produced yet; `fwd()` below does the forward-slash normalisation those wrappers exist for */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import which from 'which';


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

/**
 * Forward-slash form of a NATIVE path. The `safePath.*` wrappers this script
 * cannot import (see the header) are `node:path` plus exactly this
 * normalisation — `toForwardSlash`'s: convert only where the host's separator
 * is a backslash, because on POSIX a backslash is a filename character. The
 * ordering logic below counts `/` and reads basenames, so every path it
 * compares goes through here first.
 */
function fwd(path: string): string {
  return sep === '/' ? path : path.replaceAll(sep, '/');
}

/** The filesystem saying "nothing here", as opposed to "I could not". */
function isPathAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Delete every `*.tsbuildinfo` directly under `packageRoot`. */
function removeBuildInfo(packageRoot: string): void {
  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    // The link question first, on this binding: a linked `.tsbuildinfo` is not ours to remove.
    if (!entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
      rmSync(fwd(join(packageRoot, entry.name)), { force: true });
    }
  }
}

function collectFiles(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = fwd(join(dir, entry.name));
    // Not followed: these are build outputs about to be removed, and a link is
    // one entry to remove, not a tree to walk. (Inline rather than utils'
    // `direntKind`, because this script must run before utils is built.)
    if (entry.isSymbolicLink() || entry.isFile()) into.push(full);
    else if (entry.isDirectory()) collectFiles(full, into);
  }
}

/**
 * Absolute path of the source a declaration map was generated from, or
 * `undefined` when the map is not JSON or shaped unexpectedly — in which case
 * the caller must leave the output alone rather than guess. A map that has
 * vanished since the listing (a concurrent build swapping dist) is the same
 * "nothing to go on" case. A map the OS REFUSES to read is not: that throws,
 * because leaving the output alone there would let a permissions accident
 * keep dead emit alive with no sign anything was skipped.
 */
function declaredSource(mapPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(mapPath, 'utf8');
  } catch (error) {
    if (isPathAbsent(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const sources: unknown = (parsed as { sources?: unknown } | null)?.sources;
  const first: unknown = Array.isArray(sources) ? sources[0] : undefined;
  return typeof first === 'string' ? fwd(resolve(mapPath, '..', first)) : undefined;
}

/**
 * Deletes compiler output whose source file no longer exists.
 *
 * @returns The removed paths, in deletion order.
 */
export function pruneStaleEmit(packageRoot: string): string[] {
  const distDir = fwd(join(packageRoot, 'dist'));
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
  if (!existsSync(fwd(join(packageRoot, 'dist')))) {
    removeBuildInfo(packageRoot);
    return [];
  }
  return pruneStaleEmit(packageRoot);
}

/** The directory the compiler emits into before anything is promoted into `dist/`. */
export function stagingDir(packageRoot: string): string {
  return fwd(join(packageRoot, STAGING_DIR_NAME));
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
 * How many directories deep a relative path sits. Every relative path here
 * has been through {@link fwd}, so counting slashes needs no `path` call.
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

  const distDir = fwd(join(packageRoot, 'dist'));
  const relativePaths = staged
    .map((file) => fwd(relative(staging, file)))
    .filter((relativePath) => !relativePath.endsWith('.tsbuildinfo'))
    .sort(comparePromotionOrder);

  // Every parent directory up front: a `mkdirSync` between two renames is time
  // spent with `dist/` half-promoted, and it is the same handful of directories
  // over and over.
  const parents = new Set(
    relativePaths.map((relativePath) => fwd(join(distDir, relativePath, '..'))),
  );
  for (const parent of parents) mkdirSync(parent, { recursive: true });

  const promoted: string[] = [];
  for (const relativePath of relativePaths) {
    const destination = fwd(join(distDir, relativePath));
    replaceAtomically(fwd(join(staging, relativePath)), destination);
    promoted.push(destination);
  }
  return promoted;
}

/**
 * Spawns the compiler with the argument list, no shell in the way, and throws
 * on a non-zero exit so the build script fails the way `tsc` did.
 *
 * `which` resolves the bare name to a path the same way `safeExecSync` does.
 * On Windows that path is the `.cmd` shim `npm`/`bun` install, which only
 * `cmd.exe` can run — so that platform gets one quoted command line through
 * the shell. Every argument this script passes is a flag or a path, so the
 * quoting is a pair of double quotes around anything carrying whitespace.
 */
function runCompiler(packageRoot: string, compiler: string, args: string[]): void {
  const commandPath = which.sync(compiler);
  const needsShell = /\.(?:cmd|bat)$/i.test(commandPath);
  const quote = (arg: string): string => (/\s/.test(arg) ? `"${arg}"` : arg);
  const result = needsShell
    ? spawnSync([commandPath, ...args].map(quote).join(' '), { cwd: packageRoot, stdio: 'inherit', shell: true })
    : spawnSync(commandPath, args, { cwd: packageRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const how = result.status === null ? `signal ${result.signal ?? 'unknown'}` : `status ${result.status}`;
    throw new Error(`${compiler} exited with ${how}`);
  }
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
    runCompiler(packageRoot, compiler, [...compilerArgs, '--outDir', stagingDir(packageRoot)]);
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

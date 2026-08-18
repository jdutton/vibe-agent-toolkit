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
 * So this script never deletes `dist/`. It removes only genuinely dead output
 * and lets tsc overwrite the rest in place, so a concurrent reader sees the
 * previous complete build right up until each individual file is replaced,
 * rather than an empty directory. That is a much narrower window than a swap
 * into place could give: a directory rename is not atomic on any OS, and on
 * Windows renaming or removing a directory whose files another process holds
 * open fails outright with `EPERM`/`EBUSY` — precisely the situation here.
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

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { rimrafSync } from 'rimraf';

/* eslint-disable security/detect-non-literal-fs-filename -- every path is derived from the package root this script was invoked in */

const COMPILER_FLAG_PREFIX = '--compiler=';
const DECLARATION_MAP_SUFFIX = '.d.ts.map';

/** The four files tsc emits per source module in this repo's compiler settings. */
const EMIT_SUFFIXES = ['.js', '.js.map', '.d.ts', '.d.ts.map'] as const;

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

export function buildPackage(packageRoot: string, compiler: string, compilerArgs: string[]): void {
  prepareForBuild(packageRoot);
  safeExecSync(compiler, compilerArgs, { cwd: packageRoot, stdio: 'inherit' });
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

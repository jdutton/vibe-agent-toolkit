/**
 * Deletes a package's stale dist/ and *.tsbuildinfo before invoking tsc.
 *
 * TypeScript's incremental --build mode (and even `tsc --build --clean`) cannot
 * prune emitted output for a source file that's been deleted from the project —
 * the compiler only tracks files still in its current graph, so a stale .js left
 * over from a removed .ts survives every incremental rebuild and every --clean.
 * Left alone, that orphan gets captured verbatim into turbo's cache the next time
 * turbo snapshots `dist/**`, so even `rm -rf dist` can't dislodge it afterward —
 * the input hash is unchanged, so turbo just restores the poisoned cache entry.
 * Starting every real tsc invocation from a clean slate closes both holes at
 * the source: a genuine cache miss can never again bake an orphan into the cache.
 *
 * Invoked from a package's build script, run from the package directory:
 *   "build": "tsx ../dev-tools/src/tsc-clean-build.ts"
 *   "build": "tsx ../dev-tools/src/tsc-clean-build.ts --build"
 *   "build": "tsx ../dev-tools/src/tsc-clean-build.ts --compiler=tspc"
 *
 * `--compiler=<name>` selects a PATH-resolved drop-in tsc replacement (e.g. `tspc`
 * for ts-patch-based transformers); it's stripped before the remaining args are
 * passed through to the compiler. Defaults to `tsc`.
 */

import { pathToFileURL } from 'node:url';

import { safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { rimrafSync } from 'rimraf';

const COMPILER_FLAG_PREFIX = '--compiler=';

export function cleanBuildArtifacts(packageRoot: string): void {
  const distDir = safePath.join(packageRoot, 'dist');
  const tsbuildinfoGlob = safePath.join(packageRoot, '*.tsbuildinfo');
  rimrafSync([distDir, tsbuildinfoGlob], { glob: true });
}

export function cleanAndBuild(packageRoot: string, compiler: string, compilerArgs: string[]): void {
  cleanBuildArtifacts(packageRoot);
  safeExecSync(compiler, compilerArgs, { cwd: packageRoot, stdio: 'inherit' });
}

export function parseArgs(argv: string[]): { compiler: string; compilerArgs: string[] } {
  const compilerFlag = argv.find((arg) => arg.startsWith(COMPILER_FLAG_PREFIX));
  const compiler = compilerFlag ? compilerFlag.slice(COMPILER_FLAG_PREFIX.length) : 'tsc';
  const compilerArgs = argv.filter((arg) => !arg.startsWith(COMPILER_FLAG_PREFIX));
  return { compiler, compilerArgs };
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageRoot = process.cwd();
  const { compiler, compilerArgs } = parseArgs(process.argv.slice(2));
  cleanAndBuild(packageRoot, compiler, compilerArgs);
}

/**
 * Packaging pin for published tarballs whose contents are not obvious from the
 * source tree: `@vibe-agent-toolkit/cli` (which must NOT ship two `dist/`
 * directories) and `@vibe-agent-toolkit/projection-parquet` (which MUST ship a
 * binary its build downloaded).
 *
 * `src/pipeline-oracles/` and `src/qa-snapshot/` are this repo's correctness-oracle
 * TEST instrumentation. They deliberately live under `src/` — that is what keeps them
 * inside `tsc --build`, i.e. typechecked (test files in this repo are not) — but they
 * have zero production callers and no adopter should ever download their compiled
 * output. `package.json`'s `files` array therefore negates the two `dist/` directories,
 * and this test is what stops that negation from silently rotting.
 *
 * Why `npm pack --dry-run --json` and not a re-derivation from the `files` globs: npm's
 * packer is the only authority on what actually ships. Re-implementing its glob +
 * ignore-rule semantics here would pin our model of npm, not npm.
 *
 * ## Two traps this test is shaped around
 *
 * 1. **`--prefix <dir>` does NOT retarget the package.** `npm pack --dry-run --prefix
 *    packages/cli`, run from the monorepo root, packs the ROOT workspace (~1,900
 *    entries) while looking entirely plausible. The package under test is selected by
 *    the CHILD PROCESS'S `cwd`, and the reported-name assertion below is what kills
 *    this whole class of error — a test that packed the wrong package would still see
 *    zero `dist/pipeline-oracles/` entries and pass vacuously.
 *
 * 2. **A zero-assertion needs a positive control.** "No entry starts with X" is also
 *    true of an empty file list, a silently mis-parsed report, or the wrong package.
 *    The positive control asserts that the things which MUST ship are present and
 *    non-empty.
 *
 * ## Why this fails loudly instead of skipping when `dist/` is missing
 *
 * `npm pack` runs no build (the CLI package declares no `prepack`), so an unbuilt
 * `dist/` would produce a tarball in which the negations are trivially satisfied.
 * Skipping in that state would turn the pin into a no-op exactly when it is least
 * trustworthy, and a system test that silently skips in CI is worse than one that
 * fails. This suite runs after a build; if `dist/` is absent that is a real problem,
 * and the thrown error says how to fix it.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeExecSync, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

/** The `packages/cli` directory — the package whose tarball is under test. */
const PACKAGE_DIR = safePath.resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** `packages/projection-parquet` — the second tarball pinned here; see the header. */
const PROJECTION_PARQUET_DIR = safePath.resolve(PACKAGE_DIR, '../projection-parquet');

/** Compiled test instrumentation that must never reach an adopter's node_modules. */
const EXCLUDED_PREFIXES = ['dist/pipeline-oracles/', 'dist/qa-snapshot/'] as const;

/** `npm pack --dry-run --json` output, reduced to the fields asserted below. */
interface PackReport {
  name: string;
  entryCount: number;
  unpackedSize: number;
  files: { path: string; size: number }[];
}

/** A captured report plus its entry paths, forward-slashed once at capture. */
interface CapturedPack {
  report: PackReport;
  packedPaths: string[];
}

let cliPack: CapturedPack;
let parquetPack: CapturedPack;

/** Packed entry paths starting with `prefix`. */
function entriesUnder(pack: CapturedPack, prefix: string): string[] {
  // `packedPaths` is already forward-slashed at capture, but the comparison site is
  // where the rule can see that — normalising again here is idempotent and keeps the
  // Windows guarantee local to the comparison rather than to a distant assignment.
  return pack.packedPaths.filter((packedPath) => toForwardSlash(packedPath).startsWith(prefix));
}

/**
 * Run `npm pack --dry-run --json` for one package.
 *
 * @param packageDir - Selects the package: cwd, NOT `--prefix`. See the header.
 * @param buildHint - Printed when `dist/` is absent, because a tarball with no
 *   build output satisfies every assertion here vacuously.
 */
function capturePack(packageDir: string, buildHint: string): CapturedPack {
  const distDir = safePath.join(packageDir, 'dist');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this test file's own location, not from input
  if (!existsSync(distDir)) {
    throw new Error(
      `${distDir} does not exist, so "npm pack" would report a tarball with no build ` +
        `output and every assertion about it would pass vacuously. Build first: ${buildHint}`,
    );
  }

  // `safeExecSync` resolves `npm` on PATH and handles the Windows `npm.cmd` shell
  // wrapper, so this is not a hand-rolled platform branch.
  const stdout = safeExecSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  }).toString();

  const parsed = JSON.parse(stdout) as PackReport[];
  const first = parsed[0];
  if (!first) {
    throw new Error(`npm pack --dry-run --json reported nothing (stdout: ${stdout.slice(0, 500)})`);
  }
  return { report: first, packedPaths: first.files.map((file) => toForwardSlash(file.path)) };
}

beforeAll(() => {
  cliPack = capturePack(PACKAGE_DIR, 'bunx tsc --build packages/cli/tsconfig.json');
  parquetPack = capturePack(
    PROJECTION_PARQUET_DIR,
    'cd packages/projection-parquet && bun run build (its build DOWNLOADS the extension bytes)',
  );
}, 180_000);

describe('published @vibe-agent-toolkit/cli tarball', () => {
  it('packs the CLI package itself, not the surrounding workspace', () => {
    expect(cliPack.report.name).toBe('@vibe-agent-toolkit/cli');
    expect(cliPack.packedPaths.length).toBe(cliPack.report.entryCount);
    expect(cliPack.report.unpackedSize).toBeGreaterThan(0);
  });

  // POSITIVE CONTROL for the exclusion assertions below: without it, packing the wrong
  // package, an empty file list, or a silently mis-parsed report would all satisfy
  // "no entry starts with dist/pipeline-oracles/".
  it('still ships the real CLI: bin, commands, docs and README', () => {
    expect(cliPack.packedPaths).toContain('dist/bin/vat.js');
    expect(cliPack.packedPaths).toContain('README.md');
    expect(entriesUnder(cliPack, 'dist/bin/').length).toBeGreaterThan(0);
    expect(entriesUnder(cliPack, 'dist/commands/').length).toBeGreaterThan(100);
    expect(entriesUnder(cliPack, 'docs/').length).toBeGreaterThan(0);

    // Non-empty, not merely present — a zero-byte entry would otherwise read as shipped.
    const binEntry = cliPack.report.files.find((file) => toForwardSlash(file.path) === 'dist/bin/vat.js');
    expect(binEntry?.size).toBeGreaterThan(0);
  });

  // Plain `for` over `it`, not `it.each`: `it.each` supplies no TestContext, so any
  // later per-case gating written here would throw on the one platform that needs it.
  for (const prefix of EXCLUDED_PREFIXES) {
    it(`ships no ${prefix} entries`, () => {
      expect(entriesUnder(cliPack, prefix)).toEqual([]);
    });
  }
});

/**
 * The parquet package ships something no source tree shows: a ~3 MB DuckDB
 * extension its build step downloaded into `dist/`. If npm drops it, nothing
 * fails until an adopter's first `LOAD` — offline, that is an uninterruptible
 * hang rather than an error, which is exactly why it is pinned here.
 */
describe('published @vibe-agent-toolkit/projection-parquet tarball', () => {
  it('packs the parquet package itself, not the surrounding workspace', () => {
    expect(parquetPack.report.name).toBe('@vibe-agent-toolkit/projection-parquet');
    expect(parquetPack.packedPaths.length).toBe(parquetPack.report.entryCount);
    expect(parquetPack.report.unpackedSize).toBeGreaterThan(0);
  });

  it('ships the engine, its child, and the extension manifest', () => {
    expect(parquetPack.packedPaths).toContain('dist/index.js');
    expect(parquetPack.packedPaths).toContain('dist/engine.js');
    // The child is spawned by path, never imported — a packer that dropped it
    // would leave an engine that cannot start.
    expect(parquetPack.packedPaths).toContain('dist/engine-child.js');
    expect(parquetPack.packedPaths).toContain('dist/duckdb-extension-manifest.json');
    expect(parquetPack.packedPaths).toContain('README.md');
  });

  it('ships the captured extension binary, whole', () => {
    const extensions = entriesUnder(parquetPack, 'dist/duckdb-extensions/');
    expect(extensions.length).toBeGreaterThan(0);

    // Every captured file must be a real binary, not a placeholder: the failure
    // this guards against (a truncated or empty seed) is silent until load time.
    for (const path of extensions) {
      const entry = parquetPack.report.files.find((file) => toForwardSlash(file.path) === path);
      expect(entry?.size).toBeGreaterThan(1_000_000);
    }
  });
});

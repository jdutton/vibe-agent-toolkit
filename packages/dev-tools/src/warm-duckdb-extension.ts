#!/usr/bin/env tsx
/**
 * Capture the DuckDB extension bytes at build time so runtime never needs a network.
 *
 * Invoked from `@vibe-agent-toolkit/projection-parquet`'s build script, run from
 * the package directory, and **after** the compile step — `tsc-clean-build.ts`
 * deletes `dist/` before it emits, so any asset placed there earlier is gone:
 *
 * ```
 * "build": "tsx ../dev-tools/src/tsc-clean-build.ts && tsx ../dev-tools/src/warm-duckdb-extension.ts"
 * ```
 *
 * ## What it does
 *
 * 1. Creates a throwaway home directory and asks the freshly built engine to
 *    download the extension into it — in a **spawned child with a hard timeout**,
 *    because a download that cannot connect does not fail, it parks the process
 *    in an uninterruptible `Atomics.wait` (see `engine.ts`).
 * 2. **Gates on the engine's own receipt**, not on the resulting file tree. The
 *    duckdb-wasm glue creates the cache directories *before* it looks for the
 *    file, so deleting the `LOAD` entirely still leaves a plausible tree behind:
 *    a filesystem assertion here would pass for a build that loaded nothing.
 * 3. Mirrors the captured tree into `dist/duckdb-extensions/` verbatim, so
 *    nothing at runtime has to reconstruct the version segments DuckDB keys its
 *    cache on, and writes `dist/duckdb-extension-manifest.json` recording the
 *    coordinates the *engine reported* plus the size and SHA-256 of each file.
 *
 * Nothing here is written down: the core version and platform token come out of
 * `pragma_version()` / `pragma_platform()`, and the repository host is read off
 * the directory a real download created.
 *
 * This step needs network access. An offline build fails loudly rather than
 * shipping a package whose only failure mode is at an adopter's machine.
 */

import { copyFileSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  dynamicImportPath,
  fileContentHash,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

/**
 * Ceiling for the download child. A hard literal: `spawnSync({ timeout: 0 })`
 * means *no* timeout and `Number('')` is `0`, so a value derived from an unset
 * environment variable would restore exactly the hang this guards.
 */
const WARM_TIMEOUT_MS = 180_000;

/** Extensions VAT's parquet writer needs on every connection. */
const REQUIRED_EXTENSIONS = ['parquet'] as const;

/** Where DuckDB caches extensions below a home directory. */
const CACHE_RELATIVE_DIR = '.duckdb/extensions';

/** Asset locations inside the package's `dist/`. */
const SHIPPED_EXTENSION_DIRNAME = 'duckdb-extensions';
const MANIFEST_FILENAME = 'duckdb-extension-manifest.json';

interface ExtensionReceipt {
  name: string;
  loaded: boolean;
}

interface EngineOutcome {
  ok: boolean;
  error?: string;
  killed: boolean;
  signal: string | null;
  stderr: string;
  durationMs: number;
  receipt?: {
    coreVersion: string;
    platform: string;
    home: string;
    extensions: ExtensionReceipt[];
  };
}

interface EngineModule {
  warmExtensionDownload: (options: {
    home: string;
    extensions: readonly string[];
    timeoutMs?: number;
  }) => EngineOutcome;
}

/**
 * Every file below `dir`, as **segment arrays** relative to it.
 *
 * Segments rather than a joined string on purpose: the captured tree's segments
 * *are* the coordinates DuckDB keys its cache on, and the checks below compare
 * them one by one. Re-splitting a joined path to get them back would be both a
 * cross-platform hazard and a needless round trip.
 */
function filesUnder(dir: string, prefix: readonly string[] = []): string[][] {
  const found: string[][] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks a directory this script created
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const segments = [...prefix, entry.name];
    if (entry.isDirectory()) {
      found.push(...filesUnder(safePath.join(dir, entry.name), segments));
    } else if (entry.isFile()) {
      found.push(segments);
    }
  }
  return found;
}

/** Bare extension name from its filename, e.g. `parquet.duckdb_extension.wasm` → `parquet`. */
function extensionNameOf(fileName: string): string {
  return fileName.split('.')[0] ?? '';
}

/** Fail the build with a message that says what to do about it. */
function fail(message: string): never {
  process.stderr.write(`\nwarm-duckdb-extension: ${message}\n`);
  process.exit(1);
}

/** Download into a scratch home and return the engine's own account of it. */
function warm(engine: EngineModule, home: string): NonNullable<EngineOutcome['receipt']> {
  const outcome = engine.warmExtensionDownload({
    home,
    extensions: REQUIRED_EXTENSIONS,
    timeoutMs: WARM_TIMEOUT_MS,
  });

  if (outcome.killed) {
    fail(
      `the extension download did not finish within ${WARM_TIMEOUT_MS} ms and the child was killed ` +
        `(${String(outcome.signal)}). This build step needs network access to ` +
        'the DuckDB extension repository.',
    );
  }
  const receipt = outcome.receipt;
  if (!outcome.ok || !receipt) {
    fail(`the extension download failed: ${outcome.error ?? 'no receipt'}\n${outcome.stderr}`);
  }
  // `loaded` from duckdb_extensions() is the only field that flips — `installed`
  // and `install_path` were measured false/empty even after a successful load.
  const missing = receipt.extensions.filter((extension) => !extension.loaded);
  if (missing.length > 0) {
    fail(`engine reported these extensions as NOT loaded: ${missing.map((e) => e.name).join(', ')}`);
  }
  if (toForwardSlash(receipt.home) !== toForwardSlash(home)) {
    fail(
      `the engine child ran with home ${receipt.home}, not the scratch home ${home}. ` +
        'Its extension cache is therefore somewhere this script did not capture.',
    );
  }
  if (receipt.coreVersion === '' || receipt.platform === '') {
    fail('the engine reported an empty core version or platform token');
  }
  return receipt;
}

/**
 * Move one captured file into `dist/`, tolerating a volume boundary.
 *
 * `rename` is the cheap path and is all that is ever needed when the scratch
 * home and the package share a filesystem. They do not always: on the Windows CI
 * runner `TEMP` sits on `C:` while the checkout is on `D:`, and `rename` there
 * fails outright with `EXDEV` — the build's only failure mode, and one no
 * same-volume machine can reproduce. Copy-then-delete is the portable fallback;
 * the scratch home is removed wholesale afterwards either way, so the extra copy
 * is in flight only until this function returns.
 *
 * `rename` is injectable purely so the fallback can be tested: a same-volume
 * machine cannot provoke `EXDEV`, and a fallback that only ever runs on a Windows
 * CI runner is a fallback nobody would notice breaking.
 */
export function moveCapturedFile(
  source: string,
  destination: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  try {
    rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(source, destination);
    rmSync(source, { force: true });
  }
}

/** Copy the captured tree into `dist/` verbatim and describe it. */
function publishAssets(
  scratchHome: string,
  distDir: string,
  receipt: NonNullable<EngineOutcome['receipt']>,
): void {
  const capturedRoot = safePath.join(scratchHome, CACHE_RELATIVE_DIR);
  const captured = filesUnder(capturedRoot);
  if (captured.length === 0) {
    fail(`the engine reported a successful load but ${capturedRoot} is empty`);
  }

  // The host is discovered, never declared: it is the directory a real download
  // created. Cross-check every captured file against the coordinates the engine
  // reported, so a tree and a receipt that disagree fail the build instead of
  // shipping something whose probe path nothing will ever hit.
  const hosts = new Set(captured.map((segments) => segments[0] ?? ''));
  if (hosts.size !== 1) {
    fail(`expected exactly one extension repository host in the captured tree, found: ${[...hosts].join(', ')}`);
  }
  const repositoryHost = [...hosts][0] ?? '';
  const misplaced = captured.filter(
    (segments) =>
      segments.length !== 4 || segments[1] !== receipt.coreVersion || segments[2] !== receipt.platform,
  );
  if (misplaced.length > 0) {
    fail(
      'captured files do not sit under the coordinates the engine reported ' +
        `(${repositoryHost}/${receipt.coreVersion}/${receipt.platform}): ` +
        misplaced.map((segments) => safePath.join(...segments)).join(', '),
    );
  }

  const targetRoot = safePath.join(distDir, SHIPPED_EXTENSION_DIRNAME);
  const extensions = captured.map((segments) => {
    const relativePath = safePath.join(...segments);
    const source = safePath.join(capturedRoot, relativePath);
    const destination = safePath.join(targetRoot, relativePath);
    mkdirSyncReal(dirname(destination), { recursive: true });
    // Move rather than copy: the scratch home is thrown away next, and this
    // keeps exactly one copy of a 3 MB binary in flight.
    moveCapturedFile(source, destination);
    return {
      name: extensionNameOf(segments.at(-1) ?? ''),
      relativePath,
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path composed from a tree this script just created
      bytes: statSync(destination).size,
      sha256: fileContentHash(destination),
    };
  });

  const manifest = {
    repositoryHost,
    coreVersion: receipt.coreVersion,
    platform: receipt.platform,
    extensions,
  };
  const manifestPath = safePath.join(distDir, MANIFEST_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path composed from the calling package's own dist directory
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');

  process.stdout.write(
    `warm-duckdb-extension: captured ${extensions.length} file(s) for ` +
      `${repositoryHost} ${receipt.coreVersion} ${receipt.platform}\n` +
      extensions
        .map((extension) => `  ${extension.relativePath} (${extension.bytes} bytes, sha256 ${extension.sha256})\n`)
        .join(''),
  );
}

// CLI entry point. Guarded so a test can import the helpers above without
// running a build: this script downloads an extension and rewrites `dist/`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageRoot = process.cwd();
  const distDir = safePath.join(packageRoot, 'dist');
  const engine = await dynamicImportPath<EngineModule>(safePath.join(distDir, 'engine.js'));

  // Fresh, and under the realpath'd temp root: on macOS `os.tmpdir()` reports
  // `/var/...` while the process's home resolves to `/private/var/...`, and on
  // Windows an un-normalised temp root gives the `RUNNER~1` short form — either
  // way the receipt's home would not match the directory this script captures.
  const scratchHome = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-duckdb-warm-'));
  try {
    publishAssets(scratchHome, distDir, warm(engine, scratchHome));
  } finally {
    rmSync(scratchHome, { recursive: true, force: true });
  }
}

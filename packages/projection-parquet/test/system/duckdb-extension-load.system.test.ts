/**
 * The four measured behaviours the whole offline-extension design rests on,
 * exercised against the **built** package — `dist/engine.js` and the extension
 * bytes its build captured — because that is what an adopter installs.
 *
 * ## The offline harness, and why it does not depend on this machine's network
 *
 * Every case here points DuckDB at `http://127.0.0.1:1/<real repository host>`.
 * DuckDB keys its extension cache on the **last four segments of the URL**, so
 * that value yields a probe path identical to the production one while making
 * the network unreachable: a seeded hit still hits, and a miss can never
 * succeed by accident on a developer laptop that happens to be online.
 *
 * ⚠️ This is the only sanctioned use of `extensionRepositoryForTests`. In
 * production it would rewrite the probe path and silently invalidate the
 * shipped bytes — see `engine.ts`.
 *
 * ## What each case proves
 *
 * 1. **Negative control** — with no seed, `LOAD` blocks forever and only an
 *    external kill ends it. This is the test that makes the precheck and the
 *    `spawnSync` timeout load-bearing rather than decorative; delete either and
 *    this is what production looks like.
 * 2. **Offline load** — seeded at the derived probe path, a full parquet
 *    round trip works with no network at all.
 * 3. **Corrupt seed** — bytes that are present but wrong fail *fast and clean*
 *    through DuckDB's signature check, and bytes that are present but too small
 *    (a poisoned cache entry) never reach DuckDB at all.
 * 4. **Autoload guard** — the parquet precheck says nothing about the *other*
 *    extensions DuckDB will silently fetch mid-query. Four ordinary statements
 *    autoload `json` or `icu` and hang *with parquet already loaded*; the two
 *    `SET …_known_extensions=false` lines in `engine-child.ts` turn them into
 *    Catalog Errors. Nothing else in the suite fails if those lines are deleted.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dynamicImportPath, mkdirSyncReal, safePath, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EngineOptions, EngineOutcome, ParquetSqlBatch, WarmOptions } from '../../src/engine.js';
import { extensionProbePath, MINIMUM_EXTENSION_BYTES } from '../../src/probe-path.js';
import type { DuckdbExtensionManifest } from '../../src/schemas/extension-manifest.js';

/** The package under test. */
const PACKAGE_DIR = safePath.resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A repository URL that cannot connect but whose last four segments are the
 * production ones. See the header — this is what makes the suite offline.
 */
const DEAD_HOST_REPOSITORY = 'http://127.0.0.1:1/extensions.duckdb.org';

/** How long the negative control is allowed to hang before we kill it. */
const HANG_TIMEOUT_MS = 10_000;

/**
 * Budget for the autoload-guard case, and the only thing standing between a
 * removed guard and a wedged runner: an unguarded autoload parks the child in
 * `Atomics.wait`, so the child's own kill — not vitest's `testTimeout` — has to
 * be what ends it. Deliberately looser than {@link HANG_TIMEOUT_MS}: the guarded
 * path was measured at 1.2–1.6 s plus ~1 s of child boot, so 30 s leaves an
 * order of magnitude of headroom for a constrained Windows CI runner while
 * still bounding a regression well inside the 120 s system-test timeout.
 */
const AUTOLOAD_GUARD_TIMEOUT_MS = 30_000;

/**
 * Statements that autoload a *second* extension — `json` for the first three,
 * `icu` for the last — each measured to hang a connection that already has
 * parquet loaded.
 *
 * One batch each, not one batch of four: the first failing statement ends its
 * own batch, so a single batch would only ever exercise `json`, and the `icu`
 * path (a `SET`, not a query — a different code path in DuckDB) would go
 * untested while the case still went green.
 */
const AUTOLOADING_BATCHES: readonly ParquetSqlBatch[] = [
  { label: 'json-cast', statements: [`SELECT '{"a":1}'::JSON`] },
  { label: 'json-extract', statements: [`SELECT json_extract('{"a":1}','$.a')`] },
  { label: 'to-json', statements: ['SELECT to_json({a: 1})'] },
  { label: 'icu-timezone', statements: [`SET TimeZone='America/New_York'`] },
];

interface EngineModule {
  runParquetSql: (batches: readonly ParquetSqlBatch[], options?: EngineOptions) => EngineOutcome;
  warmExtensionDownload: (options: WarmOptions) => EngineOutcome;
}

let engine: EngineModule;
let manifest: DuckdbExtensionManifest;

const suite = setupSyncTempDirSuite('vat-parquet-system');
beforeEach(suite.beforeEach);

/** A fresh home directory for one case — every case starts from an empty cache. */
function tempHome(): string {
  return suite.getTempDir();
}

/** The path DuckDB will probe under `home`, derived from the shipped coordinates. */
function probePathIn(home: string): string {
  return extensionProbePath(
    home,
    {
      repositoryHost: manifest.repositoryHost,
      coreVersion: manifest.coreVersion,
      platform: manifest.platform,
    },
    'parquet',
  );
}

/**
 * Put arbitrary bytes exactly where DuckDB looks, then try to use the engine
 * with seeding disabled — so the run sees *these* bytes and nothing else.
 */
function runWithSeed(bytes: Buffer): EngineOutcome {
  const home = tempHome();
  const probePath = probePathIn(home);
  mkdirSyncReal(safePath.join(probePath, '..'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from the shipped manifest inside a temp dir this test created
  writeFileSync(probePath, bytes);

  return engine.runParquetSql([{ label: 'never-runs', statements: ['SELECT 1'] }], {
    home,
    seed: false,
    extensionRepositoryForTests: DEAD_HOST_REPOSITORY,
  });
}

beforeAll(async () => {
  suite.beforeAll();
  const enginePath = safePath.join(PACKAGE_DIR, 'dist/engine.js');
  const manifestPath = safePath.join(PACKAGE_DIR, 'dist/duckdb-extension-manifest.json');
  // Fail loudly rather than skip: an unbuilt package would make every assertion
  // below vacuous, and the extension bytes only exist because the build
  // captured them. This suite runs after a build.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this test file's own location
  if (!existsSync(enginePath) || !existsSync(manifestPath)) {
    throw new Error(
      `${enginePath} or ${manifestPath} is missing, so this suite would test nothing. ` +
        'Build first: cd packages/projection-parquet && bun run build',
    );
  }
  engine = await dynamicImportPath<EngineModule>(enginePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this test file's own location
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DuckdbExtensionManifest;
});

afterAll(suite.afterAll);

describe('DuckDB extension load, offline', () => {
  it('NEGATIVE CONTROL: an unseeded LOAD hangs and is only ended by an external kill', () => {
    const home = tempHome();

    const outcome = engine.warmExtensionDownload({
      home,
      extensions: ['parquet'],
      timeoutMs: HANG_TIMEOUT_MS,
      extensionRepositoryForTests: DEAD_HOST_REPOSITORY,
    });

    // It did not fail, and it did not succeed — it never came back. The child
    // wrote no result at all, which is the shape of a thread parked in
    // Atomics.wait rather than of an error being handled.
    expect(outcome.ok).toBe(false);
    expect(outcome.killed).toBe(true);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(HANG_TIMEOUT_MS - 500);
    expect(outcome.error).toContain('killed');

    // And nothing was cached: DuckDB creates the directories before it looks
    // for the file, so only the file's absence proves the load never landed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is inside a temp dir this test created
    expect(existsSync(probePathIn(home))).toBe(false);

    // The kill signal itself: libuv simulates signals on Windows, where
    // spawnSync's timeout kill has NOT been measured to report SIGTERM the way
    // POSIX does. The behaviour above (killed, no result, full timeout elapsed)
    // is asserted on every platform; only the signal *name* is skipped here.
    if (process.platform !== 'win32') {
      expect(outcome.signal).toBe('SIGTERM');
    }
  });

  it('loads the seeded extension with no network and round-trips a parquet file', () => {
    const home = tempHome();
    const parquetPath = safePath.join(home, 'round-trip.parquet');
    const csvPath = safePath.join(home, 'read-back.csv');

    const outcome = engine.runParquetSql(
      [
        {
          label: 'round-trip',
          statements: [
            `COPY (SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS t(id, name)) TO '${parquetPath}' (FORMAT parquet)`,
            // Read back THROUGH the extension, then export with the built-in CSV
            // writer so the assertion below needs no parquet reader of its own.
            `COPY (SELECT count(*) AS rows, sum(id) AS total FROM read_parquet('${parquetPath}')) TO '${csvPath}' (FORMAT csv, HEADER)`,
          ],
        },
      ],
      { home, extensionRepositoryForTests: DEAD_HOST_REPOSITORY },
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.batches).toEqual([{ label: 'round-trip', ok: true }]);

    // The engine's own account of itself — `loaded` is the only field that
    // flips on the wasm build, so it is the only one asserted.
    expect(outcome.receipt?.extensions).toEqual([
      { name: 'parquet', loaded: true, probePath: probePathIn(home) },
    ]);
    // The coordinates the running engine derived must be the ones the build
    // captured, or the seeded bytes would sit at a path nothing probes.
    expect(outcome.receipt?.coreVersion).toBe(manifest.coreVersion);
    expect(outcome.receipt?.platform).toBe(manifest.platform);

    // A real parquet file, by its own magic bytes, not merely a file that exists.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path inside a temp dir this test created
    expect(readFileSync(parquetPath).subarray(0, 4).toString('utf8')).toBe('PAR1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path inside a temp dir this test created
    expect(readFileSync(csvPath, 'utf8').trim().split('\n')).toEqual(['rows,total', '3,6']);
  });

  it('rejects a corrupt seed fast and clean, without hanging', () => {
    // Big enough to clear the size floor, so this is DuckDB's verdict on the
    // bytes rather than ours on their size.
    const outcome = runWithSeed(Buffer.alloc(MINIMUM_EXTENSION_BYTES + 1024, 0x41));

    expect(outcome.ok).toBe(false);
    expect(outcome.killed).toBe(false);
    expect(outcome.error).toContain('signature');
    // Measured at ~500 ms; the ceiling here only has to separate "failed" from
    // "hung", and a hang is bounded by the engine's 120 s default timeout.
    expect(outcome.durationMs).toBeLessThan(30_000);
  });

  it('refuses to LOAD a poisoned cache entry before DuckDB ever sees it', () => {
    // 15 bytes: the measured size of an unchecked HTTP error body written
    // straight to the cache path by the duckdb-wasm glue.
    const outcome = runWithSeed(Buffer.from('404: Not Found\n'));

    expect(outcome.ok).toBe(false);
    expect(outcome.killed).toBe(false);
    expect(outcome.error).toContain('Refusing to LOAD parquet');
    expect(outcome.error).toContain('poisoned');
  });

  it('ABSENCE PIN: statements that would autoload a second extension fail clean, not hang', () => {
    const home = tempHome();

    const outcome = engine.runParquetSql(AUTOLOADING_BATCHES, {
      home,
      timeoutMs: AUTOLOAD_GUARD_TIMEOUT_MS,
      extensionRepositoryForTests: DEAD_HOST_REPOSITORY,
    });

    // The load-bearing assertion, asserted FIRST so that it is the one that
    // speaks when the guard goes: without the two `SET …_known_extensions=false`
    // lines the first statement below parks in `Atomics.wait`, the child writes
    // no result at all, and only the kill ends it — so `killed` is precisely
    // "the guard is gone", and every other field here is merely undefined. An
    // elapsed-time ceiling would say the same thing less directly and flake on a
    // slow runner; this case is shaped around the child's own timeout instead,
    // which is also what keeps a regression from wedging the vitest runner.
    expect(
      outcome.killed,
      'the engine child was killed, i.e. a statement below hung: the autoload guard in engine-child.ts is gone or ineffective',
    ).toBe(false);

    // parquet loaded first, so what follows is DuckDB refusing a *second*
    // extension mid-query — not a run that never got off the ground.
    expect(outcome.receipt?.extensions).toEqual([
      { name: 'parquet', loaded: true, probePath: probePathIn(home) },
    ]);

    // Every batch ran and every one failed *for the right reason*. `ok: false`
    // alone would also be satisfied by a typo'd statement; the catalog error is
    // what says DuckDB knew the function existed in an extension and declined
    // to go and get it.
    expect(outcome.batches.map((batch) => batch.label)).toEqual(
      AUTOLOADING_BATCHES.map((batch) => batch.label),
    );
    for (const batch of outcome.batches) {
      expect(batch.ok, `${batch.label} should have failed: ${String(batch.error)}`).toBe(false);
      expect(batch.error, batch.label).toContain('Catalog Error');
    }
  });
});

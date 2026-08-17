/**
 * The child half of the engine: the only place in VAT that boots DuckDB.
 *
 * Nothing imports this module — `engine.ts` **spawns** it, by path, and talks to
 * it through two JSON files. That separation is deliberate on both sides:
 *
 * - The parent must be able to *kill* this process, because a DuckDB extension
 *   cache miss parks the main thread in `Atomics.wait`, which no in-process
 *   guard can interrupt.
 * - The parent must not pay for DuckDB. Importing `@duckdb/duckdb-wasm/blocking`
 *   measured ~104 ms of module load before a single query runs; a CLI that
 *   merely *mentions* the engine should not pay that.
 *
 * The `LOAD` order below is measured, not stylistic. See `engine.ts` for the
 * full set of measurements, including the four ordinary-looking statements that
 * hang a connection by autoloading a *different* extension.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

import { createDuckDB, type DuckDBBundles, type DuckDBConnection, NODE_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/blocking';

import { loadShippedManifest } from './extension-seed.js';
import { extensionProbePath, verifyExtensionSeed } from './probe-path.js';
import type { DuckdbExtensionManifest } from './schemas/extension-manifest.js';

interface ParquetSqlBatch {
  readonly label: string;
  readonly arrowIpc?: { readonly table: string; readonly path: string };
  readonly statements: readonly string[];
}

interface EngineChildRequest {
  readonly mode: 'warm' | 'write';
  readonly extensionRepository?: string;
  readonly extensions: readonly string[];
  readonly batches: readonly ParquetSqlBatch[];
  readonly resultPath: string;
}

interface ExtensionReceipt {
  name: string;
  loaded: boolean;
  probePath?: string;
}

/** Memory ceiling for the wasm instance. A resource knob, not a compatibility one. */
const MEMORY_LIMIT = '1GB';

const require = createRequire(import.meta.url);

/** The shipped manifest, read at most once — two call sites need it in write mode. */
let manifestMemo: DuckdbExtensionManifest | undefined;
function shippedManifest(): DuckdbExtensionManifest {
  manifestMemo ??= loadShippedManifest();
  return manifestMemo;
}

/**
 * Boot the wasm engine on the exception-handling bundle.
 *
 * The `mvp` bundle is deliberately absent. `DuckDBBundles` *types* it as
 * required, but the library only reads `bundles.mvp` in a branch this path
 * never takes — omitting the key entirely was measured to work, and shipping a
 * second 34 MB wasm binary to satisfy a type would be a real cost paid for a
 * compile-time fiction.
 */
async function boot(): Promise<DuckDBConnection> {
  const bundles = {
    eh: {
      mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'),
      mainWorker: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-eh.worker.cjs'),
    },
  } as unknown as DuckDBBundles;
  const db = await createDuckDB(bundles, new VoidLogger(), NODE_RUNTIME);
  await db.instantiate();
  db.open({ path: ':memory:' });
  return db.connect();
}

/** First column of the first row, as a string. */
function scalar(connection: DuckDBConnection, sql: string, column: string): string {
  const rows = connection.query(sql).toArray();
  const first: unknown = rows[0]?.toJSON();
  const value = (first as Record<string, unknown> | undefined)?.[column];
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  // Anything else (null, undefined, an Arrow object) is not an answer this
  // caller can act on, and an empty string reads as one at every call site.
  return '';
}

/** Is DuckDB itself reporting the extension as loaded? The only field that flips — see below. */
function isLoaded(connection: DuckDBConnection, name: string): boolean {
  // `installed` and `install_path` are NOT usable as evidence: on the wasm build
  // they were measured empty/false even immediately after a successful load.
  return (
    scalar(
      connection,
      `SELECT loaded FROM duckdb_extensions() WHERE extension_name = '${name}'`,
      'loaded',
    ) === 'true'
  );
}

/**
 * Refuse `LOAD` unless the bytes are already on disk where DuckDB will look.
 *
 * The coordinates are read out of the **running engine**, not out of the
 * manifest: if a duckdb-wasm upgrade moved the core version, the manifest would
 * describe a path this engine never probes, and the mismatch has to surface as
 * this error rather than as a download attempt that cannot be interrupted.
 */
function precheck(connection: DuckDBConnection, names: readonly string[]): string[] {
  const manifest = shippedManifest();
  const coordinates = {
    repositoryHost: manifest.repositoryHost,
    coreVersion: scalar(connection, 'SELECT library_version FROM pragma_version()', 'library_version'),
    platform: scalar(connection, 'SELECT platform FROM pragma_platform()', 'platform'),
  };
  const probePaths: string[] = [];
  for (const name of names) {
    const probePath = extensionProbePath(homedir(), coordinates, name);
    const verdict = verifyExtensionSeed(probePath);
    if (!verdict.ok) {
      throw new Error(
        `Refusing to LOAD ${name}: ${verdict.reason}.\n` +
          `  probe path: ${probePath}\n` +
          `  engine reports core version ${coordinates.coreVersion}, platform ${coordinates.platform}\n` +
          `  shipped manifest describes ${manifest.coreVersion} / ${manifest.platform}\n` +
          'Issuing LOAD anyway would block this process in an uninterruptible Atomics.wait.',
      );
    }
    probePaths.push(probePath);
  }
  return probePaths;
}

/** Load the named extensions, with the guards the mode calls for. */
function loadExtensions(
  connection: DuckDBConnection,
  request: EngineChildRequest,
  names: readonly string[],
): ExtensionReceipt[] {
  if (request.mode === 'write') {
    // Before anything else: a *different* extension autoloading mid-query is a
    // hang the parquet precheck cannot see.
    connection.query('SET autoinstall_known_extensions=false');
    connection.query('SET autoload_known_extensions=false');
  }
  if (request.extensionRepository !== undefined) {
    connection.query(`SET custom_extension_repository='${request.extensionRepository}'`);
  }

  const probePaths = request.mode === 'write' ? precheck(connection, names) : [];
  const receipts: ExtensionReceipt[] = [];
  for (const [index, name] of names.entries()) {
    connection.query(`LOAD ${name}`);
    const probePath = probePaths[index];
    receipts.push({ name, loaded: isLoaded(connection, name), ...(probePath ? { probePath } : {}) });
  }
  if (request.mode === 'write') {
    connection.query(`SET memory_limit='${MEMORY_LIMIT}'`);
  }
  return receipts;
}

/** Run the caller's batches. A failing statement ends its own batch, not the run. */
function runBatches(
  connection: DuckDBConnection,
  batches: readonly ParquetSqlBatch[],
): { label: string; ok: boolean; error?: string }[] {
  return batches.map((batch) => {
    try {
      if (batch.arrowIpc) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from the parent's own request file
        const stream = readFileSync(batch.arrowIpc.path);
        connection.insertArrowFromIPCStream(stream, { name: batch.arrowIpc.table, create: true });
      }
      for (const statement of batch.statements) {
        connection.query(statement);
      }
      return { label: batch.label, ok: true };
    } catch (error) {
      return { label: batch.label, ok: false, error: String(error) };
    }
  });
}

/** Which extensions this run is about: the request's list, or everything shipped. */
function requestedExtensions(request: EngineChildRequest): string[] {
  if (request.extensions.length > 0) return [...request.extensions];
  return shippedManifest().extensions.map((entry) => entry.name);
}

const requestPath = process.argv[2];
if (requestPath === undefined) {
  process.stderr.write('engine-child: no request file argument\n');
  process.exit(2);
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- path is written by the parent into a directory it just created
const request = JSON.parse(readFileSync(requestPath, 'utf8')) as EngineChildRequest;
let connection: DuckDBConnection | undefined;
let result: {
  ok: boolean;
  error?: string;
  receipt?: { coreVersion: string; platform: string; home: string; extensions: ExtensionReceipt[] };
  batches: { label: string; ok: boolean; error?: string }[];
};

try {
  connection = await boot();
  const extensions = loadExtensions(connection, request, requestedExtensions(request));
  const batches = runBatches(connection, request.batches);
  result = {
    ok: extensions.every((extension) => extension.loaded) && batches.every((batch) => batch.ok),
    receipt: {
      coreVersion: scalar(connection, 'SELECT library_version FROM pragma_version()', 'library_version'),
      platform: scalar(connection, 'SELECT platform FROM pragma_platform()', 'platform'),
      home: homedir(),
      extensions,
    },
    batches,
  };
} catch (error) {
  result = {
    ok: false,
    error: String(error),
    batches: request.batches.map((batch) => ({ label: batch.label, ok: false, error: String(error) })),
  };
} finally {
  connection?.close();
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- path is chosen by the parent inside a directory it just created
writeFileSync(request.resultPath, JSON.stringify(result), 'utf8');
// The wasm instance keeps handles alive; an explicit exit is what ends the process.
process.exit(result.ok ? 0 : 1);

/**
 * Parquet output for VAT's resource projection.
 *
 * This package is a **separate install**, on purpose. It carries the DuckDB
 * WASM engine (~37 MB of binaries once the extension bytes are seeded), and
 * `@vibe-agent-toolkit/resources` — VAT's most widely installed package — has
 * no heavy dependencies today. Putting the engine there would tax every
 * adopter who never writes a table, so the engine, the extension seeding, and
 * the writer live here instead, behind a thin seam in `resources`.
 *
 * It is deliberately NOT an `optionalDependency` of anything: npm installs
 * those by default, which would reintroduce exactly the cost this split
 * removes. Consumers run a separate `npm install`, and the CLI discovers the
 * absence at runtime through the `ERR_MODULE_NOT_FOUND` gate in
 * `packages/cli/src/utils/optional-backend.ts`.
 *
 * The two engine-free halves — Arrow IPC encoding and the `COPY` statement —
 * are here and unit-tested without DuckDB.
 */

/**
 * Filename extension every table this package writes carries.
 *
 * Named here rather than spelled inline at each call site so the writer, the
 * reader, and any consumer globbing an output directory all agree on one
 * spelling.
 */
export const PARQUET_FILE_EXTENSION = '.parquet';

// Rows → Arrow IPC stream bytes. Bytes, never an Arrow object: duckdb-wasm
// loads its own `apache-arrow` instance, and a Table handed across that seam
// serialises to zero bytes with no error. See `encode.ts`.
export {
  type ArrowEncodableTable,
  type EncodedArrowStream,
  encodeArrowStream,
} from './encode.js';

// The `COPY … TO … (FORMAT parquet)` statement, with the column list read out
// of the projection table registry and the output path escaped.
export {
  type CopyOptions,
  DEFAULT_PARQUET_COMPRESSION,
  PARQUET_COMPRESSION_CODECS,
  type ParquetCompression,
  buildTableCopySql,
  quoteIdentifier,
  quotePathLiteral,
} from './copy-sql.js';

// The engine: one spawned child boots DuckDB and runs every batch. The parent
// side deliberately imports no DuckDB code — see `engine.ts` for why the child,
// the timeout and the extension precheck are all load-bearing.
export {
  type ArrowIpcInput,
  type EngineOptions,
  type EngineOutcome,
  type EngineReceipt,
  type ParquetBatchOutcome,
  type ParquetSqlBatch,
  type WarmOptions,
  runParquetSql,
  warmExtensionDownload,
} from './engine.js';

// Placing the shipped extension bytes where DuckDB will find them, in a home
// VAT owns rather than the user's `~/.duckdb`.
export {
  EXTENSION_MANIFEST_FILENAME,
  SHIPPED_EXTENSION_DIRNAME,
  type SeedOptions,
  type SeedOutcome,
  loadShippedManifest,
  parquetEngineHome,
  seedExtensionHome,
  shippedAssetDir,
} from './extension-seed.js';

// Where duckdb-wasm probes for an extension, and whether what is there is safe
// to hand to `LOAD`. Absence is the only condition that hangs.
export {
  EXTENSION_CACHE_RELATIVE_DIR,
  EXTENSION_FILE_SUFFIX,
  type ExtensionCoordinates,
  MINIMUM_EXTENSION_BYTES,
  type SeedStat,
  type SeedVerdict,
  classifyExtensionSeed,
  extensionProbePath,
  extensionRelativePath,
  verifyExtensionSeed,
} from './probe-path.js';

export type {
  DuckdbExtensionManifest,
  ExtensionManifestEntry,
} from './schemas/extension-manifest.js';

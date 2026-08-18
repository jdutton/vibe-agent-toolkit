/**
 * A SQLite-backed `ProjectionStore` for VAT's resource projection.
 *
 * This package is a **separate install**: a storage backend is a choice, and
 * `@vibe-agent-toolkit/resources` — VAT's most widely installed package —
 * should not carry one by default. The cost of choosing this one is close to
 * zero: `node:sqlite` ships with Node, so there is no binary, no wasm module,
 * no extension to seed, and nothing to download.
 *
 * What it does carry is a **version floor**. `node:sqlite` first appears in
 * **Node 22.13.0** and is absent from 22.12.0, so this package's `engines`
 * requires `>=22.13.0` while the rest of the toolkit stays at `>=22.0.0` — a
 * backend nobody has to install should not raise everyone else's floor. The
 * module is unflagged from the Node 24 line onward; on Node 22 it emits an
 * `ExperimentalWarning` per process, which this package deliberately does not
 * suppress (a blanket `NODE_NO_WARNINGS` would hide real ones).
 *
 * 🪤 Bun's runtime has no `node:sqlite` — it ships `bun:sqlite`, a different
 * API. Nothing in VAT executes under Bun (the shipped `bin/vat` is
 * `#!/usr/bin/env node`, and Bun is only the script runner here), but an adopter
 * importing this package into a Bun *application* would hit it.
 */

// The statements, built from the projection table registry. Engine-free, so the
// schema's shape is testable without SQLite and without the version floor.
export {
  CREATE_EXTENTS_TABLE_SQL,
  EXTENTS_TABLE,
  EXTENT_KEY_COLUMNS,
  type StoredTableSpec,
  WRITTEN_AT_COLUMN,
  allSpecs,
  blobKeyColumn,
  createTableSql,
  deleteBlobFactsSql,
  deleteExtentContextSql,
  deleteRowByKeySql,
  insertSql,
  selectBlobFactsSql,
  selectExtentSql,
  storedColumns,
  storedPrimaryKey,
} from './schema-sql.js';

// Row values in and out of SQLite. The round trip is the property, so both
// halves live together.
export {
  type SqliteResultValue,
  type SqliteValue,
  decodeValue,
  encodeValue,
} from './values.js';

// The store. Opens WAL with the pragmas in the one order that survives
// contention — see `store.ts`.
export {
  type SqliteStoreOptions,
  defaultStoreDirectory,
  openSqliteProjectionStore,
} from './store.js';

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
 * `node:sqlite` was **added in Node 22.5.0 behind `--experimental-sqlite`**, and the
 * flag requirement was removed in **23.4.0 and 22.13.0**. 22.13.0 is therefore the
 * first version on the 22 line where an ordinary `import('node:sqlite')` resolves
 * without the user passing a flag, which is why this package's `engines` requires
 * `>=22.13.0`. (Saying it "arrived in 22.13.0" is the convenient shorthand and is
 * wrong: on 22.5–22.12 it exists, flagged.)
 *
 * ⚠️ **That floor is now the whole toolkit's, and this package is why.** It
 * used to read "while the rest of the toolkit stays at `>=22.0.0` — a backend
 * nobody has to install should not raise everyone else's floor." That argument
 * died when this package stopped being optional: the CLI depends on it
 * outright, and `vat resources query|check` build their ephemeral store from it
 * on every run, so Node 22.0–22.12 could not run those commands while the
 * manifests still advertised support for them. The toolkit floor moved to
 * `>=22.13.0` to stop advertising what it cannot do. This declaration stays
 * because the requirement is **intrinsic here** — this is the code that imports
 * `node:sqlite` — not because it differs any more. The
 * module needs no flag from 22.13.0 onward, but **unflagged is not
 * silent**: it still emits one `ExperimentalWarning` per process there, as it
 * does on Node 22 — verified on 24.13.1. This package deliberately does not
 * suppress it (a blanket `NODE_NO_WARNINGS` would hide real ones), so any
 * caller that turns this backend on *by default* has to filter that one warning
 * by name at its own boundary, or every one of its invocations prints it.
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
  deleteExtentSql,
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
// contention — see `store.ts`. The ephemeral variant answers the same schema
// with no file at all, so a query does not depend on a cache being there; it
// deliberately skips every one of those pragmas, which are all file properties.
export {
  type SqlQueryableStore,
  type SqliteStoreOptions,
  defaultStoreDirectory,
  openEphemeralProjectionStore,
  openSqliteProjectionStore,
} from './store.js';

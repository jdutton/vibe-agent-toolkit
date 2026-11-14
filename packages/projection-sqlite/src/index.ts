/**
 * A SQLite-backed `FactStore` for VAT's resource projection, and the run
 * database a run's SQL runs on.
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
 * without the user passing a flag. (Saying it "arrived in 22.13.0" is the
 * convenient shorthand and is wrong: on 22.5–22.12 it exists, flagged.) The
 * `engines` floor is one step higher, **`>=22.16.0`**, because
 * `RunDatabase.columns()` calls `StatementSync.columns()`, which Node
 * added in 22.16.0 — absent on 22.15.1, present on 22.16.0, measured. Deriving
 * the names any other way was tried and refused: wrapping the statement as a
 * subquery under an always-false outer join renames a duplicate result column
 * (`a`, `a` comes back `a`, `a:1`), so it answers a different question.
 *
 * ⚠️ **That floor is now the whole toolkit's, and this package is why.** It
 * used to read "while the rest of the toolkit stays at `>=22.0.0` — a backend
 * nobody has to install should not raise everyone else's floor." That argument
 * died when this package stopped being optional: the CLI depends on it
 * outright, and `vat resources query|check` build their run database from it
 * on every run, so Node 22.0–22.12 could not run those commands while the
 * manifests still advertised support for them. The toolkit floor moved to
 * `>=22.13.0` to stop advertising what it cannot do, and later to `>=22.16.0`
 * for `StatementSync.columns()` above. This declaration stays
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

// The fact store: the `FactStore` port over a file, and nothing else. Opens WAL
// with the pragmas in the one order that survives contention — see `store.ts`.
export {
  type SqliteStoreOptions,
  defaultStoreDirectory,
  openSqliteFactStore,
} from './store.js';

// The one handle SQL runs on, opened from one run's projection, and the compile
// probe: the one place every derived relation exists without a lens having
// filled it, which is why it can compile and cannot answer. See `run-database.ts`
// on why the run database is no second storage contract.
export {
  type ProjectionCompileProbe,
  type RunDatabase,
  openProjectionCompileProbe,
  openRunDatabase,
} from './run-database.js';

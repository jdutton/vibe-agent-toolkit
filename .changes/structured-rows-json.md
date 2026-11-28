### Added

- **JSON and JSONC files as queryable rows.** `vat resources query` and `vat resources check` gain
  `data__files`, `data__documents`, `data__nodes`, `data__conditions` (stored, keyed by content and
  variant) and `data__routes`, `data__values` (computed for the run). By default every
  `package.json` is read as strict JSON and every `tsconfig*.json`/`jsconfig*.json` as JSONC, only
  when a statement names a `data__*` relation. Every `data__*` relation answers from the files that
  have rows; a routed file with none is one `DATA_FILE_NO_ROWS` error at its path, which fails the
  run, and `data__routes` names its state and code.
- **`resources.extractors.data` in `vibe-agent-toolkit.config.yaml`** (`include`, `jsonc`,
  `exclude`, `allowEmpty`) chooses which files become data rows and as which variant. A declared
  block that routes nothing is `CONFIG_INVALID` when a statement names a `data__*` relation, unless
  it sets `allowEmpty: true`. An `include` glob that matches no `.json`, `.jsonc`, `.yaml` or `.yml`
  file in the bound extent is a `DATA_INCLUDE_GLOB_INERT` warning naming the glob.
  Files of named credentials kinds (`.env`, `.netrc`, `.docker/config.json` and the like) are never
  routed whatever glob matches: each is a `DATA_CREDENTIAL_FILE_NOT_ROUTED` warning, and `.npmrc`
  and `.yarnrc.yml` keep only allowlisted keys. The list is closed, so keep secrets out of routed
  files.
- **Data defect codes.** A routed file that cannot become rows is `defective` (`DATA_PARSE_ERROR`,
  `BLOB_NOT_TEXT`, a byte-determined `PARSE_LIMIT_EXCEEDED`, `DATA_LONE_SURROGATE` for a key or
  string holding an unpaired UTF-16 surrogate, which SQLite would store as U+FFFD) or `refused`
  this run. A closer that does not match the container it closes is `DATA_PARSE_ERROR` before the
  parse, so a malformed file never recurses into a stack limit. A filesystem fault on a routed
  file's read follows the one fault table: `defective` where it answers `INPUT_UNREADABLE` (a
  refused permission, a failed device), `refused` where it answers `RUN_INCOMPLETE`. A file the
  population could not read is not read again: its class comes from the one failed read.
- **`resource_realizations.contentFaultClass`**: the fault class of the read that left a
  realization `unreadable`, non-null exactly then. A promotion read that fails with no errno is
  rethrown as a bug, as the eager read already was, rather than recorded as `unreadable`.
- **Work counters `rowSet.extracted`, `rowSet.storeServed`, `rowSet.refused` and
  `rowSet.rows.decoded`**, all zero in a run that names no `data__*` relation.
- **Library (`@vibe-agent-toolkit/resources`): the row-set tier.** `ROW_SET_TABLES`,
  `storedRelationSpecs()`, `isRowSetTable`, `RowSetId` (`rowSetIdText`, `compareRowSetIds`), the
  `data__*` row types, `StoredRowsEvictedError` with `isStoredRowsEvicted`, and in
  `@vibe-agent-toolkit/resources/testing` the row-set writer contract (`ROW_SET_WRITER_CONTRACT`).
- **Library (`@vibe-agent-toolkit/resources`): the `data` instance's stage.** `runDataStage`,
  `dataDemandOf`, `dataRoutingFor`, `dataStageContentOf`, `dataDefectIssues`,
  `NO_DATA_STAGE_SEAMS`, and the types `DataDemand`, `DataRouting`, `DataStageResult`,
  `DataStageSeams` and `RowSetSource`.
- **Library (`@vibe-agent-toolkit/projection-sqlite`):** `DEFAULT_ROW_SET_TIER_BUDGET_BYTES`;
  `isCopyEligible`, whether a stored relation's rows may be copied into a run database; and a
  `./testing` subpath exporting `evictRowSetForTest`, which evicts one row set as the budget would.
- **Published JSON Schemas for every relation a statement can name.** `packages/resources/schemas/`
  now ships `projection-data--files.json`, `projection-data--documents.json`,
  `projection-data--nodes.json`, `projection-data--conditions.json`, `projection-data--routes.json`,
  `projection-data--values.json` and `projection-lens-contexts.json`. The list is derived from
  `queryableRelationSpecs()`, so a new relation ships its schema with it.
- **`@vibe-agent-toolkit/utils` ESLint plugin: `registry-iteration`** reports enumerating
  `PROJECTION_TABLES`, `ROW_SET_TABLES` or `DERIVED_TABLES` outside their accessors. It guards VAT's
  own registries; an adopter has no reason to enable it.

### Breaking

- **The projection store rebuilds once.** Its shape now covers the row-set tables and their ledger
  (`row_set_keys`), so the first run after upgrading starts cold in a new store directory.
- **Library (`@vibe-agent-toolkit/resources`): `FactStore` requires `readRowSets` and
  `writeRowSets`**; every implementation and wrapper must provide or forward them.
  `blobRowBytes` is renamed `storedRowBytes`. `ProjectionColumnKind` gains `'scalar'` and
  `ProjectionColumnType` is a union: a `scalar` column also carries `companions`. A
  `QueryableRelationSpec` carries a required `kind` (`projection`, `rowSet`, `derived`), and
  `queryableRelationSpecs()` includes the row-set tables. A `DerivedTableSpec` also requires
  `producer` (`lens` or `data`). `QueryReferenceSource`'s stored lane requires `tier: 'blob'`:
  `{ stored: { tier: 'blob', store, contentKeys } }`.
- **`packages/resources/schemas/projection-lens-entry-points.json` is removed.** No statement can
  name `lens_entry_points`, so it is not a published relation; `LensEntryPointRowSchema` is still
  exported.
- **Library (`@vibe-agent-toolkit/projection-sqlite`): `openSqliteFactStore(options)` requires
  `rowSetTierBudgetBytes`**, validated like `blobTierBudgetBytes`; pass
  `DEFAULT_ROW_SET_TIER_BUDGET_BYTES`. `StoredRows` requires a `tier` discriminant: `{ tier: 'blob',
  store, contentKeys }` or `{ tier: 'rowSet', store, ids }`. `encodeValue` and `decodeValue` are no
  longer exported, and `SqliteValue` includes `bigint`.

### Changed

- **Three more repo rules are `vat resources check` entries over `data__*` rows**: every package
  `tsconfig.json` sets `compilerOptions.composite: true` and extends `../../tsconfig.base.json`
  (JSONC rows), and every dependency on a workspace package uses a `workspace:` range.
- **The repo's Node engine-floor agreement is a `vat resources check`.** The `engine-floor-agreement`
  check in `vibe-agent-toolkit.config.yaml` is SQL over `data__values`, replacing the TypeScript
  rule in `validate-repo-structure.ts`. It checks only routed `package.json` files, so a
  gitignored manifest is no longer read, where the rule read `packages/` on disk. A defective
  routed JSON or JSONC file is its own `DATA_FILE_NO_ROWS` error; the check answers over the rest.
  A manifest with a byte-order mark or in UTF-16 is decoded and checked, where it was a finding.

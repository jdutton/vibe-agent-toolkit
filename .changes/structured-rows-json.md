### Added

- **JSON and JSONC files as queryable rows.** `vat resources query` and `vat resources check` gain
  `data__files`, `data__documents`, `data__nodes`, `data__conditions` (stored, keyed by content and
  variant) and `data__routes`, `data__values` (computed for the run). By default every
  `package.json` is read as strict JSON and every `tsconfig*.json`/`jsconfig*.json` as JSONC, only
  when a statement names a `data__*` relation. A statement naming them is refused
  (`INPUT_UNREADABLE`, or `RUN_INCOMPLETE` for a per-run failure) while a routed file has no rows;
  `data__routes` names the file.
- **`resources.extractors.data` in `vibe-agent-toolkit.config.yaml`** (`include`, `jsonc`,
  `exclude`, `allowEmpty`) chooses which files become data rows and as which variant. A declared
  block that routes nothing is `CONFIG_INVALID` when a statement names a `data__*` relation, unless
  it sets `allowEmpty: true`.
- **Work counters `rowSet.extracted`, `rowSet.storeServed`, `rowSet.refused` and
  `rowSet.rows.decoded`**, all zero in a run that names no `data__*` relation.
- **Library (`@vibe-agent-toolkit/resources`): the row-set tier.** `ROW_SET_TABLES`,
  `storedRelationSpecs()`, `isRowSetTable`, `RowSetId` (`rowSetIdText`, `compareRowSetIds`), the
  `data__*` row types, `StoredRowsEvictedError` with `isStoredRowsEvicted`, and in
  `@vibe-agent-toolkit/resources/testing` the row-set writer contract (`ROW_SET_WRITER_CONTRACT`).
  `@vibe-agent-toolkit/projection-sqlite` exports `DEFAULT_ROW_SET_TIER_BUDGET_BYTES`.
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
  `queryableRelationSpecs()` includes the row-set tables.
- **Library (`@vibe-agent-toolkit/projection-sqlite`): `openSqliteFactStore(options)` requires
  `rowSetTierBudgetBytes`**, validated like `blobTierBudgetBytes`; pass
  `DEFAULT_ROW_SET_TIER_BUDGET_BYTES`. `StoredRows` requires a `tier` discriminant: `{ tier: 'blob',
  store, contentKeys }` or `{ tier: 'rowSet', store, ids }`. `encodeValue` and `decodeValue` are no
  longer exported, and `SqliteValue` includes `bigint`.
- **A broken check's `reason.refusal` can now be `RUN_INCOMPLETE`.** `LENS_REFUSAL_CODES` (and the
  `vat resources check` report schema) admit it beside `USAGE_INVALID`, `BACKEND_UNAVAILABLE` and
  `INPUT_UNREADABLE`: a check reading a `data__*` relation while a routed file was refused this run
  (unreadable, changed under the run, past a time, heap or stack limit) is broken with it.

### Changed

- **The repo's Node engine-floor agreement is a `vat resources check`.** The `engine-floor-agreement`
  check in `vibe-agent-toolkit.config.yaml` is SQL over `data__values`, replacing the TypeScript
  rule in `validate-repo-structure.ts`. An unparseable manifest now breaks the check
  (`RESOURCE_CHECK_BROKEN`, `INPUT_UNREADABLE`) instead of being a per-file finding.

### Breaking

- **`@vibe-agent-toolkit/projection-sqlite`: `openRunDatabase(projection)` is replaced by
  `hydrateRunDatabase({ rootId, relations })`.** `relations` is a `Map` from relation name to rows;
  the run database holds exactly those relations. Neither it nor the compile probe holds `extents`
  or `blob_keys`.
- **`@vibe-agent-toolkit/resources`: table and derived specs require `textColumns`**, classifying
  every `text` column as `rootRelativePath` or `other`. `compareRows(spec)` and
  `rootlessPathRelations()` are exported.
- **`vat resources query`, `check` and `validate` refuse statements that read schema or connection
  state:** `sqlite_schema`/`sqlite_master`, `pragma_*` functions, `dbstat`, `changes()`,
  `total_changes()`, `last_insert_rowid()`, `#` parameters, and a table named only as a
  single-quoted string (`FROM 'blobs'`). `query` exits 2; `check` and `validate` report
  `RESOURCE_CHECK_BROKEN`. Name tables as identifiers and bind with `?`.
- **`vat resources query`, `check` and `validate`: rows of a statement without `ORDER BY` come in
  primary-key order**, the same whether the population was served or derived. Add `ORDER BY` where
  the order matters.
- **`@vibe-agent-toolkit/utils`: `WorkCounter` adds `statement.explained`, and `hydration.writes`
  counts one per hydration** (zero for a statement naming no projection table), not one per scope.

### Breaking

- **`@vibe-agent-toolkit/projection-sqlite`: `openRunDatabase(projection)` is replaced by
  `hydrateRunDatabase({ rootId, relations })`.** `relations` is a `Map` from relation name to rows;
  the run database holds exactly those relations. Neither it nor the compile probe holds `extents`
  or `blob_keys`.
- **`@vibe-agent-toolkit/resources`: table and derived specs require `columnRoles`**, classifying
  every `text` and `json` column as `rootRelativePath` or `other`. `compareRows(spec)`,
  `rootlessPathRelations()`, `queryableRelationSpecs()`, `queryableRelationNames()`,
  `relationsNamedBy()`, `definesCteNamed()` and `identifierSpellings()` are exported.
- **`vat resources query`, `check` and `validate` refuse more statements.** `query` exits 2;
  `check` and `validate` report `RESOURCE_CHECK_BROKEN`. Name tables as identifiers and bind with
  `?`. Refused:
  - schema introspection: `sqlite_schema`, `sqlite_master`, `sqlite_temp_schema`, `pragma_*`
    functions and `dbstat`;
  - the fact store's bookkeeping, `extents` and `blob_keys`, which no run holds;
  - connection state: `changes()`, `total_changes()` and `last_insert_rowid()`;
  - `#` parameters, and a named parameter whose name starts with `$` (`$$`, `#$`, `@$`, `:$`);
  - a statement holding a NUL character, which SQLite truncates silently;
  - a statement reading a relation it does not name itself, such as `FROM 'blobs'`, which SQLite
    reads as the table only when another statement had it hydrated;
  - a write (`WITH … DELETE … RETURNING`) at preflight, which compiled and was admitted before.
- **Refusal wording changed.** A relation the run did not hydrate now says "a statement reads a
  relation only when it names it itself as an identifier", lists the spellings, and says a
  single-quoted name is a string; a write says "This statement writes"; tooling matching the old
  text must update.
- **`vat resources query`, `check` and `validate`: rows of a statement without `ORDER BY` come in
  the same order whether the population was served or derived:** primary-key order for a plain scan
  of one relation; a join, `GROUP BY` or `DISTINCT` follows the query plan. Add `ORDER BY` where
  the order matters.
- **`@vibe-agent-toolkit/utils`: `WorkCounter` adds `statement.explained`, and `hydration.writes`
  counts one per hydration** (zero for a statement naming no projection table), not one per scope.

### Added

- **`vat resources query`, `check` and `validate` run SQL over this run's own rows only**, never
  another repository's. A statement reads only the relations it names as identifiers.
- **Statements these commands refuse** (`query` exits 2; `check` and `validate` report
  `RESOURCE_CHECK_BROKEN`). Name tables as identifiers and bind with `?`. A refusal over a table
  names it as the run holds it.
  - schema introspection: `sqlite_schema`, `sqlite_master`, `sqlite_temp_schema`, `pragma_*`
    functions, `PRAGMA` statements and `dbstat`;
  - the fact store's bookkeeping, `extents` and `blob_keys`;
  - connection state: `changes()`, `total_changes()` and `last_insert_rowid()`;
  - `#` parameters, and a named parameter whose name starts with `$` (`$$`, `#$`, `@$`, `:$`);
  - a NUL character, which SQLite would truncate at silently;
  - a relation reached through a single-quoted name, such as `FROM 'blobs'`;
  - any write.
- **Rows of a statement without `ORDER BY` come in primary-key order for a plain scan of one
  relation**; a join, `GROUP BY` or `DISTINCT` follows the query plan. Add `ORDER BY` where the
  order matters.
- **`@vibe-agent-toolkit/resources`: table and derived specs declare `columnRoles`**, classifying
  each `text` and `json` column as `rootRelativePath` or `other`. Also exported: `compareRows(spec)`,
  `rootlessPathRelations()`, `queryableRelationSpecs()`, `queryableRelationNames()`,
  `isProjectionTable()`, `relationsNamedBy()`, `definesCteNamed()`, `identifierSpellings()`, and a
  SQL lexer that follows SQLite's tokenizer: `sqlTokens()`, `sqlSpanAt()`, `SQL_IDENTIFIER_CHAR`,
  `SQL_WORD_START_CHAR` and `SQL_WHITESPACE`.

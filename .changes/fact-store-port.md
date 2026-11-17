### Added

- **`@vibe-agent-toolkit/resources`: `FactStore`**, the storage port for projection facts, and
  **`@vibe-agent-toolkit/projection-sqlite`: `openSqliteFactStore()`**, its SQLite implementation.
- **`@vibe-agent-toolkit/projection-sqlite`: `hydrateRunDatabase({ rootId, relations })`** returns a
  `RunDatabase` holding exactly the relations given (a `Map` from relation name to rows), for running
  read-only SQL over one run's rows.
- **`@vibe-agent-toolkit/utils` work counters `hydration.writes`, `hydration.rows.written` and
  `statement.explained`.** `hydration.writes` counts one per run database hydrated (zero for a run
  whose statements name no projection table); writing a lens's derived relations is not counted.
- **`@vibe-agent-toolkit/utils` ESLint plugin: `projection-sqlite-import-boundary`** reports an
  import of `@vibe-agent-toolkit/projection-sqlite` from code the config enables it for. It guards
  VAT's own package boundary; an adopter has no reason to enable it.

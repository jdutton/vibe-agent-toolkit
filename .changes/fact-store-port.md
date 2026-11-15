### Breaking

- **`@vibe-agent-toolkit/resources`: `ProjectionStore` is renamed `FactStore`.**
- **`@vibe-agent-toolkit/projection-sqlite`: `SqlQueryableStore` is removed.**
  `openSqliteProjectionStore()` is renamed `openSqliteFactStore()` and returns `FactStore`, without
  `query`, `columns` or `writeDerived`. `openEphemeralProjectionStore()` is replaced by
  `openRunDatabase(projection)`, returning a `RunDatabase`.
- **`@vibe-agent-toolkit/utils`: `WorkCounter` drops `store.reads.ephemeral` and
  `store.rows.decoded.ephemeral`.**
- **`@vibe-agent-toolkit/utils`: `store.writes.ephemeral` and `store.rows.written.ephemeral` are
  renamed `hydration.writes` and `hydration.rows.written`, and they count less.** They count only
  loading a run's projection into its run database. Writing a lens's derived relations
  (`writeDerived`) no longer counts, so for a statement that names a lens relation
  `hydration.rows.written` reads lower than the old counter did, and `hydration.writes` reads one
  lower for each lens write.
- **`vat-lab work`: no lab build reads dumps from both sides of this change.** This lab refuses a
  counter dump from a vat build before it, which carries counters it does not know, and an earlier
  lab refuses one from a build after it for the same reason, so a work comparison across the change
  is not possible.

### Added

- **`@vibe-agent-toolkit/utils` ESLint plugin: `projection-sqlite-import-boundary`** reports an
  import of `@vibe-agent-toolkit/projection-sqlite` (by package name or by a relative path into it,
  including `require`, `createRequire`, `import()` and `declare module`) in every file the config
  enables it for. It guards VAT's own package boundary: the storage backend is chosen and injected at
  one edge. An adopter has no reason to enable it.

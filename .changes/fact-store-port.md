### Breaking

- **`@vibe-agent-toolkit/resources`: `ProjectionStore` is renamed `FactStore`.**
- **`@vibe-agent-toolkit/projection-sqlite`: `SqlQueryableStore` is removed.**
  `openSqliteProjectionStore()` is renamed `openSqliteFactStore()` and returns `FactStore`, without
  `query`, `columns` or `writeDerived`. `openEphemeralProjectionStore()` is replaced by
  `openRunDatabase(projection)`, returning a `RunDatabase`.
- **`@vibe-agent-toolkit/utils`: `WorkCounter` drops `store.reads.ephemeral` and
  `store.rows.decoded.ephemeral`,** and renames `store.writes.ephemeral` and
  `store.rows.written.ephemeral` to `hydration.writes` and `hydration.rows.written`.
- **`vat-lab work`: no lab build reads dumps from both sides of this change,** so a work comparison
  across it is not possible.

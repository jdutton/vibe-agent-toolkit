### Breaking

- **`hydrateRunDatabase()` (`@vibe-agent-toolkit/projection-sqlite`) takes a source per relation**:
  `relations` maps each relation name to `{ rows }` (the rows to insert) or, for `blob_references`
  only (`STORED_COPY_RELATIONS`), `{ stored: { store, contentKeys } }` (copy that store's rows for
  those keys inside SQLite). Wrap each row array as `{ rows }`. A key evicted before the copy
  refuses it with `PROJECTION_STORE_ROWS_EVICTED`.
- **`buildResourceProjection()` (`@vibe-agent-toolkit/resources`) returns a `QueryProjection`**:
  every table but `blobReferences`, with `astReferences` holding the AST reference forms, plus
  `blobReferences`, where the query lane's `blob_references` come from (`{ rows }`, or the store
  for the keys a hit admitted). `queryProjectionOf()` turns a `Projection` into one. Edge-lens
  evaluation (`EdgeLensProjection`) reads `astReferences`.

### Added

- **`@vibe-agent-toolkit/utils` work counters `hydration.rows.copied` and
  `store.rows.decoded.repeated`.** The first counts the `blob_references` rows a query copies from
  the store inside SQLite (with `hydration.rows.written`, every row hydrated); the second counts
  stored rows a process decoded twice from one store file, which VAT's own tests hold at zero.

### Changed

- **`vat resources query` and `vat resources check` decode fewer stored rows on a store hit**: the
  lexical references (`bare-token`, `at-prefixed`, `env-anchored`) reach the run database by a copy
  inside SQLite rather than being decoded and inserted. Answers are unchanged. No action needed.
- **A store hit that turns into a miss decodes no stored row twice**: the derivation reads of each
  key only what the hit's read left out. No action needed.

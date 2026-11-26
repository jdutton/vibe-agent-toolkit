### Breaking

- **`hydrateRunDatabase()` (`@vibe-agent-toolkit/projection-sqlite`) takes a source per relation**:
  `relations` maps each relation name to `{ rows }` (the rows to insert) or, for `blob_references`
  only (`STORED_COPY_RELATIONS`), `{ stored: { store, contentKeys } }` (copy that store's rows for
  those keys inside SQLite). Wrap each row array as `{ rows }`. A key evicted before the copy
  refuses it with `PROJECTION_STORE_ROWS_EVICTED`.
- **`buildResourceProjection()` (`@vibe-agent-toolkit/resources`) takes where a hit's references
  come from and returns a `QueryProjection`**: its second argument, `references`, is `'copy'` (a hit
  copies `blob_references` from the store inside SQLite) or `'rows'` (a hit reads every form and
  hands them). It returns every table but `blobReferences`, with `astReferences` holding the AST
  reference forms, plus `blobReferences`, where the query lane's `blob_references` come from
  (`{ rows }`, or `{ stored: { store, contentKeys } }`: the store the hit read, for the keys it
  admitted). Edge-lens evaluation (`EdgeLensProjection`) reads `astReferences`.
- **`PopulationRun` (`@vibe-agent-toolkit/resources`) carries `stored`, the run's one reader of
  its stores**: `withPopulationRun()` supplies it; build a run through it rather than by hand.
  Every population and lens of the run reads and writes the store through it.
- **`FactStore` (`@vibe-agent-toolkit/resources`) requires `attachedTo(target, schema, work)`**:
  the store attaches itself read-only to another SQLite connection (`StoreAttachTarget`) for `work`,
  which is how a query copies stored rows. A wrapper of the port forwards it to the store it wraps;
  a store with no database file throws from it.
- **`readStoredMembership()` (`@vibe-agent-toolkit/resources`) takes the extent request** the run
  reads under: `MEMBERSHIP_EXTENT_REQUEST`, or `ALL_EXTENT_REQUEST` when the run's population reads
  the whole extent next.

### Added

- **`@vibe-agent-toolkit/utils` work counters `hydration.rows.copied` and
  `store.rows.decoded.repeated`.** The first counts the `blob_references` rows a query copies from
  the store inside SQLite (with `hydration.rows.written`, every row hydrated); the second counts
  stored rows a process decoded twice from one store file, which VAT's own tests hold at zero.

### Changed

- **`vat resources query` and `vat resources check` decode fewer stored rows on a store hit**: the
  lexical references (`bare-token`, `at-prefixed`, `env-anchored`) reach the run database by a copy
  inside SQLite rather than being decoded and inserted. Answers are unchanged. No action needed.
- **A run reads the store through one reader, and a key's rows come from one transaction**: every
  population and lens of a run (the claude-context lane and a `vat resources query` lens included)
  reads through it, and a request it already holds reads nothing. A request wider than a held one
  reads the key again whole, and a hit that turns into a miss, or the query lane's retry after an
  eviction, re-reads its keys whole too, so a store eviction between two reads can no longer leave
  a key served without its lexical references. No action needed.

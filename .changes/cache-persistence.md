### Breaking

- **`VAT_PROJECTION_STORE_DIR` is removed; set `VAT_CACHE_DIR` instead.** `VAT_CACHE_DIR` names the
  cache root that holds both the parse cache and the projection store, each under its release
  namespace. It defaults to `<tmpdir>/.vat-cache`, a relative value resolves against the current
  directory, and an empty value means unset. A script that still sets `VAT_PROJECTION_STORE_DIR`
  now has no effect: the store goes to the default root.
- **The external-URL caches moved to `<tmpdir>/.vat-link-cache`.** `external-links.json` and
  `auth-<osUser>/` are no longer under `<tmpdir>/.vat-cache`, and never under `VAT_CACHE_DIR`. The
  first run after upgrading rechecks external links once; `vat cache prune` removes the old copies.
- **`vat cache clear`'s report data changed shape.** It is now
  `{ locations: [{ cacheDir, existed, removed, entriesRemoved, bytesRemoved }], entriesRemoved, bytesRemoved }`,
  one location for the cache root and one for the link cache, and `examined` is 2.
- **`vat cache clear` refuses (`USAGE_INVALID`, nothing deleted) a cache root it cannot prove is
  VAT's**: one without the `CACHEDIR.TAG` VAT writes, other than the default `<tmpdir>/.vat-cache`
  when that is a real directory (not a symbolic link) owned by the current user. It always refuses
  the filesystem root, the home directory, the temp directory itself and any directory containing
  the current directory. Point `VAT_CACHE_DIR` at a directory used only by VAT; VAT tags it on
  first use if it is new or empty.
- **Library: `vatCacheRoot()` (`@vibe-agent-toolkit/resources`) honours `VAT_CACHE_DIR`, and the
  root no longer holds the link cache** (now `vatLinkCacheDirectory()`). Code that joined
  `external-links.json` onto `vatCacheRoot()` must use `vatLinkCacheDirectory()`.
- **Library: `openSqliteFactStore()` (`@vibe-agent-toolkit/projection-sqlite`) throws
  `StoreUnopenableError` (code `PROJECTION_STORE_UNOPENABLE`) for an existing store file SQLite
  reports at open as corrupt or not a database**, instead of SQLite's raw error. `close()` now
  surfaces a checkpoint failure other than contention. The CLI warns on such a failure and keeps
  the run's result.

### Added

- **`vat cache prune` removes every cache entry VAT wrote that this build does not use**: every
  namespace but this build's (older and newer releases, and under the shared default root other
  worktrees' and other VATs' namespaces), what older releases kept at the root (the link-cache files
  and the root-level `parse/` directory), and projection stores of another shape. It removes only
  names VAT recognises as its own, never anything else in the directory, and leaves (listed under
  `inUse`) any entry holding a projection store a running VAT has open. It reports what it removed
  (entries, bytes), supports `--dry-run`, and stands behind the same guard as `vat cache clear`. Run
  it before saving a CI cache so the cache stops growing with every release.
- **CI can persist VAT's caches.** Save and restore `VAT_CACHE_DIR` outside the checkout (in
  GitHub Actions, `$RUNNER_TEMP/vat-cache`, set from a step through `$GITHUB_ENV`), keyed on OS,
  architecture, Node version, lockfile hash and commit, and restore only from the same toolchain
  and lockfile. The CLI docs and the `vat-adoption-and-configuration` skill carry a GitHub Actions
  example. A run warns when the cache root is inside the scanned tree.
- **Library exports.** `@vibe-agent-toolkit/projection-sqlite`: `discardStoreDatabase`,
  `isStoreInUse`, `isStoreUnopenableError` and the `StoreUnopenableError` type.
  `@vibe-agent-toolkit/resources`: `vatLinkCacheDirectory`, `recogniseVatCacheRoot`,
  `markVatCacheRoot`, `isVatCacheRootEntryName`, `projectionStoreDirectoryName`,
  `isProjectionStoreDirectoryName`.

### Fixed

- **A corrupt, truncated or not-a-database projection store no longer fails the run.** When SQLite
  rejects the file at open, VAT warns once on stderr, naming the file and SQLite's error, discards
  it, and continues on a fresh store, or with none if that also fails. A store that fails mid-run,
  or one SQLite cannot open for a machine reason (a permission, a path, a full disk), still fails
  the run.
- **Closing the projection store checkpoints its write-ahead log**, so a cache saved right after a
  run is a self-contained `projection.db`.

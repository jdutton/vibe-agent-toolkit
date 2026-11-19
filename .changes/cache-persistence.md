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
  VAT's**: one without the `CACHEDIR.TAG` VAT writes, other than the default `<tmpdir>/.vat-cache`.
  It always refuses the filesystem root, the home directory, the temp directory itself and any
  directory containing the current directory. Point `VAT_CACHE_DIR` at a new or empty directory and
  VAT tags it on first use.

### Added

- **`vat cache prune` removes cache entries this VAT release never reads**: older release
  namespaces and projection stores of an older shape under the cache root. It reports what it
  removed (entries, bytes), supports `--dry-run`, and stands behind the same guard as
  `vat cache clear`. Run it before saving a CI cache so the cache stops growing with every release.
- **CI can persist VAT's caches.** Save and restore `VAT_CACHE_DIR` with your CI cache, keyed on
  the runner OS and the VAT version or lockfile hash. The CLI docs and the
  `vat-adoption-and-configuration` skill carry a GitHub Actions example.

### Fixed

- **A corrupt, truncated or not-a-database projection store no longer fails the run.** VAT warns
  once on stderr, naming the file and SQLite's error, discards it, and continues on a fresh store,
  or with none if that also fails. A store that fails mid-run still fails the run.
- **Closing the projection store checkpoints its write-ahead log**, so a cache saved right after a
  run is a self-contained `projection.db`.

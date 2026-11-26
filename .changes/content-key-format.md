### Breaking

- **A content key is now `<parserKind>.<keyKind>.<hex>`**, for example `markdown.sha256.<64 hex>`.
  A `sha256` key's hex is the plain SHA-256 of the file's raw bytes; the parser kind qualifies the
  key text and is no longer mixed into the hash, so a routing change still gives a path a new key.
  `keyKind` is `sha256` (the only kind VAT computes), `git-sha1` or `git-sha256`. Every projection
  store and parse cache rebuilds once on the first run after upgrading. `vat resources scan
  --verbose` prints the new shape, and the published JSON Schemas' `contentKey` pattern changed:
  `resources-scan.json` and every `projection-*.json` that carries a content key.
- **Library (`@vibe-agent-toolkit/resources`): a content key is the branded type `ContentKey`.**
  `computeContentKey` returns one and `ContentKeySchema` parses to one. Admit a string with
  `parseContentKey(text)` (`undefined` when malformed), build one with `formatContentKey(parts)`,
  read its fields with `contentKeyParts(key)`, compare two with `===` (equal exactly when their
  text is, so keys of two key kinds are never equal) and sort with `orderContentKeys`. `getResourcesByContentKey` takes a
  `ContentKey`. `parserKindOf` is removed: use `contentKeyParts(key).parserKind`.
- **Library (`@vibe-agent-toolkit/resources/testing`): `contractContentKey` is replaced by
  `testContentKey(kind, seed)`**, the one way a fixture writes a key it did not compute from bytes.
- **Library (`@vibe-agent-toolkit/resources`): `PopulationCache.treeUnchanged(realized)` takes a
  required `RealizedContentKeys`**, what the run realized at each absolute path under its root, so
  an implementation can check bytes the tree hash does not carry.
- **Library (`@vibe-agent-toolkit/projection-sqlite`): `openSqliteFactStore(options)` requires its
  options and `options.blobTierBudgetBytes`**, a positive finite number of bytes; anything else
  throws a `VatError` whose code is `PROJECTION_STORE_BUDGET_INVALID_CODE`
  (`PROJECTION_STORE_BUDGET_INVALID`), exported. `retainedBlobKeys` is removed.
  Pass `DEFAULT_BLOB_TIER_BUDGET_BYTES` (190,000,000), the budget the CLI uses.
- **The projection store bounds its blob tier by bytes, not by a key count.** A write keeps the most
  recently held content keys whose recorded row bytes fit the budget (about 265 MB of database pages
  at the default), never evicting the keys the write itself holds, whatever their timestamps. The
  previous bound was the 50,000 most recent keys. A key the store replaces now clears its rows for every harness, not only
  the harnesses this write carries, so its recorded bytes stay exact.
- **Library (`@vibe-agent-toolkit/projection-sqlite`): `CREATE_EXTENTS_TABLE_SQL` and
  `EXTENT_KEY_COLUMNS` are no longer exported.** Import `EXTENT_KEY_COLUMNS` from
  `@vibe-agent-toolkit/resources`, where the store's bookkeeping tables are now declared as data
  (`STORE_BOOKKEEPING_TABLES`, with `blobRowBytes`, the byte measure the budget is kept in);
  `createBookkeepingTableSql` builds their DDL. The store's shape digest covers these tables, so a
  bookkeeping column change moves the store to a new directory.
- **Duplicate grouping is per key kind.** `getDuplicates`, `getUniqueByContentKey` and
  `getResourcesByContentKey` group by the whole key text, so keys of two key kinds never group
  together, as identical bytes under two parser kinds never did.
- **Library (`@vibe-agent-toolkit/utils/git`): `GitSnapshotEntry` gains required `oid` and `gitPath`**
  (git's own spelling of the path). **`gitTreeKey()` and `freshGitTreeKey()` return a `GitTreeKey`**,
  the snapshot plus a required `lfs: LfsReading` (each Git LFS pointer's `absolutePath`, `lfsOid` and
  `pulled`, and `filter`: `configured`, `not-configured`, or `not-asked` when there is no pointer).
  `GitTreeKeyFailure` gains the kinds `lfs-undecidable`, `lfs-malformed`, `lfs-file-unread`,
  `lfs-unlisted` and `lfs-unreadable`; `gitSnapshotFailureOf` classifies them.

### Fixed

- **After `git lfs pull`, the next run re-reads the pulled files instead of serving the pointers'
  facts from the store.** The store key now reads which files are Git LFS pointers and whether each
  is pulled. Every keyed run spawns one `git check-attr` over the tree's files; when any is
  `filter=lfs` it also spawns `git cat-file --batch-check`, `git cat-file --batch` for blobs under
  1024 bytes, and `git config` when pointers exist, parses by git-lfs's own pointer grammar
  (extension lines and older version URLs included), and makes one `lstat` per pointer, reading a
  file only when its content is exactly as long as its pointer. The write-time guard repeats the pass
  on a fresh key. A file that is neither
  its pointer nor its content declines the key, naming `git update-index --refresh` and
  `git lfs pull`. A small `filter=lfs` blob that opens like a pointer and does not parse, a pointer's
  file the OS will not let VAT look at, and a git answer that leaves out anything it was asked about
  decline the key too. A pull that lands
  during a run, or a pulled file whose bytes no longer match its pointer, keeps that run's rows out of
  the store.
- **A notice when a tree holds pulled Git LFS files and no git-lfs filter is configured**, once per root
  per command, naming `git lfs install` and `git update-index --refresh`. Without the filter a pulled
  file whose stat changes misses the store on every run.

### Added

- **`@vibe-agent-toolkit/utils/eslint` ships `content-key-opaque`** (type-aware, not in
  `recommended`): outside the files its `allowFiles` option names, it reports a cast to `ContentKey`
  or to an array or object of keys from values that are not keys, any member access, index, spread,
  destructure or iteration of a `ContentKey`, one handed to a `RegExp`'s `test`/`exec`, and
  `compareCodeUnits` or `localeCompare` with one. `===` between two keys is the contract.

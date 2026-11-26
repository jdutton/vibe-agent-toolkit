### Breaking

- **`matchesCollection(filePath, collection)` is removed from `@vibe-agent-toolkit/resources`;
  `compileCollectionMatcher(collection)` replaces it.** It compiles a collection's patterns once and
  returns `(filePath) => boolean` with the same rules; compile once before a loop:
  `files.filter(compileCollectionMatcher(docs))`.
- **`FsLookupCache.probeStats` and the `PathProbeStats` type are removed from
  `@vibe-agent-toolkit/utils`.** `FsLookupCache.probe` keeps no memo of its own: it answers from the
  walk of the path's link chain, whose reads the place-kind snapshot keeps (only the tree's own root
  is asked of the kernel's `stat`). Count its work with the `fs.lstat` work counter.
- **`WalkLinkGraphOptions.pathProbe` is removed from `@vibe-agent-toolkit/agent-skills`.** The walk
  always builds its own probe; drop the option.

### Added

- **`withPlaceKindSnapshot(root, run)` and `withoutPlaceKindSnapshot(run)` in
  `@vibe-agent-toolkit/utils`**: inside the first, the link-chain walk reads each file, directory,
  link or absence beneath `root` once (a kept link that is no longer one, or is gone, is read
  again), and a path walked again is answered without walking; a snapshot opened inside one that
  already covers its tree uses that one. Inside the second, every walk asks afresh, whatever
  snapshot encloses it. Each CLI run declares which it is: a verb that only reads opens the
  snapshot, and a verb that writes under its tree (`vat skills build`, `vat skills package`, `vat
  claude plugin build`, `vat skill test run`) walks afresh and sees its own writes. A read-only verb
  whose `VAT_CACHE_DIR` lies inside its tree walks afresh too.
- **`withWalkPlaceKindSnapshot(root, run)` in `@vibe-agent-toolkit/utils`**, for a synchronous walk
  that writes nothing: it also reads each component outside `root` once for the walk. A skill's link
  walk is one, so a link target outside the project is read once however many links name it.
- **`WRITE_UNDER_PLACE_KIND_SNAPSHOT_CODE` in `@vibe-agent-toolkit/utils`**: the shared write
  primitives (`writeFileUnder`, `makeDirectoryUnder`, `replaceFile`, `removeEntry`,
  `renameFileAtomic`, `copyTree`, `copyRegularFile`, `applyTreePlan`, `extractArchive`,
  `mkdirSyncReal`) refuse a write beneath an open place-kind snapshot's root with a `VatError` of this
  code. Open a run that writes under its tree with `withoutPlaceKindSnapshot`.
- **The `collection.matchers.compiled` work counter** counts each collection compiled to a matcher.

### Fixed

- **`vat validate` is faster on large trees.** The link-chain walk no longer re-reads the same
  directories for every file (66,289 `lstat` calls down to 6,308 on a warm run of a 25,000-file
  project), collection globs compile once per collection instead of once per
  file, and the test-input check resolves each path once instead of once per declared directory.
  No action needed.

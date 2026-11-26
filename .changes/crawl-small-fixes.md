### Breaking

- **`matchesCollection(filePath, collection)` is removed from `@vibe-agent-toolkit/resources`;
  `compileCollectionMatcher(collection)` replaces it.** It compiles a collection's patterns once and
  returns `(filePath) => boolean` with the same rules; compile once before a loop:
  `files.filter(compileCollectionMatcher(docs))`.

### Added

- **`withPlaceKindSnapshot(root, run)` in `@vibe-agent-toolkit/utils`**: inside it, the link-chain
  walk reads each file, directory or link beneath `root` once (absent answers are asked again).
  Every run that writes nothing opens one; a change to a path's kind mid-run is not re-read.
- **The `collection.matchers.compiled` work counter** counts each collection compiled to a matcher.

### Fixed

- **`vat validate` is faster on large trees.** The link-chain walk no longer re-reads the same
  directories for every file (66,289 `lstat` calls down to 6,545 on a warm run of a 25,000-file
  project), collection globs compile once per collection instead of once per file, and the
  test-input check resolves each path once instead of once per declared directory. No action needed.

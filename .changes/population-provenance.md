### Breaking

- **`ResourceRegistry.crawl()` returns `{ resources, population }`**, not the resource array: read
  `.resources` where you used the result directly. `population` says whether the file list was
  walked (`{ lane: 'walk' }`) or enumerated by a population source.
- **`ResourceRegistry.addResources()` returns resources in admission order** (UTF-16 code-unit
  order of the resolved path), not in the order you passed: do not pair the result with your input
  by index. Look a resource up by `filePath` instead.

### Added

- **`vat resources validate` reports `data.population`**: `store` when its file list came from the
  projection store, `derived` when it was built this run (including with `VAT_PROJECTION_STORE=0`,
  which keeps the projection lane and only skips the store), and `null` only when no projection
  enumerated the files: the walk lane ran (`VAT_RESOURCES_CRAWL=walk`), or the crawl declined the
  projection because it was bound to another root, and walked instead. `vat resources query` and
  `check` add `lensPopulation` (`none`/`store`/`derived`; `null` in check when no population ran).

### Changed

- **A duplicate resource id now has one winner on every registry lane**: within one admission batch
  (an `addResources` call, so a whole crawl, or a skill's bundled assets) the registry admits paths
  in UTF-16 code-unit order of the resolved path, so `vat resources validate`, `vat audit`,
  `vat inventory` and `vat skills build`/`validate` keep the same file, with or without git, on a
  store hit or a fresh derive, and in the walk lane. `-` sorts before `/`, so `dup-hyphen/note.md`
  now beats `dup/hyphen-note.md`, where the readdir walk used to let `dup/hyphen-note.md` win. A
  file an earlier batch registered still keeps its id against a later one.
- **`vat resources scan` reports `lane: walk` when a crawl declined the projection**, since the walk
  is what enumerated; it used to report `projection` for a population the projection never built.
- **Listing order is canonical (code-unit order of the resolved path)**: `vat resources scan`'s
  resources, `vat resources validate --verbose`'s `data.files`, and duplicate-id collisions come out
  in one order on every host and run, rather than the walk's readdir order.

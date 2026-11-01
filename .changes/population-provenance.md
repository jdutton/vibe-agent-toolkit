### Added

- **`vat resources validate` reports `data.population`**: `store` when its file list came from the
  projection store, `derived` when it was built this run (including with `VAT_PROJECTION_STORE=0`,
  which keeps the projection lane and only skips the store), and `null` only when no projection
  enumerated the files: the walk lane ran (`VAT_RESOURCES_CRAWL=walk`), or the crawl declined the
  projection because it was bound to another root, and walked instead. `vat resources query` and
  `check` add `lensPopulation` (`none`/`store`/`derived`; `null` in check when no population ran).

### Changed

- **A duplicate resource id now has one winner on every registry lane**: the registry admits paths
  in UTF-16 code-unit order of the resolved path before first-added-wins decides, so
  `vat resources validate`, `vat audit`, `vat inventory` and `vat skills build`/`validate` keep the
  same file, with or without git, on a store hit or a fresh derive, and in the walk lane. `-` sorts
  before `/`, so `dup-hyphen/note.md` now beats `dup/hyphen-note.md`, where the readdir walk used to
  let `dup/hyphen-note.md` win.
- **`vat resources scan` reports `lane: walk` when a crawl declined the projection**, since the walk
  is what enumerated; it used to report `projection` for a population the projection never built.
- **Listing order is canonical (code-unit order of the resolved path)**: `vat resources scan`'s
  resources, `vat resources validate --verbose`'s `data.files`, and duplicate-id collisions come out
  in one order on every host and run, rather than the walk's readdir order.

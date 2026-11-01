### Added

- **`vat resources validate` reports `data.population`**: `store` when its file list came from the
  projection store, `derived` when it was built this run, `null` when the store did not answer it.
  `vat resources query` and `check` add `lensPopulation` (`none`/`store`/`derived`; `null` in check).

### Changed

- **A duplicate resource id now has one winner on every host and every run**: the projection's file
  list is sorted by byte order of the whole path before the first-added-wins registry sees it, so
  `dup-hyphen/note.md` beats `dup/hyphen-note.md` (`-` sorts before `/`) where the readdir walk used
  to let `dup/hyphen-note.md` win.

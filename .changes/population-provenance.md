### Added

- **`vat resources validate` reports `data.population`**: `store` when its file list came from the
  projection store, `derived` when it was built this run, `null` when nothing was populated. `vat
  resources query` and `vat resources check` add `lensPopulation` (`none`, `store`, `derived`).

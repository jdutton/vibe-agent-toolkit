### Breaking

- **`ResourceRegistry.crawl()` returns `{ resources, population }`**, not the resource array: read
  `.resources` where you used the result directly. `population` is the population source's outcome
  and extent source for the file list.
- **`ResourceRegistry.addResources()` returns resources in admission order** (UTF-16 code-unit
  order of the resolved path), not in the order you passed: do not pair the result with your input
  by index. Look a resource up by `filePath` instead.
- **`ResourceRegistry.fromCrawl()` returns `{ registry, resources, population }`**, not the
  registry: destructure `registry` where you used the result directly. The other two fields are what
  `crawl()` returned for the same crawl.

### Added

- **`vat resources validate` reports `data.population`**: `store` when its file list came from the
  projection store, and `derived` when it was built this run (including with `VAT_PROJECTION_STORE=0`,
  which only skips the store). `vat resources query` and
  `check` add `lensPopulation` (`none`/`store`/`derived`; `null` in check when no population ran).
- **`vat validate` carries the same field** for its resources phase, at
  `data.phases[name=resources].data.population`.
- **`@vibe-agent-toolkit/resources` exports the population vocabulary**: `admissionOrder()` (the one
  order the registry admits a batch in), `RegistryCrawl` and `CrawlPopulation` (what `crawl()` and
  `fromCrawl()` return), `ResourceEnumeration`, `PopulationOutcome`, `PopulateResult`,
  `TreePopulationOptions` and `ClaudeContextPopulation` (a population's `projection` with ONE
  `population`, `store` only when its root list and its real pass were both served from the store),
  and the runtime lists `POPULATION_ORIGINS` and `CRAWL_SOURCE_KINDS`, each built
  from an exhaustive record over its union so a schema enum can use it instead of a hand-typed copy.

### Changed

- **A duplicate resource id now has one winner on every registry lane**: within one admission batch
  (an `addResources` call, so a whole crawl, or a skill's bundled assets) the registry admits paths
  in UTF-16 code-unit order of the resolved path, so `vat resources validate`, `vat audit`,
  `vat inventory` and `vat skills build`/`validate` keep the same file when each lane lists the same
  spelling of the same files, in any listing order, on a store hit or a fresh derive. Where the git index and the walk spell one file differently (a case-only rename made
  without `git mv`, or NFD and NFC names on macOS), the lanes can still keep different winners.

  `-` sorts before `/`, so `dup-hyphen/note.md` now beats `dup/hyphen-note.md`, where the readdir
  walk used to let `dup/hyphen-note.md` win. A file an earlier batch registered still keeps its id
  against a later one.
- **Listing order is canonical (code-unit order of the resolved path)**: `vat resources scan`'s
  resources, `vat resources validate --verbose`'s `data.files`, and duplicate-id collisions come out
  in one order for the same spelling of the same files, in any listing order, rather than the
  walk's readdir order. `vat resources validate`'s findings follow that admission order too:
  registry iteration, unreadable resources, and duplicate drops.

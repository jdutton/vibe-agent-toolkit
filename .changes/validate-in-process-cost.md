### Breaking

- **`FactStore.readBlobFacts(contentKeys, request)` takes a required `BlobRequest`**: the
  blob-scoped tables to read and the `blobReferences` syntactic forms to keep (a set, or `'all'`).
  It answers only the requested tables (`Pick<BlobScopedRows, Table>`), so a restricted answer cannot
  be assembled into a projection. `ALL_BLOB_REQUEST` reads everything, as before. A warm
  `vat validate`'s stored admission reads `ADMISSION_BLOB_REQUEST` (the fact reader's tables,
  `BLOB_FACT_READER_TABLES`, with AST forms only) and no longer decodes the lexical reference rows or
  the harness tables; a projection hit (the checks child, `vat resources query`, `vat claude context`)
  still reads all. A backend implementing the port must honour the request.
- **`FactStore.readExtent(key, request)` takes a required `ExtentRequest`**: the extent-scoped
  tables to read and the reconstruction steps (`identity`, `roots`) to run over them. It answers
  only the requested tables (`Pick<ExtentScopedRows, Table>`), and `selectRequestedRows(extent,
  request, { contexts, rootId })` is generic over the same request. A step whose tables are not
  requested does not compile, and at run time a step missing its tables, a context-less table
  requested without its step, or a requested table the store did not return throws
  `ExtentRequestUnmetError` (code `EXTENT_REQUEST_UNMET`). `ALL_EXTENT_REQUEST` reads everything, as
  before. A warm `vat validate`'s membership read (`readStoredMembership`) reads
  `MEMBERSHIP_EXTENT_REQUEST` (`resource_realizations`, `realization_conditions`, `zone_provenance`,
  no step) and no longer decodes the other extent tables; a projection hit still reads all. A
  backend implementing the port must honour the request.
- **`store.reads.persistent` is replaced by `store.reads.extent` and `store.reads.blob`**, one per
  `FactStore.readExtent` and one per `FactStore.readBlobFacts` that asks for a key. A warm
  `vat validate` makes one of each in its resources phase and none in its skills phase; a warm
  `vat skills validate` makes one of each. The lab's `work` facet follows the new names.
- **`SkillTextRun` requires `crawlOnce(key, crawl)`**: the run's one crawl of each skill discovery
  base. `RunPopulation` holds it, one memo per run; `RunSkillRegistriesOptions` requires
  `crawlOnce`, and `RunSkillRegistries` hands every crawl to it, so every registries object over
  one run shares the run's memo. A caller-built run of one call crawls each time.
- **`countWork` refuses `git.calls`**: its counter type excludes it, and an untyped caller's call
  throws a `RangeError`. A git process is counted only where VAT starts one (`countGitSpawn`),
  which also names it in the spawn log.

### Added

- **`VAT_GIT_SPAWNS=<dir>` writes a git spawn log per vat process**: every git process it started,
  in order, with its arguments, working directory and `vat validate` phase, as
  `git-spawns-<pid>.json` (`GIT_SPAWNS_ENV`, `GitSpawnDump`). Each entry is one `git.calls`. A
  process run without the variable counts its git processes and records none of their details.
- **`memoized(memo, key, compute)` in `@vibe-agent-toolkit/utils`**: one promise per key, computed
  on first ask, a rejection kept as the answer.

### Changed

- **`VAT_WORK_COUNTERS` counts filesystem work by syscall.** `fs.stat` counts `stat` and `fstat`
  calls, and the warm admission's readability probe (an open and a close, reading nothing, counted
  as the stat it stands in for); the new `fs.lstat` counts `lstat` calls: a realization's own
  look at its path (formerly counted as `fs.stat`) and every `lstat` the link-chain walk makes,
  which per path is the components walked below the root plus one per link hop. A path walked from the filesystem root
  (one outside the tree it is checked against) counts every component of its absolute path.
- **Skill discovery lists each include base once per run.** `vat validate`'s resources phase (for
  the skills' declared `files:`) and its skills phase both discover the skills, and each listed every
  `skills.include` base with `git ls-files`, the same arguments in the same directory over the same
  tree. The skills phase now reuses the run's crawl: on a warm run with the store on, the skills
  phase's `git.calls` fall to zero; in every run, one spawn fewer per include base.

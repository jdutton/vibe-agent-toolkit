### Added

- **Library: `FactStore.readBlobFacts` and `FactStore.readExtent` take a required `BlobRequest` /
  `ExtentRequest`** naming the tables to read, and answer only those (`ALL_BLOB_REQUEST`,
  `ALL_EXTENT_REQUEST` read everything). A backend must honour it: an answer missing a requested
  table is refused (`StoreRequestUnmetError`, code
  `STORE_REQUEST_UNMET`, with `tier: 'blob' | 'extent'`).
- **Library: `SkillTextRun` and `RunSkillRegistriesOptions` require `crawlOnce(key, crawl)`**, the
  run's one crawl of each skill discovery base; `RunPopulation` holds one per run.
- **`VAT_WORK_COUNTERS` dumps `store.reads.extent`, `store.reads.blob` and `fs.lstat`.** `fs.stat`
  and `fs.lstat` count only the admission-path call sites `WORK_COUNTER_NAMES` documents; `git.calls`
  counts only git processes VAT starts, and `countWork('git.calls')` throws.
- **`VAT_GIT_SPAWNS=<dir>` writes a git spawn log per vat process** (`git-spawns-<pid>.json`):
  each git process it started, with its arguments, working directory and `vat validate` phase.
- **Library: `memoized(memo, key, compute)` in `@vibe-agent-toolkit/utils`**: one promise per key,
  computed on first ask, a rejection kept as the answer.

### Changed

- **When a skill declares `files:`, `vat validate` lists each `skills.include` base once per run**,
  not once per phase: one fewer crawl (in a git repository, one fewer `git ls-files`) per base.

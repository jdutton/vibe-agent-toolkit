### Breaking

- **`VAT_RESOURCES_CRAWL` is gone, with the resources walk lane it selected.** The projection is the
  only lane; unset the variable. Lab arms no longer set it.
- **`ResourceRegistry.crawl` no longer falls back to `crawlDirectory`**: `CrawlOptions.populationSource`
  is required, and `CrawlOptions.followSymlinks` is removed (the population never follows a symlink).
- **The registry's guard refusing `{ degrade }` beside a population source is gone**: the population
  takes `{ degrade }` itself. Degrade decides only what an unreadable directory does; it never picks
  the enumerator.
- **`ResourcePopulationSource.root` is removed, and `enumerate` takes the root, a required
  `unreadable` policy and the crawl's `members`** (`PopulationMembers`: its include and exclude
  globs). A root other than the run's home, and any root with no store, is listed by name (git's
  `ls-files` in a repository, one walk outside one): only the files the crawl admits become rows,
  and no other file is read or hashed, by VAT or by git.
- **`buildResourcePopulation` requires `run`** (a `RunPopulation`), and so does `populate()`. A
  stored population always refuses an unreadable directory; a degrading one is a listing.
- **`BlobPopulationOptions.dispatcher` is required, and its `parseCache` and `parsePool` are
  removed**: `populateBlobs` parses on the run's dispatcher and never builds a pool of its own.
- **`RegistryUnreadablePolicy` is removed.** Use `PopulationUnreadablePolicy`, the one name for the
  same type.
- **`CRAWL_LANES` is removed, and so is `vat resources scan`'s `data.lane`.** Read
  `data.extentSource`.
- **`vat resources validate`'s `data.population` is never `null`**: it is `store` or `derived`.
- **`crawlAndResolveRegistry` and `CrawlRegistryOptions` are removed.** Take a view of the run's
  registry: `ResourceRegistry.forRun(population).view(...)`.
- **`createProjectRegistry` and `ProjectRegistryOptions` are removed.** Use a `registry.view(...)`
  over the project root, or `RunSkillRegistries` for skills.
- **`resetPackagingRegistryCache` is removed**, with the per-root registry memo caches. A run's
  registries live as long as the run.
- **`ResourceRegistryOptions.parsePool` is removed.** The input cap is the population's.
- **`PackageSkillOptions.registry?` is replaced by required `registries`** (`RunSkillRegistries`).
- **`validateSkillForPackaging`'s `shared` is required**, and `SkillValidationSharedContext.registries`
  is required.
- **`RunSkillRegistriesOptions.dispatcher` is required**, and `RunSkillRegistries.dispatcher` is the
  run's one parse dispatcher: the packager's SKILL.md parse and its post-build checks run on it.
- **`checkBrokenPackagedLinks` takes a required `route`** (`{ dispatcher }`, `{ dispatcher: undefined }`
  for a one-off check), and its `droppedDests` is no longer defaulted.
- **A symlinked `.md` alias in a multi-root `vat skills validate` batch is now declined**, like
  every symlink the population meets, rather than walked as a second member.

### Added

- `@vibe-agent-toolkit/resources`: the `PopulationMembers` and `PopulationUnreadablePolicy` types.
- `@vibe-agent-toolkit/utils`: `GitTracker.listing()` and the `GitTrackerListing` type: the names
  the tracker's `ls-files` listed, and the directories git could not open.
- `@vibe-agent-toolkit/agent-skills`: `projectConfigOrNone`, `REGISTRY_INCLUDE`, `withSkillRegistries`
  and the `SkillRegistryRuling` type.

### Fixed

- **A root other than the run's home no longer reads and hashes every file under it.** `vat skills
  validate` over a project whose skills sit under a second root reads only the files a view admits.
- **`vat audit` enumerates with the same source as `vat skills validate`**: git inside a repository,
  so a tracked document under a tool-output-named directory is a member for both verbs.
- **A listing never stages the tree into an index.** In a repository a root with no store is listed
  by `git ls-files`, so `vat audit` with an untracked file git cannot read reports its findings
  (exit 1) instead of refusing the run, and untracked files are not read or hashed by git.
- **Outside a repository, authored markdown under a tool-output-named directory (`docs/coverage/`)
  is a member** for `vat audit`, `vat skills validate` and every other verb with no store: with no
  ignore rules the listing prunes only what can never be content, and the crawl's own exclude
  decides.

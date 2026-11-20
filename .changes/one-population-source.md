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
  globs). A root other than the run's home, and any root with no store, is listed: only the files
  the crawl admits become rows, and no other file is read or hashed.
- **`buildResourcePopulation` requires `run`** (a `RunPopulation`) **and `unreadable`**, and so does
  `populate()` for `run`.
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
- `@vibe-agent-toolkit/agent-skills`: `projectConfigOrNone`, `REGISTRY_INCLUDE`, `withSkillRegistries`
  and the `SkillRegistryRuling` type.

### Fixed

- **A root other than the run's home no longer reads and hashes every file under it.** `vat skills
  validate` over a project whose skills sit under a second root reads only the files a view admits.
- **`vat audit` enumerates with the same source as `vat skills validate`**: git inside a repository,
  so a tracked document under a tool-output-named directory is a member for both verbs.

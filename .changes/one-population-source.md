### Breaking

- **`VAT_RESOURCES_CRAWL` is gone, with the resources walk lane it selected.** The projection is the
  only lane; unset the variable. Lab arms no longer set it.
- **`ResourceRegistry.crawl` no longer falls back to `crawlDirectory`**: `CrawlOptions.populationSource`
  is required. A crawl of a root other than the population's home is enumerated for that root.
- **The registry's guard refusing `{ degrade }` beside a population source is gone**: the population
  takes `{ degrade }` itself.
- **`crawlAndResolveRegistry` and `CrawlRegistryOptions` are removed.** Take a view of the run's
  registry: `ResourceRegistry.forRun(population).view(...)`.
- **`createProjectRegistry` and `ProjectRegistryOptions` are removed.** Use a `registry.view(...)`
  over the project root, or `RunSkillRegistries` for skills.
- **`buildSkillsValidateRegistry` is removed.** Use `RunSkillRegistries`.
- **`resetPackagingRegistryCache` is removed**, with the per-root registry memo caches. A run's
  registries live as long as its `RunContext`.
- **`withResourcePopulationSource` is removed.** Open a run with `withRunContext`.
- **`crawlLaneDebugLine`, `RESOURCES_CRAWL_ENV` and the other crawl-lane selector exports are
  removed.** No replacement: there is one lane.
- **`publishedPopulation` and `extentSourceOf` are removed.** Read `population` on the load result.
- **`CRAWL_LANES` is removed, and so is `vat resources scan`'s `data.lane`.** Read
  `data.extentSource`.
- **`vat resources validate`'s `data.population` is never `null`**: it is `store` or `derived`.
- **`PackageSkillOptions.registry?` is replaced by required `registries`** (`RunSkillRegistries`).
- **`validateSkillForPackaging`'s `shared` is required**, and `SkillValidationSharedContext.registries`
  is required.
- **`populate()` and `buildResourcePopulation` require `run`** (a `RunPopulation`).
- **The registry's own parse limits (`parsePool.limits`) are removed.** The input cap is the
  population's, `POPULATION_PARSE_LIMITS`.
- **`RunSkillRegistriesOptions.dispatcher` is required**, and `RunSkillRegistries.dispatcher` is the
  run's one parse dispatcher: the packager's SKILL.md parse and its post-build checks run on it.
- **`checkBrokenPackagedLinks` takes a required `route`** (`{ dispatcher }`, `{ dispatcher: undefined }`
  for a one-off check), and its `droppedDests` is no longer defaulted.

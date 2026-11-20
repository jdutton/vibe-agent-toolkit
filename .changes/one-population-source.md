### Breaking

- **`VAT_RESOURCES_CRAWL` is gone, with the resources walk lane it selected.** The projection is the
  only lane; unset the variable. Lab arms no longer set it.
- **`ResourceRegistry.crawl` no longer falls back to `crawlDirectory`**: `CrawlOptions.populationSource`
  is required, and `CrawlOptions.followSymlinks` is removed (the population never follows a symlink).
- **`CrawlOptions.ignoredRefusals` (`'record' | 'skip'`) is required**, and so is
  `PopulationMembers.ignoredRefusals`: whether the crawl reports a directory it could not list inside
  ignored territory. A root with no store walks ignored territory only for `record`.
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

- `@vibe-agent-toolkit/resources`: the `PopulationMembers`, `PopulationUnreadablePolicy` and
  `IgnoredRefusals` types.
- `@vibe-agent-toolkit/utils`: `GitTracker.listing()`: the names the tracker's `ls-files` listed
  (or its open snapshot held).
- `@vibe-agent-toolkit/utils`: `gitLinksCheckedOutAsFiles`: the tracked links a `core.symlinks=false`
  checkout wrote as plain files, read from the index under one root only when `core.symlinks` is
  false (unset is false on Windows, as Git for Windows reads it), or `null` when git did not answer,
  as `gitLsFiles` and `gitLsOthers` return it.
- `@vibe-agent-toolkit/utils`: `appendAll(target, items)`, which appends one item at a time, and
  the `no-spread-push` ESLint rule (`@vibe-agent-toolkit/utils/eslint`, not in `recommended`),
  which refuses spreading an array into `push()` or `unshift()`.
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
- **A root listed with no store reports the same conditions as a stored population of the same
  tree**: an unlistable directory (refused in git's territory or inside a nested repository,
  recorded in ignored territory), and a declined link the crawl's exclude does not cover, a
  directory link no include names included. Before, a second root in a store-on run silently
  dropped an unlistable directory that the store-off run refused.
- **A root below a repository's top level reads git's `ls-files --others` paths relative to itself**,
  as git prints them, in the stored population, the listing and the Claude rules scope: an
  ignored directory under such a root was looked for in the wrong place.
- **A stored population refuses an `ls-files --others` listing git did not answer**, ignored or
  not-ignored, as a listing does, instead of reading the silence as "nothing there". So does the
  Claude rules scope's ignored listing, which read it as "nothing ignored" and called every glob
  over ignored territory `inert`. The refusal is coded by cause: `GIT_NOT_FOUND` for a git missing
  from PATH, and `GIT_NO_ANSWER` otherwise.
- **A tracked link a `core.symlinks=false` checkout wrote as a plain file is a declined link with
  the store off**, as git's index and the stored population keep it, not a member.
- **A walk of more than about 125,000 paths no longer dies with `Maximum call stack size exceeded`.**
  The stored population appended a gitignored directory's walk (a 200,000-file `.venv`) as one
  spread argument list; so did three agent-skills walks. Every array append in product source now
  goes through `appendAll`, and `local/no-spread-push` refuses the spread.
- **`vat resources validate` and `vat resources scan` with an unreadable untracked non-markdown file
  exit 0 instead of 2**, store on and off: the listing never stages the tree, so git never reads the
  file, and the stored population's notice names it without refusing the run.
- **`vat resources validate` and `scan` with the store off take no tree snapshot**, which read and
  hashed every untracked file for nothing and printed `getGitTreeSnapshot failed unexpectedly` on
  an unreadable one.
- **The skills lanes (`vat skills validate`, `vat skills build`, `vat audit`) no longer walk ignored
  territory** on a root with no store: they report no row from it.
- **A second root of a run, under the home in the home's repository, asks git nothing more**: it is
  listed off the home's tracker, ignored listing and index read. A root in a nested repository, or
  one git ignores, asks its own.

### Changed

- **Outside a repository, `vat audit` no longer reports links inside a tool-output-named directory**
  (`docs/coverage/`, `.turbo/`): it enumerates with the same source as every other verb, which
  prunes those names where no ignore rule can say whether they are authored. The known defect
  "Outside a repository, authored markdown under a tool-output-named directory is not enumerated"
  records the fix (link-following admission).

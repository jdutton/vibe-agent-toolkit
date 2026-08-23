# Command Population Matrix

**How to read a cell.** This document is a **specification**, not a description of the code. Each
cell states what a command's population *should* be. Three states, and one of them is silence:

| cell | meaning |
|---|---|
| a plain value | the intended behaviour, and the implementation conforms. **Silence is the claim** — a cell with no annotation asserts the code matches. |
| `BUG:` … | the intent is declared, the implementation diverges. Transitional. Whoever fixes the code **deletes the annotation**; the cell becomes a plain value. |
| `⚠️ undeclared` | nothing has ever declared what this should be. **Not a bug** — an open question. Never back-filled from what the code happens to do. |

**How to write a cell.** Two rules, both earned the hard way, and both invisible to any gate:

- **Write a cell from the whole route the command takes, not from the enumeration call visible at its
  entry point.** A command's own `fs.readdir` or `fs.globSync` says nothing about what it delegates
  to one call deeper. "Git is not consulted" is a claim about a *route*, and it is false the moment
  any step on that route consults git.
- **Never author a cell from a constant's, flag's or option's NAME.** A name states what somebody
  meant; a cell states what happens. Read the behaviour the name gates, then write the cell.

**Where the citations point.** A cell names `path/to/file.ts › symbolName()`, never a line number: a
symbol survives a refactor and can be grepped, a line number can do neither. Declarations that govern
many cells live once in [Declarations](#declarations) under a name a cell can call them by;
declarations that govern one cell sit inline in it. A `BUG:` annotation cites the *divergence* site
inline, because that is the actionable address and it is per-row.

**The backlog lives next door.** Every `⚠️ undeclared` cell here, and every claim a document makes
that the code does not support, is carried in
[Command Population — Open Questions](./command-population-open-questions.md). That file churns; this
one describes what is.

This document sits beside [Resource Scanning and Object Caching](./resource-scanning-and-caching.md),
which is the authority on *mechanism* — the two lanes, their cost models, the git plumbing. This one
is the authority on *which command gets which*.

## 1. The governing ruling

**The validation universe is `tracked ∪ (untracked ∧ ¬ignored)`** — what a commit made right now
*would* contain. A command that cannot see a brand-new, uncommitted, un-ignored file is a **defect**,
not a scoping choice.

**The ruling is declared in-repo** — see [the universe rule](#the-universe-rule). This repository has
no ADRs, so a decision of this kind lives in an architecture document, and that section is the
binding statement rather than a note. Every row below is scored against it. The same set expression
appears in `docs/architecture/zones.md` § *3. Zone kinds*, glossed "committed or potentially
committed", but only as the definition of the `git` *extent* — one entry in an open extent
vocabulary, which is a narrower thing than an obligation on a command's population.

Three scope bounds the ruling explicitly does **not** claim, all named where it is declared and all
carried as questions next door: whether it binds
[packaging populations](./command-population-open-questions.md#does-the-ruling-bind-packaging-populations)
— what *ships* — as well as validation populations; whether it binds
[populations that are not git-backed](./command-population-open-questions.md#does-the-ruling-bind-populations-that-are-not-git-backed);
and what
[a verb whose subject is deliberately build output](./command-population-open-questions.md#should-a-packaging-or-verify-verb-see-gitignored-build-output-deliberately)
owes it.

## 2. The three selectors, and the opt-outs they answer to

🪤 **All three selectors now default to the new lane, and each spells its escape hatch
differently.** That is the live footgun, and it is the reverse of the one this section carried until
2026-08-22: it read *"the three environment selectors default in different directions"* and marked
two of the three as opt-**in**, which had stopped being true of both. Stated here once so no row has
to restate it.

| selector | values | default | what it selects | declared |
|---|---|---|---|---|
| `VAT_RESOURCES_CRAWL` | unset · `walk` — any other value, the historical `projection` included, leaves the projection selected | **projection** (opt-**out** via `walk`) | whether the resources/packaging population comes from `crawlDirectory` or from a base-only projection | [the resources selector](#the-resources-selector) |
| `VAT_INVENTORY_CRAWL` | unset · `projection` · `walker` | **projection** (opt-**out** via `walker`) | whether `vat inventory` membership is answered by a projection or the incumbent link walk | [the inventory selector](#the-inventory-selector) |
| `VAT_EXTENT_SOURCE` | unset · `filesystem` — `EXTENT_SOURCE_GIT` is exported but no production code tests for it | **git wherever the root has a readable `.git`**, the filesystem walk elsewhere (opt-**out** via `filesystem`) | *within* the projection, which implementation enumerates the `filesystem` extent | `packages/resources/src/projection/crawl-source.ts › EXTENT_SOURCE_ENV`, decided at `› gitExtentSelected()`, applied at `› crawlSourceFor()` |

Three properties that are easy to get wrong:

- **No default is the incumbent any more, and one of the three flips was not a no-op.** The
  inventory flip was provable as byte-for-byte; the resources flip is provably *not* one and shipped
  anyway. **This is a KNOWN DIVERGENCE, `BUG:` territory under [§7](#7-how-to-audit-this), and the
  waiver has NOT been filed** — see the paragraph below for what is still owed.

  Measured facts, both arms, on a planted committed symlink:

  | extent | what a planted symlink yields | why |
  |---|---|---|
  | `filesystem` | **ZERO realizations** — the link contributes no row of its own | the walk runs `followSymlinks: false` (`packages/resources/src/projection/crawl-source.ts:180,424`), whose `processSymlink` returns before recording the link's own path (`:293`) |
  | `git` | **ZERO realizations** for the link *as a link* | `GitCrawlSource` drops mode `120000` explicitly, to match the filesystem arm (`packages/resources/src/projection/crawl-source.ts:30,295,318`) |
  | `git`, identity minting | **TWO distinct ids** where a symlink and its target are *both* tracked | `canonicalPathFor` short-circuits to `gitTracker.indexPathFor()` for any tracked path and never reaches `realPathOrSelf` (`packages/resources/src/projection/identity.ts:106-115`), so the link path and the target path each mint their own id — defeating the "a symlink and its target share one identity" consequence that same docstring declares at `:98-100` |

  Consequence for findings: a broken committed symlink that the incumbent walk reports as
  `LINK_BROKEN_FILE` produces **no finding at all** on the default lane, and where the link is not
  broken the git arm can still double-count it. `packages/cli/src/utils/resource-loader.ts ›
  resourcesProjectionCrawlSelected()` states the first loss and accepts it, with `walk` as the escape
  hatch ([the resources selector](#the-resources-selector)); the second — the two-ids case — is
  stated nowhere in the code.

  ⚠️ **Still owed, and deliberately not done here.** A committed symlink is *tracked*, so this
  default is narrower than the universe [§1](#1-the-governing-ruling) rules binding. Under §7 that
  makes it a `BUG:`-annotated cell, and §7's second rule is that *entry is defended by the key* — the
  annotation and the CODEOWNERS-guarded baseline row (carrying the divergence's `file › symbol`) must
  land **in the same commit**. That baseline edit is out of scope for this doc pass, so the
  divergence is recorded here with its measurements and the `BUG:` filing remains open.
- **An unrecognized value never throws, and now they all fail the same way.** Each selector treats
  anything that is not exactly its opt-out spelling — `walk`, `walker`, `filesystem` — as the new
  lane. A typo'd selector silently selects the projection, where it used to silently select the
  incumbent.
- **`VAT_EXTENT_SOURCE`'s default falls back silently** when the root is not in a repository, or
  when the `.git` it finds has no readable `HEAD`, so the selector and the outcome come apart — and
  `gitExtentSelected()` is therefore a function of the root, not of the environment alone. That is
  why a scan reports `extentSource` as a fact about the run rather than by re-reading the
  environment — see
  [the request and the outcome are different facts](#the-request-and-the-outcome-are-different-facts).

## 3. Population source and selector, per command

Only commands that enumerate a file population appear here.
[§6](#6-commands-that-enumerate-no-file-population) lists the rest, so that every registered command
appears in this document exactly once.

✅ **The three `(default)` cells for `vat resources scan`, `vat resources validate` and `vat rag index`
were rewritten from a per-lane read on 2026-08-23.** They previously read `crawlDirectory` walk —
which is what `VAT_RESOURCES_CRAWL=walk` buys, not what an unset environment gets. All three reach
the same seam, `packages/cli/src/utils/resource-loader.ts › loadResourcesWithConfig()`, whose lane is
decided by `› resourcesProjectionCrawlSelected()` — a single `!==` against the string `walk`, so
**unset means projection**.

⚠️ The same inversion still stands uncorrected in their [§4](#4-what-each-command-sees) rows, which
are labelled below rather than rewritten. Where §4 and
[§2](#2-the-three-selectors-and-the-opt-outs-they-answer-to) disagree, §2 is current.

| command | population source (default) | selector | declared |
|---|---|---|---|
| `vat resources scan` | **projection**, via `loadResourcesWithConfig()` → `› populationSourceFor()` → `packages/resources/src/projection/resource-population.ts › buildResourcePopulation()`. Extent chosen by `VAT_EXTENT_SOURCE`: **git** wherever the root has a readable `.git`, the `filesystem` walk elsewhere. Enumerates with `contentDemand: 'deferred'` and `CONTENT_PARSING_SKIP`, so **no file bytes are read at enumeration** ([§5](#5-content-reads-and-the-blob-stage)). Root is `projectRootOrLoudCwd(pathArg ?? cwd)`. Alone among the three, it **reports the lane it took** — `lane` and `extentSource` are fields of its YAML output (`packages/cli/src/commands/resources/scan.ts:130,162-163`). `VAT_RESOURCES_CRAWL=walk` is the escape hatch back to `crawlDirectory` | `VAT_RESOURCES_CRAWL`, plus `VAT_EXTENT_SOURCE` *within* the projection | [the resources selector](#the-resources-selector), [the blob stage default and its refusal](#the-blob-stage-default-and-its-refusal) |
| `vat resources validate` | **projection**, same loader and same extent rule as `scan`; root is likewise `projectRootOrLoudCwd(pathArg ?? cwd)`. Differs only in what it takes back from the loader — it keeps the `GitTracker` for downstream checks and **does not** surface `lane`/`extentSource` in its output, so a validate run gives the reader no way to tell which lane produced it (`packages/cli/src/commands/resources/validate.ts:606-610`) | `VAT_RESOURCES_CRAWL`, plus `VAT_EXTENT_SOURCE` | [the resources selector](#the-resources-selector) |
| `vat rag index` | **projection**, same loader — but on a **different root basis**: it resolves `projectRootOrNull(process.cwd())` and falls back to `process.cwd()` when that is null, so unlike the two above the root is derived from the cwd and never from `pathArg` (`packages/cli/src/commands/rag/index-command.ts:30,39-40`). Same deferred-content enumeration; no lane reporting | `VAT_RESOURCES_CRAWL`, plus `VAT_EXTENT_SOURCE` | [the resources selector](#the-resources-selector) |
| `vat inventory` (plugin dir) | **projection** | `VAT_INVENTORY_CRAWL` | [the inventory selector](#the-inventory-selector) |
| `vat inventory` (marketplace root, `--user`, single `SKILL.md`) | incumbent link walk — the projection lane is **plugin-directory-only** | none; the selector does not reach these shapes | `packages/cli/src/commands/inventory.ts › routeInventory()`, gated at `› populationProviderFor()` |
| `vat skills validate` | skill discovery: `crawlDirectory` walk · link registry: `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` (registry only) | [the resources selector](#the-resources-selector), [skill discovery includes untracked files](#skill-discovery-includes-untracked-files) |
| `vat skills build` | skill discovery: `crawlDirectory` walk · per-skill registry: `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` (registry only) | [the resources selector](#the-resources-selector), [skill discovery includes untracked files](#skill-discovery-includes-untracked-files) |
| `vat claude plugin build` | pool skills: `crawlDirectory` walk · plugin-local skills: `crawlDirectorySync` · tree-copy: `crawlDirectory` · registry: `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` (registry only) | [the resources selector](#the-resources-selector), [plugin-local skill visibility](#plugin-local-skill-visibility) |
| `vat audit` | five seams at once: subject tree by its own recursive `fs.readdir` walk with its own gitignore pruning (`packages/cli/src/commands/audit.ts › scanDirectory()`, pruning at `› buildGitIgnoreMap()`) · skill discovery · the inventory link registry · a packaging registry · `fs.globSync` for unreferenced-file detection | **none** — `vat audit` is on no selector at all | ⚠️ undeclared |
| `vat corpus scan` | none of its own — reads a seed file and delegates one `vat audit` per entry; `--with-review` adds a forced full walk | inherited from `vat audit` | `packages/cli/src/commands/corpus/scan.ts › corpusScanCommand()` |
| `vat skill review` | project-wide twice over: skill discovery (`crawlDirectory` walk) **and** a link registry (`crawlDirectory` walk) — despite naming one skill | `VAT_RESOURCES_CRAWL` (registry only) | [the resources selector](#the-resources-selector), [skill discovery includes untracked files](#skill-discovery-includes-untracked-files) |
| `vat skill test run` | subject resolution runs project-wide skill discovery; the build path re-enters `vat claude plugin build` for a plugin-local skill | `VAT_RESOURCES_CRAWL` (registry only) | [skill discovery includes untracked files](#skill-discovery-includes-untracked-files) |
| `vat skills package` | a project-wide `**/*.md` crawl — `packages/agent-skills/src/skill-packager.ts › packageSkill()` falls back to `createProjectRegistry(projectRoot)` when no caller supplies a registry, and `packages/cli/src/commands/skills/package.ts › packageCommand()` supplies none — then the skill's link graph over that registry, plus `fs.globSync` for unreferenced-file detection. The `files:` globs are **not** in this route: `files:` reaches the packager only through the config→spec conversion, which is the `vat skills build` / plugin-build path | none | ⚠️ undeclared |
| `vat agent build` | a fixed convention list (`scripts/`, `LICENSE.txt`), then the same project-wide `**/*.md` crawl and link graph as `vat skills package`, for the same reason — `packages/agent-skills/src/builder.ts › buildAgentSkill()` calls `packageSkill` with no registry. No `files:` globs either | none | ⚠️ undeclared |
| `vat claude context [paths...]` | its own projection lane, enumerating the tree TWICE over the `filesystem` extent: a cheap discovery pass that only names the `@`-import roots, then the real population. `ContributorRegistry` keys on `id` and partitions on `kind` before any `contribute` runs, so the root set must exist before `populate` is called and there is no caller holding it — the doubling is structural, not incidental. ⚠️ **Gitignored paths are realized here on purpose** — `buildResourcePopulation` passes `DECLINE_IGNORED` and this lane does not. The population is the whole tree; the ANSWER is much narrower — only the `CLAUDE.md` ancestry chain, the rules files in scope, and the `@`-import closure at the queried path | `VAT_EXTENT_SOURCE`, which selects the crawl source under the extent. **Not** on `VAT_RESOURCES_CRAWL`: there is no incumbent walk to select between here, the projection is the only implementation | `packages/resources/src/projection/claude-context-population.ts › buildClaudeContextPopulation()` — its module docstring carries the double-enumeration constraint, the gitignored decision and the cost that decision has — with the discovery pass at `› discoverImportRoots()` and the query's narrowing at `packages/resources/src/projection/claude-context-query.ts › whatLoadsAt()`; [the blob stage default and its refusal](#the-blob-stage-default-and-its-refusal) |
| `vat claude marketplace validate` | nested one-level `readdirSync` over the built tree, then `fs.globSync` per skill | none | ⚠️ undeclared |
| `vat claude marketplace publish` | `cpSync` of the built tree, then **git itself decides what is published** (`git add -A`) | none | ⚠️ undeclared |
| `vat claude plugin install` | nested one-level `readdirSync`, three deep — marketplaces, then plugins, then skill directories — over the extracted/source tree | none | ⚠️ undeclared |
| `vat claude plugin list` | registry JSON, plus one-level `readdirSync` for legacy skills | none | ⚠️ undeclared |
| `vat claude org skills install` | **recursive `readdirSync` of the skill directory, whose bytes are then uploaded** — the one org verb with a file population | none | ⚠️ undeclared |
| `vat skills install` | archive extraction, then one-level `readdirSync` over the source tree | none | ⚠️ undeclared |
| `vat skills list` | project and user modes: forced full walk (`respectGitignore: false`), then gitignore applied as a per-file **annotation** rather than a filter. A third mode reaches neither — an `npm:`/`.tgz`/`.tar.gz` source (`packages/cli/src/commands/skills/list.ts › listFromNpmSource()`) is a one-level `readdirSync` over the extracted tree (`› scanSkillsDir()`), with no walk and no annotation | none — the forced walk bypasses every selector | [gitignored status as an annotation](#gitignored-status-as-an-annotation) |
| `vat agent list` | raw `fs.readdir` over a hardcoded search-path list | none | ⚠️ undeclared |
| `vat agent installed` | one-level `fs.readdir` over a hardcoded scope list | none | ⚠️ undeclared |
| `vat cache clear` | not a corpus — walks `<tmpdir>/.vat-cache` | none | `packages/cli/src/commands/cache/clear.ts › clearCacheDirectory()` |
| `vat build` | orchestrator; inherits `vat skills build` then `vat claude plugin build` | inherited | `packages/cli/src/commands/build.ts › createBuildTopLevelCommand()` |
| `vat validate` | orchestrator; inherits `vat resources validate` then `vat skills validate` | inherited | `packages/cli/src/commands/validate.ts › createValidateTopLevelCommand()` |
| `vat verify` | orchestrator; inherits `vat resources validate`, `vat skills validate`, `vat claude marketplace validate`, plus the in-process phases that read `dist/` | inherited | `packages/cli/src/commands/verify.ts › createVerifyTopLevelCommand()` |

**The mechanism column is the finding, not a detail.** Beyond the incumbent walk and the projection
there are three more routes, and each answers the ruling in §1 differently:

- **Raw `readdir`, usually with no git awareness at all.** For most of the commands on this route
  neither selector nor `.gitignore` reaches the walk — the question is not asked rather than answered
  by a default. `vat audit` is the exception that shows the route does not force that answer: the
  same `fs.readdir` recursion, but with its own `GitTracker` pruning ignored paths. The route is one
  mechanism with several behaviours, and no rule says which of them a new command inherits.
- **A forced full walk with gitignore as an annotation** (`vat skills list` — see
  [gitignored status as an annotation](#gitignored-status-as-an-annotation)). It sees strictly more
  than any other route and drops nothing; ignored status is reported as a per-file flag. This is the
  only route in VAT that *reports* an ignored file rather than excluding it.
- **A registry crawl that bypasses `ResourceRegistry.crawl`** —
  `packages/claude-marketplace/src/inventory/extract-skill.ts › crawlSkillLinkRegistry()`, which
  enumerates for itself and hands the paths to `addResources` — so no `populationSource` can reach it
  and the crawl-timing bracket does not account for it. `vat audit` and three of `vat inventory`'s
  four subject lanes depend on it.
- **A delegating orchestrator**, whose population is whatever its phases enumerate.

`vat audit` alone reaches five of these at once. Nothing declares that this many routes is intended,
and nothing declares which route a new command should reach for.

## 4. What each command sees

The two visibility questions the ruling in §1 turns on. `n/a` means the command reaches this
mechanism through a route where the concept does not apply.

⚠️ **The first four rows are written with the lanes inverted.** The `vat resources scan`,
`vat resources validate` and `vat rag index` rows describe the `crawlDirectory` walk, which is now
reachable only via `VAT_RESOURCES_CRAWL=walk`; the row that follows them describes the projection as
`VAT_RESOURCES_CRAWL=projection`, which is the **default**, not an opt-in (any value that is not
exactly `walk` selects it — `packages/cli/src/utils/resource-loader.ts:184`). The *answers* in the
two right-hand columns are the same on both lanes, which is why the rows were left standing rather
than deleted; only the labels are wrong. [§3](#3-population-source-and-selector-per-command) carries
the corrected per-lane read.

| command | in a git working tree | NOT in a git working tree | sees untracked-not-ignored? | sees gitignored (e.g. `dist/`)? |
|---|---|---|---|---|
| `vat resources scan` | `git ls-files` fast path | manual `readdir` walk; `.gitignore` is never consulted, so everything not glob-excluded is a member | yes — `packages/resources/src/resource-registry.ts › ResourceRegistry.crawl()` passes `includeUntracked: true`, which widens the `git ls-files` query to `--cached --others --exclude-standard` without leaving the fast path | no |
| `vat resources validate` | `git ls-files` fast path | manual walk, as above | yes — same registry option. The **population** that closes the silent green — `tracked ∪ (untracked ∧ ¬ignored)` in a real repository, plus the non-git control — is pinned as an assertion at `packages/resources/test/integration/crawl-untracked-population.integration.test.ts`. The finding count and exit code that green was measured on are not pinned there; see [§7](#7-how-to-audit-this) | no |
| `vat rag index` | `git ls-files` fast path | manual walk, as above | yes — same loader, same registry option | no |
| `vat resources scan/validate`, `vat rag index` — with `VAT_RESOURCES_CRAWL=projection` | filesystem-extent walk, or git enumeration under `VAT_EXTENT_SOURCE=git` | filesystem-extent walk; with no git oracle every row reads `gitignored: false`, so the whole crawl is admitted | yes | no — enumerated by the extent, then declined by this consumer (`packages/resources/src/projection/resource-population.ts › buildResourcePopulation()`) |
| `vat inventory` (plugin dir) | projection over the filesystem extent | filesystem extent; no ignore oracle, whole crawl admitted | yes | no |
| `vat inventory` (other shapes) | link walk over a `crawlDirectory` registry | manual walk | yes — the skill extractor sets `includeUntracked: true` (`packages/claude-marketplace/src/inventory/extract-skill.ts › crawlSkillLinkRegistry()`) | no |
| `vat skills validate` — discovery | `git ls-files --cached --others --exclude-standard` | manual walk | yes — [skill discovery includes untracked files](#skill-discovery-includes-untracked-files) | no |
| `vat skills build` — discovery | as above | manual walk | yes — same discovery | no |
| `vat skills validate/build` — link registry | `git ls-files` fast path | manual walk | yes — `crawlAndResolveRegistry` builds its registry through `ResourceRegistry.crawl`, so a discovered skill's brand-new link target is a registry member | no |
| `vat claude plugin build` — pool skills | `git ls-files --cached --others --exclude-standard` | manual walk | yes — same discovery | no |
| `vat claude plugin build` — plugin-local skills | `git ls-files`, tracked only | manual walk — every directory is visible, and `listUntrackedPluginSkillDirs` returns `[]` because there is no git to disagree with | no, **by declared intent**, with a build **warning** naming each one ([plugin-local skill visibility](#plugin-local-skill-visibility)). ⚠️ Whether the §1 ruling overrides that intent is undeclared — see [does the ruling bind packaging populations?](./command-population-open-questions.md#does-the-ruling-bind-packaging-populations) | no, by declared intent |
| `vat claude plugin build` — tree-copy | `git ls-files`, tracked only | manual walk | no, by declared intent | no, by declared intent |
| `vat audit` — subject tree | recursive `fs.readdir`, with git consulted for **pruning**: `packages/cli/src/commands/audit.ts › resolveScanContext()` finds the git root and builds a `GitTracker`, and `› buildGitIgnoreMap()` marks every entry before the walk descends | `resolveScanContext()`'s non-git branch returns `gitRoot: null` and no tracker, so nothing is ever marked ignored and the whole tree is admitted | yes — the walk admits every un-ignored entry, tracked or not | **no, by default** — `› getSkipReason()` returns `` `gitignored: …` `` and `› scanDirectory()` skips the entry. Two escapes admit them: the `--include-artifacts` option declared at `› createAuditCommand()`, and a scan root that is itself gitignored, where `resolveScanContext()` deliberately disables filtering so the user's explicit target wins. ⚠️ undeclared whether those two escapes are the intended shape of the exception — an opt-in flag plus an implicit root-level override, neither of which any rule grants, and no rule says a verb that audits build output should need the flag |
| `vat audit` — link registry | `git ls-files` fast path | manual walk | yes — `packages/cli/src/commands/audit.ts › validateSingleSkill()` calls `crawlAndResolveRegistry(projectRoot)`, and that route reaches `ResourceRegistry.crawl`, so the walk itself carries the ruling | no |
| `vat skill review` — discovery | `git ls-files --cached --others --exclude-standard` | manual walk | yes — same discovery | no |
| `vat skill review` — link registry | `git ls-files` fast path | manual walk | yes — same `crawlAndResolveRegistry` route | no |
| `vat skill test run` — subject resolution | `git ls-files --cached --others --exclude-standard` | manual walk | yes — same discovery | no |
| `vat claude context [paths...]` | filesystem-extent walk by default; under `VAT_EXTENT_SOURCE=git` the `git ls-files` snapshot plus a bounded walk of the ignored territory git declines to hold — both arms enumerate the same extent. A `GitTracker` is consulted only to FILL the `gitignored` column, never to drop a row | filesystem-extent walk; no oracle, so every row reads `gitignored: false` and the whole crawl is admitted | yes | **yes, and by declared intent — the only such row in this table.** Claude Code reads the FILESYSTEM, not git: a gitignored `CLAUDE.md` or a generated handbook is loaded into a real session, and declining it would under-report on the file class most likely to be large. An under-report is the one direction a context-budget answer cannot tolerate. ⚠️ The cost is declared with the decision: a gitignored second copy of the tree — a vendored checkout, a generated bundle, a release staging directory — contributes its own `CLAUDE.md` and `.claude/rules/` set, so root discovery registers a contributor per copy. It doubles the WORK, not any answer. Git worktrees are **not** an instance: `**/.worktrees/**` and `**/.claude/worktrees/**` are in `NEVER_CRAWL_GLOBS`, applied on both arms, so neither can reach one |
| `vat claude marketplace validate` | one-level `readdirSync` over `dist/` | identical | n/a — the tree it reads is build output | **yes** — necessarily, and correctly: `dist/` is normally gitignored and a verify verb must see what was built. ⚠️ undeclared |
| `vat claude marketplace publish` | **git decides** — the composed tree is `git add -A`ed, so the published set is `tracked ∪ (untracked ∧ ¬ignored)` of the publish repo | n/a — publishing requires a repository | yes, by the mechanism | no |
| `vat claude plugin install` | nested one-level `readdirSync`, three deep — `packages/cli/src/commands/claude/plugin/install.ts › handleDevInstall()` over marketplaces, `› devInstallMarketplace()` over plugins, `› symlinkPluginSkills()` over skill directories, each through `› listSubdirectories()` or a bare `readdirSync` | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat claude plugin list` | one-level `readdirSync` plus registry JSON | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat claude org skills install` | recursive `readdirSync`; git is not consulted before upload | identical | yes, incidentally | **yes, incidentally — and these bytes leave the machine.** ⚠️ undeclared, and the highest-consequence cell in this table |
| `vat skills install` | one-level `readdirSync` | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat skills package` | two routes, and only one is git-blind. The link graph runs over a project-wide registry — `packages/agent-skills/src/skill-packager.ts › packageSkill()` falls back to `createProjectRegistry(projectRoot)` and `packages/cli/src/commands/skills/package.ts › packageCommand()` passes no registry — so `git ls-files --cached --others --exclude-standard` runs. `fs.globSync` over the skill dir, for unreferenced-file detection, consults nothing | registry route falls back to the manual walk; `globSync` identical | yes — `ResourceRegistry.crawl()` passes `includeUntracked: true` | registry: no. `globSync`: yes, incidentally. ⚠️ undeclared whether one command should answer this question two different ways |
| `vat skills list` | forced manual walk for the **population**; `git ls-files` still runs, but only to annotate — `packages/discovery/src/scanners/local-scanner.ts › scan()` initializes a `GitTracker` after the walk. What is never reached is the git *population* fast path, not git. The npm/tgz mode reaches neither — see §3 | identical walk; no git root, so no tracker, and the annotation reads `false` everywhere | yes | **yes, and it reports them** — each result carries an `isGitIgnored` flag instead of being dropped ([gitignored status as an annotation](#gitignored-status-as-an-annotation)) |
| `vat agent list` / `vat agent installed` | raw `fs.readdir` | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat agent build` | fixed convention list, then the same route as `vat skills package` — `packages/agent-skills/src/builder.ts › buildAgentSkill()` calls `packageSkill` with no registry, so the project-wide crawl runs `git ls-files --cached --others --exclude-standard`. No `files:` globs reach it | registry route falls back to the manual walk; convention list identical | yes — same registry option | registry: no. The convention list and the unreferenced-file `globSync`: yes, incidentally. ⚠️ undeclared, on the same terms as `vat skills package` |
| `vat cache clear` | n/a — the cache tree is outside any repository | n/a | n/a | n/a |
| `vat build` / `vat validate` / `vat verify` | inherited per phase, plus `vat build`'s own `readdir` walk of the shipped plugin tree | inherited per phase | inherited per phase | `vat build`'s own walk reads `dist/`, so yes there |

**The non-git column is the one to read twice.** SharePoint, OneDrive, iCloud-synced folders and
`~/.claude/*` are explicitly in scope for this tool, and outside a git working tree *no route
consults `.gitignore` at all* — the manual fallback in
`packages/utils/src/file-crawler.ts › crawlDirectorySync()` has no gitignore code, and the
projection's filesystem extent has no oracle to ask. A `.gitignore` file sitting in a non-git
directory is inert. Every distinction in the two right-hand columns collapses: the population is
"everything the glob filters admit". That is coherent, and it is nowhere declared.

## 5. Content reads and the blob stage

These two columns apply only where a projection runs; the incumbent walk has no `contentDemand` and
no blob stage — it reads and parses each admitted resource directly, charged at
`resource-registry:add-resource`.

| lane | `contentDemand` at enumeration | resulting `contentState` | blob stage (`contentParsing`) |
|---|---|---|---|
| resources projection (`vat resources scan/validate`, `vat rag index`, and the packaging registries — the default lane, per [§2](#2-the-three-selectors-and-the-opt-outs-they-answer-to)) | `deferred` — enumerate every path, read none of them ([the filesystem extent keys lazily](#the-filesystem-extent-keys-lazily)) | `deferred` for every file row, `none` for a directory. `contentKey` is always null | **`CONTENT_PARSING_SKIP`** — the stage is ~90% of this lane's cold cost and not one blob row is read ([the blob stage default and its refusal](#the-blob-stage-default-and-its-refusal)) |
| inventory projection (`vat inventory`, plugin dir) | `deferGitignored`, from the same contributor — key eagerly, except where the row's own `gitignored` column is true | `keyed`, or `deferred` for an ignored row, or `none`/`unreadable` | **`CONTENT_PARSING_DERIVE`** (the default). Mandatory here, not a choice: the closure contributor reads the blob-keyed tables, and `populate()` **throws** rather than silently reducing every extent to its own root |

**Zero file-content reads on this lane, and a gate holds it there.** The demand is the caller's
decision rather than a property of the contributor, so `vat inventory` keeps `deferGitignored` while
this lane passes `'deferred'`. `packages/resources/test/integration/resources-lane-zero-content-reads.integration.test.ts`
patches `node:fs` and `node:fs/promises` through an `--import` preload and fails on any content read
under the crawl root; it documents the routes it cannot observe rather than claiming completeness,
enumerated in that file's own header table, which is the authority on which routes those are.

**The flag is named for the behaviour it gates, not for the tier that behaviour fills.**
`CONTENT_PARSING_SKIP` / `CONTENT_PARSING_DERIVE`, the option key `contentParsing:`, and the type
`ContentParsing` all name one thing: reading and parsing the bytes of every distinct keyed path. The
storage tier keeps `blob` throughout, because the tables really are blob-keyed — the tier is that
behaviour's *output*, not the decision being made.

**The false conclusion a tier-shaped name produces.** Spelled `blobs: BLOBS_SKIP` — after one of the
four tables the stage fills — the resources lane's call site reads as "`vat resources validate` needs
no file content". It does not follow and it is not true: the lane declines *this stage*, while
validate still parses every admitted resource to find links — the parse simply moves to
`resource-registry:add-resource`, and the authority on how many that is, is the registry's own
`add-resource` accounting, never a number written here. A flag named for a table invites a conclusion
about the command's content reads that the flag cannot support.

**What the flag does not gate, stated so it is not guessed at.** It is not `contentDemand` and not
`ProjectionBuilder.ensureContentKey` (`packages/resources/src/projection/projection.ts`); nothing
shipped promotes a `deferred` realization to `keyed` on demand at all. What it gates is the stage,
the store's blob tier on both the read-back and write-back paths, and the post-fixpoint re-run. The
closure stratum is **not** gated: under `'skip'` it still iterates, reading an empty
`blob_references`, which is precisely why the driver refuses the combination instead of degrading
quietly — see [the blob stage default and its refusal](#the-blob-stage-default-and-its-refusal).

## 6. Commands that enumerate no file population

Listed so the bidirectional check in [§7](#7-how-to-audit-this) has a complete population to work
from. A command here makes no membership claim about a tree: it reads one named path, or it talks to
an API.

| family | commands | why no population |
|---|---|---|
| Anthropic Admin API | `vat claude org info` · `vat claude org usage` · `vat claude org cost` · `vat claude org code-analytics` · `vat claude org api-keys list` · `vat claude org api-keys update` · `vat claude org invites list` · `vat claude org invites create` · `vat claude org invites delete` · `vat claude org users list` · `vat claude org users get` · `vat claude org users update` · `vat claude org users remove` · `vat claude org workspaces list` · `vat claude org workspaces get` · `vat claude org workspaces create` · `vat claude org workspaces archive` · `vat claude org workspaces members list` · `vat claude org workspaces members add` · `vat claude org workspaces members update` · `vat claude org workspaces members remove` · `vat claude org skills list` · `vat claude org skills delete` · `vat claude org skills versions list` · `vat claude org skills versions delete` | HTTP only. **`vat claude org skills install` is NOT in this family** — it is in §3 |
| single named path | `vat agent run` · `vat agent validate` · `vat agent import` · `vat agent install` · `vat agent uninstall` · `vat skill test configure` | the argument names the subject; nothing is enumerated. ⚠️ `agent run`/`validate`/`install` still run the agent *search-path* readdir when given a bare name rather than a path — a population used only to resolve one name |
| registry / manifest read | `vat claude plugin uninstall` · `vat mcp list-collections` · `vat rag stats` · `vat rag query` · `vat rag clear` | reads a manifest, a hardcoded array, or a vector database |
| environment report | `vat doctor` · `vat audit settings` | a hardcoded check list and a hardcoded settings-path list; filesystem contact is `existsSync` probes only |
| long-running server | `vat mcp serve` | resolves the package by dynamic import, not by enumeration |

⚠️ Membership in this table is itself **undeclared** — no rule says
[which commands are entitled to have no population](./command-population-open-questions.md#which-commands-are-entitled-to-have-no-population-at-all).
`vat skill review`, `vat skill test run`, `vat skills package` and `vat claude org skills install` all
read as single-path verbs and all enumerate; the last uploads what it finds. Every row above is a
judgement call that the gate in [§7](#7-how-to-audit-this) would freeze into a contract, which is the
point of writing them down.

## 7. How to audit this

The point of a gate here is narrow: keep the table honest **as a specification**, given that the code
is expected to disagree with it during a fix.

**The check must be bidirectional, and this is the whole design.** A gate that discovers its
population from the code can only ask "does every command the code registers behave as the table
says" — which is silent about a command nobody added to the table. That silence is a known and
expensive failure mode: *a gate that discovers its population from the repo is blind to what was born
outside it.* So both directions are asserted:

- **Code → table.** Every leaf command reachable by walking the Commander tree from
  `packages/cli/src/bin.ts` appears exactly once, either in §3/§4 or in §6. A newly registered
  command fails the gate until someone states its intent.
- **Table → code.** Every command named in any table resolves to a real registered command. A
  renamed or deleted command fails the gate rather than leaving a row describing nothing.

Neither direction may derive its list from the other. The command list is generated by walking the
registration tree; it is never hand-maintained in this document's own prose, and no count of commands
appears anywhere in this document for the same reason.

**The `BUG:` annotation is a waiver, and must be shrink-only.** A row carrying `BUG:` is a license
for the code to disagree with the specification. Left ungoverned it becomes the easy way to make the
gate green. Two rules, and the second is the one that actually matters:

- **Entry is defended by the key.** The set of `BUG:`-annotated cells is extracted and compared
  against a committed baseline. A new one fails.
- **Exit is defended only by the seeder.** *A ratchet's key defends entry, and only its seeder
  defends exit* — every laundering route in this repo's history ran outward through the reseed path,
  which nobody audits. So the baseline must not be regenerable by a flag anyone can run. Adding a
  `BUG:` requires editing the baseline file in the same commit as the annotation, under CODEOWNERS,
  with the divergence's `file › symbol` recorded in the baseline row so a reviewer can check the
  claim without reading the diff. A `BUG:` whose cited symbol no longer contains the divergence fails
  the gate — that is what makes a *stale* waiver visible, which "shrink-only" alone does not.

**What the gate cannot check, and must not pretend to.** It cannot verify that a plain cell is true —
that requires running the command against a fixture tree. Two probe fixtures carry most of the
weight, and both are cheap:

- a git repository holding one committed and one untracked markdown file, each carrying a broken
  link, and
- the same tree with `.git` removed.

Every row in §4's two visibility columns is a prediction about those two fixtures. Two properties are
predicted, and only one of them is pinned:
`packages/resources/test/integration/crawl-untracked-population.integration.test.ts` asserts the
**population** — `tracked ∪ (untracked ∧ ¬ignored)` in a real repository, and the whole glob-admitted
tree in the non-git control. The **finding count and exit code** are not asserted anywhere, because
no fixture member there carries a broken link; they remain a measurement. Turning that half into an
assertion is what would move §4's cells from "asserted here" to "pinned", and it is the move this
section asks for.

**`⚠️ undeclared` must never be gate-clearable.** It is a request for a ruling, and a gate that
accepted it as a satisfied state would convert an open question into a permanent one.

## Declarations

Nine declarations govern more than one cell above. Each has a name a cell calls it by, and one place
to be corrected. Declarations that govern a single cell sit inline in that cell instead.

### The universe rule

The validation universe is `tracked ∪ (untracked ∧ ¬ignored)`, the scanning taxonomy it scores, the
three bounds it does not claim, and the measured probe behind it.

`docs/architecture/resource-scanning-and-caching.md` §2.1, with the loading routes it reaches in
§3.4. Conformed to at `packages/resources/src/resource-registry.ts › ResourceRegistry.crawl()`, which
passes `includeUntracked: true` rather than `respectGitignore: false` — keeping the `git ls-files`
fast path and keeping ignored files out, which is the half of the universe that must not widen.

### The request and the outcome are different facts

Which lane enumerated is reported as a fact about the run, never by re-reading the environment that
requested it: reading the env var back proves what was *asked for*, and the request and the outcome
come apart whenever the git source declines a root that is not in a repository.

`packages/cli/src/utils/resource-loader.ts › ResourceLoadResult` (`lane`, `extentSource`), and
`packages/resources/src/projection/resource-population.ts › ResourcePopulation`.

### The resources selector

`VAT_RESOURCES_CRAWL`, its value, its opt-in default, and the argument for that default — including
the committed-symlink divergence that stops the projection lane being a no-op.

`packages/cli/src/utils/resource-loader.ts › RESOURCES_CRAWL_ENV` and
`› RESOURCES_CRAWL_PROJECTION`, with the scope statement and the default's argument at
`› resourcesProjectionCrawlSelected()`.

### The inventory selector

`VAT_INVENTORY_CRAWL`, its three values, and the projection as default — anything that is not exactly
`walker` selects the projection.

`packages/claude-marketplace/src/inventory/inventory-population.ts › INVENTORY_CRAWL_ENV`,
`› INVENTORY_CRAWL_PROJECTION`, `› INVENTORY_CRAWL_WALKER`, resolved at `› projectionCrawlSelected()`.

### Skill discovery includes untracked files

Skill discovery crawls with `includeUntracked: true`, because a skill must be discoverable before it
is committed.

`packages/cli/src/commands/skills/skill-discovery.ts › crawlOneBase()`, reached from
`› discoverSkillsFromConfig()`.

### Plugin-local skill visibility

Plugin-local skill discovery and the tree-copy share one git visibility — tracked-only — with a build
warning for each untracked skill directory, so an author who has not `git add`ed a skill is told
rather than silently shipped or silently dropped.

`docs/architecture/skill-packaging.md` § *One listing, one answer*;
`packages/agent-skills/src/plugin-distribution-layout.ts › listPluginSourceSkillDirs()` and
`› listUntrackedPluginSkillDirs()`; the tree-copy at
`packages/cli/src/commands/claude/plugin/tree-copy.ts › treeCopyPlugin()`.

### The filesystem extent keys lazily

Key eagerly where the bytes are already essentially free from the discovery step, and defer
everywhere else; `gitignored` is merely how that rule is *evaluated*, because it is the only O(1)
test available. The extent cannot be narrowed — dropping non-markdown loses real members, and that is
measured rather than reasoned: withholding the non-markdown row costs a skill both a direct link
target and the leaf reachable only through it. The demand itself is a per-registration parameter, not
a property of this contributor.

`packages/resources/src/projection/contributors/filesystem-extent.ts ›
FilesystemExtentContributor` — the module docstring carries the rule, `› DEFAULT_CONTENT_DEMAND`
carries the default, and `› FilesystemExtentContributor.constructor()` takes the per-lane demand. The
deciding fixture is `packages/resources/test/projection-extent-narrowing.test.ts`.

### The blob stage default and its refusal

`CONTENT_PARSING_DERIVE` is the default; `CONTENT_PARSING_SKIP` is an opt-in the driver **refuses**
when a registered contributor reads the blob-keyed tables, naming the contributor, rather than
returning a closure extent silently reduced to its own root.

`packages/resources/src/projection/merge.ts › CONTENT_PARSING_DERIVE`, `› CONTENT_PARSING_SKIP`,
`› PopulateOptions.contentParsing` for what is and is not gated, and `› contentParsingFor()` for the
refusal. The resources lane's skip is at
`packages/resources/src/projection/resource-population.ts › buildResourcePopulation()`.

### Gitignored status as an annotation

The discovery scanner forces a full walk and annotates ignored status per file rather than filtering
it out — the only route in VAT that reports an ignored file instead of dropping it.

`packages/discovery/src/scanners/local-scanner.ts › scan()`, consumed by
`packages/cli/src/commands/skills/list.ts › listCommand()`.

## Related

- [Command Population — Open Questions](./command-population-open-questions.md) — the backlog half:
  every `⚠️ undeclared` cell above as a question, and every claim a document makes that the code does
  not support.
- [Command → enumeration lane](../contributing/command-lane-table.md) — the same population read from
  the entry-point side: which of three enumeration sinks each command reaches, derived from the built
  CLI and cross-checked at runtime. It records the sink a route reaches, not which enumerator did the
  work, so a projection lane shows up there as `crawl` — defensible, because `FilesystemCrawlSource`
  and `GitCrawlSource`'s descent into what git declines to describe both call `crawlDirectory`, and
  incomplete, because the git snapshot that does the bulk of the enumeration under the default, the
  selectors and the content stages have no column there.
  Those are **this** document's §2–§5. Where the two disagree about whether a command enumerates at
  all, this one is the specification and that one is a reachability finding: it listed
  `vat inventory` as enumerating nothing until 2026-08-22, while §3 has always carried both of that
  command's lanes.
- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the mechanism behind
  every route named here: the two lanes, the git plumbing, the symlink divergences, the measurements.
- [Resource Projection](./resource-projection.md) — the output side: what gets built from the bytes a
  population names.
- [Zones](./zones.md) — the extent and lens vocabulary the projection's populations are expressed in.
- [Skill Packaging](./skill-packaging.md) — the packaging shapes whose populations §3 and §4 split
  into pool, plugin-local and tree-copy.

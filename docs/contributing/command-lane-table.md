# Command → enumeration lane

Which of VAT's commands read the filesystem to build a resource population, and through which
entry point. This exists to replace the standing claim *"~70 commands, 5 examined"* with a bounded
list, so the four-phase pipeline work knows exactly whose behaviour it must preserve.

**Population: 68 commands** — 67 leaves plus `vat audit`, the only command group that is also
runnable in its own right (`vat audit [git-url-or-path]` alongside its `settings` subcommand).

**26 enumerate. 42 do not.**

⚠️ It read *"67 commands — 66 leaves, 25 enumerate"* until 2026-09-01. The leaf added is
`vat resources query`, registered at `packages/cli/src/commands/resources/index.ts ›
createResourcesCommand()`. It enumerates, and it is the first command on the projection lane that
does **not** run under `contentDemand: 'deferred'` / `CONTENT_PARSING_SKIP` — a query about
headings, links or sections needs the blob rows the other resources lanes deliberately never pay
for. See `packages/resources/src/projection/resource-population.ts ›
buildResourceProjection()`.

⚠️ It read *"66 commands — 65 leaves, 24 enumerate"* until 2026-08-23. The leaf added is
`vat claude budget`, registered at `packages/cli/src/commands/claude/index.ts ›
createClaudeCommand()`, which took the always-loaded budget check out of `vat resources validate`
and gave it its own verb.

The population was re-derived by the method below on 2026-08-22 and had gone **stale**: it read
*"65 commands — 64 leaves"*, and the leaf it was missing is `vat cache clear`, registered at
`packages/cli/src/bin.ts` via `commands/cache/index.ts › createCacheCommand()`. It landed after this
table was written and two revisions missed it. Nothing here re-derives itself, so the count is only
as fresh as the last person who ran the recursion.

## The three enumeration entry points

| Lane | Entry point | Defined in |
|---|---|---|
| `crawl` | `crawlDirectory` / `crawlDirectorySync` | `packages/utils/src/file-crawler.ts` |
| `registry-md` | `createProjectRegistry` (include `**/*.md`) | `packages/agent-skills/src/skill-packager.ts` |
| `registry-md-html` | `crawlAndResolveRegistry` (include md **+ html**) | `packages/agent-skills/src/validators/packaging-validator.ts` |

`scanDirectory` is not a fourth sink — the discovery package reaches `crawlDirectory` underneath.
That the two registry builders crawl *different include sets* and observably disagree is a known
defect, tracked separately; this table records which commands are exposed to it.

**The projection lane sits across this taxonomy rather than inside it, and the taxonomy predates
it.** A projection's `filesystem` extent enumerates through
`packages/resources/src/projection/crawl-source.ts › crawlSourceFor()`, which hands back one of two
sources, and neither is a clean fourth sink:

- `GitCrawlSource` is the one that normally runs, and it is a **hybrid**. It is not opted into:
  `› gitExtentSelected()` returns false only when `VAT_EXTENT_SOURCE` is exactly `filesystem` — an
  opt-**out** — or when no `.git` at or above the root has a readable `HEAD`, so the choice is a
  function of the ROOT as much as of the environment, and `crawlSourceFor`'s own JSDoc reads
  *"Defaults to git wherever there is a git working tree"*. The constant `EXTENT_SOURCE_GIT` is
  exported but never tested in production; there is no `=git` selector to set. Its primary
  enumerator is a git tree snapshot plus two `ls-files --others --directory` listings — the ignored
  side and the untracked side — and **that half is un-modelled here**, which under this default
  means the normal case is the un-modelled one. It reaches sink 1 only for territory git declines
  to describe: `› expandDirectory()` — *"Walk one directory that git declined to enumerate"* —
  calls `crawlDirectory`, once per submodule (a submodule's files belong to its own repository) and
  once per collapsed **ignored** directory, that one guarded by `isDirectory`. Untracked-but-not-
  ignored territory contributes the collapsed entry alone and takes no descent. So a repository with
  no submodule and no collapsed ignored directory reaches sink 1 **not at all** on this arm.
- `FilesystemCrawlSource` runs outside a git working tree, on an unreadable git marker, or under
  the `VAT_EXTENT_SOURCE=filesystem` opt-out. It calls `crawlDirectory`, so that arm does land
  squarely in sink 1 — several hops and two packages from the command's own module, as the
  `vat claude context` row's `Via` chain spells out.

Either way the command reports the enumerator that RAN, not the one the environment asked for. So a
projection row's `crawl` mark is true but partial: it names a sink the lane can reach, not the
enumerator doing the work, and how much work reaches that sink depends on which source
`crawlSourceFor` returned for that root and what the tree contains. **Nine rows carry a projection**,
and each takes it by default unless its escape hatch is set: `vat resources scan`,
`vat resources validate` and `vat rag index` through
`packages/cli/src/utils/resource-loader.ts › loadResourcesWithConfig()`; `vat skills validate`,
`vat skills build` and `vat claude plugin build` for their link registries through
`› withResourcePopulationSource()` — both gated by `› resourcesProjectionCrawlSelected()`, which is
`!== 'walk'`; `vat inventory` on a plugin directory; and `vat claude context` and `vat claude budget`, neither of
which has a walk arm at all. Four more inherit one: `vat build`, `vat validate` and `vat verify` through the phases they
spawn, and `vat skill test run` by re-entering `vat claude plugin build`.

⚠️ **No command carries two projections in one process any more**, and one briefly did. Between
2026-08-22 and 2026-08-23 `vat resources validate` built the resource population from
`loadResourcesWithConfig()` *and* a claude-context population for a default-on
`ALWAYS_LOADED_CONTEXT_BUDGET` check. That check now has its own verb — `vat claude budget` — so
each command holds exactly one population again. The two populations still answer different
questions (*what files are here* versus *what does the harness load*) and still derive differently
(the resource population skips content keying and the blob stage; the context population needs
both), which is why they were never merged into one; what changed is that they no longer run in the
same process. The raw `readdir` populations several commands build for themselves are un-modelled
here on the same terms.
`docs/architecture/command-population-matrix.md` §2–§5 is the accounting for the projection lane and
those other routes — their selectors, extents and content stages; this table is deliberately not a
second copy of it, and records only which enumeration entry point a command's route reaches.

## Commands that enumerate

`vat validate`, `vat verify` and `vat build` are **orchestrators**: they do no enumeration in
process, they `spawnSync` the vat binary once per phase. Their lane is the union of the phases they
spawn, and they are the mechanism behind "every verb re-parses the same corpus in a separate
process" — a cross-process cache is the only kind that can help them.

| Command | Lane | Via |
|---|---|---|
| `vat audit [path]` | `crawl` + `registry-md-html` | `audit.ts` |
| `vat build` | *spawns* `skills build`, `claude plugin build` | `build.ts` → `runPhase` |
| `vat validate` | *spawns* `resources validate`, `skills validate` | `validate.ts` → `runPhase` |
| `vat verify` | `crawl`, *plus spawns* `resources validate`, `skills validate` | `verify.ts` → `runPhase` |
| `vat agent build` | `crawl` + `registry-md` + `registry-md-html` | `agent/build.ts` |
| `vat claude plugin build` | `crawl` + `registry-md` + `registry-md-html` | `claude/plugin/build.ts` |
| `vat skills build` | `crawl` + `registry-md` + `registry-md-html` | `skills/build.ts` |
| `vat skills package` | `crawl` + `registry-md` + `registry-md-html` | `skills/package.ts` |
| `vat skill test run` | `crawl` + `registry-md` + `registry-md-html` | `skill/test/run.ts` |
| `vat skills validate` | `crawl` + `registry-md-html` | `skills/validate-command.ts` |
| `vat skill review` | `crawl` + `registry-md-html` | `skill/review.ts` |
| `vat corpus scan` | `crawl` + `registry-md-html` | `corpus/index.ts` (inline; see limits) |
| `vat resources query` | `crawl` | `resources/query.ts` — one population, via `packages/resources/src/projection/resource-population.ts › buildResourceProjection()`. The same registry and the same admitted set as `resources scan`/`validate`, with content parsing ON |
| `vat resources scan` | `crawl` | `resources/scan.ts` |
| `vat resources validate` | `crawl` ×1 | `resources/validate.ts` — one crawl, for the resource population, via `packages/cli/src/utils/resource-loader.ts › loadResourcesWithConfig()`. Read `crawl` ×3 until 2026-08-22 and `crawl` ×2 until 2026-08-23, when the second population — built for the then-default-on `ALWAYS_LOADED_CONTEXT_BUDGET` check — moved out to `vat claude budget`. This command has no knowledge of the context budget at all now: no check, no flag in either direction |
| `vat skills list` | `crawl` | `skills/list.ts` |
| `vat rag index` | `crawl` | `rag/index-command.ts` |
| `vat claude context [paths...]` | `crawl` ×1 | `claude/context.ts` → `buildClaudeContextPopulation` → `› sharedEnumeration()` → `crawlSourceFor` → `GitCrawlSource` **by default**, or `FilesystemCrawlSource` → `crawlDirectory` (this cell named only the filesystem source until 2026-08-22, and read `crawl` ×2 until 2026-08-23). Two `populate()` passes, ONE crawl: both `FilesystemExtentContributor` registrations are handed the same enumeration |
| `vat claude budget [paths...]` | `crawl` ×1 | `claude/budget.ts` → `buildClaudeContextPopulation` → the same route, the same double `populate()` and the same single crawl as the `vat claude context` row above. It is the SAME lane and the SAME population; only the question differs — `context` reports what one path loads, `budget` sweeps every working location and applies a threshold (`packages/resources/src/projection/claude-context-budget-sweep.ts › sweepAlwaysLoadedBudgets()`), and the sweep is nine `whatLoadsAt` queries on this repository rather than 589 |
| `vat inventory [path]` | `crawl`, **or** the projection's `filesystem` extent on a plugin directory (the default there) | `inventory.ts` → `routeInventory()`; the walk at `packages/claude-marketplace/src/inventory/extract-skill.ts › crawlSkillLinkRegistry()` → `crawlDirectory`; the projection at `inventory.ts › populationProviderFor()` → `buildInventoryPopulation` → `FilesystemExtentContributor` → `crawlSourceFor` → `crawlDirectory` or `GitCrawlSource` |
| `vat claude marketplace validate` | `crawl` | `claude/marketplace/validate.ts` |
| `vat claude org skills list` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills install` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills delete` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills versions list` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills versions delete` | `crawl` | `claude/org/skills.ts` |

`vat claude context` and `vat claude budget` each **populate** twice, and that doubling is
structural rather than incidental:
`ContributorRegistry` keys on `id` and partitions on `kind` before any `contribute` runs, so
`discoverImportRoots` must run once — under `CONTENT_PARSING_SKIP`, with `'deferred'` content,
reading no bytes — purely to name the `@`-import contributors the real population then registers.
⚠️ It does **not** crawl twice, and this paragraph said it did until 2026-08-23. The registration
ordering is what is structural; the second walk never was. `sharedEnumeration()` performs one crawl
and both passes replay it, which is sound only because both now ask the extent the same question —
same source, same `DECLINE_IGNORED` parameter set — differing solely in `contentDemand`, which
decides what a row SAYS rather than which paths exist. Documented at the head of
`claude-context-population.ts`. Its enumeration reaches
`GitCrawlSource` rather than `FilesystemCrawlSource` wherever `gitExtentSelected` holds — which this
paragraph called an "opt-in" until 2026-08-22 and is not one: git is the default and `filesystem` is
the opt-out, as the bullets above set out, and the same is true of every row in this table that goes
through `crawlSourceFor`.

`vat inventory` sat under *Commands that do not enumerate* until 2026-08-22, and the header read
*"23 enumerate. 42 do not."* — wrong on **both** of that command's routes. `routeInventory()`
dispatches four subject shapes and only one of them takes the projection. A marketplace root and
`--user` fan out through `extractClaudePluginInventory` to one `extractClaudeSkillInventory` per
skill, supplying neither a shared registry nor a shared population, so each skill's link walk builds
its own registry through `crawlSkillLinkRegistry()` — `crawlDirectory`, sink 1, this table's own —
and a single `SKILL.md` reaches the same walk directly. A plugin directory takes the projection
unless `VAT_INVENTORY_CRAWL=walker` says otherwise. The projection arm is not unconditional even
there: `populationProviderFor()` returns `undefined` when `findProjectRoot` finds no root, and
`packages/claude-marketplace/src/inventory/extract-skill.ts › membersFromPopulation()` returns
`undefined` for a skill the supplied population holds no extent for — either fallback lands back on
`crawlSkillLinkRegistry`. `crawl` is therefore the lane every shape can reach and the projection is
the extra one, which is why the row carries both rather than choosing between them. Two of the
extractors also `readdir` trees of their own, which is a population of the un-modelled kind described
above: `extract-plugin.ts` (three sites) and `extract-install.ts`. `extract-marketplace.ts` is not
one of them — it reads manifests with `existsSync` and `readFile` and reaches a directory listing
only through the plugin extractor it fans out to.

## Commands that do not enumerate

The 42 remaining. The bulk are Admin-API calls over HTTPS — `claude org *` is 26 commands in all, of
which 21 appear here once the five `skills` commands above are excluded — plus process-level commands
that read JSON layers or a manifest rather than crawling.

`agent`: `import`, `install`, `installed`, `list`, `run`, `uninstall`, `validate` ·
`audit settings` ·
`cache clear` ·
`claude marketplace publish` ·
`claude org`: `api-keys list`, `api-keys update`, `code-analytics`, `cost`, `info`,
`invites create`, `invites delete`, `invites list`, `usage`, `users get`, `users list`,
`users remove`, `users update`, `workspaces archive`, `workspaces create`, `workspaces get`,
`workspaces list`, `workspaces members add`, `workspaces members list`, `workspaces members remove`,
`workspaces members update` ·
`claude plugin`: `install`, `list`, `uninstall` ·
`doctor` ·
`mcp`: `list-collections`, `serve` ·
`rag`: `clear`, `query`, `stats` ·
`skill test configure` · `skills install`

`vat cache clear` is on that list on a technicality worth stating: it reaches none of the three
sinks, but it does build a population — a raw `fs.readdir` walk of `<tmpdir>/.vat-cache` at
`packages/cli/src/commands/cache/clear.ts › readdirOrNull()`, driven from `› clearCacheDirectory()`.
That is exactly the un-modelled route described above, and the sibling matrix carries it as a §3 row
rather than as an absence. "Does not enumerate" in this table means "reaches no sink named here",
which is narrower than "builds no population".

## How this was derived

**Population — from the built CLI, never from source.** `--help` is recursed on
`packages/cli/dist/bin.js`, and a node with no `Commands:` block is a leaf. A grep for
`new Command(` cannot define this population: it sees construction sites, not the reachable tree.
Two parsing details, because the recursion is re-run by hand and must land on the same number twice:
a `Commands:` block ends at the first blank line — read past it and the `addHelpText('after', …)`
prose on `audit`, `rag`, `agent` and `cache` parses as phantom subcommands — and Commander's
built-in `help`, which only `mcp` prints, is not a leaf. The 2026-08-22 re-derivation on that basis
returns **65 leaves**, one more than the count this table shipped with.

**Lanes — barrel-aware static analysis, cross-checked at runtime.** For each command, the module
implementing its handler is resolved (delegated `.action(handler)` → the handler's module; inline
`new Command('x'); …action(async () => {…})` → the registrar itself), then that module is checked
for reachability to the three sinks.

Then the sinks in `dist/` were patched to write a marker to stderr and 22 real invocations were run
against real inputs, recording which sinks actually fired.

### Two methods that were tried and rejected — do not repeat them

1. **Naive module-level import reachability.** It reported `vat claude org cost` — an HTTPS call —
   as reaching all three sinks, and 45 of 98 command modules as reaching all three. Barrels are why:
   `utils/index.ts` has 26 exports and `agent-skills/index.ts` has 37, so importing one helper marks
   every sink in that package reachable. The graph was right; the question was wrong.
2. **Joining a leaf to its registrar file.** Wherever a group `index.ts` registers several leaves,
   each leaf inherits the union of its siblings' lanes — `vat agent list` read as crawling, while a
   runtime probe shows it reaching no sink on an exit-0 run.

### What the runtime cross-check caught that static analysis could not

`vat validate` was classified `NONE` and is not: it spawns `resources validate` and
`skills validate` as child processes. **No import edge exists to follow**, so a static graph is
structurally blind to it and always will be. The child inherits stderr, which is the only reason the
instrumented run saw it. Any future revision of this table must keep the runtime leg.

## Declared limits

- **`vat corpus scan` is marked `?`.** Its action is inline in a group `index.ts`, so its lane is
  that file's, which is the union over its imports — this row may over-attribute. It is the only
  such row.
- **A runtime probe proves presence, never absence.** `vat audit` fired no sink against a scratch
  directory holding two markdown files and no skill, and `crawlAndResolveRegistry`×2 against this
  repo. A `NONE` in this table means "no reachable sink under static analysis", corroborated by
  runtime where a credential-free invocation exists — not "proven never to enumerate".
- **The `claude org *` commands were not run** (they need `ANTHROPIC_ADMIN_API_KEY`; the probe
  recorded them `INCONCLUSIVE`, exit 2, before doing work). Their `NONE` rests on static analysis
  plus the inline HTTPS bodies being directly readable.
- **Lanes are per command, not per invocation.** `vat audit` reaches the registry lane against a
  project root and only `crawl` against a bare skills directory. The table is the upper bound.
- **The `vat inventory` row is a correction, and the method above did not produce it.** Its walk arm
  reaches sink 1 in one hop through `crawlSkillLinkRegistry()`, which alone makes the `NONE` it
  carried an under-report by the static leg rather than a lane this table cannot express. Its
  projection arm reaches sink 1 only conditionally — through `FilesystemCrawlSource` where that
  source is chosen, and on the git default only through `expandDirectory()`'s two descents, so a
  repository with neither a submodule nor a collapsed ignored directory does not reach it at all.
  **Which edge the static leg declined to follow is not recoverable**: the derivation was a one-off
  and no script for it is committed. What can be said is
  that both of `inventory.ts`'s routes to a sink leave the CLI package through a barrel import,
  which is exactly the edge rejected method 1's fix stopped attributing — its cure for barrel
  *over*-reporting has an under-reporting direction, and nothing in the derivation bounds it. The
  runtime leg cannot exonerate it either: 22 invocations against 67 commands, and a probe proves
  presence, never absence. This row was read out of `routeInventory()` and the two providers it
  gates.

# Command → enumeration lane

Which of VAT's commands read the filesystem to build a resource population, and through which
entry point. This exists to replace the standing claim *"~70 commands, 5 examined"* with a bounded
list, so any change to enumeration knows exactly whose behaviour it must preserve.

**Population: 72 commands** — 71 leaves plus `vat audit`, the only command group that is also
runnable in its own right (`vat audit [git-url-or-path]` alongside its `settings` subcommand).
The population is re-derived from the built CLI by the method at the end of this page; do not
correct the count by hand — re-run the recursion and replace the list.

**25 enumerate. 47 do not.**

## The enumeration entry points

Four declared lanes:

| Lane | Entry point | Defined in |
|---|---|---|
| `crawl` | `crawlDirectory` / `crawlDirectorySync` | `packages/utils/src/file-crawler.ts` |
| `registry-md` | `createProjectRegistry` (include `**/*.md`) | `packages/agent-skills/src/skill-packager.ts` |
| `registry-md-html` | `crawlAndResolveRegistry` (include md **+ html**) | `packages/agent-skills/src/validators/packaging-validator.ts` |
| `okf-bundle-walk` | `discoverOkfBundle` — bare recursive `readdir` | `packages/resources/src/okf/discovery.ts` |
**`okf-bundle-walk` is deliberate, and the reason generalises.** It does **not** route through
`crawlDirectory`, because both of that function's narrowings are correctness holes inside an OKF
bundle root: it answers from `git ls-files` by default, so an untracked concept document is
invisible (the `git-route-hides-untracked` trap), and `NEVER_CRAWL_GLOBS` drops whole subtrees on a
relevance judgement that has no standing there. OKF's conformance population is spec-defined and
**maximal** — every non-reserved `.md` beneath the root — so a walk that sees fewer files lets VAT
certify a bundle while a file it never opened breaks conformance. Any future population defined by
an external specification rather than by VAT's own relevance rules belongs here too, not in `crawl`.

That the two registry builders crawl *different include sets* and observably disagree is a known
defect, tracked separately; this table records which commands are exposed to it.

**Raw `readdir` populations that reach no lane** are recorded per row below as `raw-readdir` with
the function that owns them. They are populations in every sense that matters (a symlink or an
unreadable directory changes what the command sees) and they are un-modelled by every lane above.

### The projection lane sits across this taxonomy

A projection's `filesystem` extent enumerates through
`packages/resources/src/projection/crawl-source.ts › crawlSourceFor()`, which hands back one of two
sources, and neither is a clean fifth sink:

- `GitCrawlSource` is the one that normally runs, and it is a **hybrid**. It is not opted into:
  `› gitExtentSelected()` returns false only when `VAT_EXTENT_SOURCE` is exactly `filesystem` — an
  opt-**out** — or when no `.git` at or above the root has a readable `HEAD`, so the choice is a
  function of the ROOT as much as of the environment. Its primary enumerator is a git tree snapshot
  plus two `ls-files --others --directory` listings — the ignored side and the untracked side — and
  **that half is un-modelled here**, which under this default means the normal case is the
  un-modelled one. It reaches `crawl` only for territory git declines to describe:
  `› expandDirectory()` calls `crawlDirectory` once per submodule and once per collapsed **ignored**
  directory (guarded by `isDirectory` and by the entry not being a symlink). Untracked-but-not-ignored
  territory contributes the collapsed entry alone and takes no descent. So a repository with no
  submodule and no collapsed ignored directory reaches `crawl` **not at all** on this arm. It makes
  one filesystem call of its own outside every sink: `› symlinkShape()` `lstat`s each collapsed
  entry, because that listing carries no mode bits and a symlink's own path must not become a member.
- `FilesystemCrawlSource` runs outside a git working tree, on an unreadable git marker, or under
  the `VAT_EXTENT_SOURCE=filesystem` opt-out. It calls `crawlDirectory`, so that arm lands squarely
  in `crawl` — several hops and two packages from the command's own module.

Either way the command reports the enumerator that RAN, not the one the environment asked for. So a
projection row's `crawl` mark is true but partial: it names a sink the lane can reach, not the
enumerator doing the work. **Nine rows carry a projection**, each by default unless its escape hatch
is set: `vat resources scan`, `vat resources validate` and `vat rag index` through
`packages/cli/src/utils/resource-loader.ts › loadResourcesWithConfig()`; `vat skills validate`,
`vat skills build` and `vat claude plugin build` for their link registries through
`› withResourcePopulationSource()` — both gated by `› resourcesProjectionCrawlSelected()`, which is
`!== 'walk'`; `vat inventory` on a plugin directory; and `vat claude context` and `vat claude budget`,
neither of which has a walk arm at all. Four more inherit one: `vat build`, `vat validate` and
`vat verify` through the phases they spawn, and `vat skill test run` by re-entering
`vat claude plugin build`.

No command carries two projections in one process: `vat claude budget` owns the always-loaded
context-budget check that `vat resources validate` used to run beside its resource population. The
two populations answer different questions (*what files are here* versus *what does the harness
load*) and derive differently (the resource population skips content keying and the blob stage; the
context population needs both), which is why they were never merged into one.
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
| `vat audit [path]` | `crawl` + `registry-md-html` | `audit.ts` → `audit/scan-population.ts › enumerateAuditPopulation()` → `crawlDirectory` for the subject tree (git route with untracked files by default; the walk route under `--include-artifacts` or when the scan root is itself gitignored — `NEVER_CRAWL_GLOBS` applies on both); `crawlAndResolveRegistry` once per project root it finds for the link graph. Against a bare skills directory only the crawl runs |
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
| `vat corpus scan` | `crawl` + `registry-md-html` (`?`) | `corpus/index.ts` (inline; see limits) |
| `vat okf validate` | `okf-bundle-walk` | `okf/validate.ts` → `discoverOkfBundle` |
| `vat resources check` | `crawl`, *in a spawned child* | `resources/check.ts` — one population, same lane as `resources query`; both reach it through `packages/cli/src/utils/projection-query.ts › withQueriedProjection()`. With a `--budget` (the default), the crawl happens in a CHILD process: the parent spawns `dist/bin.js resources check … --cost-log <path>` and enumerates nothing itself, so it can kill a run that stops making progress (a check's SQL is adopter-authored and a runaway statement cannot be interrupted in process). `--budget 0` keeps everything in one process. It spawns ITSELF, exactly once, and its lane is unchanged |
| `vat resources query` | `crawl` | `resources/query.ts` — one population, via `packages/resources/src/projection/resource-population.ts › buildResourceProjection()`. Same registry and same `DECLINE_IGNORED` parameter set as `resources scan`/`validate`, with content parsing ON. ⚠️ Its ROW SET is a strict superset of what `scan`/`validate` see: those post-filter directories, non-existent rows and gitignored rows out of the population, so `SELECT COUNT(*) FROM resource_realizations` counts directories a validate run never looks at |
| `vat resources scan` | `crawl` | `resources/scan.ts` |
| `vat resources validate` | `crawl` ×1 | `resources/validate.ts` — one crawl, for the resource population, via `loadResourcesWithConfig()`. It has no knowledge of the context budget: no check, no flag in either direction (that lives in `vat claude budget`) |
| `vat skills list` | `crawl`, or `raw-readdir` under `--user` | `skills/list.ts` — project mode goes through the discovery package's `scan`; `--user` mode is `› scanSkillsDir()`'s own `readdirSync` over `~/.claude/skills` |
| `vat rag index` | `crawl` | `rag/index-command.ts` |
| `vat claude context [paths...]` | `crawl` ×1 | `claude/context.ts` → `buildClaudeContextPopulation` → `› sharedEnumeration()` → `crawlSourceFor` → `GitCrawlSource` **by default**, or `FilesystemCrawlSource` → `crawlDirectory`. Two `populate()` passes, ONE crawl: both `FilesystemExtentContributor` registrations are handed the same enumeration |
| `vat claude budget [paths...]` | `crawl` ×1 | `claude/budget.ts` → the same route, the same double `populate()` and the same single crawl as `vat claude context`. SAME lane, SAME population; only the question differs — `context` reports what one path loads, `budget` sweeps every working location and applies a threshold (`packages/resources/src/projection/claude-context-budget-sweep.ts › sweepAlwaysLoadedBudgets()`) |
| `vat inventory [path]` | `crawl`, **or** the projection's `filesystem` extent on a plugin directory (the default there) | `inventory.ts` → `routeInventory()`; the walk at `packages/claude-marketplace/src/inventory/extract-skill.ts › crawlSkillLinkRegistry()` → `crawlDirectory`; the projection at `inventory.ts › populationProviderFor()` → `buildInventoryPopulation` → `FilesystemExtentContributor` → `crawlSourceFor` → `crawlDirectory` or `GitCrawlSource`. Two extractors also `readdir` trees of their own (`extract-plugin.ts`, three sites; `extract-install.ts`) — `raw-readdir` |
| `vat claude marketplace validate` | `crawl` + `raw-readdir` | `claude/marketplace/validate.ts` — `readdirSync` over `plugins/` and each plugin's `skills/` (`› listPluginDirs`, the skill-entry loop), then the packaging validator's registry crawl per skill |
| `vat claude org skills install` | `raw-readdir` | `claude/org/skills.ts › collectFiles()` — recursively `readdirSync`s the skill directory (or the `dist/skills/` of a downloaded npm package, found through `› listNodeModulePackages()` / `› findSkillsDir()`) and **uploads those bytes**. Not `crawlDirectory`: the walk has no gitignore awareness, so an untracked file in the source directory ships |
| `vat claude org skills versions add` | `raw-readdir` | `claude/org/skills.ts` — the same `collectFiles()` walk and the same consequence as `install`; only the id is given rather than minted |

`vat claude context` and `vat claude budget` each **populate** twice, and that doubling is
structural rather than incidental: `ContributorRegistry` keys on `id` and partitions on `kind`
before any `contribute` runs, so `discoverImportRoots` must run once — under `CONTENT_PARSING_SKIP`,
with `'deferred'` content, reading no bytes — purely to name the `@`-import contributors the real
population then registers. It does **not** crawl twice: `sharedEnumeration()` performs one crawl and
both passes replay it, which is sound only because both ask the extent the same question — same
source, same `DECLINE_IGNORED` parameter set — differing solely in `contentDemand`, which decides
what a row SAYS rather than which paths exist. Documented at the head of
`claude-context-population.ts`.

`vat inventory` carries both lanes because `routeInventory()` dispatches four subject shapes and
only one of them takes the projection. A marketplace root and `--user` fan out through
`extractClaudePluginInventory` to one `extractClaudeSkillInventory` per skill, supplying neither a
shared registry nor a shared population, so each skill's link walk builds its own registry through
`crawlSkillLinkRegistry()` — `crawlDirectory` — and a single `SKILL.md` reaches the same walk
directly. A plugin directory takes the projection unless `VAT_INVENTORY_CRAWL=walker` says otherwise,
and even there `populationProviderFor()` returns `undefined` when `findProjectRoot` finds no root,
and `membersFromPopulation()` returns `undefined` for a skill the population holds no extent for —
either fallback lands back on `crawlSkillLinkRegistry`. `crawl` is therefore the lane every shape can
reach and the projection is the extra one.

## Commands that do not enumerate

The 47 remaining. The bulk are Admin-API calls over HTTPS — `claude org *` is 27 commands, of which
25 appear here once `skills install` and `skills versions add` above are excluded — plus
process-level commands that read JSON layers or a manifest rather than crawling.

`agent`: `import`, `install`, `installed`, `list`, `run`, `uninstall`, `validate` ·
`ard emit` ·
`audit settings` ·
`cache clear` ·
`claude marketplace publish` ·
`claude org`: `api-keys list`, `api-keys update`, `code-analytics`, `cost`, `info`,
`invites create`, `invites delete`, `invites list`, `skills delete`, `skills list`,
`skills versions delete`, `skills versions list`, `usage`, `users get`, `users list`,
`users remove`, `users update`, `workspaces archive`, `workspaces create`, `workspaces get`,
`workspaces list`, `workspaces members add`, `workspaces members list`, `workspaces members remove`,
`workspaces members update` ·
`claude plugin`: `install`, `list`, `uninstall` ·
`doctor` ·
`mcp`: `list-collections`, `serve` ·
`rag`: `clear`, `query`, `stats` ·
`skill test configure` · `skills install`

Three of these are on the list on a technicality worth stating — "does not enumerate" here means
"reaches no lane named above", which is narrower than "builds no population":

- `vat cache clear` builds a raw `fs.readdir` population of `<tmpdir>/.vat-cache` at
  `packages/cli/src/commands/cache/clear.ts › readdirOrNull()`, driven from `› clearCacheDirectory()`.
- `vat claude plugin install` `readdirSync`s the source tree it copies (four sites in
  `claude/plugin/install.ts`) and `vat agent installed` `readdir`s the install directory.
- `vat ard emit` reads `vibe-agent-toolkit.config.yaml` plus the skill manifests that config already
  names, and never walks a tree to discover a population.
- The `claude org skills list` / `delete` / `versions list` / `versions delete` verbs are pure
  HTTPS: their handlers in `claude/org/skills.ts` reach neither `collectFiles()` nor any `readdir`.
  An earlier revision of this table marked them `crawl` by joining each leaf to its registrar file
  — the second rejected method below.

## How this is derived

**Population — from the built CLI, never from source.** `--help` is recursed on
`packages/cli/dist/bin.js`, and a node with no `Commands:` block is a leaf. A grep for
`new Command(` cannot define this population: it sees construction sites, not the reachable tree.
Two parsing details, because the recursion is re-run by hand and must land on the same number twice:
a `Commands:` block ends at the first blank line — read past it and the `addHelpText('after', …)`
prose on `audit`, `rag`, `agent` and `cache` parses as phantom subcommands — and Commander's
built-in `help`, which only `mcp` prints, is not a leaf.

```bash
walk() { local out; out=$(node packages/cli/dist/bin.js $1 --help 2>/dev/null)
  local subs; subs=$(echo "$out" | awk '/^Commands:/{f=1;next} f&&/^$/{exit} f&&/^  [a-z]/{print $1}' | sed 's/|.*//' | grep -v '^help$')
  if [ -z "$subs" ]; then echo "LEAF: vat $1"; else for s in $subs; do walk "$1 $s"; done; fi; }
walk ""
```

**Lanes — barrel-aware static analysis, cross-checked at runtime.** For each command, the module
implementing its handler is resolved (delegated `.action(handler)` → the handler's module; inline
`new Command('x'); …action(async () => {…})` → the registrar itself), then that module is checked
for reachability to the sinks. Then the sinks in `dist/` were patched to write a marker to stderr
and real invocations were run against real inputs, recording which sinks actually fired. Rows
corrected since that derivation cite the code site that decided them.

### Two methods that were tried and rejected — do not repeat them

1. **Naive module-level import reachability.** It reported `vat claude org cost` — an HTTPS call —
   as reaching all three sinks, and 45 of 98 command modules as reaching all three. Barrels are why:
   importing one helper from `utils` or `agent-skills` marks every sink in that package reachable.
   The graph was right; the question was wrong.
2. **Joining a leaf to its registrar file.** Wherever a group `index.ts` registers several leaves,
   each leaf inherits the union of its siblings' lanes — `vat agent list` read as crawling, and the
   four HTTPS-only `claude org skills` verbs read as `crawl`, while a runtime probe shows them
   reaching no sink.

### What the runtime cross-check caught that static analysis could not

`vat validate` was classified `NONE` and is not: it spawns `resources validate` and
`skills validate` as child processes. **No import edge exists to follow**, so a static graph is
structurally blind to it and always will be. The child inherits stderr, which is the only reason the
instrumented run saw it. Any future revision of this table must keep the runtime leg.

## Declared limits

- **`vat corpus scan` is marked `?`.** Its action is inline in a group `index.ts`, so its lane is
  that file's, which is the union over its imports — this row may over-attribute. It is the only
  such row.
- **A runtime probe proves presence, never absence.** `vat audit` fired the `crawl` sink against a
  scratch directory holding two markdown files and no skill (its subject population), and
  `crawlAndResolveRegistry`×2 against this repo. A `NONE` in this table means "no reachable sink under static analysis", corroborated by
  runtime where a credential-free invocation exists — not "proven never to enumerate".
- **The `claude org *` commands were not run** (they need `ANTHROPIC_ADMIN_API_KEY`). Their rows
  rest on static analysis plus the inline HTTPS bodies being directly readable.
- **Lanes are per command, not per invocation.** `vat audit` reaches the registry lane against a
  project root and only the crawl against a bare skills directory. The table is the upper bound.
- **The `vat inventory` row was read out of `routeInventory()` and the two providers it gates**, not
  produced by the method above: both of its routes leave the CLI package through a barrel import,
  which is exactly the edge rejected method 1's fix stopped attributing — its cure for barrel
  *over*-reporting has an under-reporting direction, and nothing in the derivation bounds it. No
  script for the static leg is committed, so which edge it declined to follow is not recoverable.

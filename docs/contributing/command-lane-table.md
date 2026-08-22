# Command → enumeration lane

Which of VAT's commands read the filesystem to build a resource population, and through which
entry point. This exists to replace the standing claim *"~70 commands, 5 examined"* with a bounded
list, so the four-phase pipeline work knows exactly whose behaviour it must preserve.

**Population: 65 commands** — 64 leaves plus `vat audit`, the only command group that is also
runnable in its own right (`vat audit [git-url-or-path]` alongside its `settings` subcommand).

**23 enumerate. 42 do not.**

## The three enumeration entry points

| Lane | Entry point | Defined in |
|---|---|---|
| `crawl` | `crawlDirectory` / `crawlDirectorySync` | `packages/utils/src/file-crawler.ts` |
| `registry-md` | `createProjectRegistry` (include `**/*.md`) | `packages/agent-skills/src/skill-packager.ts` |
| `registry-md-html` | `crawlAndResolveRegistry` (include md **+ html**) | `packages/agent-skills/src/validators/packaging-validator.ts` |

`scanDirectory` is not a fourth sink — the discovery package reaches `crawlDirectory` underneath.
That the two registry builders crawl *different include sets* and observably disagree is a known
defect, tracked separately; this table records which commands are exposed to it.

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
| `vat resources scan` | `crawl` | `resources/scan.ts` |
| `vat resources validate` | `crawl` | `resources/validate.ts` |
| `vat skills list` | `crawl` | `skills/list.ts` |
| `vat rag index` | `crawl` | `rag/index-command.ts` |
| `vat claude context [path]` | `crawl` ×2 | `claude/context.ts` → `buildClaudeContextPopulation` → `FilesystemExtentContributor` → `crawlSourceFor` → `FilesystemCrawlSource` → `crawlDirectory` |
| `vat claude marketplace validate` | `crawl` | `claude/marketplace/validate.ts` |
| `vat claude org skills list` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills install` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills delete` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills versions list` | `crawl` | `claude/org/skills.ts` |
| `vat claude org skills versions delete` | `crawl` | `claude/org/skills.ts` |

`vat claude context` is the one row marked `crawl` **×2**, and the doubling is structural rather than
incidental: `ContributorRegistry` keys on `id` and partitions on `kind` before any `contribute` runs,
so `discoverImportRoots` must enumerate once — under `CONTENT_PARSING_SKIP`, with `'deferred'`
content, reading no bytes — purely to name the `@`-import contributors the real population then
registers. Documented at the head of `claude-context-population.ts`. Its enumeration also reaches
`GitCrawlSource` rather than `FilesystemCrawlSource` when `gitExtentSelected` holds, which is the
`crawlSourceFor` opt-in and applies to every row in this table that goes through that function.

## Commands that do not enumerate

The 42 remaining. The bulk are Admin-API calls over HTTPS (`claude org *`, 26 of them once the five
`skills` commands above are excluded), plus process-level commands that read JSON layers or a
manifest rather than crawling.

`agent`: `import`, `install`, `installed`, `list`, `run`, `uninstall`, `validate` ·
`audit settings` ·
`claude marketplace publish` ·
`claude org`: `api-keys list`, `api-keys update`, `code-analytics`, `cost`, `info`,
`invites create`, `invites delete`, `invites list`, `usage`, `users get`, `users list`,
`users remove`, `users update`, `workspaces archive`, `workspaces create`, `workspaces get`,
`workspaces list`, `workspaces members add`, `workspaces members list`, `workspaces members remove`,
`workspaces members update` ·
`claude plugin`: `install`, `list`, `uninstall` ·
`doctor` · `inventory` ·
`mcp`: `list-collections`, `serve` ·
`rag`: `clear`, `query`, `stats` ·
`skill test configure` · `skills install`

## How this was derived

**Population — from the built CLI, never from source.** `--help` is recursed on
`packages/cli/dist/bin.js`, and a node with no `Commands:` block is a leaf. A grep for
`new Command(` cannot define this population: it sees construction sites, not the reachable tree.

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

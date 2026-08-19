# Command Population Matrix

**How to read a cell.** This document is a **specification**, not a description of the code. Each
cell states what a command's population *should* be. Three states, and one of them is silence:

| cell | meaning |
|---|---|
| a plain value | the intended behaviour, and the implementation conforms. **Silence is the claim** — a cell with no annotation asserts the code matches. |
| `BUG:` … | the intent is declared, the implementation diverges. Transitional. Whoever fixes the code **deletes the annotation**; the cell becomes a plain value. |
| `⚠️ undeclared` | nothing has ever declared what this should be. **Not a bug** — an open question. Never back-filled from what the code happens to do. |

Provenance sits in a separate **[Declaration register](#declaration-register)** keyed `D1`…`Dn`, not
inline. Inline `file:line` citations in an eight-column table make it unreadable, and the same
declaration governs many rows — a register de-duplicates it and gives each declaration one place to
be corrected. A `BUG:` annotation cites the *divergence* site inline, because that is the actionable
address and it is per-row.

This document sits beside [Resource Scanning and Object Caching](./resource-scanning-and-caching.md),
which is the authority on *mechanism* — the two lanes, their cost models, the git plumbing. This one
is the authority on *which command gets which*.

## 1. The governing ruling

**The validation universe is `tracked ∪ (untracked ∧ ¬ignored)`** — what a commit made right now
*would* contain. A command that cannot see a brand-new, uncommitted, un-ignored file is a **defect**,
not a scoping choice.

**The ruling is declared in-repo, at [D2] §2.1.** This repository has no ADRs — a decision of this
kind lives in an architecture document — so that section is the binding statement, not a note, and it
supersedes the sentence in the same document that used to decline the call. Every row below is scored
against it. The set expression also appears at [D1], but only as the definition of the `git`
*extent* — one entry in an open extent vocabulary, which is a narrower thing than an obligation on a
command's population.

Three scope bounds the ruling explicitly does **not** claim, all named at [D2] §2.1 and all still
open in §8: whether it binds **packaging** populations (what *ships*) as well as validation
populations (what is *checked*) — U2; whether it binds populations that are not git-backed at all —
U3; and what a verb whose subject is deliberately build output owes it — U6.

## 2. The three selectors, and their opposite defaults

🪤 **The three environment selectors default in different directions.** This is the live footgun; it
is stated here once so no row has to restate it.

| selector | values | default | what it selects | declared |
|---|---|---|---|---|
| `VAT_RESOURCES_CRAWL` | unset · `projection` | **walk** (opt-**in** to the projection) | whether the resources/packaging population comes from `crawlDirectory` or from a base-only projection | [D3] |
| `VAT_INVENTORY_CRAWL` | unset · `projection` · `walker` | **projection** (opt-**out** to the walk) | whether `vat inventory` membership is answered by a projection or the incumbent link walk | [D4] |
| `VAT_EXTENT_SOURCE` | unset · `git` | **filesystem walk** (opt-**in** to git) | *within* the projection, which implementation enumerates the `filesystem` extent | [D5] |

Three properties that are easy to get wrong:

- **`VAT_INVENTORY_CRAWL` is the only one whose default is the new lane**, and the asymmetry is
  deliberate rather than an oversight: the inventory flip was provable as a byte-for-byte no-op, and
  the resources flip is provably *not* one — it drops committed symlinks [D3]. It used to disagree in
  the other direction too, by adding findings on untracked files; that half is gone now that the
  default lane honours §1, so the symlink loss is the whole of the remaining disagreement.
- **An unrecognized value never throws.** `VAT_INVENTORY_CRAWL` treats anything that is not exactly
  `walker` as the projection [D4]; the other two treat anything that is not exactly their opt-in
  spelling as the default. A typo'd selector silently selects a lane.
- **`VAT_EXTENT_SOURCE=git` falls back silently** when the root is not in a repository, so the
  selector and the outcome come apart. That is why a scan reports `extentSource` as a fact about the
  run rather than by re-reading the environment [D6].

## 3. Population source and selector, per command

Only commands that enumerate a file population appear here.
[§6](#6-commands-that-enumerate-no-file-population) lists the rest, so that every registered command
appears in this document exactly once.

| command | population source (default) | selector | declared |
|---|---|---|---|
| `vat resources scan` | `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` | [D3] |
| `vat resources validate` | `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` | [D3] |
| `vat rag index` | `crawlDirectory` walk (same loader) | `VAT_RESOURCES_CRAWL` | [D3] |
| `vat inventory` (plugin dir) | **projection** | `VAT_INVENTORY_CRAWL` | [D4] |
| `vat inventory` (marketplace root, `--user`, single `SKILL.md`) | incumbent link walk — the projection lane is **plugin-directory-only** | none; the selector does not reach these shapes | [D7] |
| `vat skills validate` | skill discovery: `crawlDirectory` walk · link registry: `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` (registry only) | [D3], [D8] |
| `vat skills build` | skill discovery: `crawlDirectory` walk · per-skill registry: `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` (registry only) | [D3], [D8] |
| `vat claude plugin build` | pool skills: `crawlDirectory` walk · plugin-local skills: `crawlDirectorySync` · tree-copy: `crawlDirectory` · registry: `crawlDirectory` walk | `VAT_RESOURCES_CRAWL` (registry only) | [D3], [D9] |
| `vat audit` | five seams at once: subject tree by raw `fs.readdir` recursion · skill discovery · the inventory link registry · a packaging registry · `fs.globSync` for unreferenced-file detection | **none** — `vat audit` is on no selector at all | ⚠️ undeclared |
| `vat corpus scan` | none of its own — reads a seed file and delegates one `vat audit` per entry; `--with-review` adds a forced full walk | inherited from `vat audit` | [D10] |
| `vat skill review` | project-wide twice over: skill discovery (`crawlDirectory` walk) **and** a link registry (`crawlDirectory` walk) — despite naming one skill | `VAT_RESOURCES_CRAWL` (registry only) | [D3], [D8] |
| `vat skill test run` | subject resolution runs project-wide skill discovery; the build path re-enters `vat claude plugin build` for a plugin-local skill | `VAT_RESOURCES_CRAWL` (registry only) | [D8] |
| `vat skills package` | the skill's link graph, plus `fs.globSync` for unreferenced-file detection and the `files:` globs | none | ⚠️ undeclared |
| `vat agent build` | a fixed convention list (`scripts/`, `LICENSE.txt`), then the skill's link graph and `files:` globs | none | ⚠️ undeclared |
| `vat claude marketplace validate` | nested one-level `readdirSync` over the built tree, then `fs.globSync` per skill | none | ⚠️ undeclared |
| `vat claude marketplace publish` | `cpSync` of the built tree, then **git itself decides what is published** (`git add -A`) | none | ⚠️ undeclared |
| `vat claude plugin install` | one-level `readdirSync` over the extracted/source tree | none | ⚠️ undeclared |
| `vat claude plugin list` | registry JSON, plus one-level `readdirSync` for legacy skills | none | ⚠️ undeclared |
| `vat claude org skills install` | **recursive `readdirSync` of the skill directory, whose bytes are then uploaded** — the one org verb with a file population | none | ⚠️ undeclared |
| `vat skills install` | archive extraction, then one-level `readdirSync` over the source tree | none | ⚠️ undeclared |
| `vat skills list` | forced full walk (`respectGitignore: false`), then gitignore applied as a per-file **annotation** rather than a filter — every mode | none — the forced walk bypasses every selector | [D19] |
| `vat agent list` | raw `fs.readdir` over a hardcoded search-path list | none | ⚠️ undeclared |
| `vat agent installed` | one-level `fs.readdir` over a hardcoded scope list | none | ⚠️ undeclared |
| `vat cache clear` | not a corpus — walks `<tmpdir>/.vat-cache` | none | [D11] |
| `vat build` | orchestrator; inherits `vat skills build` then `vat claude plugin build` | inherited | [D12] |
| `vat validate` | orchestrator; inherits `vat resources validate` then `vat skills validate` | inherited | [D13] |
| `vat verify` | orchestrator; inherits `vat resources validate`, `vat skills validate`, `vat claude marketplace validate`, plus the in-process phases that read `dist/` | inherited | [D14] |

**The mechanism column is the finding, not a detail.** Beyond the incumbent walk and the projection
there are three more routes, and each answers the ruling in §1 differently:

- **Raw `readdir`, with no git awareness at all.** Neither selector nor `.gitignore` reaches it — the
  question is not asked rather than answered by a default.
- **A forced full walk with gitignore as an annotation** (`vat skills list`, [D19]). It sees strictly
  more than any other route and drops nothing; ignored status is reported as a per-file flag. This is
  the only route in VAT that *reports* an ignored file rather than excluding it.
- **A registry crawl that bypasses `ResourceRegistry.crawl`** ([D20]), so no `populationSource` can
  reach it and the crawl-timing bracket does not account for it. `vat audit` and three of
  `vat inventory`'s four subject lanes depend on it.
- **A delegating orchestrator**, whose population is whatever its phases enumerate.

`vat audit` alone reaches five of these at once. Nothing declares that this many routes is intended,
and nothing declares which route a new command should reach for.

## 4. What each command sees

The two visibility questions the ruling in §1 turns on. `n/a` means the command reaches this
mechanism through a route where the concept does not apply.

| command | in a git working tree | NOT in a git working tree | sees untracked-not-ignored? | sees gitignored (e.g. `dist/`)? |
|---|---|---|---|---|
| `vat resources scan` | `git ls-files` fast path | manual `readdir` walk; `.gitignore` is never consulted, so everything not glob-excluded is a member | yes — `ResourceRegistry.crawl` passes `includeUntracked: true`, which widens the `git ls-files` query to `--cached --others --exclude-standard` without leaving the fast path | no |
| `vat resources validate` | `git ls-files` fast path | manual walk, as above | yes — same registry option. The silent green [D2] measured over a file it could not see is pinned as an assertion at `packages/resources/test/integration/crawl-untracked-population.integration.test.ts` | no |
| `vat rag index` | `git ls-files` fast path | manual walk, as above | yes — same loader, same registry option | no |
| `vat resources scan/validate`, `vat rag index` — with `VAT_RESOURCES_CRAWL=projection` | filesystem-extent walk, or git enumeration under `VAT_EXTENT_SOURCE=git` | filesystem-extent walk; with no git oracle every row reads `gitignored: false`, so the whole crawl is admitted | yes | no — enumerated by the extent, then declined by this consumer [D15] |
| `vat inventory` (plugin dir) | projection over the filesystem extent | filesystem extent; no ignore oracle, whole crawl admitted | yes | no |
| `vat inventory` (other shapes) | link walk over a `crawlDirectory` registry | manual walk | yes — the skill extractor sets `includeUntracked: true` [D16] | no |
| `vat skills validate` — discovery | `git ls-files --cached --others --exclude-standard` | manual walk | yes [D8] | no |
| `vat skills build` — discovery | as above | manual walk | yes [D8] | no |
| `vat skills validate/build` — link registry | `git ls-files` fast path | manual walk | yes — `crawlAndResolveRegistry` builds its registry through `ResourceRegistry.crawl`, so a discovered skill's brand-new link target is a registry member | no |
| `vat claude plugin build` — pool skills | `git ls-files --cached --others --exclude-standard` | manual walk | yes [D8] | no |
| `vat claude plugin build` — plugin-local skills | `git ls-files`, tracked only | manual walk — every directory is visible, and `listUntrackedPluginSkillDirs` returns `[]` because there is no git to disagree with | no, **by declared intent**, with a build **warning** naming each one [D9]. ⚠️ Whether the §1 ruling overrides that intent is undeclared — see §8 | no, by declared intent [D9] |
| `vat claude plugin build` — tree-copy | `git ls-files`, tracked only | manual walk | no, by declared intent [D9] | no, by declared intent [D9] |
| `vat audit` — subject tree | raw `fs.readdir`; git is not consulted | identical — the route has no git branch | yes, incidentally: `readdir` sees every file | **yes**, incidentally — nothing filters ignored paths out of the subject walk. ⚠️ undeclared whether that is intended |
| `vat audit` — link registry | `git ls-files` fast path | manual walk | yes — `packages/cli/src/commands/audit.ts:330` calls `crawlAndResolveRegistry(projectRoot)`, and that route reaches `ResourceRegistry.crawl`, so the walk itself now carries the ruling | no |
| `vat skill review` — discovery | `git ls-files --cached --others --exclude-standard` | manual walk | yes [D8] | no |
| `vat skill review` — link registry | `git ls-files` fast path | manual walk | yes — same `crawlAndResolveRegistry` route | no |
| `vat skill test run` — subject resolution | `git ls-files --cached --others --exclude-standard` | manual walk | yes [D8] | no |
| `vat claude marketplace validate` | one-level `readdirSync` over `dist/` | identical | n/a — the tree it reads is build output | **yes** — necessarily, and correctly: `dist/` is normally gitignored and a verify verb must see what was built. ⚠️ undeclared |
| `vat claude marketplace publish` | **git decides** — the composed tree is `git add -A`ed, so the published set is `tracked ∪ (untracked ∧ ¬ignored)` of the publish repo | n/a — publishing requires a repository | yes, by the mechanism | no |
| `vat claude plugin install` | one-level `readdirSync` | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat claude plugin list` | one-level `readdirSync` plus registry JSON | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat claude org skills install` | recursive `readdirSync`; git is not consulted before upload | identical | yes, incidentally | **yes, incidentally — and these bytes leave the machine.** ⚠️ undeclared, and the highest-consequence cell in this table |
| `vat skills install` | one-level `readdirSync` | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat skills package` | `fs.globSync` over the skill dir; git is not consulted | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat skills list` | forced manual walk — `git ls-files` is never reached | identical walk; the annotation reads `false` everywhere because there is no tracker | yes | **yes, and it reports them** — each result carries an `isGitIgnored` flag instead of being dropped [D19] |
| `vat agent list` / `vat agent installed` | raw `fs.readdir` | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat agent build` | fixed convention list + `files:` globs; git is not consulted | identical | yes, incidentally | yes, incidentally. ⚠️ undeclared |
| `vat cache clear` | n/a — the cache tree is outside any repository | n/a | n/a | n/a |
| `vat build` / `vat validate` / `vat verify` | inherited per phase, plus `vat build`'s own `readdir` walk of the shipped plugin tree | inherited per phase | inherited per phase | `vat build`'s own walk reads `dist/`, so yes there |

**The non-git column is the one to read twice.** SharePoint, OneDrive, iCloud-synced folders and
`~/.claude/*` are explicitly in scope for this tool, and outside a git working tree *no route
consults `.gitignore` at all* — the manual walk in `packages/utils/src/file-crawler.ts:268` has no
gitignore code, and the projection's filesystem extent has no oracle to ask. A `.gitignore` file
sitting in a non-git directory is inert. Every distinction in the two right-hand columns collapses:
the population is "everything the glob filters admit". That is coherent, and it is nowhere declared.

## 5. Content reads and the blob stage

These two columns apply only where a projection runs; the incumbent walk has no `contentDemand` and
no blob stage — it reads and parses each admitted resource directly, charged at
`resource-registry:add-resource`.

| lane | `contentDemand` at enumeration | resulting `contentState` | blob / reference-following stage |
|---|---|---|---|
| resources projection (`vat resources scan/validate`, `vat rag index`, and the packaging registries under `VAT_RESOURCES_CRAWL=projection`) | `deferred` — enumerate every path, read none of them [D17] | `deferred` for every file row, `none` for a directory. `contentKey` is always null | **`BLOBS_SKIP`** — the stage is ~90% of this lane's cold cost and not one blob row is read [D18] |
| inventory projection (`vat inventory`, plugin dir) | `deferGitignored`, from the same contributor — key eagerly, except where the row's own `gitignored` column is true [D17] | `keyed`, or `deferred` for an ignored row, or `none`/`unreadable` | **`BLOBS_DERIVE`** (the default). Mandatory here, not a choice: the closure contributor reads the blob-keyed tables, and `populate()` **throws** rather than silently reducing every extent to its own root [D18] |

**Zero file-content reads on this lane, and a gate holds it there.** The demand is the caller's
decision rather than a property of the contributor, so `vat inventory` keeps `deferGitignored` while
this lane passes `'deferred'`. `packages/resources/test/integration/resources-lane-zero-content-reads.integration.test.ts`
patches `node:fs` and `node:fs/promises` through an `--import` preload and fails on any content read
under the crawl root; it documents the six routes it cannot observe rather than claiming completeness.

**`BLOBS_SKIP` / `BLOBS_DERIVE` are named for the wrong thing.** They read as a choice about a
storage tier. What they actually gate is whether a `deferred` realization is ever promoted to
`keyed` on demand — a *behaviour*, not a table. The names are recorded here as misleading; nothing
is renamed by this document.

## 6. Commands that enumerate no file population

Listed so the bidirectional check in §9 has a complete population to work from. A command here makes
no membership claim about a tree: it reads one named path, or it talks to an API.

| family | commands | why no population |
|---|---|---|
| Anthropic Admin API | `vat claude org info` · `vat claude org usage` · `vat claude org cost` · `vat claude org code-analytics` · `vat claude org api-keys list` · `vat claude org api-keys update` · `vat claude org invites list` · `vat claude org invites create` · `vat claude org invites delete` · `vat claude org users list` · `vat claude org users get` · `vat claude org users update` · `vat claude org users remove` · `vat claude org workspaces list` · `vat claude org workspaces get` · `vat claude org workspaces create` · `vat claude org workspaces archive` · `vat claude org workspaces members list` · `vat claude org workspaces members add` · `vat claude org workspaces members update` · `vat claude org workspaces members remove` · `vat claude org skills list` · `vat claude org skills delete` · `vat claude org skills versions list` · `vat claude org skills versions delete` | HTTP only. **`vat claude org skills install` is NOT in this family** — it is in §3 |
| single named path | `vat agent run` · `vat agent validate` · `vat agent import` · `vat agent install` · `vat agent uninstall` · `vat skill test configure` | the argument names the subject; nothing is enumerated. ⚠️ `agent run`/`validate`/`install` still run the agent *search-path* readdir when given a bare name rather than a path — a population used only to resolve one name |
| registry / manifest read | `vat claude plugin uninstall` · `vat mcp list-collections` · `vat rag stats` · `vat rag query` · `vat rag clear` | reads a manifest, a hardcoded array, or a vector database |
| environment report | `vat doctor` · `vat audit settings` | a hardcoded check list and a hardcoded settings-path list; filesystem contact is `existsSync` probes only |
| long-running server | `vat mcp serve` | resolves the package by dynamic import, not by enumeration |

⚠️ Membership in this table is itself **undeclared** — no rule says which commands are entitled to
have no population, and the boundary moved twice while this document was being written. `vat skill
review`, `vat skill test run`, `vat skills package` and `vat claude org skills install` all read as
single-path verbs and all enumerate; the last uploads what it finds. Every row above is a judgement
call that the §9 gate would freeze into a contract, which is the point of writing them down.

## 7. Contradictions between docs and code

Each is a specific, falsifiable claim that the code does not support. One is already fixed and is
recorded so the pattern is legible.

| # | claim | where | status |
|---|---|---|---|
| C1 | "opt-in second implementation", of a lane that had become the default | `packages/claude-marketplace/src/inventory/inventory-population.ts` header | **fixed** at `b4afef72` — the header now says the projection is the default [D4] |
| C2 | "a separate product decision this document does not make", of the untracked question | [D2] | **fixed** — [D2] §2.1 now declares the ruling instead of declining it, and `ResourceRegistry.crawl` conforms to it |
| C3 | "This extent cannot be narrowed — dropping non-markdown loses real members" | [D17], the closing lines of the file header | **open** — asserted with no fixture behind it. No test in the repo demonstrates a real member lost by narrowing to markdown. The neighbouring claim about *re-sourcing* is measured; this one is reasoned |
| C4 | "Discovery honors the same git visibility as the tree-copy (tracked files only, inside a git repo)" | [D9] | **open, and self-contradicting** — the same paragraph then describes warning about untracked skill directories, which requires seeing them. Two listings exist (`listPluginSourceSkillDirs`, tracked-only; `listUntrackedPluginSkillDirs`, everything) and the sentence describes only the first while the paragraph describes both |
| C5 | the selector "covers `vat resources scan`/`validate`, `vat rag index` and the pipeline oracles in one place — they all load through `loadResourcesWithConfig`" | [D2] §3.4, and [D3] | **open** — true of those four, but `vat audit` builds its registry through `crawlAndResolveRegistry` with no `populationSource` (`packages/cli/src/commands/audit.ts:330`) and is therefore reachable by no selector. The sentence is accurate about what it lists and reads as a claim of completeness |
| C6 | "None of them is durable — recovery is always rescan", of the four caches | [D11] | **open, and narrow** — true of the caches, but `vat cache clear` is documented as the recovery path for a *corrupt* cache while nothing detects corruption, so the operator is the detector. Not wrong; unfalsifiable as written |
| C7 | two different config keys answer "which skills does this project have" | `packages/cli/src/commands/skills/list.ts:236` reads `resources.include`/`resources.exclude`; every other skills lane reads `skills.include` via `discoverSkillsFromConfig` [D8] | **open** — `vat skills list` can disagree with `vat skills validate` about the skill set of the same project, by construction rather than by drift, and no diagnostic says so |
| C8 | "Detectors are pure consumers of inventory data — they never walk the filesystem directly" | `docs/architecture/README.md`, Audit System § | **open** — accurate about the *detectors*, but `vat audit` itself reaches five enumeration seams, one of which (`crawlSkillLinkRegistry`, [D20]) bypasses `ResourceRegistry.crawl` entirely and so is invisible to the crawl-timing bracket that would otherwise account for it |

## 8. ⚠️ Undeclared — the open questions

Every cell above marked `⚠️ undeclared`, collected. These are decisions, not defects. Nothing here
should be resolved by reading the code.

**The keys are stable identifiers, so a decided question leaves a gap rather than a renumbering.**
U1 asked whether `tracked ∪ (untracked ∧ ¬ignored)` is the universe for every command; it was
decided and declared at [D2] §2.1, and retired from this table. Nothing renumbers.

| # | question |
|---|---|
| U2 | **Does the ruling bind packaging populations — what *ships* — as well as validation populations?** `vat claude plugin build` deliberately ships tracked-only and warns [D9]. Under §1's set, an untracked-not-ignored skill *would* be in a commit, so it should ship. Under "you ship what you committed", it should not. Both readings are defensible and they disagree |
| U3 | **Does the ruling bind populations that are not git-backed?** Outside a working tree the concepts do not exist and the whole tree is the population. Nothing says whether that is the intended answer or an accident of there being no oracle |
| U4 | **Is the raw-`readdir` route intended, or is it drift?** Every command whose §3 row names it enumerates with no git awareness, so neither selector nor `.gitignore` reaches it. Nothing says which route a new command should reach for |
| U5 | **Should `vat audit` be on the projection lane?** It is the highest-volume enumerating verb and is reachable by no selector |
| U6 | **Should a packaging/verify verb see gitignored `dist/` deliberately, or incidentally?** Today it sees it because its route never filters, not because a rule grants it |
| U7 | **What is the intended non-git behaviour for a corpus with a `.gitignore` in it?** SharePoint/OneDrive/iCloud corpora are in scope; `.gitignore` there is inert |
| U8 | **Which commands are entitled to have no population at all?** §6 is a judgement call this document makes and no rule supports |
| U9 | **Is `vat inventory`'s projection lane meant to stay plugin-directory-only?** [D7] gives a rootedness *reason* for excluding the marketplace, `--user` and single-skill shapes, not an intent that they stay excluded |
| U10 | **Should `contentDemand` be a property of the lane or of the consumer?** It is set on the contributor [D17], so every consumer of the filesystem extent inherits one policy; the change in flight is evidence that one policy does not fit both |
| U11 | **What should the blob-stage flags be called?** They gate demand promotion and are named for a storage tier |
| U12 | **Should a command ever *report* a gitignored file rather than dropping it?** [D19] does, uniquely. If that is the right model, the other routes are wrong; if it is not, it is |
| U13 | **Should `vat claude org skills install` consult git before uploading?** It walks the skill directory with `readdirSync` and uploads what it finds, so a gitignored scratch file, a stray key, or an eval answer key under the skill dir leaves the machine. Nothing declares an intended filter. Of everything in this document this is the one with an exfiltration shape rather than a correctness shape |
| U14 | **Is `crawlSkillLinkRegistry` [D20] meant to be a separate seam?** It calls `crawlDirectory` and feeds `addResources` without going through `ResourceRegistry.crawl`, so it is reachable by no `populationSource` and is outside the accounting bracket. Three commands depend on it |
| U15 | **Should a "single named path" verb ever enumerate the whole project?** `vat skill review` names one skill and crawls the project twice; `vat skill test run` and `vat agent run` enumerate to resolve a bare name. Nothing says whether that is intended cost or accidental reach |

## 9. How to audit this

Proposed, not built. The point of a gate here is narrow: keep the table honest **as a
specification**, given that the code is expected to disagree with it during a fix.

**The check must be bidirectional, and this is the whole design.** A gate that discovers its
population from the code can only ask "does every command the code registers behave as the table
says" — which is silent about a command nobody added to the table. That silence is the failure mode
this repo has already paid for: *a gate that discovers its population from the repo is blind to what
was born outside it.* So both directions are asserted:

- **Code → table.** Every leaf command reachable by walking the Commander tree from
  `packages/cli/src/bin.ts` appears exactly once, either in §3/§4 or in §6. A newly registered
  command fails the gate until someone states its intent.
- **Table → code.** Every command named in any table resolves to a real registered command. A
  renamed or deleted command fails the gate rather than leaving a row describing nothing.

Neither direction may derive its list from the other. The command list is generated by walking the
registration tree; it is never hand-maintained in this document's own prose, and no count of commands
appears anywhere in this document for the same reason.

**The `BUG:` annotation is a waiver, and must be shrink-only.** A row carrying `BUG:` is a
license for the code to disagree with the specification. Left ungoverned it becomes the easy way to
make the gate green. Two rules, and the second is the one that actually matters:

- **Entry is defended by the key.** The set of `BUG:`-annotated cells is extracted and compared
  against a committed baseline. A new one fails.
- **Exit is defended only by the seeder.** *A ratchet's key defends entry, and only its seeder
  defends exit* — every laundering route in this repo's history ran outward through the reseed path,
  which nobody audits. So the baseline must not be regenerable by a flag anyone can run. Adding a
  `BUG:` should require editing the baseline file in the same commit as the annotation, under
  CODEOWNERS, with the divergence's `file:line` recorded in the baseline row so a reviewer can check
  the claim without reading the diff. A `BUG:` whose cited `file:line` no longer contains the
  divergence should fail the gate — that is what makes a *stale* waiver visible, which "shrink-only"
  alone does not.

**What the gate cannot check, and must not pretend to.** It cannot verify that a plain cell is true —
that requires running the command against a fixture tree. Two probe fixtures would carry most of the
weight, and both are cheap: a git repository holding one committed and one untracked markdown file
with a broken link each (which already exists as a measurement in [D2] and is not pinned as an
assertion), and the same tree with `.git` removed. Every row in §4's two visibility columns is a
prediction about those two fixtures. Turning the measurement into an assertion is what would move
those cells from "asserted here" to "pinned".

**This document demonstrated its own headline `BUG:` on the way in, and the fix closed it.** Before
this file was committed, `vat resources validate docs/architecture` reported ten files scanned; the
same command with `VAT_RESOURCES_CRAWL=projection` reported eleven and validated this file's links.
The one-file difference was this document. Re-measured once `ResourceRegistry.crawl` was given
`includeUntracked: true`: the default lane reports eleven over `docs/architecture`, and with one
untracked markdown file carrying a broken link planted there it reports **twelve, one error, and
exits `error`** — the arm that used to exit green over exactly that file. That pair is the fixture
the first probe above needs, and both of its halves are now pinned as assertions at
`packages/resources/test/integration/crawl-untracked-population.integration.test.ts`.

**`⚠️ undeclared` must never be gate-clearable.** It is a request for a ruling, and a gate that
accepted it as a satisfied state would convert an open question into a permanent one.

## Declaration register

| key | declaration | source |
|---|---|---|
| D1 | the `git` extent is `tracked ∪ (untracked ∧ ¬ignored)`, glossed "committed or potentially committed" | `docs/architecture/zones.md:106` |
| D2 | **the §1 ruling, declared** (§2.1), the scanning taxonomy it scores, the three bounds it does not claim, and the measured probe behind it | `docs/architecture/resource-scanning-and-caching.md` §2, and §3.4 |
| D3 | `VAT_RESOURCES_CRAWL`, its value, its opt-in default and the argument for that default | `packages/cli/src/utils/resource-loader.ts:128-171`; scope statement at `:130-133` |
| D4 | `VAT_INVENTORY_CRAWL`, its three values, and the projection as default | `packages/claude-marketplace/src/inventory/inventory-population.ts:68-143` |
| D5 | `VAT_EXTENT_SOURCE`, and the walk as default even inside a repository | `packages/resources/src/projection/crawl-source.ts:432-491` |
| D6 | the request/outcome distinction — why the lane is reported from the run, not the environment | `packages/cli/src/utils/resource-loader.ts:38-62`; `packages/resources/src/projection/resource-population.ts:119-133` |
| D7 | the inventory projection is plugin-directory-only, and why the other subject shapes keep the walk | `packages/cli/src/commands/inventory.ts:99-157`, `:181-231` |
| D8 | skill discovery sets `includeUntracked: true`, because a skill must be discoverable before it is committed | `packages/cli/src/commands/skills/skill-discovery.ts:97-116` |
| D9 | plugin-local skill discovery and tree-copy share one git visibility, tracked-only, with a warning for untracked skill directories | `docs/architecture/skill-packaging.md:93`; `packages/agent-skills/src/plugin-distribution-layout.ts:60-119`; tree-copy at `packages/cli/src/commands/claude/plugin/tree-copy.ts:218-224` |
| D10 | `vat corpus scan` reads a seed and delegates per entry | `packages/cli/src/commands/corpus/scan.ts:1-30` |
| D11 | `vat cache clear` clears the whole shared tree; none of the caches is durable | `packages/cli/src/commands/cache/clear.ts:1-12` |
| D12 | `vat build` phases, in dependency order | `packages/cli/src/commands/build.ts:1-7` |
| D13 | `vat validate` covers source-level surfaces only and never requires a build | `packages/cli/src/commands/validate.ts:1-24` |
| D14 | `vat verify` phases, subprocess and in-process | `packages/cli/src/commands/verify.ts:1-15` |
| D15 | the resources consumer declines gitignored rows while the extent still enumerates them | `packages/resources/src/projection/resource-population.ts:30-50`, `:226-229` |
| D16 | the inventory skill extractor crawls with `includeUntracked: true` | `packages/claude-marketplace/src/inventory/extract-skill.ts:212-245` |
| D17 | the filesystem extent's lazy-keying rule, and the claim it cannot be narrowed | `packages/resources/src/projection/contributors/filesystem-extent.ts:27-70` (at `b4afef72`), applied at `:172` |
| D18 | `BLOBS_DERIVE` as default, `BLOBS_SKIP` as an opt-in the driver refuses when a blob reader is registered | `packages/resources/src/projection/merge.ts:124-130`, `:195-223`, `:688-699`; the resources lane's skip at `packages/resources/src/projection/resource-population.ts:142-164`, `:210` |
| D19 | the discovery scanner forces a full walk and annotates ignored status per file rather than filtering | `packages/discovery/src/scanners/local-scanner.ts:56-66`, `:103-117`; consumed by `packages/cli/src/commands/skills/list.ts:225-255` |
| D20 | the skill link registry crawls with `includeUntracked: true` and feeds `addResources` directly, bypassing `ResourceRegistry.crawl` | `packages/claude-marketplace/src/inventory/extract-skill.ts:212-250`; the docstring at `:216-236` states the timing bracket does not cover it |
| D21 | `vat audit`'s subject enumeration is its own recursive `fs.readdir` walk with its own prune rules | `packages/cli/src/commands/audit.ts:2413`, `:2477`; prune at `:2258`, `:2277`; the registry it validates against at `:330` |

## Related

- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the mechanism behind
  every route named here: the two lanes, the git plumbing, the symlink divergences, the measurements.
- [Resource Projection](./resource-projection.md) — the output side: what gets built from the bytes a
  population names.
- [Zones](./zones.md) — the extent and lens vocabulary the projection's populations are expressed in.
- [Skill Packaging](./skill-packaging.md) — the packaging shapes whose populations §3 and §4 split
  into pool, plugin-local and tree-copy.

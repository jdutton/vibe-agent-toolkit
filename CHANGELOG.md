# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`vat resources scan --format json`** — the same document as the YAML default, for consumers
  without a YAML parser.
- **`vat resources scan` now reports a `lane` field** naming which enumerator produced the
  population — `walk` or `projection`.
- **`vat resources scan` now reports an `extentSource` field** — `git`, `filesystem`, or `null` for
  the walk. Comparing two projection populations requires it: `lane` reads `projection` for both
  extent sources, so two runs can differ in `VAT_EXTENT_SOURCE` and look identical without it.
- **`VAT_EXTENT_SOURCE=git` enumerates the projection's filesystem extent through git** instead of
  by walking the tree. Opt-in, and only meaningful alongside `VAT_RESOURCES_CRAWL=projection`; the
  walk stays the default.
- **`gitLsOthers()` and `gitTreeSnapshot()` in `@vibe-agent-toolkit/utils`** — untracked/ignored
  path listings, and every path git can see with the blob OID of its **on-disk** bytes.
  `gitTreeSnapshot()` writes loose objects into the target repository's `.git/objects`.
- **`runGit()` and `runGitOrThrow()` in `@vibe-agent-toolkit/utils`** — run git against a path you
  were handed, without a git hook's inherited `GIT_DIR` silently redirecting it at another
  repository. Pass `{ ambient: true }` when you do mean the repository the process is standing in,
  and `{ trim: false }` for a NUL-delimited (`-z`) listing or for file content.

### Changed

- **`VAT_RESOURCES_CRAWL=projection` is several times faster on a cold parse cache.** The lane no
  longer parses every file in the tree to fill tables it does not read. Results are unchanged.

- **`blob_references` rows now carry `startOffset`/`endOffset`** — the half-open span of the
  reference token, so a consumer can rewrite a link without re-parsing. `ResourceLink` gains the
  same two fields, optional.

- **`VAT_CRAWL_TIMING` no longer double-counts the projection lane.** Its `base` rows nest inside
  `resource-registry:enumerate`, and both were added to the total; they are now reported as nested.
  Totals from earlier dumps overstate the projection arm.

- **(library) `ExtentContributor` now requires a `readsBlobs` field**, and `populate()` accepts
  `blobs: 'skip'` to leave the blob-keyed tables empty. A custom contributor must declare whether
  it reads them; `'skip'` throws if any registered contributor does.

- **`@vibe-agent-toolkit/utils` now depends on `@vibe-validate/git` (0.20.0).** It replaces this
  package's own copy of the git-environment scrub and tree-snapshot machinery. Adds
  `@vibe-validate/utils` and `yaml` to the installed tree.

### Breaking

- **(library) `safeExecSync()` and `safeExecResult()` now throw when asked to run `git`.** Migrate:
  `safeExecSync('git', args, opts)` → `runGitOrThrow(args, opts)`; `safeExecResult('git', args,
  opts)` → `runGit(args, opts)`, checking `.ok` instead of `.success`. Drop `encoding` — output is
  always decoded, and trimmed unless you pass `{ trim: false }`. CLI users are unaffected.

### Fixed

- **Git commands run from inside a git hook could read — or write — the wrong repository.** Worst
  case, `vat claude marketplace publish` switched a branch and landed a commit in the repository you
  were committing from. Also affected `gitLsFiles()`, `isGitIgnored()` and `cloneGitSource()`.
  Fixed; no action needed.

- **`vat doctor` reported "Git is not installed" when git was installed and working.** Also affected
  `getToolVersion('git')` and `isToolAvailable('git')` for library callers.

- **`vat` ignored git configuration supplied through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/
  `GIT_CONFIG_VALUE_*`**, so a clone that CI had pointed at an internal mirror went to the network
  instead. Those are honoured again; `GIT_CONFIG_PARAMETERS` is still ignored inside a hook.

- **A `linkAuth` token command that invokes `git` was refused.** Configured commands such as
  `git credential fill` work again.

### Changed

- **Scanning a tree with large ignored directories does one filesystem probe per ignored path
  fewer.** `GitTracker.isIgnoredByActiveSet()` takes an optional second argument, `knownToExist`,
  so a caller that has already stat'd the path is not made to pay for a second `existsSync`. The
  projection's `filesystem` extent enumerates every ignored path by design and had already
  `lstat`ed each one: **11,108 redundant `existsSync` calls on an adopter tree of 8,496 paths**,
  which is 14% of that command's total filesystem calls. Answers are unchanged. Omitting the
  argument preserves the previous behaviour exactly.

- **The RAG backend is no longer loaded by every `vat` command, and can now be omitted from an
  install.** `@vibe-agent-toolkit/rag` and `@vibe-agent-toolkit/rag-lancedb` moved from
  `dependencies` to `optionalDependencies`, and the four `vat rag` subcommands load their
  implementation only when actually invoked.

  **Why it mattered.** The import chain from the CLI entry point to `@lancedb/lancedb` was fully
  static, so **every** command — `vat --version` included — dlopened a platform-native LanceDB
  binary first. Measured: that import is **1,350 ms cold** (~50 ms warm), and the binary is
  **119.6 MiB unpacked on `win32-x64`**. Verified by direct observation rather than timing:
  `process.report().sharedObjects` now lists **0** LanceDB/onnxruntime objects for `vat --version`
  and **1** for `vat rag stats`.

  **To actually shrink the install you must ask for it:** `npm install vibe-agent-toolkit
  --omit=optional`. npm installs `optionalDependencies` by default, so a plain install is unchanged
  in size — measured, on the published `0.1.42`: 351.3 MB across 15,416 files, of which ~275 MB is
  the RAG lane (`onnxruntime-web` 133 MB, the LanceDB native binary 98 MB, `gpt-tokenizer` 44 MB).
  The startup saving above applies either way.

  `vat rag --help` and every subcommand's `--help` work with nothing loaded. If the backend is
  absent, `vat rag <cmd>` exits **2** naming the package to install rather than throwing a module
  resolution stack trace.

### Added

- **`vat resources scan`/`validate`, `vat rag index` and the pipeline oracles can now take their
  file population from the projection instead of `git ls-files`, via
  **`VAT_RESOURCES_CRAWL=projection`**. Opt-in; the default is unchanged.

  **What it fixes.** Inside a git working tree these lanes are answered by `git ls-files` with
  tracked files only, so **a markdown file you have written but not committed is invisible to
  validation** — the command reports a confident green over a corpus it did not fully see. On a
  two-file repository with one committed and one uncommitted broken link, the default lane reports
  `filesScanned: 1` and one finding; this lane reports 2. The projection-sourced population is
  `tracked ∪ (untracked ∧ ¬ignored)` — the same semantics skill discovery has always used, because
  skills must be discoverable before being committed. Gitignored files stay out.

  ⚠️ **What it loses: committed symlinks.** The projection's population crawls with
  `followSymlinks: false` and skips symlink entries outright, so a committed symlink that the
  default lane enumerates is not a member here — measured `filesScanned: 3` (default) vs `1`
  (projection) on a two-symlink probe. Where the symlink points **inside** the tree this is
  arguably an improvement: the default lane reports the same defect once per path. Where it points
  **outside** the tree it is a real capability loss — those bytes have no other path into the
  population, so a broken link the default lane reports goes unreported here. If your corpus
  reaches content through committed symlinks to out-of-tree targets, stay on the default lane.

  ⚠️ **Opt-in rather than default precisely because it disagrees in both directions.** Turning it
  on adds findings on real trees and drops the symlink ones, so the blast radius is yours to
  choose. Verified byte-identical (but for `durationSecs`) against the default lane on a 198-file,
  3,950-link non-git corpus.

  ⚠️ **Slower: `resource-registry:enumerate` went 2.7 ms → 851.9 ms on that corpus (316×)**, whole
  command 0.085 s → 0.926 s. `include`/`exclude` still apply, and are still applied by the registry
  with the same matcher the incumbent crawler uses.

  The projection does **not** parse binary files. A blob whose first 8000 bytes contain a NUL is
  recorded as `BLOB_NOT_TEXT` and left unparsed — git's own test, chosen over an extension list so a
  renamed archive is still caught and a bundled script is still read. Without it an 8 MB zip beside
  one markdown file cost 4.83 s against the default lane's 0.035 s, for the identical answer.

- **Two link exclusions that used to produce no output at all are now reported.** A markdown link
  resolving to a **directory** raises `LINK_TO_UNBUNDLED_DIRECTORY` (**warning**), and a reference
  dropped by an `excludeReferencesFromBundle` rule raises `LINK_EXCLUDED_BY_PATTERN` (**info**,
  naming the patterns of the rule that matched). Previously both were classified, filtered to
  `null`, and discarded — so an author asking "why did this file not ship?" got nothing back.

  `LINK_TO_UNBUNDLED_DIRECTORY` is a *new* code rather than the existing `LINK_TARGETS_DIRECTORY`,
  whose own fix text states it does not apply to navigational prose links. It is a **warning**, not
  an error, matching the two existing codes for the same phenomenon (`LINK_TO_NAVIGATION_FILE`,
  `LINK_FROM_NON_ROUTABLE_FILE`): the link resolves fine for a reader in the repo, so the defect is
  in packaging rather than at source.

  ⚠️ Projects declaring `excludeReferencesFromBundle` will see new **info** lines from `vat build`
  and `vat verify`. Info is non-blocking and packaged output is unchanged.

- **`vat inventory` now answers membership from a projection instead of the link walk, for a plugin
  directory subject.** This is a **behaviour change with identical output**: across six real adopter
  plugins (51 skills, 152 linked paths) the two lanes produce **byte-identical** YAML, and the
  incumbent walk remains available via **`VAT_INVENTORY_CRAWL=walker`**.

  ⚠️ **The other three subject shapes still walk, unchanged:** `--user`, a marketplace root, and a
  path to a single `SKILL.md`. A marketplace fans out to plugins that each sit in their own
  directory, so one population rooted at the marketplace answers a different question for every
  skill under it — the same reason that lane already declines a shared link registry.

  ⚠️ **It is slower, and that is a deliberate, accepted trade — roughly 5.3× on that adopter** (522 ms
  of link walk against 2,751 ms of projection, warm, clean machine). The cost is not the membership
  traversal, which is 2.5% of the projection's own time; it is the substrate beneath it, which
  enumerates the whole project tree (20,965 paths against the walk's 1,673 markdown documents) and
  reads every file it can content-key. Both halves are load-bearing: enumeration bounds membership,
  so narrowing it to markdown silently drops real non-markdown members, and the parse is what lets
  the closure see references emitted from a skill's bundled scripts — which the markdown-only link
  walk is structurally blind to.

  Scoped to `vat inventory` only — no packaging call site moved. The two packaging call sites additionally
  consume `excludedReferences`, `deferredAssets` and `maxBundledDepth`; the closure selects the same
  files but emits **no reason**, so pointing either at it would silently delete adopter-visible
  validation findings. Membership parity is not flip-readiness.

  Both crawlers stay live. The projection is honoured only for a root that exactly matches the one
  the extractor derives, and only for a skill it actually holds an extent for; anything else —
  including a source that throws — falls back to the walk rather than reporting an empty membership
  as an answer.

  `vat-lab` gained `--command inventory` so the two lanes can be measured against one subject. It is
  **not** in the default command set, so a bare `vat-lab crawl run` measures exactly what it did
  before.

- **`vat inventory` lists a skill's linked files in sorted order.** They were previously emitted in
  link-walk discovery order — bundled resources first, then assets, each in traversal order — which
  was never a stable property: it is a function of link order within each document, so inserting one
  link near the top of a `SKILL.md` reshuffled the tail. Both membership lanes now sort with the same
  host-independent comparator, so the listing is stable across machines and across the two crawlers.

- **The projection's closure primitive gained `CLOSURE_REFERENCE_OUTSIDE_ROOT`**, distinguishing a
  reference that escapes the extent root from one that simply did not resolve. Both used to report
  `CLOSURE_REFERENCE_UNRESOLVED`, which conflated "outside the project" with "no such file".

- **The crawl paths can now say where their own time goes — including the link walker, whose own
  work was never measured by anything.** Setting **`VAT_CRAWL_TIMING=<directory>`** makes every vat
  process that crawls write a `crawl-timing-<pid>.json` file into that directory as it exits,
  attributing elapsed time and invocation counts per `(contributorId, stratum, pass)`. The existing
  `VAT_PARSE_TIMING` seam measures *parsing* — including the parsing that feeds the walk — but never
  the walk itself, so a walker's traversal, its exclude-rule evaluation and its gitignore reads
  previously showed up nowhere at all.

  **Four strata make the two crawl implementations comparable from one dump**: `crawl` is the
  incumbent — `walkLinkGraph`'s traversal plus the `ResourceRegistry` build that feeds it, recorded
  under named synthetic contributor ids; `base` and `closure` are the projection's contributors, the
  latter charged per fixpoint pass; and `shared` holds work **both** crawlers consume and neither
  owns, so that it counts toward what a command spent and toward neither side of the comparison.
  `pass: 0` is reserved for a bracket placed *inside* the measured code, which cannot know the
  driver's fixpoint pass — the driver numbers from 1, so the two never merge.

  Today `shared` holds one row, `git-tracker:initialize` — the `git ls-files` spawn behind every
  gitignore answer. It is not a rounding error, and how large it is depends entirely on how much
  else the command does: measured on this repository's own tree it is **35%** of
  `vat resources scan`'s crawl budget and **27%** of `vat audit`'s, and on a directory with no VAT
  config — where the crawlers find almost nothing to do — it rises to **62%** and **100%**
  respectively. Because both crawlers are handed a tracker by their caller, this cost cancels out of
  any comparison between them — which is exactly why it went uncharged, and exactly why a symmetric
  omission still made the command totals wrong.

- **The projection's blob stage is charged too, and it is the one omission that did NOT cancel.**
  `populateBlobs` reads and parses every path the base contributors keyed — the projection's
  analogue of the incumbent's `resource-registry:add-resource`, which was already charged. It is now
  `blob-population:derive`, in the `base` stratum at the driver's pass. An omission on one arm
  biases the crawler-against-crawler comparison the seam exists to support, unlike the tracker
  spawn, whose omission at least fell on both sides equally.

  **A dump declares what its build can charge, and a comparison refuses two arms that disagree.**
  Adding a bracket charges work that was previously charged nowhere: no existing row changes, every
  row lines up, and the command TOTAL grows. An A/B across that boundary reads a widening of the
  *instrument* as a regression in the *subject* — and reads it consistently, so the pairs look
  stable and a confident delta gets printed instead of a refusal. Each dump therefore carries
  `charges` (the strata and synthetic ids the build can file), `vat-lab crawl compare` names what is
  missing on which side and declines to subtract, and the dump version goes back to guarding layout
  alone. It was never able to do more: an integer says "different", never "different how", and it
  only moves when somebody remembers to move it.

  **Each dump is one process and carries no cross-process total.** Under a verb that spawns the
  binary more than once, summing wall time across dumps would double-count the parent's lifetime,
  so the reader publishes a record per process and no total. An empty `entries` array is a
  reading — nothing was crawled; an empty *directory* means the build has no seam.

- **The parse paths can now say where their own time goes, per parser kind.** Setting
  **`VAT_PARSE_TIMING=<directory>`** makes every vat process that parses a document write a
  `parse-timing-<pid>.json` file into that directory as it exits, attributing elapsed time and
  invocation counts across the passes inside **both** parsers: the eight in `parseMarkdownContent`
  (token estimation, remark processor construction, the remark parse itself, the single AST-facts
  walk, unresolved references, code-context ranges, lexical references and content measures) and
  the four in `parseHtmlContent` (the parse5 parse, the element walk, token estimation and content
  measures). `vat validate` spawns the binary once per phase, so expect one dump per process.

  **The dump is grouped by parser kind, and each group carries its own documents, its own passes
  and its own bracketing total** — `markdown-total`, `html-total` — held in a field beside the pass
  rows rather than as a row among them. So a group's unattributed overhead is
  `<kind>-total - sum(that kind's passes)`, there is no arrangement of the rows that lets a reader
  compute a remainder against the wrong bracket, and no kind's breakdown can be read as the whole.
  The two parsers share no pipeline, so they are not forced into one pass list: HTML has no
  frontmatter, no reference scan and no code fences, and four permanently-zero rows would be a
  costume rather than a measurement.

  Instrumenting only markdown would have been a generalisation from one corpus: on a
  markdown-dominant tree the HTML parses are a rounding error, but on an HTML-heavy one the same
  instrument attributes almost none of the real work while still emitting a confident, well-formed
  breakdown. `vat-lab parse` therefore names the **dominant** parser kind before it shows any
  breakdown at all, says "mixed corpus" when no kind owns 80% of the parse time, and states every
  pass share against its own kind's total rather than the command's.

  **Accumulators, not spans.** The parsers run well over a thousand times per command on a large
  tree, so a span per file per pass would allocate its way into becoming the cost it set out to
  measure. The seam keeps two fixed-size numeric accumulators covering both kinds and emits one
  file per process. When the variable is unset it reads a module-level binding — never
  `process.env`, whose access in Node is a native call — and registers no exit handler at all.

  **The dump carries the parse-cache hit/miss split alongside the counts**, because VAT's parse
  cache short-circuits the parsers entirely on a hit. On a warm tree the honest answer is "every
  document was a cache hit, there is nothing to attribute", and that must never be readable as
  "these passes are free". Sub-phase attribution is a cold-cache measurement. The cache counters
  cover every parser kind, but several call sites reach a parser without consulting the cache at
  all, so the document counts and `cache.misses` are related and not equal — the difference is
  reported as an explicit remainder rather than left to a reader's arithmetic.

  **The dump also carries process wall and CPU time** (`process.wallMs`, `cpuUserMs`,
  `cpuSystemMs`), read once at exit — one syscall, where a per-pass CPU reading would be ~12,000
  and would become the cost it measured. The passes are wall-timed, so a process whose CPU time is
  far below its wall time was waiting rather than computing; the report says so in a sentence when
  the divergence is large instead of printing two numbers for the reader to divide.

- **A population reads and keys each file exactly once, and says what it cost.**
  `@vibe-agent-toolkit/resources` exports `RunContentCache` and `readKeyedContent`: `populate`
  threads a per-run content cache through the builder to every contributor's realization context
  *and* to the blob-derivation stage, so a path realized by several extents is read and SHA-256'd
  once rather than once per extent plus once more to parse. The cache is never a module-level
  singleton — its lifetime is one `ProjectionBuilder`, because two populations of a changed tree
  sharing bytes would describe the wrong corpus with complete confidence.

  **The semantics this fixes in place:** a population describes a single consistent instant — the
  instant each path was first read — rather than re-observing files as later stages reach them. A
  file rewritten or deleted *during* a run is not re-read, so blob derivation's
  `BLOB_CONTENT_CHANGED` and `BLOB_UNREADABLE` conditions do not arise for a path the run already
  read. Both guards remain live for a `populateBlobs` call whose builder carries no cache, where
  the derivation-time read genuinely is a fresh one.

  **A caveat worth knowing before pointing this at a large tree:** the cache holds each keyed
  file's decoded content for the whole run, so peak memory scales with the bytes the extents
  enumerate — not with the tracked corpus. `FilesystemExtentContributor` crawls with
  `respectGitignore: false` by design, so on a project whose build output dwarfs its source that
  is a much larger number than the repository size suggests. Which is what the next entry is for.

  `populate` also accepts `onContributorTiming` (`ContributorTiming` exported), one record per
  contributor invocation carrying the contributor id, its stratum, the fixpoint pass and elapsed
  milliseconds — so a contributor that is cheap once but runs in every pass is distinguishable
  from one that is expensive once, without re-running the corpus with contributor subsets.

- **A population no longer hashes bytes nobody reads, and says so explicitly rather than by
  omission.** `resource_realizations` gains a required **`contentState`** column —
  `keyed` | `deferred` | `unreadable` | `none` — and `PROJECTION_SCHEMA_VERSION` bumps to **3**.
  `contentKey: null` previously meant four unrelated things at once (a directory, an absent path, a
  dangling symlink, a failed read); lazy keying would have added a fifth, *nobody asked yet*, and an
  unreadable file becoming indistinguishable from an unvisited one is precisely the completeness
  failure `zone_provenance.extentDigest` exists to prevent. A schema refinement now pins
  `keyed` ⟺ a non-null key in both directions.

  `FilesystemExtentContributor` crawls with `respectGitignore: false` so that output CI cannot see
  is still representable — and **that argument is satisfied entirely by paths.** It never needed the
  bytes. A gitignored path still gets a row reporting `exists`, `isDirectory` and `gitignored`; only
  the hash is withheld, as `contentState: 'deferred'`. On a project whose build output dwarfs its
  source this is the difference between hashing **1.19 GB and 40.8 MB**. The general rule is not
  "gitignored" — it is *key eagerly where the bytes are already free from the discovery step* — and
  `RealizationContext.contentDemand` (`eager` | `deferred` | `deferGitignored`, defaulting to
  `eager`) is where a contributor declares which it is. Where there is no git repository nothing is
  gitignored, so nothing defers and behaviour is unchanged.

  **What this changes for a reader of the projection:** a deferred realization contributes no blob,
  so its links do not appear in `blob_references` and it is not traversed by the closure stratum
  until something asks for it. `ProjectionBuilder.ensureContentKey(path)` is that ask — it promotes
  every deferred row at a path, reading once through the run cache. The new
  `realizationsContentDeferred` counter is named outside the `realizationsSkipped*` family on
  purpose: a nonzero value is the design working, not a warning.

- **A projection can now say WHERE a refusal came from, not just that one happened.**
  `realization_conditions` gains six columns — `sourcePath`, `sourceLine`, `sourceRef`,
  `targetExists`, `matchedPattern`, `matchedPayload` — and `PROJECTION_SCHEMA_VERSION` bumps to
  **4**. They are the provenance the shipped link walker attaches to an excluded reference
  (`LinkResolution`), so a consumer reading a closure extent's conditions can now raise the same
  issue the walker raises: the file and line to open, the href as authored, whether the target
  existed, and which declared rule turned it away. Null on every condition no reference provoked
  (a path collision, an absent declared root); spread the exported `CONDITION_WITHOUT_REFERENCE`
  at those producers rather than writing six nulls.

  `ExtentRefusalRule` gains an opaque **`payload`**, copied verbatim to
  `realization_conditions.matchedPayload` and never interpreted — the channel for rule vocabulary
  the primitive has no column for. The skill translation now emits **one refusal rule per declared
  `excludeReferencesFromBundle` rule** (same label, declared order, so first-match-wins is
  unchanged) and puts each rule's index and its `template` in that payload, which is what makes
  "which rule matched" answerable at all. Measured against `walkLinkGraph` over this repository's
  real skill corpus: 59 paths refused by both implementations, **0 disagreements on any of the five
  fields**.

### Breaking

- **The crawl-timing seam moved from `@vibe-agent-toolkit/resources` to
  `@vibe-agent-toolkit/utils`.** Every `CRAWL_*` constant, `crawlTimingStart`, `recordCrawlPass`,
  `recordRegistryPass`, `withContributorStratum`, `recordContributorInvocation`, the
  `CrawlStratum` / `CrawlTiming*` types and the `__*ForTest` helpers now import from `utils`; they
  are no longer exported from `resources`. No shim is provided.

  The seam has to bracket `GitTracker.initialize()` — the `git ls-files` spawn both crawlers
  consume — and `GitTracker` lives in `utils`, which may not import `resources`. Bracketing at each
  of the six sites that construct a tracker would have left `@vibe-agent-toolkit/discovery`
  permanently unmeasurable, since it depends on `utils` alone.

  ⚠️ `@vibe-agent-toolkit/utils` therefore declares `"sideEffects": ["./dist/crawl-timing.js"]`
  instead of `false`. That module registers a `process` exit listener when `VAT_CRAWL_TIMING` is
  set, so declaring the package side-effect-free entitled a bundler to drop the dump.

- **`extractClaudeSkillInventory` now takes an options object, and a git tracker source is
  REQUIRED.** The signature moves from
  `(skillMdPath, sharedRegistry?, gitTrackerSource?)` to
  `(skillMdPath, { gitTrackerSource, sharedRegistry? })`. Callers that genuinely want a
  tracker-less walk pass the new exported `NO_GIT_TRACKER`.

  The old optional parameter made "walk without a git tracker" the **silent default**, and the two
  gitignore oracles do not agree: without a tracker the link walker falls back to a
  `git check-ignore` spawn per target, while a projection's `gitignored` column is filled only from
  a tracker it was handed. Requiring the argument does not make those oracles agree — it makes
  choosing between them explicit and greppable instead of something a caller can omit by accident.

- **The same requirement now reaches the plugin, marketplace and install extractors — so
  `vat inventory --user` no longer walks tracker-less.** All three move to options objects with a
  REQUIRED `gitTrackerSource`:
  `extractClaudePluginInventory(pluginPath, { gitTrackerSource, sharedRegistry? })`,
  `extractClaudeMarketplaceInventory(marketplacePath, { gitTrackerSource })` and
  `extractClaudeInstallInventory({ gitTrackerSource, pathsOrRoot? })` (whose install root moves
  from a positional into the options object, because a required member cannot follow an optional
  positional). Pass `NO_GIT_TRACKER` to choose the tracker-less walk.

  Requiring it on the skill extractor alone had left the obligation stopping one call short:
  `extractClaudePluginInventory` coalesced a missing source to `NO_GIT_TRACKER` on its callers'
  behalf, so the `--user` lane — every cached plugin under `~/.claude/plugins/cache`, the largest
  such population in the product — and the marketplace-root lane both walked with the
  `git check-ignore` oracle without either end saying so. That coalesce is gone.

  ⚠️ Behaviour change, not only a signature change: those two lanes now answer gitignore questions
  from a tracker's active set where one is available. The two oracles are demonstrably
  distinguishable, so a skill's `files.linked` can differ — a file created after the tracker's
  `git ls-files` snapshot is *ignored* to the active set and *not ignored* to `git check-ignore`.
  The marketplace extractor deliberately accepts **no** `sharedRegistry`: its plugins each sit in
  their own directory, where one shared registry matches no skill's project root and was measured
  1.5× slower than the N+1 crawl it would replace.

- **The crawl-timing dump format is version 2, and `VAT_CRAWL_TIMING` now charges the link walker
  for building the registry its walk consumes.** No field changed; what a `crawl` total is a total
  *of* did. At version 1 the projection arm was charged for its preparation (`base`) while the
  incumbent arm was charged for traversal only, so the two arms of the side-by-side the seam exists
  to render were not comparable — and the resulting numbers looked perfectly well-formed. Registry
  enumeration, admission and link resolution are now bracketed inside `ResourceRegistry` itself,
  under `resource-registry:*` ids. Version-1 dumps are refused rather than compared.

  `crawlSkillLinkRegistry` — the registry `vat inventory` hands the walker, and the one
  construction route that enumerates *outside* `ResourceRegistry` — now brackets its own
  `crawlDirectory` call and files the same `resource-registry:enumerate` row. Left uncharged it was
  a one-sided under-count: that registry is built for the incumbent and never for the projection.

- **The parse cache is namespaced per build of VAT, and both hand-bumped version constants are
  gone.** `CONTENT_KEY_SCHEMA_VERSION` and `PARSE_CACHE_SCHEMA_VERSION` are removed from
  `@vibe-agent-toolkit/resources`. Entries now live under
  `<tmpdir>/.vat-cache/<namespace>/parse/<shard>/<key>.json`, where `<namespace>` is the package
  version when installed and `<version>-dev-<6 hex>` from a source checkout, the hex covering the
  package path so two worktrees never share a cache. New exports: `vatCacheNamespace()`,
  `vatCacheNamespaceRoot()`. `parquet/` is reserved as a sibling of `parse/` under the same
  namespace.

  A content-addressed cache cannot see a change to the *parser itself*, and the namespace is what
  answers that. **For a source checkout it is answered by a hand-bumped constant, not
  automatically** — the alternative, fingerprinting the emitted parser modules so every rebuild
  re-namespaced, was measured and rejected: it left **65 namespaces holding 267 MB** with nothing
  evicting them, one day's rebuilds alone accounting for ~200 MB of near-duplicate content. So a
  dev cache now survives `tsc --build`, and the cost is that changing what the parser *produces*
  requires bumping the revision constant beside it, or running `vat cache clear`. Installed
  releases are unaffected: the published version already discriminates parser behaviour, and two
  machines on one release still share a namespace.

  Two consequences worth knowing. **Content keys are now stable across VAT versions** — they are
  `<parserKind>.<sha256>` with no version component — so upgrading no longer churns every recorded
  key, and the key-masking machinery in VAT's own pipeline-snapshot test instrument is deleted
  rather than left as dead weight (snapshot `formatVersion` is 2; older snapshots are refused, not
  mis-compared). And the
  external-link and linkAuth caches deliberately stay *outside* the namespace: URL reachability is a
  fact about the world, not about this build, so it survives upgrades.

- **`@vibe-agent-toolkit/resource-compiler`'s `parseMarkdown` is now `toMarkdownResource`.** The
  monorepo exported two functions named `parseMarkdown` with opposite argument domains — this one
  takes markdown *content* and returns a `MarkdownResource` for the type/codegen compiler, while
  `@vibe-agent-toolkit/resources`' takes a *file path* and returns a link `ParseResult`. The latter
  keeps its name, and gained a content-only sibling (`parseMarkdownContent`), which made three
  similarly-named parsers one rename away from a real mix-up. No alias is left behind, per the
  pre-1.0 policy. Consumers importing `parseMarkdown` from `@vibe-agent-toolkit/resource-compiler`
  (or its `/compiler` subpath) must rename the binding; nothing else about the function changed.

- **`@vibe-agent-toolkit/utils` no longer exports `verifyCaseSensitiveFilename`; use
  `fillSiblingNames` + `classifyFilenameCaseFrom`.** Answering "does this file exist at exactly this
  case?" needs one filesystem fact — the target's parent directory listing — and the old helper took
  that listing *per path, at the moment of judgement*. The replacement splits it into a fill pass
  (`fillSiblingNames(filePaths, fsCache)`, which de-duplicates parents and lists them concurrently,
  returning a `SiblingNamesTable`) and a pure judge (`classifyFilenameCaseFrom(table, filePath)`),
  so a caller with many paths lists each directory once, up front, instead of serialising one
  listing behind each previous answer. Removed from both the `.` barrel and the `./fs` subpath, with
  no alias, per the pre-1.0 policy. A single ad-hoc check migrates as
  `classifyFilenameCaseFrom(await fillSiblingNames([p], cache), p)`. Note the judge **throws** when
  handed a table with no row for the path's parent: the fill is meant to be derived from exactly the
  paths about to be judged, and answering a missing row as "unreadable directory" would silently
  report every file under it as absent.

### Added

- **The resource projection is populated, not just declared.** `@vibe-agent-toolkit/resources`
  exports versioned Zod schemas (and generated JSON Schema) for twelve resource-projection tables,
  plus `populate()` — a stratified merge driver that fills them from a real tree. A *zone* is an
  **extent** (which resources exist) plus a **lens** (how they are traversed and resolved);
  visibility falls out of extent, so there is no visibility relation. Extents are data; lenses are
  functions, which is why `edges`, `edge_resolutions` and `lens_entry_points` are deliberately
  **not** materialized here — they are derived per lens.

  Extents come from `ExtentContributor`s, and the contract is deliberately tiny — `contribute(base,
  parameters)` returning rows, with the driver merging them without interpreting:

  ```ts
  export interface ExtentContributor {
    readonly id: string;
    readonly kind: string;
    readonly stratum: ContributorStratum;
    contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution>;
  }
  ```

  Six ship: filesystem, git and package (the acyclic base stratum, one pass) and closure, skill and
  plugin/marketplace (the closure stratum, iterated to a fixed point). The skill extent is the
  evidence the seam is right — it is a pure delegation to the generic closure contributor, with no
  bespoke walker, so a link-graph closure is expressible as *configuration*
  (`closureFrom`/`follow`/`maxDepth`/`exclude`) rather than adopter code.

  Resource identity is `hash(rootId, canonicalPath at first observation)` and deliberately does
  **not** hash the origin zone: a file belongs to several extents at once, so there is no
  precedence to pick, and `vat build` populates twice (dist does not exist pre-build), which would
  otherwise mint two ids in one run. `canonicalPath` uses git-index casing where tracked, else
  on-disk with symlinks resolved. The twelve columns that vary per zone — `contentKey` among them —
  live on `resource_realizations`, because the packager rewrites content into bundles, so a source
  and a dist realization of one resource have different bytes.

  New: `exportProjection()` / `serializeProjection()` emit the projection as a document. Rows out —
  no index, no join, no filter, no query. Every table is sorted by its primary key (one crawl route
  enumerates in filesystem order, which differs across ext4, APFS and NTFS), and `roots.path`, the
  model's only absolute path, is replaced with a placeholder.

- **`isFilesystemAccessError(err)`**, exported from `@vibe-agent-toolkit/utils` and its `./fs` subpath. Answers whether an error is the filesystem refusing a path (`EACCES`, `ENOENT`, `ENOSPC`, …) rather than a bug, which is the question a tool has to answer before deciding to carry on over a tree it does not own. VAT uses it in `vat audit` and in skill packaging so both agree on what counts as the environment's fault.

- **`externalSource` on a marketplace plugin entry** — reference a plugin published in
  *another* marketplace/repo (`github`, `url`, `npm`, or `pip`, matching Claude Code's
  official marketplace source shapes) instead of building one locally. `vat claude plugin
  build` writes the source object straight into `marketplace.json` and never builds or
  copies the referenced plugin's content, so one marketplace can cherry-pick a plugin
  published elsewhere without vendoring it. Set `skills: []` and omit
  `source`/`files`/`exclude`/`changelog` on the entry — the config schema rejects the
  combination otherwise. See "Referencing Another Marketplace's Plugin" in
  `docs/guides/marketplace-distribution.md`.

- **`fillRealpaths(paths, fsCache)` + `realpathFrom(table, path)`** in `@vibe-agent-toolkit/utils` —
  the canonical-path column, a second fill/judge pair alongside `fillSiblingNames` +
  `classifyFilenameCaseFrom`. Link validation asked `fs.realpathSync` twice per *existing* link
  target, at judgement time, inside a synchronous loop: once for the target and once for the
  **run-constant project root**. On this repo's own corpus (770 links over 266 documents) that was
  roughly 1,500 serialised `realpathSync` calls, about half of them re-canonicalizing the same root.
  The column now canonicalizes each distinct path once, concurrently, before judging, and the
  project root is a single row; the judge reads the table and makes no `realpath` call of either
  kind. Output-neutral by design — verified with VAT's pipeline-snapshot oracles, all 12 artifacts
  byte-identical.

  ⚠️ **`FsLookupCache.realpath` now canonicalizes with `promisify(fs.realpath)` rather than
  `fs/promises.realpath`, and the choice is load-bearing.** Node ships two different realpath
  implementations and they do not agree: `fs.realpathSync` and the `fs.realpath` *callback* form run
  Node's own JS lstat/readlink walk, which preserves the casing the caller asked for, while
  `fs/promises.realpath` and `fs.realpath.native` call `uv_fs_realpath`, which reports the casing
  **on disk**. On a case-insensitive filesystem — macOS and Windows — those return different
  strings, so a column filled through the native route would flip containment verdicts against the
  synchronous callers it replaces and report link problems the un-refactored code never reported.
  Anyone who was calling `FsLookupCache.realpath` directly (it had no in-tree callers before this
  change) now gets `realpathSync`-equivalent answers.

- **`FsLookupCache.probe(path)`** in `@vibe-agent-toolkit/utils` — memoizes the `existsSync` +
  `statSync` pair that link-target classification asks per link, so it is asked once per distinct
  target instead. The two syscalls are deduplicated, not collapsed into one: the pair distinguishes
  "absent" from "present but unstattable", and the link-graph walker branches differently on each.
  Exposes `probeStats` (`{ probes, misses }`), and `walkLinkGraph` accepts an optional `pathProbe`
  so callers can read those counters back. Output-neutral by design — verified with VAT's
  pipeline-snapshot oracles (12/12 artifacts identical) and a byte-for-byte diff of the packaged
  skill output.

- **`parseMarkdownContent(content, sizeBytes)` and `parseHtmlContent(content, sizeBytes)`** in
  `@vibe-agent-toolkit/resources` — the content-addressable halves of `parseMarkdown` / `parseHtml`,
  pure functions of their arguments with no filesystem access. The path-taking originals are
  unchanged and now delegate. `sizeBytes` is a parameter rather than derived from `content` because
  the two genuinely differ: the on-disk byte count is the authority, and re-encoding a decoded
  string diverges from it on malformed UTF-8 (each bad byte becomes a 3-byte U+FFFD).

- **Content keys — `computeContentKey()`, `parserKindForPath()`, `readContentWithKey()`** are exported
  from `@vibe-agent-toolkit/resources`. A content key names a parse result by the bytes the parser
  read *and* which parser read them, with no path component, so the same document in two trees shares
  one key. `parserKindForPath()` is now THE markdown-vs-HTML discriminator — `ResourceRegistry` calls
  it rather than repeating the extension test — because parser selection is part of a document's parse
  identity: identical bytes at `x.md` and `x.html` legitimately parse differently, which is realizable
  on the *empty file*. `readContentWithKey(filePath, parserKind)` reads and keys in one step, so a
  caller cannot key one read and parse another, and returns the raw `byteLength` alongside the decoded
  content. Its `parserKind` is a **required argument, deliberately not defaulted to the extension**:
  the key must name the parser that actually runs, and shipped code exists where those differ — the
  LanceDB RAG lane hands every resource, including the `.html` ones the registry crawls, to the
  markdown parser. A defaulted kind would file that lane's markdown facts under the key a genuine
  HTML parse uses, and one lane would be served the other's facts. Callers that really do want the
  extension rule pass `parserKindForPath(filePath)` explicitly.
  `computeContentKey()` takes **raw bytes** (`Uint8Array`), not a decoded string: UTF-8 decoding is
  many-to-one on invalid input, so keying the decoded form gave three distinct files
  (`[c2]`, `[e2 82]`, `[ff]`) one key while `ParseResult.sizeBytes` — a raw byte count that reaches
  rule variables and rewriting templates — differed between them. Mixing in the byte *length* would
  not close it either, since two of those three are the same length.

- **`ResourceRegistry.getDuplicateIdCollisions()`** returns the first-added-wins drops in arrival
  order. `validate()` already reported *that* a collision happened; this reports *which file won*,
  which is the part decided by enumeration order.

- **`LINK_FROM_NON_ROUTABLE_FILE` (`warning`) — a link out of a bundled HTML page that VAT did not follow.** VAT parses HTML, so a bundled `.html` file is a registry *member* whose links get rewritten; it is not *routable* — VAT does not walk through it to pull its own link targets into the bundle. Routing is markdown-only, matching Anthropic's skill guidance. `SKILL.md → guide.html → diagram.svg` therefore bundles the page and drops the diagram, and because the referring page *did* ship, the missing image reads as a link-rewriter bug rather than a deliberate boundary. That drop is now reported instead of silent. Opt out with `severity.LINK_FROM_NON_ROUTABLE_FILE: ignore`. A target that does not exist on disk at all stays `LINK_MISSING_TARGET` — the author's broken link is the more actionable finding.

- **`DuplicateResourceIdError`** is exported from `@vibe-agent-toolkit/resources`, so a caller of `addResource()` can catch a first-added-wins collision **by type**. The one in-tree consumer was matching on `error.message.startsWith('Duplicate resource ID')`, which stops working silently the day the message is reworded.

- **`canCreateSymlinks(dir)`** is exported from `@vibe-agent-toolkit/utils`. Probes whether the host
  permits symlink creation — Windows needs Developer Mode or `SeCreateSymbolicLinkPrivilege`, and the
  privilege cannot be inferred from `process.platform` — so a fixture can say it skipped rather than
  passing silently.

- **`compileFrontmatterSchema()` and `validateCompiledFrontmatter()`** are exported from
  `@vibe-agent-toolkit/resources`, splitting schema compilation from validation. Use them when
  validating many documents against one schema; `validateFrontmatter()` is unchanged and still
  compiles per call.

- **A cross-process parse cache, on by default.** Parsing is 80.4% of `vat resources validate`'s
  library time. Every document VAT parses is now filed under a content key — a hash of the exact
  bytes plus the parser they route to — in `<tmpdir>/.vat-cache/parse/`, and a later run over
  unchanged bytes reconstructs the parse instead of redoing it. Measured over this repo's 265
  tracked markdown files: **1,177 ms cold versus 26 ms warm, a 45× reduction on the parse step**,
  for entries totalling 21% of the corpus size.

  It has to be cross-process rather than an in-memory memo because `vat validate`, `vat verify` and
  `vat build` parse nothing themselves — they spawn the vat binary once per phase, so a per-process
  cache could not help the three commands most worth speeding up.

  Correctness properties worth knowing, because they constrain how it can be changed:

  - **Entries never store the document text.** The key can only be computed by reading the file, so
    the content is always in hand and is re-attached rather than stored. That is where the 21%
    comes from, and it keeps the cache from being a full plaintext copy of a possibly-sensitive
    corpus.
  - **Frontmatter is stored as YAML source, never as the parsed object.** JSON cannot carry `.inf`,
    `.nan` or `!!binary`, and it throws outright on cyclic anchors — those documents would have
    silently never cached. Re-parsing the source is lossless because it is the same call the cold
    path makes.
  - **Every hit returns a freshly deserialized object graph.** Two resources served from one entry
    never share a `links` array. Bundling mutates `resolvedId` on parsed links in place, so a
    shared array would leak one skill's decisions into another's.
  - **Fail-soft covers corruption, not wrongness.** A missing, unreadable, corrupt or
    wrong-schema-version entry is a miss. A well-formed entry filed under a wrong key is not
    something fail-soft can catch, which is why the key rules are strict.

  A cold-versus-warm equivalence test asserts the two runs produce identical metadata **and** that
  the warm run actually hit — verified against a mutant where the cache always misses, which leaves
  a bare equality assertion perfectly green.

- **`parseFileCached(filePath, parserKind, cache?)`** in `@vibe-agent-toolkit/resources` — the cached
  replacement for `parseMarkdown(path)` / `parseHtml(path)`. Those two read the file and hand the
  bytes straight to a parser, so they bypass the cache entirely; every VAT call site that does not go
  through `ResourceRegistry` now uses this instead. Eight of them did: skill packaging, skill and
  packaging validation, the post-build HTML href scan, skill-name discovery, `vat skills package`
  (link collection and dry-run) and the LanceDB indexer. `parseKeyed(keyed, cache)` is the same
  interception one step lower, for a caller that has already read and keyed the bytes.
  `defaultParseCache()` is the process-wide instance used when no cache is supplied. `parseMarkdown`
  and `parseHtml` remain exported and uncached — VAT's own parse-fact oracle uses them
  deliberately, since an oracle that consults the cache cannot verify it.

- **`vat cache clear`** removes VAT's on-disk caches — the parse cache and the external-URL
  validation caches, which share `<tmpdir>/.vat-cache/`. Reports what it removed; exits 0 when
  there is nothing there; works even when caching is disabled, since a no-op in that case would be
  a trap. This is the user-invocable form of "recovery is rescan", which previously had none.

  That directory is shared by every VAT on the machine — other worktrees, other sessions, and any
  adopter running an installed copy — so a clear issued while one of them is mid-run walks a tree
  growing underneath it, and the recursive delete can stop part-way on `ENOTEMPTY`. Short overlaps
  are now absorbed by a bounded retry. A delete that still cannot finish reports **`status:
  partial`** with exit 1, naming which top-level entries went, which survived, why, and the counts
  actually reclaimed — re-read from disk rather than inferred, because the error names one path and
  says nothing about the rest. It previously failed with no account of itself at all, which is the
  worst moment to be silent: most of the cache was already gone.

- **`--no-cache` on the root command** disables VAT's on-disk caches for the run by setting
  `VAT_CACHE=0`. An environment variable rather than a plumbed flag because the commands that need
  it most spawn child processes, and only the environment crosses that boundary. The pre-existing
  `vat resources validate --no-cache` now covers both caches — and now works at all; see Fixed.

### Changed

- **A markdown link whose target exists but cannot be read is now reported instead of silently
  dropped — new `LINK_TARGET_UNREADABLE` code (error).** When `existsSync` found a link target and
  `statSync` then threw anyway (a permissions problem, or a change racing the walk), the skill
  link-graph walker classified it as "skipped": no exclusion, no bundle entry, no finding. The link
  simply vanished, so the report described a corpus with one fewer edge in it than the tree on disk.
  The resources lane has always reported the identical read failure as `RESOURCE_UNREADABLE`; the
  two lanes now give one answer to one situation. Configurable like any other code
  (`validation.severity.LINK_TARGET_UNREADABLE`), and documented in `docs/validation-codes.md`.

- **`vat audit` and `vat inventory` stopped spawning a `git check-ignore` process per link target.**
  The skill link walk asks whether each link target is gitignored. `walkLinkGraph` has always
  accepted a `GitTracker` — which answers that in O(1) from a single `git ls-files` — but the
  inventory extractor was the one call site that never passed one, so it fell back to a subprocess
  per distinct target. Measured on a 1,484-document monorepo: **786 `check-ignore` spawns per
  `vat audit`, 9.2 s of the run**; on a real `~/.claude/plugins` install, 715 spawns. The CLI now
  supplies a tracker source backed by the per-git-root cache the audit lane already builds, so a
  repository is listed once instead of interrogated hundreds of times. Both lanes now spawn **zero**,
  and the whole `vat audit` command over that monorepo goes **12.5 s → 2.5 s (≈5×)** — measured as a
  paired A/B on one tree with only that wiring toggled. Reports are byte-identical across the change
  on both corpora (1,431,451 and 2,788,833 bytes; only the `duration:` line differs).

  **One behavioural caveat, because the two oracles are not equivalent everywhere.** `git ls-files`
  cannot list a path reached through a symlinked ancestor directory, a path inside a git submodule,
  or a path under `.git/`; the active set therefore reports those as *ignored*, where
  `git check-ignore` reports them as *not ignored*. In such a tree a link target of that kind moves
  from bundled to excluded-as-gitignored in `vat inventory`'s reported `files.linked`. No `vat audit`
  finding is computed from that array, and across 766 real skills (this repo's 54 plus 712 installed
  plugin skills) **not one linked set changed**. The three divergent classes are pinned as
  expected-to-differ rows in `git-ignore-oracle-parity.integration.test.ts`, alongside the seven
  classes where the oracles are verified to agree, so the boundary is a test rather than a footnote.

- **A frontmatter link-validation failure is no longer reported as a frontmatter *schema* error.**
  `validateAgainstCollectionSchema` wrapped the schema load, the schema check and the frontmatter
  link walk in one `try` whose `catch` blamed the schema by name, so any throw out of link validation
  surfaced as `FRONTMATTER_SCHEMA_ERROR: Failed to load or parse frontmatter schema '<file>'` —
  once per resource in the collection, against a schema that had loaded and compiled fine, with the
  real cause buried in the tail of the message. The `try` now covers the schema load alone. This
  widens what escapes: an Ajv runtime fault or an error inside link validation now aborts the run
  instead of becoming N findings. That is deliberate — none of them are a defect in the user's
  schema, and reporting them as one sends the reader to edit a file that is not broken.

- **Skill validation and skill-name discovery stopped re-reading files they had just parsed.**
  `validateSkillPackaging` read SKILL.md a second time to count its lines and to feed the
  compatibility detectors, and `readSkillName` read it a second time for its H1 fallback — in both
  cases the parse result already carried the identical raw source. Each now uses `parseResult.content`,
  removing a whole-file read per skill and the window in which the two reads could disagree.

- **`ResourceRegistry.addResource` now reads each file once and stats it once, instead of twice
  each.** Every crawl-based command builds its registry through this method, and it was making four
  filesystem round-trips per document: `parseMarkdown`/`parseHtml` read the file *and* stat'd it, a
  second `stat` supplied `modifiedAt`, and `calculateChecksum` re-read the whole file to hash it. It
  now performs one read and one stat, and derives the parse, the checksum, the byte size and the
  modification time from that single pair.

  **Output is unchanged, deliberately.** `sizeBytes` still comes from `stat().size` — never a byte
  length re-derived from the decoded string, which diverges from the file's real size on malformed
  UTF-8 — and `checksum` is still the SHA-256 of the *decoded* string, which is a different keyspace
  from the raw-byte content key and is user-facing through `vat resources scan --verbose` and
  `getResourcesByChecksum`. Both are now pinned by tests using a deliberately malformed-UTF-8
  fixture, the only condition under which the alternatives are distinguishable.

- **Markdown parsing walks the syntax tree twice per document instead of fifteen times.** Every
  resource-reading command (`vat resources validate`, `vat audit`, `vat skills build`, …) parses the
  project's markdown, and `parseMarkdown` was making seven full `visit()` passes over the tree in
  `link-parser.ts` (definitions, links, link references, definitions *again*, raw HTML, headings,
  frontmatter) plus eight more in `unresolved-references.ts` (seven mask kinds, then definition
  identifiers) — fifteen complete traversals to collect facts that are all available from one. Each
  file is now walked once for the link/heading/anchor/frontmatter facts and once for the
  dangling-reference mask.

  Measured over this repo's 265 tracked markdown files: traversal cost drops from 306 ms to 66 ms
  (−78%), taking whole-corpus `parseMarkdown` from 1,155 ms to 979 ms (−15%). The floor is
  micromark's own tokenization at 864 ms, which this does not touch. **No output change**: link
  ordering (all `link`s, then all `linkReference`s, then all `definition`s), heading slug
  deduplication order, and HTML-anchor emission order are all preserved, verified by diffing the
  complete `ParseResult` of all 265 documents before and after — zero rows differ.

### Security

- **VAT's on-disk cache directory is now created owner-only (`0700`) on POSIX.**
  `<tmpdir>/.vat-cache/` is a world-readable location shared by every user on the host, and it holds
  the set of external URLs a project links to — including private hostnames. The per-OS-user cache
  beside it (`auth-<user>/`) was scoped **by directory name alone**, with no permission backing that
  separation at all. Both `mkdir` sites now pass `mode: 0o700`. On Windows the mode bits reduce to
  the read-only flag, so this is a real mitigation on Linux and macOS and a no-op there; it should
  not be cited as a cross-platform guarantee.

### Fixed

- **`vat-lab parse ab` compared medians, so a single slow repeat read as a real effect.** A facet's
  `estimate` must be "a per-capture reduction already robust to a slow repeat", because `ab` then
  takes a minimum across captures — and a min over medians is not a min. `parse` handed `ab` the
  median repeat it reports whole; it now hands over the fastest, from the `totalMsSamples` the row
  already published, sharing one reduction with `crawl` instead of stating the rule twice. Measured
  on the first real `parse ab`: samples `[9381.952, 9085.774, 9258.195]` reduced to `9258.195`
  rather than `9085.774`, injecting **+172.4ms (1.9%)** — about 1.8× that run's noise floor — into
  every capture. **`parse ab` deltas from before this change carry that error**; `parse run` output
  and every per-pass breakdown are unaffected, since those always came from one real repeat.

- **`excludeReferencesFromBundle`'s `patterns` were documented against the wrong root.** Both schema
  copies — `ExcludeReferenceRuleSchema` in `@vibe-agent-toolkit/resources` and the `vat.skills`
  package metadata in `@vibe-agent-toolkit/schema` — described the globs as "relative to skill
  root". They are matched against the **project** root: `walk-link-graph.ts` compares
  `safePath.relative(options.projectRoot, targetPath)` and the packager passes the project root. A
  pattern written against the skill root silently matches nothing, which is the worst failure shape
  for an exclusion rule — the file is bundled and no error is raised. Documentation only; matching
  behaviour is unchanged.

- **`vat skills build` no longer dies on a `files:` glob that matches a symlink to a directory.** The build failed with a raw `ENOTSUP` that named neither the `files:` entry nor the path — and on macOS it renders as "operation not supported on socket", describing the object as something it is not. Anything a glob matches that cannot be packaged (a symlink to a directory, a dangling symlink, a FIFO, a socket, a device node) is now skipped and reported as **`FILES_GLOB_SKIPPED_NON_REGULAR_FILE`** (`warning`), and the rest of the entry ships. `vat skills validate` and `vat audit` report it before a build too.

  **A symlink to a regular file is still copied by content** — that case is unchanged.

- **A `files:` entry that cannot be copied now tells you which entry it was.** Any failure copying a declared file — it cannot be read, the output directory is not writable, the disk is full — used to surface as a bare OS error naming a path and nothing else, leaving you to work out which line of your config produced it. The message now names the `files:` entry, the resolved path, the OS reason, and what to check. This covers glob and explicit entries in `skills.config.<name>.files`, on the read and the write side, and the `integrity:` verification that follows a copy. The plugin lane (`claude.marketplaces.<mp>.plugins[].files`) is a separate copier and is **not** covered yet.

  These still fail the build rather than shipping a partial bundle, deliberately: you declared the file and expect it in the artifact, so quietly shipping without it would change what you publish.

- **An unreadable or unwritable linked file now tells you which file and what to check, on the most-travelled copy path in `vat skills build`.** Every ordinary markdown-linked asset — not a `files:` entry, just a link a skill's docs point to — used to surface a bare OS error (`EACCES: permission denied, open '/abs/path'`) with no skill named and no remedy, whether the failure hit while collecting the file's own links, while reading it to copy or rewrite it, or while writing the rewritten result (or an unlinked passthrough copy) into the bundle. All of these now report the project-relative path, what was being attempted, and what to check.

- **`vat audit` no longer aborts when its own config cannot be read.** A config file it could not open or parse ended the command with `status: error` and no report — after the scan had already run and collected every finding, and over a file whose only job is deciding which findings to *hide*. It now reports what it found, warns on stderr that the config could not be read, and applies no severity overrides. **What to do:** if you see that warning, fix the config — your `validation.severity` settings are not being applied until you do.

- **`vat audit` no longer throws away every finding when it hits one unreadable file or directory.** A single path it could not read — most likely a root-owned or quarantined entry under `~/.claude/plugins` — ended the whole run with `status: error`, exit code 2, and **zero findings**, including everything already collected from parts of the tree that scanned fine. This hit `vat audit --user` hardest, where sudo-installed and quarantined files are normal.

  The scan now continues past the path it could not read, keeps every other finding, and reports the gap as **`SCAN_PATH_UNREADABLE`** (`warning`) naming the path and the OS message. Exit code is no longer 2 for this, so a run that previously died now reports what it found.

  **What to do:** nothing required. Fix the path's permissions to scan it, or pass `--exclude` to skip it deliberately.


- **`vat` now runs the version your lockfile pinned when you install with pnpm.** It was silently
  running a different one. The wrapper looked for a locally installed CLI at a single hardcoded path
  that only exists in npm's flat `node_modules` layout; under pnpm that path is absent, so the
  lookup failed and `vat` quietly fell back to whichever globally installed copy it could find — no
  warning, and the version it printed looked plausible. If you adopted VAT through the umbrella
  `vibe-agent-toolkit` package, this affected you on every invocation.

  Resolution now goes through Node's own module resolver, which works across npm, bun, pnpm and yarn
  PnP. **What to do:** nothing. If you are on pnpm, check that `vat --version` now matches your
  lockfile — it may change, because it was previously wrong.

- **`vat verify`, `vat build`, `vat validate`, and `vat skills validate`/`build` pointed a
  no-path-scope refusal at `vat audit <path>`, which exits 0 unconditionally — including when
  it reports `status: error`.** An operator who followed the recommended fallback to inspect a
  single skill or bundle got a command whose exit code carries no pass/fail signal at all.
  All five now point at `vat skill review <path>`, whose exit code is 1 iff status is
  `warning` or `error` by construction.

- **A markdown document that declares the same reference-definition label twice resolved every
  `[ref][label]` to the LAST declaration; CommonMark resolves it to the FIRST.** `[dup]: ./a.md`
  followed by `[dup]: ./b.md` made VAT report `./b.md` for every `[ref][dup]`, while every renderer
  links to `./a.md` — so link validation was checking a target the reader never actually visits.
  Fixed with first-write-wins resolution in the link parser.

- **A link to a file whose name carries an accent was reported broken even though the file was right
  there.** The same visible filename has two Unicode encodings — precomposed `é` (NFC) and
  decomposed `e` + combining acute (NFD) — and the two sides of every filename comparison come from
  different places: `readdir` and `git ls-files` hand back whatever form is on disk (commonly
  decomposed on macOS), while a link href carries whatever an editor typed (almost always composed).
  Nothing reconciled them, so three lookups in the link pipeline missed on files that plainly exist:
  the parent-directory listing check emitted `LINK_BROKEN_FILE`; the registry's path index withheld
  `resolvedId`, which strips the href during packaging and fails the build with
  `PACKAGED_UNREFERENCED_FILE`; and the fragment index silently skipped anchor checking. All three
  now key on NFC via the new `toNfc()` helper (`@vibe-agent-toolkit/utils/path`). Paths handed to
  the filesystem are deliberately left alone — on Linux the normalized form of a decomposed filename
  names no file at all. Because folding can paper over a genuine cross-platform break — the link
  resolves only after normalizing, which macOS/APFS and Windows tolerate but Linux/ext4 does not —
  a fold-only match (not byte-identical) now also emits the new **`LINK_NORMALIZATION_MISMATCH`**
  (`warning`), naming both spellings and recommending the file and link both move to NFC. A
  byte-identical match is unaffected.

- **`--debug` produced no debug output from any command, and an unexpected failure printed no stack
  under it either.** `--debug` is declared on the root program *and* on 47 subcommands; Commander
  resolves the root's definition first, so every command's action ran with `options.debug`
  undefined and all 74 `logger.debug(...)` sites in the CLI were unreachable through the flag they
  document — wherever it sat on the command line. Measured on `vat resources scan <dir> --debug`:
  one `[DEBUG]` line before the fix (written by the launcher straight from `process.argv`, which is
  why the existing test could not fail), five after. Separately, the exit-2 envelope — the
  *unexpected* failure — carried `error.message` alone, so an internal `TypeError` reached users as
  a single line with no file and no frames, and a thrown non-`Error` was flattened to the literal
  string `Unknown error`. The root value is now copied to the dispatched command, and exit-2
  failures write the stack (or an inspected rendering of a non-`Error`) to the debug channel.
  Output without `--debug` is unchanged.

- **A merely *broken* root-absolute link was reported as *escaping the project* whenever the project
  root reaches the filesystem through a symlink** — macOS `/tmp → /private/tmp`, a bind mount, a
  checkout under a symlinked path. Canonicalizing a path that does not exist fell back to a lexical
  resolve, which keeps the link's spelling, while the root gained the symlink's target from a
  successful `realpath` — so the two sides were compared in different namespaces and a missing file
  under the root read as outside it. A non-existent path is now canonicalized from its deepest
  *existing* ancestor, with the missing remainder re-appended, in both the live-syscall form and the
  pre-filled column that the link judge reads (these are documented as answering byte for byte
  identically, and now do again). Containment is not widened: a missing file behind a directory
  symlink that leaves the root is still outside, because the ancestor the walk lands on is that
  escaping link. Adopters on such a layout will see `/docs/gone.md`-style links change from a
  traversal error to the correct "file not found".

- **`directFileCount` counted link *occurrences*, not files, and could exceed the bundle's own file
  count.** `getResolvedMarkdownLinks` walked `parseResult.links` — one entry per occurrence — and
  probed each one, so a skill whose routing table pointed 14 rows at the same document contributed
  14 "direct files". A skill in this repo reported `{ fileCount: 9, directFileCount: 41 }`. The
  packaging validator now collapses to distinct targets before resolving, preserving first-seen
  order. The existing `directFileCount <= fileCount` assertion had been passing over the violation
  because its fixture links three *distinct* files and so could not distinguish the two answers.

- **Repeated filesystem probes across `vat audit`.** Four call sites asked the OS the same question
  many times in one run; measured on this repo, `vat audit .` drops from 5,505 to 5,373 Node `fs`
  calls. `gitFindRoot` now memoizes its walk, seeding every ancestor it climbs and caching the
  negative answer (89 `existsSync` → 21); `resetProjectRootCaches()` clears it, so there is still
  exactly one public reset. Plugin extraction walks the tree once matching a list of filenames
  instead of once per filename (`readdir` 35 → 19). The packaging validator resolves declared
  test-input directories once per skill rather than twice (a term quadratic in project skill count),
  and the implicit-eval-suite probe is memoized per resolution call (`existsSync` 14 → 2). No
  behaviour changes: link resolution order, crawl order and audit output are unchanged.

- **Three CLI options were silently doing nothing.** Commander represents `--no-x` as the *positive*
  key `x` (true by default, false when the flag is passed) and camelCases every long name — it never
  produces `noX`, and never a kebab-case key. Three option reads asked for keys Commander never
  emits, so the flags parsed, appeared in `--help`, and had no effect:

  - **`vat resources validate --no-cache`** read `options.noCache`. The external-URL cache was never
    disabled. It now is — and it now covers the parse cache too (see Added). This one shipped
    non-functional in **every stable release from `0.1.35` through `0.1.42`**, so if you have been
    passing it to force fresh link checks, you have been reading cached results for eight releases;
    expect your first run after upgrading to surface external-link failures that stale cache entries
    were masking. That is the fix working, not a new regression.
  - **`vat skills package --no-rewrite-links`** read `options['no-rewrite-links']`, so relative links
    in copied files were **always** rewritten. ⚠️ Behaviour change: a user who passed this flag as
    documented was getting rewritten links, and their packaged output will now differ.
  - **`vat skills package -b, --base-path <path>`** read `options['base-path']`, so the base always
    fell back to `dirname(SKILL.md)`. ⚠️ Behaviour change with the widest reach of the three: the
    flag now feeds link resolution, the relative paths listed in a dry run, **and** the `rootDir`
    passed to `validateSkill` — so a package run that validated clean against the implicit base may
    now surface findings against an explicit one. That is what the flag has always documented.

  The root cause was the option *interfaces*, which declared `'no-rewrite-links'?: boolean` and
  `'base-path'?: string` — so TypeScript validated the broken reads against a type that itself
  encoded the wrong shape. The interfaces now declare the keys Commander really emits, which makes
  the compiler catch this class instead of endorsing it. All 88 declared options were audited; no
  other instances were found.

- **`crawlDirectory({ followSymlinks: true })` no longer enumerates a file once per symlink level.**
  The recursive walk kept no record of which directories it had entered, so a directory symlink
  pointing at its own ancestor (`a/loop -> a`) returned `a/note.md` **sixteen times** under sixteen
  distinct paths — one per nesting depth. It did not hang: the walk ended when the *kernel* refused
  to resolve further links, a limit that is 32 on macOS and 40 on Linux, so **the resulting file
  count was a property of the operating system**. It ended inside the `catch` that exists to skip
  broken symlinks, so nothing was reported. Two directory symlinks pointing at the same directory
  produced the same duplication with no cycle involved at all.

  The walk now keeps a set of visited real paths (`realpathSync.native`, so two names for one
  directory collide) and enters each directory once. The set is maintained **only** when
  `followSymlinks` is true, so the default path performs no additional `realpath` calls and its
  behaviour is byte-for-byte unchanged. No VAT command sets the flag today, so nothing shipped was
  affected — but `crawlDirectory` is a published export, and this had to be sound before the two
  crawl routes can be converged on symlink handling.

- **A file that cannot be read no longer kills the command.** `vat resources scan`/`validate` and
  `vat audit` terminated with a raw `ENOENT` stack trace when the crawl handed them a file they
  could not open — reachable from a plain `git clone`, because a committed dangling `*.md` symlink
  is returned by `git ls-files` as an ordinary mode-120000 entry. The read failure is now recorded
  and reported as the new **`RESOURCE_UNREADABLE`** (`error`), naming the file and stating that it
  was skipped. **This is a population change:** the file is enumerated but not admitted, so it is
  absent from `filesScanned`, link totals and bundle contents — previously nothing was absent
  because nothing completed. Only recognized filesystem errno codes (`ENOENT`, `EACCES`, `ELOOP`,
  `EISDIR`, …) are demoted to findings; a parse or indexing defect still throws, so a bug in VAT
  cannot disguise itself as a per-file warning. Set `severity.RESOURCE_UNREADABLE` to `warning` for
  corpora expected to contain unresolvable entries. `ResourceRegistry.getUnreadableResources()`
  returns the raw log for callers reconciling enumerated-against-admitted.

- **`vat audit` and post-build validation no longer expect files that `vat skills build` never
  ships.** The two lanes disagreed about whether HTML is traversable. Audit's registry includes
  `.html`/`.htm`, and the link walker treated *any* registry member as a door — so on
  `SKILL.md → page.html → notes.md`, audit walked through the page and counted `notes.md` as
  bundled, while the build treated the page as a leaf asset and shipped no `notes.md` at all.
  Audit reported a bundle that did not exist. Routability is now a property of the file rather
  than a side effect of which globs a registry happened to crawl: markdown is routable, HTML is
  not, in every lane. Links out of a bundled HTML page that no other route bundles are reported
  as the new `LINK_FROM_NON_ROUTABLE_FILE` rather than silently disappearing, and the walker's
  `excludedReferences` gain a matching `non-routable-source` reason instead of being mislabelled
  `depth-exceeded`. **Widening a registry's include globs no longer widens what the walker
  follows** — the two are now independent.

- **The verbatim-copy warning named a cause that cannot happen.** When a bundled file misses the
  resource registry it is copied with its links unrewritten, and the warning attributed that to
  "typically an ID collision with a same-named markdown file". Resource ids carry the extension
  (`page.md` → `page-md`, `page.html` → `page-html`), so a same-named markdown file never
  collides — the reachable collision is a *path-slug* one, where `a-b/c.html` and `a/b-c.html`
  both flatten to `a-b-c-html`. The warning now looks the collision up instead of guessing, and
  names the file that actually holds the id, so there is a real path to open. When no collision
  is recorded it states the observed fact and asserts no cause. Two code comments carrying the
  same impossible example (`config.yaml` + `config.md` → `resources-config`) were corrected.

- **Collection frontmatter schemas are compiled once per validation run, not once per resource.**
  Every resource belonging to a collection re-read its schema file, re-parsed the JSON, constructed a
  fresh Ajv instance and recompiled the schema — on a repository with 129 collection-bearing
  resources and 2 distinct schemas, that was 129 compilations of the same two schemas. Compiled
  validators are now memoized for the span of one run, keyed on validation mode plus the *resolved*
  schema path, so two collections naming one schema by different specifiers (a relative path and an
  npm bare specifier) share a validator. On a ~1,100-document repository `ResourceRegistry.validate()`
  drops from **668 ms to 168 ms**; measured over the schema-bearing collections alone, 655 ms to
  94 ms. The cache is discarded when the run returns, so a schema edited between runs is picked up.
  Reported issues are unchanged, including the wording of schema-load failures.

- **A tracked file with a non-ASCII filename vanished from every git-aware command, and was
  separately misreported as gitignored.** `gitLsFiles` ran `git ls-files` without `-z`, so git's
  default path-quoting wrapped any non-ASCII filename in a quoted, octal-escaped string (`café.md`
  came back as `"caf\303\251.md"`) instead of the real name — every exact-match consumer missed it
  outright. `GitTracker`'s O(1) gitignore oracle is built from that same output, so the same file was
  also misclassified as ignored. Fixed by adding `-z` and splitting on NUL, the idiom this repo's own
  build tooling already uses.

- **Two published ESLint autofixers could rewrite or delete code that had nothing to do with
  `node:path`.** The `no-path-join`/`no-path-resolve`/`no-path-relative` repair leg (recovering a
  half-migrated file after a partial `--fix`) and the shared dead-import cleanup those rules and
  `no-manual-path-normalize` rely on both used "is `safePath` bound anywhere in this file" as a proxy
  for "did THIS rule's own rewrite just orphan this import / consume this call." A coincidence — a
  sibling function's migration elsewhere in the same file, or a same-named ambient-global function
  ESLint's scope analysis cannot see (`declare global`, a bundler shim) — was enough to arm either
  rule against unrelated code, silently redirecting a call to VAT's `safePath` or deleting an
  always-dead, unrelated import with a false "this rule's autofix orphaned it" message. Both are now
  gated on positive, per-declaration evidence that this rule's own replacement actually runs in the
  file. A narrow residual remains — a file with two same-module imports where one was already fully
  dead before this rule pack ever touched it can still be deleted with an inaccurate message — but it
  can only produce a redundant, harmless deletion, never a rewrite to the wrong function.

- **`prefer-startswith-over-regex` missed some patterns ending in an escaped backslash before an
  anchor, and `no-manual-path-normalize` could autofix a literal two-backslash split to
  `toForwardSlash()` — not equivalent, and a behavior change.** The first judged whether a trailing
  `$` was an anchor or an escaped literal dollar sign by checking only the pattern's last two
  characters, which misreads `/\\$/` (an escaped backslash followed by a genuine anchor) as the
  reverse. The second treated `.split('\\')` (one backslash, `path.sep`-equivalent, safe to rewrite)
  and `.split('\\\\')` (a literal two-backslash sequence — a different, rarer operation) as the same
  case. Fixed with a proper trailing-backslash-parity count, and by dropping the two-backslash case
  from what the rule treats as safe to autofix.

## [0.1.42] - 2026-08-08

### Breaking

- **`@vibe-agent-toolkit/utils/fs` no longer re-exports the pure path-string helpers.** Seven
  symbols moved from `./fs` to the new `./path` entry: `safePath`, `toForwardSlash`,
  `isAbsolutePath`, `isAbsoluteAnyPlatform`, `hasParentTraversalSegment`, `toAbsolutePath`, and
  `getRelativePath`. `./fs` was a published subpath before this release and went from 14 exports to
  7; anything importing one of those seven from `@vibe-agent-toolkit/utils/fs` must change the
  specifier to `@vibe-agent-toolkit/utils/path`. The two entries are disjoint by design — `./fs` now
  holds only the helpers that genuinely touch `node:fs`/`node:os`/`node:url`, which is what lets
  `./path` reach `node:path` and nothing else. **The `.` barrel is unaffected**: it still exports all
  seven, so consumers importing from `@vibe-agent-toolkit/utils` need no edit. Permitted under the
  pre-1.0 policy; called out here because a silently narrowed published subpath is not.

  A new guard test enumerates the `.` barrel's full export set, so a future removal from *it* cannot
  ship unremarked the way this one nearly did.

- **`verifyCaseSensitiveFilename(filePath)` now requires a second argument: `verifyCaseSensitiveFilename(filePath, fsCache)`.**
  Library-only API break — no CLI behaviour changes. Answering the question needs a listing of the
  target's parent directory, and it was doing an uncached `readdir` per call: measured at 9,963
  `readdir` calls validating a 3,437-document tree, and 7,443 on a 1,132-document monorepo, over a
  few hundred distinct directories. The listing now comes from a caller-supplied `FsLookupCache`
  (new, exported from `@vibe-agent-toolkit/utils/fs` and the `.` barrel), which memoizes `readdir`
  and `realpath` and shares in-flight promises so concurrent callers collapse to one syscall.
  **What to do:** construct one `new FsLookupCache()` per validation run and pass it to every call
  in that run. `verifyCaseSensitiveFilename(p, new FsLookupCache())` at each call site reproduces
  the old behaviour exactly if you want a mechanical migration first. The cache is deliberately
  instance-based, never a module singleton — it holds a *snapshot* of directory contents, so a
  watch-mode or server process must let each run have its own and drop it afterwards. The parameter
  is required rather than defaulted for the same reason: a default lets an unmigrated call site keep
  the un-memoized path silently, which is a no-op wearing the shape of a fix.

  `ValidateLinkOptions` in `@vibe-agent-toolkit/resources` gains a matching **required** `fsCache`
  field, so anything constructing that options object must supply the run's cache.

- **The vestigial `zod` peerDependency is gone from `@vibe-agent-toolkit/utils`.** It was a
  *required* peer, so anyone importing only `./path` was still told by their package manager to
  install `zod`. The package imports `zod` nowhere: all six occurrences of `from 'zod'` in the
  shipped `dist` are inside JSDoc `@example` blocks, and the version-introspection helpers
  deliberately duck-type `_def.typeName` rather than importing the library — which is exactly what
  makes them work across v3 and v4. The declared range (`^3.25.0 || ^4.0.0`) would additionally have
  rejected a future major that the duck typing handles by design. `zod` remains a devDependency, so
  the test that exercises the introspection against a real `zod` is unaffected.

  **Listed as breaking, not merely removed**, because of who it breaks: not anyone importing from
  `utils`, but a consumer that was relying on this package to pull `zod` into *their* tree and now
  finds it absent. If you import `zod` yourself, declare it yourself. (Reported twice by an adopter
  who went looking for this under Breaking and did not find it — it was filed under Added, beside
  the subpath work that prompted it.)

### Added

- **A `@vibe-agent-toolkit/utils/eslint` subpath — 21 ESLint rules that enforce the safety helpers
  in the rest of the package.** The helpers exist because `path.join()`, `os.tmpdir()`,
  `fs.realpathSync()`, `child_process.execSync()` and `await import(absolutePath)` each have a
  platform pothole; until now nothing stopped a call to the raw primitive, so the API shipped
  without its enforcement. The rules were maintained privately in this repo and had never been
  installable. Most auto-fix, and every message names the replacement and the `utils` subpath it
  lives on.

  ```js
  // eslint.config.js
  import vat from '@vibe-agent-toolkit/utils/eslint';
  export default [vat.configs.recommended];
  ```

  `configs.recommended` registers the rules under the `@vibe-agent-toolkit` namespace and enables
  the cross-platform safety core — 18 of the 21 rules, `error` except three at `warn`
  (`no-path-join`, `no-path-resolve`, `no-path-relative`), the ones whose first run on an existing
  codebase produces a migration rather than a bug list — measured at 4,336 findings on a
  4,670-file tree, **all autofixable**. Three rules ship without riding in `recommended`:
  `require-justified-skip` and `no-test-scoped-functions` encode a position on *test style* rather
  than a portability fact, and `no-unsafe-root-join` is held back on correctness — it keys on
  whether an identifier's name ends in `root` rather than on taint, so it fires on all-literal
  calls and stays silent on `safePath.join(base, userInput)`, the shape it exists to catch. All
  three are enabled by naming them.

  **`--fix` writes the import to the narrow subpath that owns the helper**, matching the rule
  table: `path.join()` becomes `safePath.join()` imported from `@vibe-agent-toolkit/utils/path`,
  the `fs` rules point at `./fs`, and `no-child-process-execSync` at `./process`. A file that
  already reaches the helper through the `.` barrel keeps its existing import and only has the
  call rewritten — a second binding of the same name would be `SyntaxError: Identifier 'safePath'
  has already been declared`, so the fixer checks whether the name is bound at all rather than
  whether it was imported from the module the fixer prefers. That check is scope-based, so a
  top-level `const safePath = …` is a conflict too.

  **A per-rule `safeModule` option redirects both the fix and the message at your own re-export
  seam** — `['error', { safeModule: '@acme/dev-tools/paths' }]`. Necessary because in a workspace
  with isolated `node_modules` an import of an undeclared package does not degrade, it fails to
  resolve: an adopter measured that the defaults would write a specifier resolving in **0 of their
  top 25 affected packages** while their own seam resolved in 24 — 620 files across 52 packages
  that declare no dependency on this one. Per-rule rather than a single shared key because a seam
  need not split its symbols the way this package does (theirs carried `normalizedTmpdir()` but not
  `safePath`, so the `fs` and `path` families needed different targets). Every rule that names a
  module accepts it, including the six that only advise and never fix, so configured advice never
  points at a module you don't use.

  Rules take an `exemptFiles`
  option naming the file(s) allowed to call the banned primitive — the one that implements your
  wrapper. There are deliberately **no** built-in exemptions: those paths are a claim about one
  repo's layout, and matching is anchored at a path segment, so declaring `src/paths.ts` never
  exempts `tools/hooks/paths.ts`. An entry with no `/` at all is reported as
  `unanchoredExemptFile` rather than accepted: because ESLint reports absolute filenames, a bare
  `paths.ts` exempts every file of that name anywhere in the tree, including ones added later.
  Requires ESLint 9+ (flat config) and Node >= 22. Full rule table
  in [the subpath's README](https://github.com/jdutton/vibe-agent-toolkit/blob/main/packages/utils/eslint/README.md).

  `--fix` is safe to run across a whole migration: every rule that rewrites a call and edits
  imports fixes all of a file's call sites without leaving a reference to something it just
  un-imported, never deletes a `type`-only, aliased or re-exported specifier, and leaves a
  suppressed call site working. Enforced by a suite that runs `--fix` to its fixpoint per rule and
  checks the result with `no-undef`.

  It also **finishes the job**, which matters in a repo gating at `--max-warnings=0`. Rewriting the
  last `path.*` call in a file leaves `import path from 'node:path'` bound to nothing — not a
  dangling reference, so a `no-undef` check cannot see it, and an adopter measured **536 such errors
  surviving a converged `--fix` across 232 files**. The rules now report that orphaned binding
  themselves, as a separate finding on the import line with its own fix, so it is visible and
  suppressible rather than a rewrite quietly deleting a declaration. Deliberately narrow: a closed
  list of Node builtins (`node:path`, `node:os`, `node:fs`, `node:fs/promises`,
  `node:child_process`, and their bare spellings), only in a file where the safe symbol is already
  bound, only whole declarations with no references left. Bare `import 'node:path'` side-effect
  imports, `type` specifiers and partially-used declarations are left alone. This is not a general
  unused-import rule and will not become one — the ecosystem's rules abstain here for good reason,
  and in any case cannot help: `@typescript-eslint/no-unused-vars` declares `meta.fixable: 'code'`
  yet emits only a *suggestion* for an unused import, which `--fix` never applies.

  The member-call rules (`no-os-tmpdir` and friends) check the receiver rather than the method name,
  and now recognise a namespace bound by `const os = require('node:os')` or
  `const os = await import('node:os')` as well as by a static `import * as os`. An unrelated object
  with a same-named method is still not a finding.

  **There is no separate plugin package to install**, and `eslint` is declared as an *optional* peer
  dependency, so nothing changes for consumers who take `utils` for `safePath.join()` alone: they
  get no unmet-peer warning and no new dependency. An ESLint plugin is data rather than code that
  runs — the rule modules export plain objects and never `require('eslint')` — so this entry
  reaches no Node builtin and no third-party package, and the other twelve subpaths keep resolving
  in a tree with no ESLint anywhere in it. The cost is bytes on disk and nothing else: the packed
  tarball goes 148,953 → 187,753 bytes (+38,800 compressed; 135,381 unpacked across 27 `.cjs`
  files, a README and a type declaration) for code nothing loads unless you lint. Both endpoints
  are measured in the same tree, by packing with and without the `eslint` entry in `files`, so the
  delta is the subpath's cost and not the drift of a `dist/` built months apart. What it buys is
  one install, one version, and no way for a rule to name a helper signature the installed `utils`
  no longer has.

- **`@vibe-agent-toolkit/utils` is now a first-class public package with narrow subpath exports.**
  The `exports` map goes from 3 keys to 15: `./path`, `./fs`, `./process`, `./git`, `./glob`,
  `./zod`, `./yaml`, `./template`, `./testing`, `./asset`, `./crawl`, `./project`, `./eslint`
  (see below), and `./package.json`, plus the `.` barrel. `./project` carries `findProjectRoot`,
  `findConfigFile`, `findNodeWorkspaceRoot` and `resetProjectRootCaches` — functions whose own code
  imports nothing but `node:fs` and `node:path`, so reaching them no longer requires the `.` barrel
  and its five third-party dependencies. They remain VAT-shaped (`findProjectRoot` looks for
  `vibe-agent-toolkit.config.yaml`, then `.git/`), which the README says plainly; the entry exists
  so that finding out costs nothing. Projects
  building skills with VAT write Node code that has to run on Windows, macOS, and Linux, and hit the
  same platform potholes VAT does — `.cmd` shims needing a shell, `tmpdir()` returning 8.3 short
  paths, backslash-vs-forward-slash comparisons, `await import()` of an absolute path failing on
  Windows. Those primitives are now importable without taking the whole toolkit. The `.` barrel's
  export set is unchanged, so consumers importing from it need no edit — consumers of the
  pre-existing `./fs` subpath do; see **Breaking** above.

  The narrow entries are narrow in their *dependency graph*, not merely in name: `./path` and
  `./glob` reach only `node:path`, never `node:fs`, `node:os`, or `node:url`. A guard test walks
  each entry's transitive source graph and asserts both its `node:` builtin set and its third-party
  set, so the README's "resolves with zero deps installed" column is enforced rather than
  documented. It fails loudly when it cannot resolve a module, so it cannot pass vacuously, and a
  fixture with a dangling import exercises that failure.

  This is **not** a bundle-size change: the package has set `"sideEffects": false` since 0.1.40, and
  a tree-shaking bundler already dropped unused code from the barrel. What subpaths control is what
  a build must *resolve* and what a module graph *reaches* — the barrel reaches `yaml`, `handlebars`,
  and `node:fs` regardless of what you destructure, so it cannot be bundled for a browser target and
  requires every dependency installed.

- **`@vibe-agent-toolkit/utils/process` now exports the Windows spawn safety it was missing.**
  `spawnHardened` (async spawn with correct `.cmd`/`.bat` launching), `shouldUseShell`,
  `windowsShellQuote`, and `buildWindowsShellLine` were reachable only through the `.` barrel, so the
  one subpath meant to make command execution safe on Windows covered synchronous exec only.

- **`engines: { node: ">=22.0.0" }` on all 21 published packages.** Exactly one of the 21 declared a
  Node floor before this release, so an adopter installing on an older Node got no install-time
  signal from any of the other 20 — they simply failed later, at a syntax or API error, with nothing
  pointing at the Node version.

- **A `./crawl` subpath**, promoting `crawlDirectory`/`crawlDirectorySync` and the crawl-exclusion
  glob constants. It is deliberately kept out of `./glob`: it is the only subpath that
  reaches `picomatch` (linkAuth's host matching reaches it too, but only from the `.` barrel), and
  folding it in would break `./glob`'s guarantee of reaching nothing but `node:path` and no
  third-party package at all.

  A `./project` subpath (`findProjectRoot`, `findConfigFile`, `findNodeWorkspaceRoot`,
  `resetProjectRootCaches`) was prototyped and **deliberately dropped before release**. Validated
  against the package's primary real-world consumer, its four exports had zero replaceable call
  sites: `findNodeWorkspaceRoot` needs a `package.json` carrying a `"workspaces"` key and returned
  `null` from every directory in that pnpm workspace; `findConfigFile` hardcodes VAT's config
  filename; and `findProjectRoot`'s config-then-`.git` ladder contradicted all six of that repo's
  own marker walk-ups — one of them a published runtime package, where keying on `.git/` would be a
  bug, since it is absent at install time. The two sites that genuinely wanted a `.git` walk-up are
  served by `gitFindRoot` on `./git`. All four functions remain on the `.` barrel, where VAT's own
  internals use them; only the narrow entry is gone.

- **`PLUGIN_TOPLEVEL_BIN_DIR` — surface a top-level `bin/` in a published plugin (`warning`).** `bin/` and `scripts/` mean different things: Anthropic documents `bin/` as *"Executables added to the Bash tool's `PATH`… invokable as bare commands"*, while `scripts/` is the conventional home for helper scripts invoked by path. A plugin whose executables are only ever invoked by explicit path is using `bin/` without using what `bin/` provides — and a claude.ai-hosted marketplace sync has been **observed** to skip a plugin containing one, silently: the publish succeeds and the plugin simply never appears, surfacing only on the org admin console. VAT now names the shape at audit time so it is visible in the publishing repo. **Advisory only** — `bin/` is a supported, documented CLI feature, VAT has a single undocumented observation of the hosted rejection, and per [validation-rule-design.md](docs/validation-rule-design.md) that is not grounds for a build-blocking error. It is deliberately *not* escalated by strict marketplace validation, and a test pins that. Opt out with `severity.PLUGIN_TOPLEVEL_BIN_DIR: ignore` or a scoped `validation.allow` entry.
- **`docs/contributing/plugin-distribution-findings.md` — a running evidence log behind VAT's plugin-shape rules.** [validation-rule-design.md](docs/validation-rule-design.md) requires evidence to justify a rule's severity; this is where that evidence now lives, so a `warning` shipped on one observation stays distinguishable from a `warning` shipped on principle, and can be promoted (or dropped) when evidence changes. Entries carry an explicit **DOCUMENTED / OBSERVED (n=) / INFERRED** label. Also names the *silent hosted-sync divergence* failure class — publish succeeds, plugin never appears — and carries a **"rules NOT to add"** list recording proposals that were investigated and rejected, with reasons, so they are not re-proposed. Adopter-sourced findings are recorded as shapes, never identities.
- **Authoring guidance — where a script shared by several skills should live.** `vat-skill-authoring` gains a section on the per-skill vs. plugin-level `files:` fork. Per-skill duplication keeps each skill self-contained and standalone-mountable at the cost of duplicated bytes; a plugin-level `files:` entry (whose `dest` may not resolve under `skills/`) ships one copy but forces skill bodies onto `${CLAUDE_PLUGIN_ROOT}`, giving up standalone mounting — which `NON_PORTABLE_ASSET_REFERENCE` correctly flags. The section names the deciding question (does this skill ever run outside its plugin?), and shows recording the answer as a scoped `validation.allow` entry with a required `reason` rather than a repo-wide `severity: ignore`.

### Changed

- **`@vibe-agent-toolkit/utils/git` exposes exactly one git-root finder.** The subpath previously
  re-exported whole modules, surfacing both `gitFindRoot` and the deprecated `findGitRoot` — two
  differently-named functions for the same job, which guarantees consumers split between them. The
  subpath is now an explicit, curated export list carrying `gitFindRoot`; see **Removed** for the
  alias itself.

- **Guidance for building the Node scripts a skill ships**, in the `vat-skill-authoring` skill:
  bundling to a self-contained tree-shaken `.mjs`, statically scanning the artifact for surviving
  external imports, and clean-room booting it outside any `node_modules`. It documents a trap VAT
  itself creates: `files:` injects a bundle under a different `dest` basename, so a script guarding
  its entry point on `basename(process.argv[1])` evaluates that guard as false under the shipped
  name and exits 0 having printed nothing — inert, while reading as success to anything watching
  exit codes.

  It also documents that trap's sibling, which an adopter found the hard way across three of their
  own bins: npm writes `node_modules/.bin/<name>` as a **symlink**, so `process.argv[1]` is the link
  path while `import.meta.url` is the realpath target — meaning the obvious remedy
  (`import.meta.url === pathToFileURL(process.argv[1]).href`) fails the same fail-open way on the
  most common invocation path of all. The guidance therefore recommends shipping a guard-free bin
  entry module, and specifies clean-room verification on **three** legs — shipped `dest` name,
  through a symlink, and from a packed tarball installed outside the workspace. A copy-only clean
  room cannot see the symlink case at all: a copy has no symlink, so it certifies fail-open bins as
  healthy.

### Removed

- **`findGitRoot` is gone from `@vibe-agent-toolkit/utils`. Use `gitFindRoot`** — the behavior is
  identical, because `findGitRoot`'s entire body was `return gitFindRoot(startDir)`. It had carried
  an `@deprecated` tag for some time. Curating it off the new `./git` subpath (see **Changed**)
  addressed only the symptom: the alias stayed on the `.` barrel, the entry with the most consumers,
  so both names remained one import away and the coin flip just moved. Under the pre-1.0 policy
  (never maintain two APIs for the same job) the alias is deleted rather than relocated. No
  production code in this repository ever called it.

  This also removes one of the symbols that were reachable **only** from the wide `.` barrel — the
  shape that undercuts "import the one you need" — and it is the one whose narrow home already
  existed.

### Security

- **16 advisories cleared from the dependency tree** via the root `overrides` block: `undici`
  7.28.0 → 7.29.0 (5 advisories), `ip-address` 10.1.1 → 10.3.1 (3), `hono` 4.12.27 → 4.12.34,
  `fast-uri` 3.1.4 → 3.1.5, `js-yaml` 4.3.0 → 4.3.1, and `postcss` 8.5.18 → 8.5.23, plus a new
  `nanoid` 3.3.16 → 3.3.17 pin closing GHSA-2v37-7h3g-55p8 (CVSS 8.2). `nanoid` reaches the tree
  only through `postcss`, whose `^3.3.16` range the patched version satisfies, so no other pin
  moved. All are within-major bumps of transitive packages; no declared dependency changed and no
  consumer-facing API is affected.

  One advisory is **accepted rather than fixed** and recorded in `osv-scanner.toml` with its
  reasoning: `brace-expansion` (GHSA-rgw5-rvv9-x895) resolves to 1.x, 2.x, and 5.x simultaneously
  in this tree, and the fix lands separately in each line (1.1.18 / 2.1.4 / 5.0.9), so no single
  value in a global `overrides` block can patch all three — pinning any one forces the other two
  majors onto an incompatible version. It is a ReDoS against attacker-controlled brace patterns;
  VAT only ever expands patterns it authors. Same shape, and the same deferral, as the existing
  `minimatch` and `picomatch` entries.

### Fixed

- **`isGitIgnored()` spawned a git subprocess per ancestor directory when the path was not in a git
  repository at all — `vat resources validate` on a 3,437-document tree outside any repository went
  from 196 s to 20.6 s, with a byte-identical report.** `git check-ignore` exits 128 for two
  unrelated conditions: "beyond a symbolic link" and "not a git repository". The code treated any
  non-0/non-1 status as the first, whose recovery is to walk up the ancestor directories re-spawning
  git for each one. Outside a repository *every* ancestor also exits 128, so the walk never broke,
  climbed to the filesystem root, and returned `false` after (1 + depth) spawns — per call, and it is
  called per link. It was the right answer by the wrong route, which is why no assertion ever caught
  it; on the tree above, `spawnSync` was 87.6% of a 225.6-second run. "Is there a repository here?"
  is now settled from the filesystem (via `gitFindRoot`) before anything is spawned, so outside a
  repository the answer costs zero subprocesses. In-repository behaviour, including the symlink
  ancestor walk, is unchanged and pinned by tests that assert the spawn count rather than only the
  return value.

- **VAT crawls walked into `.turbo`.** turborepo's per-package directory was on neither
  `NEVER_CRAWL_GLOBS` nor `BUILD_OUTPUT_GLOBS`, so any crawl with `respectGitignore: false` — the
  path those lists exist for — descended into it and reported turbo's task logs, and, where
  `cacheDir` points inside `.turbo`, files out of the hash-keyed cache. That cache holds *copies* of
  package build output, so the crawl reported the same file twice under two paths: the duplicate
  reading `**/.worktrees/**` is on the never-crawl list to prevent. It is now on
  `NEVER_CRAWL_GLOBS` (not `BUILD_OUTPUT_GLOBS` — a lane that spreads only the never-crawl list is
  by definition one that wants to see build output, and is precisely the lane that must not walk a
  cache of copies). Turborepo is common enough for this to matter: every package in this repo has a
  `.turbo/`.

- **`windowsShellQuote` produced command lines that `CommandLineToArgvW` mis-parses, corrupting
  arguments and silently merging them with the argument that follows.** The function knew none of
  Windows' backslash-escaping rules: a backslash run preceding a quote — or preceding the closing
  quote it adds — is escape-processed by the child's parser, so `C:\Program Files\` was emitted as
  `"C:\Program Files\"` whose final `\"` reads as an *escaped quote* rather than a terminator. A path
  with a trailing separator and a space is the everyday case, and the space is exactly what triggers
  quoting, so the two conditions coincide constantly.

  Now implemented as the canonical algorithm: every backslash run preceding a quote or end-of-string
  is doubled, and quotes escape as `\"`. Measured by round-tripping through an implementation of
  `CommandLineToArgvW` over every string up to length 4 across `{a, \, ", space, %}` — the old
  implementation fails **85 of 781** cases, 74 of them swallowing the next argument; the new one
  fails **0**. That harness ships as a test, self-checked against Microsoft's published worked
  examples so it cannot be silently wrong.

  One documented trade: no byte sequence is correct under *both* parsers in the chain, because
  `cmd.exe` counts every quote while the child needs an odd count to represent a literal one. `\"` is
  chosen because it is understood identically by every known implementation, whereas `""` is absent
  from `CommandLineToArgvW`'s documented rules and CRT variants disagree about it. The residual cost
  is bounded and stated in the code: cmd's quote tracking desyncs only for an argument containing
  both a quote *and* a shell metacharacter.

  Two safety claims in the same module were also overstated and are now documented honestly rather
  than changed. `%` and `!` trigger quoting but are **not neutralized** by it — `cmd.exe` still
  expands `%VAR%` inside double quotes, which also corrupts a literal `%` in a filename (legal on
  Windows). And `shouldUseShell`'s JSDoc asserted "arguments passed as array, preventing injection"
  and "never concatenate user input into command strings" while the Windows shell branch does
  exactly that concatenation. Both now name `shell: false` as the escape hatch.

- **`buildWindowsShellLine` silently produced a broken command line when handed a command path it
  could not safely place in the command position — it now throws instead.** Two shapes reached it:
  an unquoted path containing spaces, which `cmd.exe` splits at the first space; and `''`, which
  promoted the caller's *first argument* into the command position, so
  `buildWindowsShellLine('', ['calc', 'b'])` returned `" calc b"` — a line whose command is `calc`.
  It now requires a single shell token and throws with a message naming the offending token.
  Separately, `safeExecSync`/`safeExecResult` now quote a path-like command the way `spawnHardened`
  already did; the sibling paths previously disagreed and only one was correct.

  **What changes for you:** a call that used to return a subtly wrong command line now raises. If
  you pass a command path through these helpers, resolve it first (both of VAT's own call sites go
  through `which.sync`, which is why neither could reach the empty-token case).

- **`@vibe-agent-toolkit/utils/package.json` was not exported**, so
  `require('@vibe-agent-toolkit/utils/package.json')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. Version
  reporting and resolution assertions all reach for it. Now exported.

- **The `@vibe-agent-toolkit/utils` README documented four functions that do not exist**
  (`normalizeFilePath`, `readFileContent`, `getGitRootDir`, `ensureGitRepository`) and named a fifth
  wrongly (`setupTestTempDir`). The reference is rewritten against verified exports and organized by
  subpath. A `../../docs/` link that resolved to nothing on npm is now absolute.

- **`NON_PORTABLE_ASSET_REFERENCE` no longer advises an impossible fix for `CLAUDE_PROJECT_DIR`.** The family emitted one shared remediation — *"reference bundled files by a path relative to the skill directory"* — for every variant. That is right for `CLAUDE_PLUGIN_ROOT` and absolute script paths, and **wrong** for `CLAUDE_PROJECT_DIR`, which denotes the *user's repository* rather than a bundled asset: no skill-relative path can express it, and substituting one silently re-anchors user artifacts onto the plugin install directory. An adopter reported the rule advising them to revert a fix for exactly that bug. The `claude-project-dir` variant now carries its own remediation (take the location as an explicit parameter with `$CLAUDE_PROJECT_DIR` as fallback; make declared `targets` reflect the Claude Code coupling), and the shared headline no longer asserts the skill-relative advice.

- **`NON_PORTABLE_ASSET_REFERENCE` over-captured a closing brace in nested shell expansion.** The variant patterns used `\$\{?NAME\}?`, whose optional trailing `\}?` consumed the closing brace of an **enclosing** expansion — `"${VAR:-$CLAUDE_PROJECT_DIR}"` was reported as `` "$CLAUDE_PROJECT_DIR}" ``. The malformed token reads exactly like the typo `$FOO}`, sending reviewers to source that was in fact valid shell. Matching is now brace-balanced via alternation. *(Adopter-reported; independently reproduced.)*

## [0.1.41] - 2026-08-03

Entries describe change relative to **0.1.40**, the last stable release. Defects introduced and fixed
entirely within the `0.1.41-rc.*` line are deliberately not listed — no released version ever
exhibited them. Every fix below ships with a regression test.

### Security

- **`vat skill test` no longer stages a skill's eval answer key where the skill under test can read
  it.** Every subject-resolution route — a plain path, a plugin tree-copy, an npm/url/vendored
  artifact, a `packageSkill` dist — carried the eval suite (`evals.json` plus its `fixtures/`,
  including `expected_output`/`expectations`) into the tree the executor runs against, so a skill
  could read its own answer key and pass while demonstrating nothing. The suite is now stripped from
  every staged copy before it is copied onward or content-hashed, and relocated to a VAT-only,
  mode-`0700` directory outside the harness root. `workspaces/` and `results/` are likewise created
  `0700` rather than inheriting the umask.
- **`vat claude org skills install` no longer uploads your eval suite to your Anthropic org
  workspace.** It uploaded *every* file it found, with a hardcoded directory-*name* backstop
  (`evals`, `node_modules`, `.git`) — so a project keeping its suite anywhere else
  (`fixtures/qa/evals.json`, a bare `answers.json`) published every `expected_output`, exited 0, and
  printed an empty exclusion list. The uploader now resolves the *declared* suite through the same
  nearest-ancestor config walk-up `vat audit` and `vat skill review` use, and withholds it in
  addition to the name-based exclusions, which remain as the fail-safe when no config is
  discoverable. Every withheld path is reported.
- **Dependency sweep — the tree goes from 32 vulnerable packages / 120 advisories to 0
  un-triaged.** Highlights an adopter inherits directly: `adm-zip` → `0.6.0`, closing a
  path-traversal advisory ([GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85),
  CVSS 7.5) in a package used at runtime to extract archives fetched from skill-source URLs;
  `tar` → `7.5.22`, closing five advisories including
  [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) (CVSS 9.2) in a direct
  CLI dependency; and the **complete elimination of the `protobufjs@6` transitive chain (11
  advisories, including a 9.8-critical) for every consumer, unconditionally** — adopters could not
  previously override it because `onnx-proto` pins `protobufjs@^6`. Remaining transitive advisories
  are pinned via root `overrides`; the two that cannot be fixed (`brace-expansion`, whose fix exists
  in neither coexisting major line, and `@hono/node-server`, whose vulnerable `serve-static` export
  is never imported) are documented in `osv-scanner.toml`. An OSV-Scanner CI gate now runs against
  the committed lockfile.
- **The `vat skill test` grader protocol is hardened against a skill forging its own verdict.** vat
  is the sole writer of `results/`; each grader fragment carries a secret per-run nonce the executor
  never sees (delivered only via the grader's stdin — never on disk, never in argv), fragments are
  unlinked the instant they are read, and the untrusted transcript and a skill's own
  `declaredExecutables` strings reach the grader inside a nonce-bound fence. Same-uid caveat: the
  grader runs as the same OS user as the skill, so this raises the bar substantially but is not full
  isolation — separate-uid/container isolation is tracked in
  [#149](https://github.com/jdutton/vibe-agent-toolkit/issues/149).

### Added

- **`vat skill test` — transcript-grounded evaluation with a separate executor and grader (issue
  [#145](https://github.com/jdutton/vibe-agent-toolkit/issues/145)).** Each eval now runs in two
  roles instead of one self-grading agent: a blind **executor** (the skill under test) performs the
  task and its transcript is captured in memory, then a separate **grader** judges that transcript
  against the rubric. A grader-side internal failure, or a missing/forged nonce, aborts with the
  harness-broke exit **1** and is never laundered into a pass/fail verdict.
  - `graderModel` config and `--grader-model <id>` (default `claude-sonnet-5`) select the grader
    independently of `model`/`--model`, which now select the **executor**. `--concurrency <n>`
    bounds parallel evals, each retrying a rate-limit with backoff.
  - **Declared tool-expectations.** An eval may declare `toolExpectations`
    (`mustRun` / `mustNotRun` / `mustSucceed` / `sequence`), judged from the transcript and written
    to their own `tool-eval.json` channel so tool verdicts never leak into `grading.json`. A skill's
    packaging config accepts a `declaredExecutables` manifest (`{ path, kind, howInvoked }`) so the
    grader recognizes varied launch forms of one tool (`uv run csvsum.py`, `./csvsum`,
    `node dist/csvsum.mjs`).
  - **Composite, fail-closed verdict.** The reported pass/fail ANDs the output grade with every tool
    verdict, and the run fails closed (exit **4**) if any result artifact is missing, unparseable or
    invalid after the merge.
  - **Cost-tiered fail-fast.** Evals may declare a numeric `tier`; tiers run cheapest-first,
    bounded-parallel within a tier, stopping before the expensive ones once a cheaper tier fails.
  - **Two advisory pre-spend warnings** (never change the exit code): an eval whose expectations are
    all presence-only with no negative check, and a `toolExpectations` entry that looks like a typo
    of a declared executable.
  - **Run-wide spend aggregation** — the summary carries `≈$<total> across <N> sessions`.
- **`vat skill test run --evals <path>` — grade a skill against an eval suite stored outside its own
  tree** (issue [#163](https://github.com/jdutton/vibe-agent-toolkit/issues/163)).
- **`exclude:` on a marketplace plugin entry.** Patterns, relative to the plugin source dir, that
  the verbatim tree-copy must skip — for project-specific content the built-in exclusions cannot
  know about. Additive to the defaults (`.claude-plugin/`, gitignored files, produced skill dirs,
  agent-instruction files).

  ```yaml
  plugins:
    - name: my-plugin
      skills: "*"
      exclude: ["scratch/**", "docs/internal"]
  ```

  A pattern may be a glob (`scratch/**`) or a bare directory name with or without a trailing slash;
  all three drop the whole subtree, in or out of a git repository. A pattern matching nothing is a
  `PLUGIN_EXCLUDE_PATTERN_UNUSED` warning in the structured result.
- **Declared test input is auto-excluded from packaged output.** Declaring a path under
  `skills.config.<name>.test.evals` names it as that skill's eval suite; VAT now treats that
  declaration as the instruction not to package it, and reports what it withheld via
  `PACKAGED_TEST_INPUT`. Declarations are assembled once per run across the whole project, so one
  skill's suite cannot leak into another skill's bundle via an ordinary documentation citation.
- **New validation codes**, each overridable with `validation.severity.<CODE>`:
  - **`LINK_UNRESOLVED_REFERENCE` (`warning`)** — a dangling reference-style link: `[text][label]`
    or the collapsed `[label][]` with no matching `[label]: url` definition.
  - **`REGISTRY_SHAPE_DRIFT` (`info`)** — Claude Code's installed-plugins registry parses cleanly
    but carries a field VAT does not model, so drift stays visible without being an error.
  - **`TREE_PROVENANCE_INDETERMINATE` (`warning`)** — `vat audit` could not decide whether a tree is
    a distribution artifact or ordinary repository source because git could not be consulted (`git`
    absent from `PATH`, an unreadable or corrupt `.git`). It claims only that the tool could not
    tell, never anything about the artifact, and fires only when the tree actually contains
    agent-instruction files, so a clean repo in a git-less container stays quiet.
  - **`LINK_TO_AGENT_INSTRUCTION_FILE` (`error`)**, **`PACKAGED_AGENT_INSTRUCTION_FILE` (`warning`)**,
    **`FILES_GLOB_DROPPED_NEVER_PACKAGED` (`warning`)**, **`FILES_GLOB_MATCHED_NOTHING` (`info`)**
    and **`FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED` (`warning`)** — see Changed.
- **User-facing documentation for `vat skill test` and its config surface**
  (`packages/cli/docs/skill-test.md`), covering the per-skill `skills.config.<skill>.test` block and
  the global `test:` node.
- **The `coherence-audit` skill ships in the `vibe-agent-toolkit` plugin** — the audit method this
  release used: the one-contract question, the failure-direction tell, and how to spot a test suite
  that is structurally blind to the defect it covers.

### Changed

- **BREAKING: repo-internal agent-instruction files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
  `GEMINI.md`) are no longer bundled into skills, and linking to one is now an `error`
  (`LINK_TO_AGENT_INSTRUCTION_FILE`).** Bundling them caused silent mis-resolution — under
  `resourceNaming: basename` two packages' `CLAUDE.md` files collapse onto one destination, and an
  adopter verified by checksum that 2 of 3 links in a packaged document pointed at the wrong file —
  and unintended instruction loading: Claude Code loads `CLAUDE.md` files under the working
  directory on demand, so a skill installed project-locally (`.claude/skills/<name>/`) turns a
  bundled `CLAUDE.md` into live agent instructions the moment a reference beside it is opened.

  **What to do**, cheapest first:
  - **Point the link at the file's canonical home as an absolute URL** — it survives packaging
    verbatim and keeps the pointer. On one adopter this cleared 15 of 28 errors with seven one-line
    edits.
  - **Link the specific content the file describes**, or extract the shared part into a document
    meant for distribution — the right answer when the skill tells the agent to *read* the target.
  - **Ship it deliberately**: declare it under `skills.config.<name>.files` with an **explicit**
    (non-glob) `source:`. It is bundled at its declared `dest`, the link is rewritten to point at
    it, and the finding does not fire. A glob that merely catches the file earns none of that.

  `validation.severity.LINK_TO_AGENT_INSTRUCTION_FILE: ignore` silences the finding; unless an
  explicit `files:` entry names the file, it stays out of the bundle either way. The check runs in
  the packaging lanes (`vat build`, `vat validate`, `vat verify`); auditing a skill tree whose
  documents merely *contain* `CLAUDE.md` files is unaffected.
- **New `PACKAGED_AGENT_INSTRUCTION_FILE` (warning) — the presence-side half.** The link check
  cannot see a file that arrives in a bundle without any link. `vat build`, `vat verify` (a new
  in-process `packaged-content` phase crawling every built skill bundle) and `vat audit` now report
  each agent-instruction file found in a distributed tree, whatever route put it there — including a
  **built skill bundle**, which no lane inspected before: a bundle carrying two such files reported
  `filesScanned: 1`, zero issues, `warnings: 0`. `vat audit` decides a tree is distributed by
  PROVENANCE, not path shape and not your config: a `SKILL.md` inside a Claude install root
  (`~/.claude/plugins|skills|marketplaces`) is an installed artifact, and one that is **gitignored or
  outside any git repository** is a built bundle or unpacked third-party tree. Repository source —
  tracked, *or* written and not yet committed — stays silent, whether or not your project has
  adopted VAT. The install-root clause outranks the git one because Claude Code installs
  marketplaces by `git clone`. Measured on one real install: **7 findings across 628 audited
  skills**, one an intentional scaffold template. In `vat build` and `vat verify` an **explicit**
  `files:` entry naming the file suppresses it (a glob match earns nothing); `vat audit <path>`
  still reports it, having no config block to read intent from. Silence an intentional one with
  `validation.severity.PACKAGED_AGENT_INSTRUCTION_FILE: ignore`.
- **BREAKING: a `files:` glob and a plugin's verbatim tree-copy no longer ship files that never
  belong in a bundle.** Two routes reached a published bundle with no link pointing at them and no
  finding: a plugin's `source:` directory was tree-copied verbatim, so a `CLAUDE.md` beside
  `plugin.json` shipped to every consumer; and a `files:` glob (`source: extras/**/*`) shipped
  whatever it caught, including an `extras/README.md`, because `PACKAGED_UNREFERENCED_FILE` exempts
  any declared `files:` dest and the glob inherited an exemption earned by *explicit* declaration.
  Now:
  - **Agent-instruction files** are never packaged by a glob on any surface — skill bundle *and*
    plugin tree-copy, at any depth, **whatever their case**. (The plugin tree-copy has no per-file
    escape at all.) Case-insensitivity is load-bearing: on APFS and NTFS, Claude Code's lookup for a
    project-local `CLAUDE.md` is satisfied by `Claude.md` or `claude.md` just the same.
  - **Navigation files** (`README.md`, `index.md`, `toc.md`, `overview.md` + case variants) are
    never packaged into a **skill bundle**, but are still copied from a plugin source dir: a
    plugin-root `README.md` is the plugin's front page — 57 of 94 plugins installed on one real
    machine ship one, against 6 of 339 skills with a README beside their `SKILL.md`.
  - **The rule is glob-vs-explicit.** `source: extras/README.md` — a file you named — still ships. A
    deliberate scaffold or skill README needs **no new config**.

  **What to do:** if a glob was your way of shipping one of these, name it explicitly; entry order
  does not matter, including alongside an `integrity: true` glob over the same subtree. Every
  dropped file is a `FILES_GLOB_DROPPED_NEVER_PACKAGED` **warning in the structured result** (not
  merely stderr), anchored at the refused **source** file. A glob whose matches are *all*
  never-packaged is a hard build error. A `SKILL.md` link to a dropped file still fails the build as
  `PACKAGED_BROKEN_LINK`, now naming the never-package rule as the cause.
- **The pre-build gates now predict BOTH glob failures that kill the build.** `vat skills build` has
  two distinct hard errors for a `files:` glob — matched nothing ("has your build run?"), or matched
  and every match was refused by the never-package list — and `vat skills validate`, the lane
  adopters run in CI *before* the build, reported `success` on both. Two new codes close that:
  **`FILES_GLOB_MATCHED_NOTHING` (`info`)**, deliberately `info` because matching nothing before the
  artifact exists is expected and must not fail anyone's CI; and
  **`FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED` (`warning`)**, one finding per entry, **not** silenced
  by an explicit entry re-shipping one of the refused files. The three verdicts are mutually
  exclusive per entry.
- **BREAKING: there is now ONE answer to "findings → status", and every validation result carries
  per-severity counts.** Six places independently collapsed findings into a verdict and disagreed.
  Consequences across the CLI: `status` everywhere uses the same three-value vocabulary
  (`success` | `warning` | `failed`) — `vat resources validate` and `vat skill review --yaml`
  previously used two-valued vocabularies that could not express `warning`, and `vat skills
  validate` printed `status: success` and "✅ All validations passed" above active warnings; every
  result publishes `issueCounts`; `activeErrors`/`activeWarnings` are gone in favour of `allErrors`
  as the sole container; `vat audit` names file counts and finding counts apart
  (`summary.success|warnings|errors` become `summary.filesPassed|filesWithWarnings|filesWithErrors`);
  `vat audit settings --file` replaces `valid: true|false` with `status` + `issueCounts` +
  `findings` + `typeConfidence`; `vat doctor` reports four outcomes per check (`pass`, `fail`,
  `undetermined`, `skipped`) rather than a boolean; and `@vibe-agent-toolkit/claude-marketplace`'s
  `SettingsValidateResult` loses `valid`/`errors` for the same shape. **Every field named `error*`
  now counts errors only** — `vat resources validate` had such fields carrying mixed-severity
  totals, so a consumer gating on them blocked on warnings. **Exit code 2 ("System error") is now
  actually reachable** on `vat validate`, `vat verify` and `vat build`: a phase whose child exits 2,
  is killed by a signal, or never spawns is a system error, not a validation failure. Warnings
  remain non-blocking (exit 0).
- **BREAKING: `ValidationIssue.location` is always a project-relative POSIX path, and a link finding
  is anchored to the file that CONTAINS the link, not to the link's target.** One field had been
  carrying six incompatible meanings; for a missing target the old `location` named a path that does
  not exist, so no editor could open it. **If you have `validation.allow` globs for link codes, they
  must be rewritten against the containing file (or the href)** — `allow` entries match an issue's
  `location` or its `link`, both of which changed meaning here.
- **BREAKING: reports state their base once (`root`) and every `path` and `location` is relative to
  it.** Applies to `vat audit`, `vat resources scan --verbose`, `vat skills list`, `vat agent list`,
  `vat rag query` and `vat claude marketplace validate` — the last renames its top-level `path:` to
  `root:` and makes each `plugins[].path` relative to it. Absolute `$HOME` paths no longer appear in
  machine-readable output, so an audit can be shared or archived and still resolve. `vat inventory`
  and `vat audit settings` are deliberately unchanged; human-readable **stderr** keeps absolute
  paths.
- **BREAKING: `vat validate` stdout is a single parseable YAML document.** Child phases ran with
  inherited stdio, so N child documents were concatenated with no separator and `YAML.parse()` threw.
- **BREAKING: `--only` is removed from `vat verify` and `vat validate`.** Measured on a large
  adopter project, `vat verify` takes 31.7s end to end — the flag saved little and multiplied the
  ways a run could be partial. `vat build --only` remains.
- **BREAKING: the validating commands report per ASSET by default; `--verbose` restores full
  detail.** Applies to `vat resources validate`, `vat skills validate` and `vat claude marketplace
  validate`. **Errors always render in full at any verbosity**; warnings and info collapse into a
  count line. Machine-readable output is never filtered.
- **BREAKING: `vat verify` can see warnings.** Phase status was derived from the child's exit code
  alone, and `vat skills validate` exits 0 while reporting `status: warning` — so a warning phase
  reported `passed`. Its consistency phase now reports `warning` when it emits warnings, and
  publishes `issueCounts` plus the findings into the archived report.
- **BREAKING (widens the scan): `.claude/` and every other dot-directory is no longer invisible to
  VAT's file crawler.** picomatch refuses to let `*` or `**` traverse a segment beginning with a
  dot, so `**/*.md` — the default include pattern — could never match inside `.claude/`, `.github/`
  or any dotted directory. One adopter had **68 tracked files silently uncrawled** (`.claude/rules/`
  15, `.claude/skills/` 48, `.claude/commands/` 3, `.claude/agents/` 1). Every pattern now compiles
  with `dot: true`. **What to expect:** tracked markdown under a dot-directory with no narrowing
  `include` allowlist will now be scanned, and may report findings for the first time.
- **BREAKING: a path argument no longer voids the project's `include`/`exclude` globs.** Affects
  `vat resources validate|scan <path>`, `vat rag index <path>` and `vat audit <path>`. These re-based
  the crawl onto the given path, discarding every root-relative glob — so naming a subdirectory
  scanned build output, vendored trees and deliberately-broken fixtures the project had excluded on
  purpose, turning a green project red. On VAT's own tree `vat resources validate
  packages/vat-development-agents` reported 50 files / 7 errors where the configured run reported
  success; it now reports 25 files / 0 errors. The crawl base stays at the project root, the path
  narrows `include` only, and `exclude` always applies. A path outside the project root warns; a
  path that does not exist now fails loudly instead of reporting `filesScanned: 0` as success.
- **BREAKING for `owner/repo` shorthand: `vat audit <path>` never reaches the network for a path
  that exists.** The command asked "is this a git URL?" before "is this a directory?", and bare
  GitHub shorthand is spelled exactly like a two-segment relative path — so `vat audit plugins/arc`
  resolved to `https://github.com/plugins/arc.git`, never audited the local tree, and silently
  contacted github.com with a name derived from your own directory layout. Anyone registering that
  `owner/repo` could have had their tree cloned and reported back as your audit. An argument naming
  an existing file or directory is now always a path; shorthand applies only when nothing of that
  name exists locally.
- **BREAKING: `<skill-root>/evals/evals.json` is a declaration in the packaging lane too.** The
  harness has always defaulted to that path; the packager did not, so the harness protected the eval
  signal while the build **packaged and published the answer key**. The inference is narrow: keyed
  on the suite *file* existing, never a directory's name, and only at exactly `<skill-root>/evals`.
  An explicit `test.evals` still wins. **If you keep a `<skill-root>/evals/evals.json` suite and
  relied on it shipping, declare its contents through `files:` or move it.**
- **BREAKING: `${fixturesDir}` resolves per eval, under that eval's own staged workspace.** Because
  eval-suite isolation removes `<staged>/evals/` from every staged subject, the old target no longer
  exists. **This supersedes the 0.1.39 note** that fixtures under `evals/fixtures/` auto-stage with
  the eval tree — they no longer do; a fixture reaches the executor only by being declared in its
  eval's `files` list. An eval that declares no input `files` has no workspace, so `${fixturesDir}`
  there now fails at preflight (exit **2**) naming the env key, instead of injecting a path to
  nowhere.
- **BREAKING: `vat skill test`'s `--with`/`--with-optional` stage companion skills, and a run tests
  exactly one subject** (issue [#153](https://github.com/jdutton/vibe-agent-toolkit/issues/153)).
  `--with name=<src>` stages a **required** companion the subject can invoke; `--with-optional`
  stages an optional one. This replaces an undocumented behavior where `--with` merely overrode the
  staging source of an already-listed positional skill and **silently no-op'd** any name that wasn't
  positional — so a routing/deferral eval could "pass" against a skill set that never contained the
  companion. The positional argument is now a single `<skill>` (was variadic). A required companion
  that cannot be resolved fails the run (exit **2**); an optional one is skipped with a warning;
  staging the same name twice is an error. `skills.config.<skill>.test.with`/`optional` behave the
  same way — they previously never staged anything. A companion mapping to a declared skill is now
  **built** rather than tree-copied from raw source, so one backed by a bundled executable no longer
  stages non-functional and hangs the executor with no diagnostic.
- **BREAKING: `license: <spdx-id>` in your marketplace config only accepts identifiers VAT can
  render in full.** `vat claude marketplace publish` vouched for eleven SPDX shortcuts but carried
  real license text for one. Nine fell through to a two-line stub, and `apache-2.0` emitted only the
  short-form notice header — written verbatim as the published `LICENSE`, so a `publish` reporting
  success shipped a distribution whose license file grants nothing (GPL-3.0 §4 and Apache-2.0 §4(a)
  both require conveying a complete copy of the License). `mit` renders as before; the other ten now
  fail with an error naming the identifier, linking its canonical text, and telling you to point
  `license` at a file path (`./LICENSE`), which `publish` has always supported.
- **BREAKING: `vat skills install` installs a skill under the name it declares, not the name of the
  directory it arrived in.** Every other lane treats SKILL.md frontmatter as the identity. The
  command now also says which of its seven targets VAT can see back, and `vat skills list` reports
  the declared name alongside the directory name.
- **BREAKING: plugin-local skills are packaged, not copied verbatim.** A skill in a plugin's own
  `skills/` source tree (`vat claude plugin build`) now goes through the same packaging pipeline as
  every other skill — link traversal, reference rewriting, nav stripping and `files:` injection.
- **BREAKING: local RAG embeddings are batteries-included, backed by `onnxruntime-web` (WASM)
  instead of native `onnxruntime-node`.** No native addon to build. This also fixes **`vat rag
  index`/`query` exiting 134 on macOS**: the native backend raced LanceDB's native runtime at
  process teardown and their static destructors could abort with `libc++abi: mutex lock failed`
  (SIGABRT) **after** the command had already produced correct output.
- **BREAKING: a link to a file that does not exist reports `LINK_MISSING_TARGET`, not
  `LINK_TO_GITIGNORED_FILE`.** Three layers composed to name the wrong cause in every real case.
- **BREAKING: `flushStdout` is removed** from `@vibe-agent-toolkit/cli` (library API only). It had
  no production callers and was not a harmless no-op — it waited only above `highWaterMark`. The
  blocking-stdio fix below replaces it.
- **BREAKING: `vat audit --user` plugin groups are named after the plugin.** The name was read at a
  fixed offset from `marketplaces/`, which does not hold in Claude Code's real layout.
- **BREAKING (library API): `validateFrontmatterSchema`, `validateFrontmatterRules`,
  `detectUndeclaredCrossSkillAuth`, `detectBundledResourceWithoutLinks` and the five inventory
  detectors take an extra argument** — the skill location / project root. Required rather than
  optional by design: a defaulted parameter would let existing call sites silently keep the old
  behaviour. Only affects code importing these directly; no CLI surface changes.
- **BREAKING: `vat skills build` no longer stops at the first bad skill, and a failed build no longer
  destroys `dist/skills/`.** It validated skills one at a time and exited on the first failure, after
  clearing the whole output tree up front — so on a 90-skill adopter monorepo, a run carrying 28
  errors across 6 skills reported **3 of them, named 1 of the 6, and left `dist/skills` absent**, not
  merely stale: 27 bundles and 106 files of gitignored, unrecoverable prior output. `vat claude
  plugin install --dev` symlinks each skill *out of* `dist/skills/` and skips what it cannot find, so
  the installed plugin ended up with no skills, and a subsequent `vat build --only claude` reported
  `status: success` with `errors: 0` against input the previous command had deleted. Separately, a
  skill that failed by *throwing* escaped the batch entirely: a single filename collision discarded
  all 89 other results and collapsed the report into one bare `error:` string. **The exit code for
  that case changes 2 → 1** — it is the validation failure it always was, and a collision is now
  reported as a finding naming its skill by declared name rather than thrown as a raw `Error`.

  Now every skill is validated, every failure collected and contained, and the run reports all of
  them in one pass, with pre-build validation failure published as its own population distinct from
  "packaging threw" and "built, then failed validation". Output is written to a staging directory
  beside `dist/skills` and promoted with a same-filesystem rename only when the run earns it; a
  failed run restores the previous bundle byte for byte. The report gains `outputCommitted`,
  `skillsFailedValidation` and `skillsStaged`, and the exit code derives from `outputCommitted`
  rather than being recomputed. `--dry-run` now touches `dist/` not at all. A failed promotion
  publishes a `promotionError` naming the parked path and the exact `mv` to recover it, forces
  `status: error`, and exits **2** *after* writing the document — previously that path threw past
  the reporting layer and emitted no report at all. The report also **names its findings**: each row
  carries a full `issues:` array in the shape `vat audit` and `vat skills validate` already publish,
  where a ~90-skill adopter run previously reported 67 warnings with no `code`, no location and no
  fix string at any verbosity. Per-skill progress lines name their skill, which at 92 skills is the
  difference between a readable log and 86 anonymous `Built N files` lines.
- **BREAKING: `vat skills validate <path>` and `vat skills build <path>` now exit 2 on a path they
  cannot scope to, instead of reporting success.** A path that does not exist, is not a directory,
  or holds no `vibe-agent-toolkit.config.yaml` was silently rescoped to nothing and signed off with
  **exit 0**. A CI step naming a mistyped path passed while validating zero skills; a release step
  naming one published having built nothing, and reported success. Both errors now name the path and
  suggest `vat audit <path>` for scanning an arbitrary directory. Only an explicit argument is
  judged; the bare invocations are unchanged.
- **BREAKING: `-v` is no longer an alias for `--version`. It now means `--verbose` on every verb
  that has a `--verbose`.** The root registered `.version(…, '-v, --version')`, and Commander
  resolves a root option before the subcommand's own — so the short flag silently shadowed the
  `-v, --verbose` that `validate`, `verify`, `build`, `skills build` and `skills validate` each
  document in their own `--help`. `vat validate -v` printed the version string and exited **0**
  having validated nothing, so a CI step spelled that way was a permanently-green gate that ran no
  checks. Any script relying on `vat -v` to print the version must switch to `vat --version`. `vat
  audit` and `vat doctor` advertised only the long `--verbose`; both now carry the short form too.
- **`validation.severity` overrides now work in every lane and in BOTH directions.** The documented
  opt-out was a partial or total no-op in four places: `vat audit` consulted the merged override map
  for exactly one value (`!== 'ignore'`), so suppression worked while `error`, `warning` and `info`
  fell through — an adopter promoting a code to `error` saw `severity: warning`, `errors: 0`,
  `status: warning`, while `vat verify` on the *same config key* promoted correctly; `vat audit`'s
  config lookup never searched upward, so auditing `dist/skills/<name>` looked for
  `vibe-agent-toolkit.config.yaml` *inside the bundle* and skipped severity filtering entirely; the
  filter only considered results of skill type, so a finding on a **plugin** or marketplace tree
  kept its severity regardless of config (the load-bearing half — a plugin that intentionally ships
  a scaffold `CLAUDE.md` *template* lands on a plugin result, which no per-skill key can name); and
  `vat verify`'s `marketplace:<name>` phase read no project config at all, so two
  `PACKAGED_AGENT_INSTRUCTION_FILE` warnings survived `ignore` at `skills.defaults`, at every
  per-skill key, and at the plugin's own name, while its `packaged-content` phase honoured the same
  key on the same tree.

  `skills.defaults.validation.severity` now applies project-wide, with `skills.config.<name>`
  layering on top wherever a result names a skill, and one shared resolver serves every lane —
  skill, plugin, marketplace, required-file and in-plugin-skill findings alike. A promotion moves
  the reported severity, the result `status`, and `vat claude marketplace validate`'s exit code (1)
  that `vat verify` reads back as the phase status; it does **not** change `vat audit`'s exit code,
  which stays advisory. Manifest-unreadable findings are exempt. Per-plugin granularity remains
  unavailable: neither marketplace config schema has a `validation` key.

### Fixed

**Link integrity and packaging fidelity**

- **Frontmatter schemas declaring JSON Schema draft 2020-12 or 2019-09 now compile.** VAT compiled
  every external `frontmatterSchema` with Ajv's default export, which carries only draft-07 and
  older meta-schemas, so a schema declaring the current standard raised `FRONTMATTER_SCHEMA_ERROR`
  at **error** severity for *every file in the collection* — one adopter saw **247 errors from a
  single four-property schema**. VAT now selects the Ajv build matching the declared dialect, and
  also registers the non-canonical `http://` spelling of each dialect URI as an alias.
- **Root-relative (`/docs/…`) markdown links survive packaging instead of being silently stripped.**
  The link-graph walker resolved them and **bundled** the target while `ResourceRegistry` left the
  link unresolved, so the packaged prose lost the link entirely: on one real adopter document the
  packaged copy carried **4 links where the source had 15**, and the orphaned target then failed the
  build with an error-severity `PACKAGED_UNREFERENCED_FILE`. Relatedly, a root-absolute link is no
  longer misreported as `LINK_OUTSIDE_PROJECT`, which produced **81 false errors** on one monorepo.
- **A markdown link whose target does not ship is stripped to plain text, in every spelling, keeping
  its own text and inline formatting.** A directory link with a trailing slash (`[refs](refs/)`)
  survived verbatim and tripped `PACKAGED_BROKEN_LINK`; the same link without the slash, and any
  non-markdown asset dropped from the bundle, shipped `[text]()`; and two links sharing an href
  rendered the second with the **first** link's text (VAT's own `vat-skill-review` skill shipped
  "See cached guidance for a cached copy…" where the author wrote the filename). The inline-link
  regex also no longer runs past a stray unpaired `[` into the next link.
- **Link syntax inside fenced code blocks and inline code spans is no longer rewritten**, so a skill
  *teaching* link syntax ships the spelling a reader must type rather than the packaged path.
- **`<a id="short">` anchors in markdown resolve instead of being reported as broken links.** VAT
  indexed heading slugs only, so an explicit short anchor above a long heading produced
  `LINK_BROKEN_ANCHOR` for a link GitHub resolves — one adopter repointed working links at the long
  slug to appease the tool. An `id=` inside a code block is still never indexed.
- **A file declared in `files:` and also linked from `SKILL.md` now ships exactly once, at the
  destination it declares.** An **explicit** entry shipped twice — at the declared `dest:` and again
  where the link-follower puts it, with the rewritten link pointing at the second copy, while
  `filesPackaged` counted the `files:` side alone (reporting 2 where the disk held 4). A **glob**
  entry had the mirror-image bug: it skipped a file link traversal had already bundled, *before*
  computing its destination, so the file was missing from the declared `dest` subtree and the build
  exited 0 — and `integrity: true` did not catch it, the file being in neither the expected set nor
  the on-disk subtree. The path map is now built in two passes, globs first, explicit second.
- **`vat skills build` no longer fails on its own `files:` payload.** `PACKAGED_UNREFERENCED_FILE`
  (severity `error`) fired on files VAT itself had just copied in from a skill's `files:` map — a
  vendored engine, generated schemas, data packs. Adopters who added `validation.allow` waivers
  restating their own `files:` map can delete them.
- **A `files:` remap is now a real remedy for a filename collision.** `FILENAME_COLLISION` was
  judged on the naming strategy's *would-be* destinations, one step before `files:` entries override
  them, so an adopter who remapped both colliding sources to distinct dests still had the build
  failed at **error** severity for a collision that no longer physically occurred. The check now
  runs against the **final** destination map — and it moved rather than weakened: two `files:`
  entries pointing at one dest is a genuine collision the old check had no trace of.
- **A `files:` entry with a directory-shaped `dest` no longer writes a file named after the
  directory.** `dest: "guides/"` on a non-glob entry silently produced a *file* called `guides`
  holding the source's bytes. Such a `dest` is now rejected at config-parse time; globs are
  unaffected, their `dest` being a subtree root.
- **A `files:` glob with a `..` segment after its static base is now rejected when the config
  loads.** `source: "dist/gen/**/../../secrets/*"` parsed cleanly, passed `vat skills validate`, then
  killed the build at copy time. The static base may still begin with `..` (the deliberate
  sibling-base monorepo feature).
- **`packagingConfigToPackageOptions` now forwards `excludeNavigationFiles`.** It was dropped in the
  canonical config→options conversion whose docstring promises byte-for-byte parity, so with the
  flag `false` the pre-build gate predicted a `README.md` would ship and the build stripped it.
- **`resources validate` and `skills validate` agree on `files:`-declared build artifacts**, and a
  `files:` destination is exempt from the gitignore-leak rule even before the build runs — so
  building the project can no longer turn a previously-passing `vat skills validate` red on its own
  declared, gitignored output.
- **A file whose frontmatter fails to parse is no longer also reported as having no frontmatter.** A
  document with a duplicate YAML key drew both `FRONTMATTER_INVALID_YAML` and `FRONTMATTER_MISSING`,
  with two conflicting remediations.
- **`vat verify` now inspects skills discovered by `skills.include` globs, not just those with an
  explicit `skills.config.<name>` block.** Its in-process phases enumerated config keys, so a
  glob-discovered skill was silently skipped — and for a project using only `skills.defaults.files`,
  the `files-config-dests` check was a **total no-op while its phase banner still reported that it
  ran**. **Adopters should expect new findings** on projects that use `skills.defaults.files` or
  omit `skills.config`.

**Reports that told the truth about themselves**

- **Piped output is no longer truncated at 64 KB.** Node makes a pipe's stdio non-blocking and every
  command calls `process.exit()` without draining those buffers, so everything past the first pipe
  buffer was silently discarded, cut mid-token, **with exit code 0** — breaking exactly the usage
  the CLI's own docs recommend (`vat command | jq .status`). A large `vat resources scan --verbose`
  emitted **65,540 bytes through a pipe against 346,937 to a file**, so a consumer read a header
  claiming 1,322 files above a list containing 293. An interactive TTY is unbuffered and always
  looked correct. Both streams are now blocking at startup — including stderr, which carries the
  findings — in both published bins.
- **`writeYamlOutput` no longer emits a trailing `---`.** In YAML `---` OPENS a document, so every
  command's stdout was a two-document stream and a plain `YAML.parse()` threw `Source contains
  multiple documents` — on output this CLI documents as machine-parseable.
- **`vat audit --user` no longer audits every marketplace-installed plugin twice.** `marketplaces/`
  lives *inside* `plugins/`, and the user scan walked both recursively, so every finding class was
  inflated: one real install reported **12** agent-instruction findings for **7** distinct files.
  Roots contained in another root are now dropped, but only when the walk is recursive.
- **`vat audit`: info-severity findings are no longer invisible.** The terse renderer decided
  "nothing to show" from the result's *status*, and an info-only result is `success` — so a real
  `--user` scan counted 504 info findings and rendered none of the 167 belonging to the 128 skills
  that had info findings and nothing else. Info findings are also no longer labelled `[WARNING]`.
- **`vat audit`: a result's status, counts and summary follow its findings, and header totals agree
  with per-file totals.** A plugin carrying a warning reported `status: success`,
  `issueCounts: {0,0,0}` and `summary: Valid plugin` in the same entry that listed the warning. One
  `--user` run reported 55/422/504 in the header against 55/360/405 summed per file — **91 of 614
  entries declared `{0,0,0}` directly above the findings they listed.** Every total is now derived
  from one traversal of the final issue set.
- **The `skills` command family told four inconsistent stories; it now tells one.** Its header
  reported more warnings than its rows summed to (1814 vs 1800 on a large tree); a `skills` failure
  produced **zero bytes of stdout** before exiting 2; `vat skills build` and `vat skills package`
  exited 1 from their validation gate with empty stdout though `--help` documents a summary for
  exactly that case; and `vat skills package` hardcoded `status: success`, so a skill `vat skills
  build` reported as `warning` came back `success`. A build that fails only on built-output
  validation now also shows why.
- **`vat audit settings` emits the full `overrode` provenance chain** for every effective value,
  naming each value it replaced down to the lowest-precedence layer — the question the command
  exists to answer. It was computed and then dropped.
- **`vat audit --user`: cached skills are matched against their own source.** The cache/source index
  was keyed by bare skill name; one real scan had 93 collisions across two marketplaces, so cached
  copies were compared against unrelated same-named skills — reporting `cacheStatus: stale` for
  byte-identical copies, and able to hide genuinely drifted ones as `fresh`.
- **`vat verify`, `vat validate` and `vat build` reject a path argument instead of silently
  discarding it.** Commander accepts excess arguments by default, so `vat verify dist/skills/demo`
  threw the path away, ran an unscoped whole-project verify, and reported `status: success`; on
  `vat build` the same defect silently rescoped a command that *writes*. All three now exit 2 naming
  the discarded argument and pointing at `vat audit <path>` — exit 2 rather than Commander's
  usage-error 1, because on these commands 1 means "validation errors found".
- **Build and plugin failure messages no longer publish your absolute filesystem paths into
  machine-readable stdout.** Four `files:` failure routes interpolated the fully resolved absolute
  path into `failedSkills[].message` / `failures[].message` — the output adopters paste into CI logs
  and issue reports — disclosing the operator's home directory and the project's location on disk.
- **`vat --version` names the binary that produced it.** The `-dev (<path>)` suffix was derived from
  the *current directory*, not the binary, so a development build run by absolute path from another
  repository printed a version string byte-identical to the released one — precisely the situation
  every adopter integration test runs in. The output now carries a `binary:` line derived from the
  entry module Node actually loaded; the version still comes first, so `--version | head -1` parses
  as before.
**Crashes, hangs and stalls**

- **`vat skill test run` no longer crashes on Windows with `spawn EINVAL`.** On Windows `claude`
  resolves to an npm `.cmd` shim, and since the Node CVE-2024-27980 fix a bare `spawn` of a `.cmd`
  throws synchronously — so the harness died the instant it tried to launch the session (reported by
  an adopter across cmd.exe, PowerShell and Git Bash). Spawning now detects `.cmd`/`.bat`/`.ps1`
  shims and launches them through the shell with per-arg quoting. In-flight grader/executor children
  are also killed before the harness exits, rather than left running and billing tokens.
- **`vat audit` no longer dies on a single unreadable file.** One markdown file the process could
  not open — anywhere under the crawl root — aborted the whole command with `status: error` and exit
  **2**, returning none of the findings already gathered. It now degrades to one `parseError` per
  affected skill.
- **`vat audit <owner>/<repo>` no longer stalls ~60 seconds on a git credential prompt.**
  Interaction is disabled for the clone, but **only when the URL was inferred from shorthand**, so
  someone who typed a full URL for a private repo can still authenticate. `GIT_TERMINAL_PROMPT=0`
  alone was measured to be insufficient: every askpass hook short-circuits the terminal path before
  that variable is consulted, so an editor exporting `GIT_ASKPASS` would have kept the entire stall.
- **`vat build --only` with an unroutable phase prints a structured document instead of a stack
  trace.** It threw from outside the command's try block, so the user got a raw Node stack, **zero
  bytes of stdout**, and an exit 1 indistinguishable from "validation errors". The message was also
  self-refuting: *"Unknown phase: claude. Valid phases: skills, claude."*

**Performance**

- **`vat audit` re-did the most expensive thing VAT owns once per skill; it now does it once per
  project root.** On a ~1,200-document monorepo, auditing a directory of 46 skills did not complete
  in ten minutes while `vat resources validate` scanned the same tree in seconds. Two independent
  causes: the inventory link walk crawled with `respectGitignore: false`, which also means "include
  everything git is told to ignore" and abandons `git ls-files` for a full recursive walk of every
  build cache and nested worktree — **39,599 ms versus 16 ms**, for 1,146 files versus 1,143; and
  the registry was rebuilt per skill, parsing every markdown document under the project root (~20 s
  on that tree) N times over. Auditing a plugin directly went from **369 s to 42 s** for 2 skills
  and is now effectively flat in skill count (a 19-skill plugin audits in 27 s).
- **`vat claude plugin build` no longer re-reads the whole project once per skill.** The cost was
  fixed per skill and independent of the skill's own size: on a monorepo with 1,039 markdown files a
  1-file skill and a 17-file skill each cost **~25 s**, putting a 46-skill build past a 30-minute CI
  cap with no output during the gaps. The registry is now created once per run and threaded through
  (**~2× faster** per skill). `vat skills build` was never affected.

**Discovery and detection**

- **A newly-authored, uncommitted `SKILL.md` is now discovered.** Discovery crawled via
  `git ls-files`, which lists only tracked files, so a brand-new skill was invisible: `vat skills
  validate` silently reported one fewer skill and exited 0, and `vat skills build` did not ship it.
  Nothing warned — the count was the only tell.
- **`vat audit --user`: 52 of 59 errors were false; the run goes 59 → 7.** VAT modelled Claude
  Code's installed-plugins registry and `known_marketplaces.json` — maximally external data — with
  `.strict()` schemas, a non-optional `isLocal` that current Claude Code never writes, and a `scope`
  union missing the `project` and `local` values the real file contains. Drift stays visible via the
  new `REGISTRY_SHAPE_DRIFT`.
- **`ALLOW_UNUSED` is evaluated across the whole run instead of per skill.** `validation.allow` is
  declared per *package* but unused-ness was computed per *skill*, so an entry scoped to two files
  was reported unused by every other skill — **87 false warnings from 3 legitimate entries** on
  VAT's own 13-skill package, and 32 on `vat build` from a second, independent cause. Both go to 0,
  with all entries still listed under "Allowed issues" so the zero is a true answer rather than a
  suppression. A genuinely dead entry still yields exactly one warning for the run.
- **The bundled-resource-link detector can fire on `.md` files at all.** It hardcoded
  `['scripts','references','assets']` while the routing module that calls itself the single source
  of truth routes `.md` and every unknown extension to `resources/`, so the most common bundled
  shape was structurally unreachable; coverage was also computed per *directory*, so one live
  mention marked a whole directory referenced. Measured over the plugin corpus fixture: **6 → 19
  findings, 0 lost.**
- **`vat audit` no longer reports 179 real Python standard-library modules as third-party
  dependencies.** `PYTHON_IMPORT_THIRD_PARTY` classified imports against a hand-typed list of 151
  modules, so `import zoneinfo`, `import fcntl`, `import wsgiref` and 176 others were reported as
  depending on packages that do not exist. The list is now generated from CPython's own
  `sys.stdlib_module_names`, unioned across Python 3.10–3.14.
- **An external link no longer changes verdict between the first run and the second.** The
  fresh-fetch path judged "alive" against an exact allowlist while the cache-read path used a
  `>= 200 && < 400` range, so twelve status codes failed one run and then passed for the next 24
  hours off the persistent cache — self-concealing, since it disappeared on exactly the retry you
  would run to reproduce it.
- **`CLAUDE_CONFIG_DIR` is now normalised once, where it is read.** An empty or whitespace-only
  value — `CLAUDE_CONFIG_DIR=`, the ordinary way a shell or CI env block clears a variable — was not
  caught by the `??` default, so `$cwd/skills` and `$cwd/plugins` were treated as Claude install
  roots. A relative value made the answer depend on the working directory, and a `~/`-prefixed one
  (never expanded inside a `.env` file) resolved to `$cwd/~/.claude`, silently disabling
  install-root detection altogether. The value is now trimmed, treated as absent when blank,
  `~`-expanded and resolved at its single read site. Install-root comparisons additionally
  canonicalise both sides, so a symlinked Claude config directory — and, on macOS/Windows, a
  case-variant spelling of an ordinary repository path — no longer flips the verdict.

**Other**

- **The Vercel AI SDK adapters no longer discard an explicit `temperature: 0`.** Both
  `llm-analyzer` and `conversational-assistant` spread the setting through a truthiness guard, so
  the one value a caller is most likely to set deliberately — deterministic output — was silently
  replaced by the provider default. The same guard dropped `maxTokens: 0`. Both are now guarded on
  `!== undefined`.
- **`author.url` in your `plugin.json` is no longer destroyed by the plugin build.** `vat claude
  plugin build` replaced the whole `author` object with `{name, email}` built from the marketplace
  `owner`, and Claude's manifest supports `author.url` while VAT's config has no field for it — so
  an adopter who wrote `author: {name, email, url}` lost the URL on every build **with no config
  field to restore it**. `author` is now merged per subfield: `name` and `email` come from `owner`,
  everything else passes through untouched.
- **`vat rag` no longer silently degrades embeddings when the configured model is not BERT-shaped.**
  The local ONNX provider accepted any HuggingFace model id and loaded that model's own `vocab.txt`,
  but framed every sequence with **hardcoded** BERT special-token ids. Point it at a RoBERTa-derived
  encoder and those ids are arbitrary wordpieces while padding is written as `<s>` rather than
  `<pad>` — the vocab parses, dimensions match, no exception, no warning, and `vat rag index` builds
  a quietly worse index forever. Special-token ids are now read from the loaded vocabulary, and a
  vocabulary that does not define them fails at **load** time with an `IncompatibleVocabError`
  naming the model, the file, and the missing tokens. There is deliberately no bypass flag.
- **Two remediation strings no longer prescribe the wrong fix.** `PACKAGED_UNREFERENCED_FILE` and
  `SKILL_REFERENCES_BUT_NO_LINKS` told you to waive the finding via `validation.allow`; both now
  point at `skills.config.<name>.files`, where a declared `dest` is exempt outright. The old
  phrasing led one adopter to hand-write ~130 lines of waivers duplicating their own `files:` map.
- **VAT's published skill-review rubric no longer attributes VAT's own rules to Anthropic.**
  Re-verified against the live best-practices page, which showed **no vendor drift** — every numeric
  limit unchanged. Three items marked `[A]` are VAT's own and are now `[VAT]`, and the rubric records
  where VAT *under*-enforces the vendor: `REFERENCE_TOO_DEEP` fires only above 2 hops, so a chain
  that is Anthropic's own "Bad example: Too deep" passes validation. **No threshold value changed.**
- **`vat claude org`'s not-yet-implemented stubs no longer promise a release that already shipped.**
  They emitted `plannedFor: "0.1.22"` from a package 19 releases later. The version literal is gone
  rather than bumped, since any literal re-creates the same rot.

### Notes for adopters

- **`mustRun` means *invoked*; use `mustSucceed` for *worked*.** `mustRun` passes as long as the
  tool ran, even if it errored. Both are transcript-judged, so a skill that swallows a non-zero exit
  (`cmd || true`) can still read as success — pair it with an output expectation when you need
  certainty. Tracked in [#150](https://github.com/jdutton/vibe-agent-toolkit/issues/150).
- **`tool-eval.json` is always written** (`{"evals": []}` when no eval declares `toolExpectations`)
  so the fail-closed artifact check has something to read — check `.evals.length`, not file
  existence.
- **`--allow-eval-failure` (from 0.1.40) also downgrades a fail-fast-gated run to exit 0** —
  consistent with how it downgrades any eval failure, but worth knowing if you gate CI on tiered
  runs.
- **`status: warning` on a warnings-only project is deliberate.** `success` means "nothing you must
  act on", not "nothing to see" — so a CI gate should read `issueCounts.errors` or the exit code,
  both of which stay `0` through any number of warnings.

## [0.1.40] - 2026-07-12

### Changed

- **`vat skill test` now fails closed on eval failure by default.** A completed run whose expectations did not all pass now exits **4** (`EvalFailure`) instead of the previous exit **0**. This code stays distinct from the harness-broke codes (`1` internal/stall/timeout, `2` preflight, `3` bootstrap) so a CI consumer can tolerate eval failures while failing closed on everything else: `case $? in 0) ;; 4) tolerate/warn ;; *) exit 1 ;; esac`. The old opt-in `--fail-on-eval-failure` flag is **replaced** by an opt-out `--allow-eval-failure` (for interactive iteration), which downgrades a failing verdict back to exit 0. Which specific evals failed still lives in `results/grading.json`, never in the exit code. The timeout/stall/non-zero-exit → exit-1 semantics are unchanged.

### Added

- **`VAT_LINKAUTH_ALLOW_COMMAND=0` opt-out for token command sources (issue #113 §6.2).** Set `VAT_LINKAUTH_ALLOW_COMMAND=0` in your environment to skip all `{ command: ... }` token sources at runtime — only `{ env: ... }` sources are tried. Useful in security-sensitive CI environments or policies that prohibit arbitrary child-process execution from the link validator. The opt-out can also be set programmatically via `allowCommand: false` in the injected `TokenResolutionDeps`.

### Fixed

- **`vat skill test` path targets now honor the declared skill's `test:` config.** Pointing at a declared skill's built dist (`vat skill test run ./dist/skills/my-skill/`) now applies that skill's `skills.config.<name>.test` block — model, evals, timeout — and resolves the authored eval suite from the skill's **source** dir, so a path target behaves like the name `my-skill` (minus the rebuild). Previously a path target silently ignored the config and could spuriously bootstrap a fresh `evals.json` because it looked for the suite under the dist. The mapping is project-aware (`findDeclaredSkillForPath` walks up from the path, config-first) so it works regardless of the working directory. A path that maps to **no** declared skill is still tested as-is (config-blind); the one-line stderr note now fires only in that case and points at the name form (or the built-dist path) to get config honored.
- **`vat skill test` default `--timeout` now scales with the declared eval count** instead of a flat 5 minutes. A correctly-configured multi-eval suite was being truncated at the 300s wall and reported as a spurious exit-1 failure even though a complete, all-passing `grading.json` had already been written; the default is now ~`2min + 2min/eval` (floored at 5min, capped at 1h), which gives real suites headroom. An explicit `--timeout` still overrides. On timeout the error message now names the declared eval count and points to `--timeout`/`--stall`. The timeout/stall/non-zero-exit → exit-1 semantics are unchanged — a completed-but-killed run is still never laundered into a PASS.
- **`vat skill test` now surfaces `friction.json` entries to stderr at the end of a run — even when the verdict can't be computed.** Packaging friction (e.g. a declared runtime bundle absent from the staged tree, which silently reduces a "behavioral" suite to documentation comprehension) was written to `results/friction.json` but never echoed, so it hid behind a green-looking summary. Friction entries are now printed to stderr as `[severity] category: message`. The report is emitted from the harness `finally` block, so it also surfaces on the failure paths — a grader nonce/skew error (exit 1), a missing/invalid `grading.json`, or a timeout — where a hollow package tends to trip the friction *and* the error at once, and the friction ("your bundle is missing") is the key diagnostic that the error would otherwise mask.
- **`vat skill test run` warns when a path target bypasses the project's `test:` config.** A path/source target silently ignored the `skills.config.<skill>.test` block (model, evals) that a name target honors; it now prints a one-line stderr note pointing to the name-target form so the divergence is visible.
- **`gh auth token` (and other token commands) no longer fail when `vat resources validate` runs from a git pre-commit hook (issue #113 §6.1).** Git sets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and related vars before invoking hooks; these poison any tool that internally shells out to git, including `gh auth token`. The default token-command runner now strips all `GIT_*` vars from the environment before spawning, so authenticated link checking works correctly in both hook and non-hook contexts.

## [0.1.39] - 2026-07-03

### Added

- **Dogfood eval suites for the whole `vat-development-agents` skill set, plus the fixes that dogfooding surfaced.** Every published VAT dev skill now ships a committed `vat skill test` eval suite (`evals/<skill>/`): `vat-audit`, `vat-skill-authoring`, `vat-knowledge-resources`, `vat-skill-distribution`, `vat-rag`, `vat-agent-authoring`, and `markdown-rewriting` (joining the existing `vat-skill-review` suite), wired via `skills.config.<skill>.test`. Final grades: vat-skill-distribution 25/25, vat-agent-authoring 24/24, vat-rag 22/22, vat-knowledge-resources 22/22, markdown-rewriting 18/18, vat-skill-authoring 21/22 (one capability-headroom miss), vat-audit 33/40 baseline A/B (the without-skill failures demonstrate the skill's lift on CI-gating/compat knowledge). Running the suites caught real skill/doc bugs, now fixed:
  - **`markdown-rewriting` is now actually published.** It lived in the skills dir and `vat-skill-authoring` told agents to load `[[markdown-rewriting]]`, but the discovery glob (`vat-*.md`) didn't match its name, so it never shipped — a dangling skill reference. Added it to `skills.include` and `package.json` `vat.skills`; it now builds and ships.
  - **`vat-skill-authoring`** gained the conservative-frontmatter-keys rule (the standard key set; stamp `version`/`team`/ownership under `metadata:` or in config.yaml, never as bare top-level keys) — the agent was inventing top-level `version:`/`team:` fields.
  - **`vat-skill-review`** corrected a factual error: it claimed a `metadata:` field "will be rejected," but `metadata` is an allowed standard key (the sanctioned home for custom data per `SKILL_FRONTMATTER_EXTRA_FIELDS`).
  - **`vat-rag`** removed a nonexistent `vat rag index --rebuild` flag (the real reset is `vat rag clear`; indexing is incremental) and added the missing `OnnxEmbeddingProvider` to the providers table.
  - **`vat-knowledge-resources`** now states that `strict` mode only rejects extra fields when the schema sets `"additionalProperties": false`, and that collection validation defaults to `permissive`.
  - **Collection-validation docs** corrected: `mode` defaults to `permissive` (matching `validateAgainstCollectionSchema`), not `strict` as previously documented.
  - **Skill-test harness:** `buildForwardedEnv` now forwards `USER`/`LOGNAME` (see below) and eval fixtures (including intentionally-broken `.ts` files) are excluded from ESLint.

- **`vat skill test run` / `vat skill test configure` — behavioral skill testing in a context-isolated harness (#132).** Stage a packaged skill plus its declared dependencies into a throwaway, locked-down harness and run a canned, non-interactive evaluation that grades the skill against your `evals.json` (reusing skill-creator's grading rubric and JSON shapes) and writes `grading.json` (with a published [JSON Schema](docs/skill-test-grading-schema.md)), `friction.json`, and full transcripts you can inspect. `configure` writes a per-skill `test:` block to your config as a surgical edit — only the keys you pass change; surrounding formatting and comments are byte-preserved; a first `run` with no `evals.json` writes a template for you to fill in. Runs end-to-end against `claude` 2.x. **Security:** the harness runs the skill's own code with your account's privileges — it is *context* isolation, not an OS sandbox — so `run` requires `--i-understand-this-runs-skill-code`, enforced *before* anything runs (including the optional pre-stage build), and you should only test skills you trust. The pass/fail verdict is recomputed from the graded expectations, so a failing or empty grade is never silently reported as a pass; add `--fail-on-eval-failure` to make a failing eval exit non-zero and gate CI on it. See the new `vibe-agent-toolkit:vat-skill-testing` skill for auth modes, budget/turn/timeout caps, `--baseline` A/B runs, and exit codes.
  - **Pre-stage `build:` hook + plugin-root staging.** An optional `test.build` command runs once before staging, so a skill that depends on a generated, un-committed artifact has it present (a non-zero build fails fast at preflight, before any tokens are spent). Plugin-distributed skills stage under their real plugin-root layout with `CLAUDE_PLUGIN_ROOT` set; standalone skills stage flat.
  - **Declared test-env passthrough.** `passEnv` / `--pass-env` forwards host variables; `env` / `--env` injects values with `${fixturesDir}` / `${stagedSkillDir}` / `${harnessRoot}` / `${resultsDir}` interpolation. Both apply *after* the security allowlist — protected names always win, so committed test config can neither reroute your account credentials nor inject code: auth credentials, `PATH`, and credential-routing variables (`ANTHROPIC_BASE_URL` and the other endpoint/proxy overrides, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`) cannot be overridden. Fixtures under the skill's `evals/fixtures/` auto-stage with the eval tree.
  - **Project-aware subject resolution.** Name a skill declared in `vibe-agent-toolkit.config.yaml` and `run` builds it first and tests the shipping **dist** — link-following, reference-rewriting, nav-stripping, and `files:` injection all applied — so you exercise exactly what installs, not the source tree. A path (including an already-built dist dir), or a `workspace:` / `npm:` / `url:` / `path:` / `vendored` source, is tested as-is; use `./<name>` to force a local directory over a colliding declared name. `--no-build` stages an existing dist without rebuilding (and errors if it is absent); `--dry-run` assembles the command without building and flags when the previewed dist may be stale, and — when no `evals.json` exists yet — reports where a real run *would* scaffold the template (exit 3) instead of writing it, so a dry run never touches your tree. A build failure fails fast at preflight (exit 2), before any tokens are spent.
  - **Eval `files` are now provisioned.** Each eval's declared input files are staged into a per-eval working directory the executor operates on, enabling realistic "drop the agent in a project" evals. Files resolve relative to the `evals.json` directory and are materialized under `<harnessRoot>/workspaces/<id>/`; the experimenter prompt hands the executor that directory via a new `{{WORKSPACES_ROOT}}` token. A declared-but-missing input file fails fast at preflight (exit 2). Previously `files` was documented but inert.
  - **Merge-readiness: liberal eval-suite schema, macOS subscription-auth fix, expanded skill, first dogfood suite.** (1) `evals.json` is adopter-authored data VAT *reads*, so its schema is now liberal per VAT's Postel's Law: `EvalSuiteSchema`/`EvalEntrySchema` are `.passthrough()` and `id` accepts a descriptive **string** or an int — only the fields VAT consumes (`prompt`, `expected_output`, `expectations`) stay required. This reverses the earlier strict-parser call that rejected real adopter suites three ways (string `id`, `category`, `_category_note`) and restores compatibility for the flagship adopter's suites. The persisted `test:` *config* block stays **strict** (it's VAT-produced config) — the deliberate inverse. (2) **macOS subscription-auth fix:** the harness env allowlist (`buildForwardedEnv`) dropped the POSIX `USER`/`LOGNAME` vars, so on macOS `claude auth status` could not read the login Keychain with the API key scrubbed — `--auth subscription` (and `inherit`'s subscription fallback) wrongly failed preflight, and the experimenter child could not authenticate. `USER`/`LOGNAME` are now forwarded (non-secret; already derivable from the forwarded `HOME`). (3) The `vibe-agent-toolkit:vat-skill-testing` skill gains a research-grounded "Authoring `evals.json`" section (blind realistic prompts, discriminating + negative expectations, categories, fixtures, `--baseline` skill-lift, grading) and a full flag⇄config knob table. (4) Ships the first committed VAT dogfood suite (`vat-skill-review`, 5 evals across catch-violation / no-false-positive / guidance-correctness) wired via `skills.config.vat-skill-review.test`, with eval fixtures excluded from `vat resources validate`.
- **`files:` entries now support glob sources and an optional `integrity` byte-verify.** A `source` containing glob magic (`*`, `**`, `?`, `[`) fans out into a directory `dest`, preserving the directory structure below the static base (glob is VAT's existing idiom, as in `skills.include` — no `recursive` flag). Globbed dests are late-bound, so `SKILL.md` links into them are treated as deferred artifacts at validate time (no `LINK_TO_GITIGNORED_FILE` allowlist needed). Add `integrity: true` to byte-verify the copy at build time and assert an exact dest subtree for glob entries.
- **`NON_PORTABLE_ASSET_REFERENCE` validation code (default `warning`) — a portability check family.** `vat skills validate` / `vat audit` now flag a skill document that references a bundled script/asset via a non-portable anchor, scanning the `SKILL.md` body **and every reachable bundled markdown doc** (agents copy invocations from reference files too). It's a family of sub-checks under one code — `claude-plugin-root`, `claude-project-dir`, and `absolute-script-path` — each finding names the variant and carries a tailored fix, and a single `validation.allow` entry silences the whole family for a file. These anchors don't exist when a skill is mounted standalone (claude.ai upload, API container), so the path breaks on the agent's first invocation; reference bundled files relative to the skill directory instead. See [`NON_PORTABLE_ASSET_REFERENCE`](docs/validation-codes.md#non_portable_asset_reference).
- **Skill-authoring guidance: portable bundled-script paths.** The `vibe-agent-toolkit:vat-skill-authoring` skill now documents how to reference bundled scripts/assets portably (relative to the skill directory, never `CLAUDE_PLUGIN_ROOT`/absolute/env-var anchors), and `vibe-agent-toolkit:vat-skill-review` carries the matching pre-publication checklist item.
- **Skill-review guidance: reserved words `claude`/`anthropic` in skill names.** The `vibe-agent-toolkit:vat-skill-review` skill's Naming section now carries the reserved-word rule as a canonical `[A]` item — Anthropic's authoring guidance states a skill `name` "Cannot contain reserved words: 'anthropic', 'claude'", and Claude Code refuses to load a non-certified skill named that way, so it fails at install/validation, not just review (`[RESERVED_WORD_IN_NAME]`). Surfaced by dogfooding the skill against its own eval suite (the reviewer was noting the prefix as "redundant" but missing the install-blocking consequence). The rule directs the reviewer to surface that consequence when reviewing such a name and to include the warning when advising on naming.
- **`NON_PORTABLE_COMMAND` validation code (default `warning`) — a portability check family.** `vat skills validate` / `vat audit` now flag a skill document that tells an agent to run a GNU/Linux-only shell command, scanning the `SKILL.md` body **and every reachable bundled markdown doc** (agents copy invocations from reference files too). It's a family of sub-checks under one code — `timeout`, `grep-pcre` (`grep -P`), `sed-i-no-backup` (`sed -i` with no suffix), `readlink-f`, and `date-d` (GNU `date -d`) — each finding names the variant and carries a tailored fix, and a single `validation.allow` entry silences the whole family for a file. Patterns match commands in command position only (not bare prose), so `grep -E`/`sed -i.bak` and nouns like "the request will timeout" are not flagged. Promotes a former manual `vat skill review` checklist line into an automated check. See [`NON_PORTABLE_COMMAND`](docs/validation-codes.md#non_portable_command).
- **Authenticated link checking for private GitHub and SharePoint URLs (`resources.linkAuth`, issue #113).** Add a `resources.linkAuth` block to `vibe-agent-toolkit.config.yaml` and `vat resources validate` will authenticate requests to configured hosts instead of fetching anonymously — fixing the long-standing problem where private GitHub repository links and SharePoint pages always appear dead. Two built-in macros ship ready to use: `use: github` (token via `gh auth token`) and `use: sharepoint` (token from the `SHAREPOINT_TOKEN` environment variable); full inline providers are supported for any other private host. Authenticated responses surface as five new validation codes rather than the generic `EXTERNAL_URL_*` set: `LINK_AUTH_DEAD` (error — confirmed dead link on a host that does not mask unauthorized responses as 404, e.g. SharePoint), `LINK_AUTH_DEAD_OR_UNAUTHORIZED` (warn — 404 on a host like GitHub that may mask 403 as 404), `LINK_AUTH_FORBIDDEN` (warn — 403, token accepted but insufficient access), `LINK_AUTH_UNAUTHORIZED` (warn — 401, token missing or rejected), and `LINK_AUTH_UNVERIFIED` (warn — no token resolved; the link was skipped). Authenticated results cache per OS user under `<cacheDir>/auth-${user}/external-links.json`, so two runners on the same CI host cannot read each other's cache entries. Also ships `fetchAuthenticated(url, config)` as a new public export from `@vibe-agent-toolkit/resources` for retrieving the *bytes* of a private URL — useful when you need the file content, not just whether the link resolves. Pair it with the new optional `provider.fetch.headers` block to send different request headers for content retrieval than for link checking (e.g. `Accept: application/vnd.github.raw` to stream raw bytes inline versus `Accept: application/vnd.github+json` for the metadata-only link-health check).
- **Corpus seed expanded from 9 → 237 entries via a new committed importer at `packages/dev-tools/src/import-marketplace.ts` (`bun run import-marketplace [--allow-shrink]`).** The script fetches `.claude-plugin/marketplace.json` from `anthropics/claude-plugins-official` (205 of 209 raw entries kept) and `anthropics/knowledge-work-plugins` (30 of 60 — the knowledge-work catalog turns out to be ≈50% mirror entries of the official catalog) via `gh api`, maps each upstream entry to a `PluginEntry`, deduplicates by `source` URL (preserved VAT-owned entries always win; otherwise alphabetical-first-name wins within each duplicate cluster), and rewrites `corpus/seed.yaml`. Mapping rules: `bucket: official` uniformly (both catalogs are anthropics-curated marketplaces — `bucket` is the *reporting posture* per slice 1a, not code provenance); `confidence: first-party` for catalog-internal string sources and `github.com/anthropics/...` object sources, else `curated`; the `./partner-built/` knowledge-work convention overrides to `curated`; `maturity: production` for all entries. URL composition handles all five upstream source shapes (string, `git-subdir` ± `ref`, `url` ± `path`, `github`), throwing on unknown discriminators. The seven sample entries from slice 1a are regenerated from upstream manifests on every re-import. Re-import safety: the importer refuses to overwrite `corpus/seed.yaml` if either upstream catalog returned 0 plugins or the new entry count would drop more than 20% vs. the existing seed; `--allow-shrink` bypasses both gates for the rare case where shrinkage is real. The generated `seed.yaml` header dropped its earlier per-entry `validation:` claim (the importer throws on validation blocks today) and now states explicitly that entry `source` URLs pin a fragment ref (typically the default branch), not a per-entry commit SHA — the catalog SHAs in the header are this run's audit provenance. Issue #99 slice 1b — follows the schema change from PR #111 (slice 1a).
- **Empirical compatibility harness (`packages/dev-tools/src/compat-empirical/`).** Per-#100 research scaffold for measuring skill compatibility across `claude-code`, `claude-cowork`, and `claude-chat`: a CLI (`predict`/`run`/`judge`/`report`/`all`) that joins VAT's static predictions with deterministic runtime observations and an LLM-judge semantic read into a reality-vs-prediction matrix — an evidence artifact for proposing detector improvements that each cite specific (skill, runtime) cells. Probe coverage: multi-prompt + repeat-N with adaptive N=3→N=5 extension, mandatory positive+negative prompt pairing per corpus entry, and negative-prompt agreement inversion so false-positive triggers surface as `vat-optimistic`. Evidence quality: the deterministic class is widened from 6 to 9 values (splitting `error` into `install-failed`/`runtime-error`, `not-invoked` into `not-invoked-engaged`/`not-invoked-empty`, adding `refused`), with a v2 judge prompt that adds a `refused` verdict. Report fidelity: coverage stats, per-bucket headline (own/official/community × ran/agree/optimistic/pessimistic/gray-zone), gray-zone (mixed-signal) and high-variance subsections, and per-attempt variance rendered inline (`runtime-error (2/3) / failed (3/3)`). Judge replay persists `judge-calls/<skillId>-<promptId>-<target>-<attemptIdx>.json` artifacts that a new `re-judge` subcommand re-executes against an optionally different model or freshly-edited system prompt — without re-spending operator hours on the runtime side. Also landed: `git fetch --tags --force` before named-ref fetch (annotated tag refresh) and `setup()` teardown-first idempotency for the manual driver. No detector code or `RUNTIME_PROFILES` changes; lives entirely in the private `@vibe-agent-toolkit/dev-tools` package with no adopter-facing surface. Design: [the v2 harness design](./docs/research/2026-05-23-compat-empirical-harness-v2-design.md). Corpus authoring, the first real run, and the docs deliverable are the downstream work.
- **Cowork driver spike.** Added [`docs/contributing/cowork-driver-spike.md`](docs/contributing/cowork-driver-spike.md) — a time-boxed investigation (per §4a of the harness v2 design) of whether `claude-cowork` can be driven programmatically by the empirical compat harness today. Verdict: **not feasible**; cowork is a Claude Desktop app product with no public API/CLI surface. The `claude-cowork` runtime stays on `scripted-assisted` until Anthropic ships a Cowork CLI mode, Sessions API, or documented filesystem-import path. Adjacent finding (not a cowork replacement): the public-beta Skills API (`POST /v1/skills` + `container.skills[]` on `/v1/messages`) supports a fully-automatable *new* runtime — captured in the spike doc as a potential follow-up, gated on a separate design decision.
- **Subscription-only compat harness billing.** The harness now bills a Claude Pro/Max subscription instead of the API: both token-consuming surfaces (the `claude-code` runtime driver and the LLM judge) route through one shared `claude` CLI invoker (`runtimes/shared/claude-cli.ts`) that injects the operator's `CLAUDE_CODE_OAUTH_TOKEN` and deletes every API credential from the child env, so the CLI cannot fall back to API billing. The operator's own token is sourced at preflight — env var if set, otherwise an interactive prompt — so a run only ever spends the operator's personal plan. The judge was migrated off `@anthropic-ai/sdk` (dependency removed) onto the CLI, parsing a strict JSON verdict with one retry instead of the SDK's forced-tool call (`judge-system.md` now asks for a JSON object). `RunMetadata` gains `authMode` and the report methodology discloses subscription auth + parsed-not-forced verdicts. Premise (zero API billing under the OAuth token) still pending the manual smoke test.
- **Top-level `vat validate` command ([#128](https://github.com/jdutton/vibe-agent-toolkit/issues/128)).** A single command that runs the source-level validators the project's config declares — and only those: `resources validate` (when `resources:` is configured) and `skills validate` (when `skills:` is configured), in that stable order. Config is read from the resolved project root, so a run from a subdirectory still discovers the project's surfaces. Aggregates results and exits non-zero if any fail. A surface with no config block is skipped (no error, no noise, but a stderr warning if *nothing at all* is configured, so a config typo like `recources:` can't masquerade as a passing exit-0 run); `--only <surface>` restricts the run, and fails with **exit 1** whether the named surface is unrecognized or simply not configured — both are "you asked for a surface that can't run," and now share one exit code instead of splitting across 1 and 2. It is source-level only and **never requires a build**, so it is safe for pre-commit and CI-before-build, replacing the hand-composed `vat resources validate && vat skills validate` with one command. Decision (revisitable): marketplace-artifact validation is intentionally excluded — it runs against the built `dist/` tree, so it stays in `vat verify` (built mode) and `vat claude marketplace validate` (standalone) rather than coupling `vat validate` to a prior `vat build`.
- **First-class local HTML resources (#112).** `.html`/`.htm` files are now discovered, parsed, link- and anchor-validated, checked for well-formedness, and link-rewritten on bundle — using the same `ParseResult` contract and validation framework as markdown. A parse5-backed parser extracts `<a href>` and `<img src>` links plus `id`/`name` fragment anchors; `ResourceRegistry` routes HTML through it and persists optional `anchors`/`parseErrors` on `ResourceMetadata`. Anchor validation now uses a format-neutral fragment index (each file's markdown heading slugs or HTML `id`/`name`, with its case-matching policy carried per entry), enabling cross-format anchor checks (md↔html) with HTML ids matched case-sensitively and markdown slugs case-insensitively. A new `MALFORMED_HTML` code (default `info`) surfaces parser well-formedness diagnostics. On bundle, `<a href>`/`<img src>` values are rewritten by offset-splicing the original source (never re-serialized), so unchanged markup round-trips byte-for-byte and original attribute quoting is preserved (a rewritten value that would be unsafe unquoted is wrapped in quotes). Scope is `<a href>` + `<img src>` only; `<link>`/`<script>`/`<iframe>`/`<source srcset>`/CSS `url(...)` are deferred (asset/machinery references, not the content link graph). `<base href>` is not honored — relative hrefs resolve against the file's own directory (see the breaking note below for the `ResourceMetadataSchema` tightening that shipped with this work).
- **`DUPLICATE_RESOURCE_ID` validation code (default `error`).** When two files resolve to the same resource id after path normalization (e.g. `My Guide.md` and `my-guide.md` both → `my-guide-md`), `vat resources validate` now reports it as an `error` issue naming both files, instead of aborting the entire run with an uncaught `Duplicate resource ID` exception. Documented under [Resource Registry Codes](./docs/validation-codes.md).
- **Live audit/validate now sees source HTML links (issue #129 AC2).** `vat audit` / `vat skills validate` previously crawled `**/*.md` only, so links inside source `.html`/`.htm` files were invisible until build time. The live crawl now includes HTML (the registry already parses it via parse5), so the link-graph walker traverses HTML references and a broken local link inside a source HTML file surfaces as `LINK_MISSING_TARGET` at validate time, at parity with the built path's `PACKAGED_BROKEN_LINK`.
- **`LINK_DEFERRED_ARTIFACT` info code (issue #127, slice 2 of #129).** A `SKILL.md` link to a `files:`-declared artifact that doesn't exist yet (a dest built later, or a not-yet-created source) is no longer reported as a broken link — it downgrades from `LINK_MISSING_TARGET` to the new [`LINK_DEFERRED_ARTIFACT`](docs/validation-codes.md#link_deferred_artifact) info code at validate time, and `vat skills build` preserves and rewrites the link to the materialized dest instead of stripping it.

### Changed (breaking, pre-1.0)

- **`computeDeferredPaths` return type changed (issue #127, slice 2 of #129).** `computeDeferredPaths(files)` now returns `{ destPaths, sourcePaths }` instead of a flat `Set<string>` — a breaking API change (pre-1.0, intentional). Both `vat skills validate` and `vat skills build` now consume the deferred-path set (previously `deferredAssets` was silently dropped), and deferred dest/source paths resolve project-root-relative so the new behavior works for skills in subdirectories, not only at the project root. Plugin-local `files:` deferred paths remain out of scope for this slice (see [AC-10d](docs/architecture/skill-packaging.md#ac-10d--plugin-local-files-deferred-paths-are-out-of-scope-for-issue-127--slice-2-of-129)).
- **Directory links are now valid targets; `LINK_TARGETS_DIRECTORY` is narrowed to typed single-file slots (issue #126, slice 1 of #129).** A navigational local link that resolves to an existing directory (e.g. `[docs/](docs/)` in a ToC, README, or SKILL.md body) is no longer an error in `vat resources validate` or the skill-bundling link walk — previously any local link to a directory was a hard error. A renamed/deleted directory still fails via the ordinary broken-link path. `LINK_TARGETS_DIRECTORY` (still `error`) now fires **only** for a packaging `files:` *source* entry that resolves to a directory (the contract demands exactly one file). GitHub-style directory-index resolution (`docs/` → `docs/README.md`) is intentionally not implemented. Known limit (tracked for #129): a no-slash link such as `[Concepts](concepts)` that resolves to a directory is still treated as a file link; the slash form is the navigational case this slice covers.
- **`ResourceMetadataSchema` is now `strict()`.** Shipped with first-class HTML support (#112): the resource-metadata schema rejects unknown top-level fields instead of silently accepting them, so a typo or stale field in code that constructs `ResourceMetadata` now fails at parse time rather than passing through. Move any extra data into a recognized field or drop it.
- **Resource ids now carry a file-extension suffix.** `generateIdFromPath` appends `-<ext>` to every resource id (e.g. `guide.md` → `guide-md`, `guide.html` → `guide-html`, `README.md` → `readme-md`). This makes a markdown file and a same-stem HTML file distinct resources instead of colliding — the prerequisite for first-class HTML resources sharing a directory with their markdown source. Resource ids are internal, path-derived identifiers (never hand-authored in config or frontmatter), but anything that referenced an id by its old bare form must use the suffixed form — most visibly `vat rag query --resource-id` filters and re-indexed chunk ids (re-index to regenerate).
- **`vat resources validate` gains per-code severity configuration, and external-URL findings no longer fail the build by default.** Resource findings now use the same configurable severity framework as `vat skills`: each is a documented code (e.g. `LINK_BROKEN_FILE`, `EXTERNAL_URL_DEAD`) with a default severity, overridable per project under `resources.validation.severity` / `resources.validation.allow`. External-URL findings now default to `warning` and no longer flip the exit code (fixing a bug where they always failed the command); set their severity to `error` to restore failing. Severity now also accepts an `info` level. The never-implemented `resources.validation.checkLinks`/`checkAnchors`/`allowExternal` keys are removed.
- **`validation.severity` / `validation.allow` keys are validated against real codes.** A mistyped code key (e.g. `LNIK_OUTSIDE_PROJECT`) is now a config-load error instead of a silent no-op.
- **Corpus seed entries now require `bucket`, `confidence`, and `maturity` metadata fields.** `PluginEntrySchema` in `vat corpus scan`'s seed loader gains three required enum fields: `bucket: 'official' | 'community'`, `confidence: 'first-party' | 'curated' | 'listed'`, and `maturity: 'production' | 'experimental' | 'example'`. The bundled `corpus/seed.yaml` is updated; downstream callers running custom seeds must add the fields to every entry. `bucket` is the load-bearing discriminator (`official` entries report named findings; `community` entries are aggregate-only in follow-up work). The other two are descriptive metadata used by triage tooling.
- **`vat claude marketplace publish` no longer reports the project root `package.json` version in the CLI banner, commit message, status YAML, or CHANGELOG section lookup.** The label is now derived from the staged `marketplace.json`. Single-plugin marketplaces use the plugin's version — banner reads `Publishing marketplace "X" v0.0.4`, commit subject reads `publish v0.0.4`. Multi-plugin marketplaces drop the `v<X>` entirely — banner reads `Publishing marketplace "X"`, commit subject reads `publish X` — since the per-plugin `version` fields in the published `marketplace.json` are the source of truth for which plugin moved to which version. Two visible side-effects follow: (1) the status YAML's `published[*].version` field is now absent for multi-plugin marketplaces (previously it carried the misleading project version) — automation should read per-plugin versions from the published `marketplace.json` instead; (2) the stamped `## [X.Y.Z]` CHANGELOG lookup now uses the plugin's version rather than the project's, so a previously-ignored matching section will now be picked up as the commit body for single-plugin marketplaces. The `marketplace.json` schema's optional top-level `version` field is not yet consumed — that is a separate follow-up.
- **Adopter-facing `LinkAuthConfig` type renamed to `LinkAuthProjectConfig` (issue #113).** Both `@vibe-agent-toolkit/utils` (engine) and `@vibe-agent-toolkit/resources` (Zod-inferred adopter shape) previously exported a type named `LinkAuthConfig`, causing IDE auto-import ambiguity in any code that touched both. The adopter type — accessible as `import type { LinkAuthProjectConfig } from '@vibe-agent-toolkit/resources/schemas/link-auth'` — is the one renamed; the engine's `LinkAuthConfig` is unchanged (more API surface depends on it). Migration: rename the import. The Zod schema's name (`LinkAuthConfigSchema`) is unchanged.
- **External-link cache directory layout adds an `auth-${osUser}/` subdirectory and an entry `version: 1` field (issue #113 §6.3).** When `vat resources validate` runs with `resources.linkAuth` configured, authenticated-fetch results land under `<cacheDir>/auth-${sanitizedOsUser}/external-links.json` rather than the shared `external-links.json` used by the anonymous `markdown-link-check` path — two users on the same host (e.g. shared CI runners) cannot read each other's authenticated cache entries. All cache entries now carry an explicit `version: 1` field; entries written under a different (or missing) version are treated as a cache miss, so any pre-existing `external-links.json` triggers a one-time re-fetch on first run after upgrade. The `version` gate is forward-compat for slice 3's content-cache shape evolution.
- **`vat claude marketplace publish` no longer pushes per-plugin `<name>-v<version>` source-repo tags.** The post-publish tagging step (introduced alongside multi-plugin versioning) is removed entirely — no tags are created or pushed, and the misleading `Repository not found` / "tag already exists at a different commit" warnings it emitted on every cross-repo publish are gone ([#121](https://github.com/jdutton/vibe-agent-toolkit/issues/121)). The tags were pushed to the marketplace remote rather than a source remote, never landed anywhere useful, and there was no opt-in demand. Which plugin moved to which version is now determined solely by the per-plugin `version` fields in the published `marketplace.json`. No config key or flag is involved; if you relied on these tags, create them in your own release workflow.

### Fixed

- **`vat skill test` now verifies a per-run integrity nonce on `grading.json`, so untrusted skill code can no longer forge a passing result.** The experimenter writes `grading.json` into the harness results dir, which is inside the skill-writable sandbox (`--add-dir`, `bypassPermissions`) — an adversarial skill could therefore write or rewrite a passing `grading.json` that the harness would trust. The harness now stamps a secret per-run nonce into the experimenter prompt and requires `grading.json` to echo it in a top-level `runNonce`; a missing or mismatched nonce is rejected (exit 1). The nonce is delivered to the experimenter **only via stdin** — the prompt is no longer written to disk (`spawnHeadlessClaude` takes the prompt in memory), and the persisted `experimenter-prompt.txt` audit copy is redacted — so skill code cannot read the nonce back to forge a match. Surfaced by adversarial review; the harness still runs behind the `--i-understand-this-runs-skill-code` ack (this is defense-in-depth, not an OS sandbox).
- **A committed `test.*` config can no longer RAISE `vat skill test`'s built-in cost/runtime caps — only lower them.** `test.maxBudgetUsd` / `test.maxTurns` / `test.timeout` fed the same precedence slot as the CLI flags, so a subject repo you were merely testing could commit `maxBudgetUsd: 100` and silently bill a run far above the built-in $5 / 50-turn / 5-minute ceilings. A config-sourced value is now clamped to the built-in cap (with a one-line stderr note when clamped); a CLI flag, being explicit operator intent, may still exceed it. Surfaced by adversarial review.
- **`vat skill test` no longer cross-wires two injected plugins that share a directory basename.** The staged plugin-root dir was keyed on `basename(pluginDir)` alone, so two different `--with` plugins at e.g. `…/a/my-plugin` and `…/b/my-plugin` collided onto one staged root — the second silently inherited the first's `CLAUDE_PLUGIN_ROOT` and `.claude-plugin/` manifest, producing a misleading result. The staged segment is now keyed on the full resolved plugin path (basename kept as the readable slug, disambiguated by a hash of the full path).
- **A `files:` entry's `integrity: true` byte check is no longer silently skipped when the file was already link-bundled.** In `applyFilesConfig`, a non-glob entry whose source had already been materialized by link traversal short-circuited past the integrity verification — so a requested byte check simply didn't run for that file. The byte check now runs against the link-bundled dest (which lands at `entry.dest`) on the skip path, exactly as it would on the copy path.
- **A broken `vibe-agent-toolkit.config.yaml` is no longer silently ignored by `vat skill review` / `vat skill test` (regression fix).** The shared config walk-up (`loadConfigCached`, via `resolveSkillPackagingConfig`) swallowed a *present-but-broken* config to `undefined` — indistinguishable from "no config." That silently downgraded `vat skill review` (which previously errored on a bad config through the throwing `loadConfig`) and would let `vat skill test` apply defaults / stage the wrong subject against a config the author clearly intended. A broken config now raises a typed `ConfigLoadError` that skill-resolving commands surface (review reports it; `vat skill test` exits 2 with a clean message), while `vat audit` — a bulk linter that must keep scanning — explicitly catches it and falls back to config-free validation. An *absent* config still resolves to `undefined` as before. The error is cached so a broken config re-throws without re-parsing across a multi-skill scan.
- **`vat skill test run` now rejects a bad usage flag with a clean message and preflight exit code (2) instead of a raw stack trace.** Flag validation and config loading (`--auth`/`--require-auth` values, numeric `--max-turns`/`--max-budget-usd`/`--timeout`/`--stall`, the persisted test config) ran *before* the command's first `try`, so a malformed flag surfaced as an unhandled promise rejection (stack dump, exit 1). They now run inside a preflight guard: an unrecognized value prints `Error: --auth must be one of: …` and exits 2 without ever reaching the harness. `--auth`/`--require-auth` are validated on the run path too (previously only `configure` checked them), via a shared `auth-flags` helper so the two commands cannot drift. The `--dry-run` help no longer claims to print "the exact assembled command" (it shows the model flag; budget/turns/permission flags are added at spawn time).
- **`vat skill test`'s scrubbed-env deny-list now blocks the OS-linker and Node module-resolution code-injection vars.** A skill-under-test's committed config can forward named host env vars into the headless `claude` child via `test.passEnv`/`test.env`. The deny-list already refused `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS` (code injection before any userland code runs) but not their exact siblings — `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` (native `.so`/`.dylib` injection), `NODE_PATH` (module-resolution hijack), and `GIT_SSH_COMMAND` (arbitrary command on a `git:` source clone). These are now deny-only: a config naming one is ignored with a warning, the protected value wins. (The feature already runs behind an explicit `--i-understand-this-runs-skill-code` ack and a loud security warning; this closes a defense-in-depth gap surfaced by adversarial review.)
- **`vat resources validate` no longer flags inline `data:`/`blob:` resources as `LINK_UNKNOWN` warnings.** A `data:` URI embeds its own payload and a `blob:` URL references an in-memory object — neither has a target to fetch or an anchor to resolve, so there is nothing to validate. They previously fell into the "unknown link type" catch-all (any href containing `:` that wasn't `http(s)`/`mailto`) and surfaced as warnings, which is noise for the extremely common inline-image pattern (`<img src="data:image/svg+xml,…">`). A new `embedded` link type classifies them and skips validation, mirroring how `external`/`email` links are already skipped. Genuinely unrecognized schemes (`javascript:`, `tel:`, `ftp:`) still classify as `unknown`.
- **`vat resources validate` no longer emits false-positive `LINK_BROKEN_ANCHOR` errors for `#fragment` links in HTML files.** HTML fragment anchors are frequently resolved at runtime by client-side JavaScript — hash routers, SPA `#/route` links, hash-encoded query params (`#id=1&mode=x`) — rather than by a literal element `id`/`name` in the markup, and ids can also be injected dynamically at runtime. A static "id not found" is therefore not proof the link is broken. Anchor resolution is now **skipped for HTML targets by default**; markdown heading-anchor validation is unchanged and still errors on a genuine miss. A new `--check-html-anchors` flag (mirroring `--check-external-urls`) opts in to strict HTML anchor resolution for fully-static pages — and even then, structural non-anchors (`#/route`, `#k=v&…`) are skipped since they can never be element ids. This restores clean `vat verify`/`vat resources validate` runs for HTML/SPA projects, reported by an external adopter whose gating CI turned red on functional runtime deep-links.
- **`vat build` now fails when a shipped Claude plugin skill has a broken packaged link.** `vat claude plugin build` never ran a post-assembly link check on the plugin output tree — only the pool packaging path did. A plugin skill whose shipped links were broken (e.g. relative links that assumed pool-packaging relocation but the skill was verbatim tree-copied) previously shipped silently. `vat build` now runs the existing depth-free `checkBrokenPackagedLinks` check against every shipped skill dir after the `claude` phase and fails the build with a `PACKAGED_BROKEN_LINK` error on any dead link. The check is scoped per skill dir — a skill is a self-contained portable unit, so a link that escapes its own directory (even to a sibling skill that co-ships in the same plugin) is a broken shipped link.
- **`vat claude plugin build` no longer double-produces a skill that is both pool-selected and present in the plugin's own `skills/` source tree.** Tree-copy (verbatim, unaware of packaging) and pool-import (packaged, link-rewritten) never coordinated — a skill claimed by both mechanisms shipped as two coexisting copies at different depths inside the same `skills/<name>/` directory, with the raw tree-copy carrying un-rewritten (and therefore potentially dead) relative links. The plugin's resolved pool selector is now excluded from the verbatim tree-copy before it runs, so the pool-packaged copy is the sole source for a colliding skill; the build prints a warning naming the skill and both sources. Non-colliding tree-copy and pool-import usage is unaffected.
- **`validateSkill` no longer silently reports a boundary-escaping AND missing link as a warning-only boundary notice.** `validateLocalLink`'s boundary-escape check returned before the existence check ever ran, so a link that both escaped the skill directory boundary and pointed at a non-existent file was classified `LINK_OUTSIDE_PROJECT` (warning) and never surfaced as broken — this is why `vat claude marketplace validate` could report a shipped tree with a dead, boundary-escaping link as 0 errors. Existence is now checked before boundary classification: a missing target is always `LINK_INTEGRITY_BROKEN` (error), regardless of whether it also escapes the boundary. A link that escapes the boundary but resolves to an existing file is unaffected (still a warning).
- **Skill-test eval-suite schema hardened after an adversarial review of the Postel liberalization.** Four issues the `id`/passthrough widening introduced or left open, all verified against a real adopter's eval suites:
  - **String eval ids are now validated as filesystem-safe path segments** (`[A-Za-z0-9_-]+`). A string `id` names a per-eval working directory, and the experimenter substitutes it verbatim into `<workspaces>/<id>`; an id like `year:extraction` previously passed parse, then failed on Windows (illegal filename) — surfacing as a *misleading* "escapes the eval directory" copy error. Rejected at parse with a clear message instead. Hyphenated ids are unaffected.
  - **Numeric `1` and string `"1"` no longer slip past the uniqueness check.** Ids are deduped on their stringified form, since both name the same workspace directory and would otherwise silently clobber each other's staged files.
  - **A near-miss typo of the optional `files` field is now flagged** (`filez` → "did you mean files?"). Under plain `.passthrough()` such a typo was silently swallowed and the eval ran in an empty workspace. The check is a single-edit match scoped to recognized fields, so legitimate adopter extras (`name`, `category`, `notes`, `_category_note`) still pass through untouched.
  - **`stageEvalWorkspaces` no longer mislabels copy failures as containment escapes.** Containment (`joinUnderRoot`) and the filesystem copy are now in separate try/catch blocks, so a permission/illegal-filename/disk error reports accurately instead of as "escapes the eval directory."
- **Skill-test `expected_output` is now optional, and is fed to the grader as context when present.** The pass/fail verdict is always decided per `expectations` entry, so `expected_output` is no longer required (per Postel's Law) — this unblocks real adopter suites that grade with `expectations` alone. Previously the field was accepted but consumed by nothing; the experimenter prompt now passes it to the grader as the author's prose description of a correct result, informing judgment without becoming a checklist item. Still validated as a non-empty string when present.
- **`vat claude plugin build` now copies a tree-copied skill's `files:` artifacts into the distributed plugin (#127).** A skill that ships build-provided artifacts in its own directory via `files: [{ source, dest }]` but lives in a plugin's source tree was distributed by a verbatim tree-copy that skipped its `files:` step, so the shipped plugin was missing those artifacts. Build now applies each tree-copied skill's `files:` config into `skills/<name>/`, exactly as it already does for shared-pool skills — removing the need for an external inject-into-dist script (which VAT couldn't see, producing false `LINK_TO_GITIGNORED_FILE` and `missing-bundled-file` findings).
- **`vat verify` no longer false-flags skills in plugins distributed by verbatim tree-copy (`vat build --only claude`).** A plugin that ships its skills by copying its own `skills/` tree (`source:` set, `skills: []`) builds correctly, but two verify checks still assumed the shared-skill-pool model and failed a byte-correct artifact: `files-config-dests` looked for a skill's `files:` dests only under `dist/skills/<name>/` and missed the plugin tree where build actually wrote them, and `PUBLISHED_SKILL_NOT_IN_PLUGIN` was blind to `source:`, flagging every skill a tree-copy plugin ships. Both checks (and `vat build`) now agree on where a tree-copied skill lands, so the false failures are gone. (Whether private `.claude/skills/**` skills should count as "published" is unchanged and tracked separately.)
- **`ExternalLinkValidator.clearCache()` and `getCacheStats()` now operate on both caches (issue #113).** Slice 2 introduced a second cache instance for authenticated-link results (per-OS-user scoping); the existing `clearCache()` / `getCacheStats()` methods continued to touch only the anonymous cache, so an adopter rotating a token would see stale `401`/`403` entries until the auth cache TTL expired. Both methods now clear/sum across both caches.
- **`ExternalLinkCache` IO errors degrade to a cache miss instead of aborting validation (issue #113).** `loadCache()` previously threw on anything other than `ENOENT` / `SyntaxError` (e.g. `EACCES` on a permissions-restricted cache file, `EROFS` on a read-only filesystem); `saveCache()` had no try/catch (write errors propagated). A failed read / write on the status-cache file would abort the whole `vat resources validate` run. Both paths are now fail-soft: a read failure returns an empty in-memory cache, a write failure no-ops while the in-memory cache stays authoritative for the remainder of the run. Cost of a bad cache entry: one extra fetch. Cost of a bad cache entry under the previous behavior: the whole run.
- **Lazy-loaded embedding providers no longer mislabel model/runtime failures as "not installed" ([#118](https://github.com/jdutton/vibe-agent-toolkit/issues/118)).** `loadPipeline` in `transformers-embedding-provider.ts` wrapped both the dynamic `import('@xenova/transformers')` and the model download/inference in a single `catch` that always rethrew a fixed `@xenova/transformers is not installed` message, swallowing the real error (not even as `cause`) — so a model-download or `onnxruntime-node` native-backend failure on an installed package was reported as a missing dependency. The two failure modes are now separated: an import failure keeps the actionable install hint (now with the original error attached as `cause`), while a model/inference failure throws `Failed to load transformers model '<model>'` preserving `cause`. The sibling `onnx-embedding-provider.ts` was audited: its install-hint `catch` was already correctly scoped to the import alone, but its model download (`ensureModelFiles`) and session creation (`InferenceSession.create`) previously bubbled raw errors with no provider/model context, so they now throw `Failed to download ONNX model '<model>'` / `Failed to load ONNX model '<model>'` with `cause` preserved.
- **Transformers.js integration tests now skip on Windows CI instead of flaking.** `transformers-embedding-provider.integration.test.ts` and the Transformers.js block of `comparison.integration.test.ts` skip on Windows (in addition to skipping when the optional `@xenova/transformers` dependency is absent), matching the existing `onnx-embedding-provider` test. These tests download a model over the network and load the `onnxruntime-node` native backend — both flaky in Windows CI. Such a failure was previously mislabeled `@xenova/transformers is not installed` by an over-broad `catch` in the provider's `loadPipeline` (the package was installed; the model download/inference is what failed), which is also why an availability-only guard did not prevent it.
- **Config-first skill discovery now honors `..` in `skills.include` patterns.** `vat build`, `vat verify`, and `vat skills validate` all funnel through `discoverSkillsFromConfig`, which previously passed every include pattern to a single downward-only crawl rooted at `projectRoot` — so an include like `"../../docs/skills/*/SKILL.md"` (common in monorepos where SKILL.md sources live alongside, not inside, the package) silently matched zero skills. `vat audit` accepted the same config only because it has a separate filesystem-first walker. Each include pattern is now split into a literal base + glob remainder via `picomatch.scan`, patterns are grouped by their resolved absolute base, and the crawler runs once per base — making config-first discovery agree with audit. User-supplied excludes stay anchored to `projectRoot` so patterns like `docs/private/**` keep their original meaning, and a pattern resolving to a nonexistent base now silently produces zero matches.
- **Anchor validation no longer reports a false `LINK_BROKEN_ANCHOR` for un-indexed target files (#112).** Previously a fragment link to any file the resource registry had not parsed (e.g. a target outside the crawl) was reported as a broken anchor. Anchor checks now skip targets absent from the fragment index — affecting markdown and HTML alike — while genuinely missing fragments in indexed files are still reported.
- **`vat resources validate` no longer crashes on same-stem `.md` + `.html` sibling files (#116).** Making HTML first-class added `.html`/`.htm` to the crawl, and same-stem siblings (e.g. `index.md` + `index.html`) previously produced an uncaught `Duplicate resource ID` exception that aborted the whole command. Fixed by the extension-suffixed ids above (siblings now get distinct ids), with `DUPLICATE_RESOURCE_ID` as a graceful backstop for any genuine post-normalization collision.
- **Post-build link checks now cover bundled HTML (#116).** `checkBrokenPackagedLinks` and the unreferenced-file check previously scanned only `.md`, so a broken `<a href>`/`<img src>` inside a packaged `.html`/`.htm` file shipped with a green build. Both checks — and the reachability traversal — now extract HTML links via the same parser, so broken links in packaged HTML surface as `PACKAGED_BROKEN_LINK` (failing the build) and an HTML file referenced only by other HTML is no longer falsely flagged `PACKAGED_UNREFERENCED_FILE`.
- **Deferred-artifact existence parity in the link walker (issue #129 carry-forward).** `walk-link-graph`'s `checkDeferred` guarded only the `files:` *source* branch with `!existsSync`; the *dest* branch deferred unconditionally. An existing real file at a `files:` dest (e.g. a gitignored artifact already on disk) was therefore silently downgraded to the `LINK_DEFERRED_ARTIFACT` info code, masking a genuine `LINK_TO_GITIGNORED_FILE` / directory-target signal. Both branches now share the existence guard: a path is treated as deferred only when it does not yet exist on disk.
- **`computeDeferredPaths` resolves `files:` sources exactly as the packager does (issue #129 carry-forward).** The deferred-source set was computed with `resolve(projectRoot, source)`, which let an absolute-looking source escape the project root, while the packager copies with `resolve(join(projectRoot, source))`. The two now use the identical expression, so an absolute-looking source roots under the project root in both places and the deferred set matches what the build actually copies.

### Internal

- **Skill-test eval fixtures excluded from the remaining link/structure validators (CI hygiene, no adopter-facing change).** The intentionally-broken eval fixtures (`resources/skills/evals/**` — non-portable SKILL.md samples, a fake plugin for `vat audit`) are test input, not real docs/code. They were already excluded from the repo-root resource validation, ESLint, and repo-structure checks; now also from the `vat-development-agents` package config (so `vat verify`'s resources phase stops failing on the fixtures' deliberate `LINK_BROKEN_FILE`s) and the `project-validation` dogfooding system test (hardcoded exclude list). Every exclusion site cross-references the others.
- **Eval fixtures hold clean, realistic code — incidental smells removed.** Two fixtures carried code-quality issues unrelated to what their eval tests: the `release-notifier-plugin` notifier script (a payload that only needs to *exist* so `vat audit` can flag the skill's local-script dependency) now validates its `--changelog` path instead of opening it blind, and the `vat-knowledge-resources` starter config dropped a redundant `TODO` comment (the eval's prompt already states the task). Fixtures that are themselves the *subject under review* (e.g. the vat-agent-authoring analyzer the eval asks an agent to improve) keep their VAT-domain flaws by design.
- **Unified `resolveSkillSource` skill-source resolver (#132, foundation).** A `skill-source/` module in `@vibe-agent-toolkit/agent-skills` that materializes a typed source union (`workspace` / `npm` / `url(+sha256)` / `path` / `vendored`) to a hardened, content-addressed staged directory through a per-user, `0700`, uid-checked fetch cache. The git-URL parser moved from `@vibe-agent-toolkit/cli` to `@vibe-agent-toolkit/utils`. No user-facing CLI surface yet — this is the resolver consumed by `vat skill test`.
- **`corpus/seed.yaml` is now generated from the upstream Anthropic marketplaces (issue #99, slice 1b).** A committed importer (`bun run import-marketplace [--allow-shrink]`) fetches the `claude-plugins-official` and `knowledge-work-plugins` catalogs, deduplicates by `source` URL, and rewrites the seed — replacing the previously hand-maintained list. Re-import is guarded against accidental shrinkage (refuses to overwrite on a 0-plugin fetch or a >20% drop unless `--allow-shrink`); current entry counts and audit provenance live in the generated seed header.
- **Empirical compatibility harness (issue #100).** A research scaffold (`packages/dev-tools/src/compat-empirical/`) for measuring skill compatibility across `claude-code`, `claude-cowork`, and `claude-chat` — it joins VAT's static predictions with deterministic runtime observations and an LLM-judge read into a reality-vs-prediction matrix, as evidence for future detector improvements. Lives entirely in the private `dev-tools` package with no adopter-facing surface; no detector or `RUNTIME_PROFILES` changes. [Design](./docs/research/2026-05-23-compat-empirical-harness-v2-design.md).
- **Cowork driver spike.** [`docs/contributing/cowork-driver-spike.md`](docs/contributing/cowork-driver-spike.md) records a time-boxed finding that `claude-cowork` cannot currently be driven programmatically (no public API/CLI surface), so it stays on `scripted-assisted` in the compat harness. Notes the public-beta Skills API as a separate, fully-automatable runtime worth a future follow-up.
- **Subscription-only compat harness billing.** The compat harness now bills a Claude Pro/Max subscription via a shared `claude` CLI invoker (uses the operator's `CLAUDE_CODE_OAUTH_TOKEN` and strips all API credentials from the child env), instead of the API; the LLM judge migrated off `@anthropic-ai/sdk` onto the same CLI. Private `dev-tools` only — no adopter-facing surface.
- **Intent-aware skill-resource verdict engine (issue #129, slice 3).** Skill-resource validation now routes through a pure verdict engine (`packages/agent-skills/src/validators/rule-engine/`): `evaluate(ctx)` maps an intent-aware context to at most one validation code, and a single `materializeIssue` constructor sources severity/description/fix/reference from `CODE_REGISTRY` so docs, runtime, and tests cannot drift. This is a refactor of how the existing codes are produced — the built and live paths now share one engine instead of duplicated literals, with no change to which codes fire — guarded by a table-driven scenario harness that enforces one-code-per-context, registry equality, and an anti-workaround invariant on every code's `fix`.
- **Single-source rule catalog (issue #129 AC5).** `docs/validation-codes.md` gains a machine-readable skill-resource rule catalog (between `<!-- BEGIN:rule-catalog -->` markers) and a disambiguation map; a docs test enforces full cell-equality (severity/description/fix) with `CODE_REGISTRY` so the registry, docs, and runtime cannot drift.

## [0.1.38] - 2026-05-18

### Changed (breaking, pre-1.0)

- **`findProjectRoot` from `@vibe-agent-toolkit/utils` has new semantics.** It
  now walks `vibe-agent-toolkit.config.yaml` → `.git/` and returns
  `string | null` with no fallback to `cwd`. The previous workspace-anchored
  behavior (workspace `package.json` → git → `cwd`, returning `string`) moved
  to a new function: `findNodeWorkspaceRoot`, scoped to workspace `package.json`
  lookup only and also returning `string | null`. Migration: use
  `findNodeWorkspaceRoot` if you wanted Node-monorepo binary discovery; use
  `findProjectRoot` if you wanted the VAT authoring boundary. Either way,
  handle the `null` return — there is no more silent `cwd` fallback.

- **`resolveLocalHref` returns a discriminated union.** From
  `{ resolvedPath; anchor } | null` to one of `anchor_only | resolved |
  absolute_no_root | absolute_escapes_root`. The function exported from
  `@vibe-agent-toolkit/resources` now also accepts an optional `projectRoot`
  parameter. Leading-`/` markdown links and frontmatter URI-references now
  resolve against `projectRoot` per RFC 3986 §4.2 absolute-path-reference
  semantics — matching GitHub, MkDocs, Sphinx, Docusaurus, VuePress, Jekyll,
  Astro Starlight, Nextra, and MDN. Previously `safePath.resolve(sourceDir,
  '/docs/foo.md')` resolved to filesystem-absolute `/docs/foo.md`. The two
  new union kinds (`absolute_no_root`, `absolute_escapes_root`) surface to
  consumers as the existing `broken_file` issue with distinct messages — no
  new validation-code names. External callers destructuring the old return
  shape must update to switch on `kind`.

- **`ValidateLinkOptions.projectRoot` semantic narrowing.** In monorepos, the
  effective root for link validation is now the nearest
  `vibe-agent-toolkit.config.yaml` ancestor (or `.git/` ancestor), not the
  workspace root. Cross-package relative links (`../sibling-pkg/foo.md`) are
  still validated for file existence, case mismatches, and anchor resolution
  — path-based logic is unaffected. **The gitignore-safety gate, however,
  scopes to the sub-package's `projectRoot` only.** Adopters who own per-package
  `vibe-agent-toolkit.config.yaml` files in a monorepo and rely on
  workspace-wide gitignore checking for cross-package doc links must either
  move the config up to the workspace root or accept the narrower scope. In
  practice, the file-existence + anchor checks are what catch broken links;
  the narrower gitignore gate matches how VAT already treats links to
  truly-external files.

- **Some adopter configs may need `validation.allow.LINK_OUTSIDE_PROJECT`.**
  Because the effective `projectRoot` narrows in monorepos with per-package
  configs, cross-package links that previously passed under workspace-wide
  scope may now emit `LINK_OUTSIDE_PROJECT`. Add a `validation.allow` entry
  for the affected paths or `validation.severity` override at the config that
  governs the linking skill.

- **`Logger.warn` added to the CLI `Logger` interface.** The interface widened
  with a `warn(message: string): void` method that writes to stderr. If you
  implement the `Logger` interface directly (custom embedders, test doubles),
  add the method.

- **`excludeReferencesFromBundle` no longer masks cross-package links flagged
  as outside-project.** Under the new `projectRoot` model, `outside-project`
  fires before bundle-exclusion pattern match. If you used
  `excludeReferencesFromBundle` to hide cross-package links from audit, those
  links will now surface — switch to `validation.severity` or `validation.allow`
  on `LINK_OUTSIDE_PROJECT` for the relevant skill.

- **Skill packager rewrites frontmatter URI-references during packaging.**
  When a markdown file's collection has a `frontmatterSchema` configured, the
  packager now walks every schema-annotated URI-reference field (`format:
  uri-reference`, `uri`, `iri-reference`, `iri`) and rewrites the value with
  the same target-path lookup that drives body-link rewriting. Body and
  frontmatter URI-refs now agree on packaged paths, and inline comments on
  rewritten fields survive. Previously, packaged artifacts could ship with
  rewritten body links but stale source-path frontmatter pointers — a silent
  half-correct rewrite.

- **`@vibe-agent-toolkit/resource-compiler` now depends on
  `@vibe-agent-toolkit/resources`.** The markdown parser there goes through
  `openFrontmatter` so frontmatter comments survive into compiled output.
  Pure transitive consumers see no API change; embedders who installed
  `resource-compiler` standalone now pull `resources` too.

### Added

- **Canonical comment-preserving primitive for frontmatter edits:
  `openFrontmatter` from `@vibe-agent-toolkit/resources`.** Wraps `yaml`
  (eemeli) in a round-trip-safe editor with `get` / `set` / `setArrayItem` /
  `appendArrayItem` / `delete` / `toString` and a settable `body`. Comments,
  blank lines, key order, quoting style, anchors, and EOL survive on
  mutation. `openFrontmatter(x).toString()` is byte-identical to `x` until
  you mutate. Malformed YAML throws `FrontmatterParseError` with the
  underlying error on `.cause`. Use this instead of `gray-matter`,
  `front-matter`, or raw `yaml.parse` for any write path — those drop
  comments silently.

- **`createAjvWithUriFormats(options?)` from `@vibe-agent-toolkit/resources`** —
  Ajv factory pre-registered with the URI-family formats (`uri`,
  `uri-reference`, `iri`, `iri-reference`) plus the rest of the
  `ajv-formats` standard vocabulary. Use this anywhere downstream code
  compiles a schema that may reference those formats: vanilla
  `new Ajv({ allErrors: true })` throws `unknown format "uri-reference"
  ignored` under default strict mode, and adopters had to invent the
  workaround themselves. `iri` / `iri-reference` are registered as no-op
  validators (semantic validation is the caller's job — VAT uses
  `resolveLocalHref` for that). Ajv options pass through unchanged so
  callers control `allErrors`, `strict`, `verbose`, etc.

- **Three rewriter helpers sharing one `(href: string) => string` callback
  shape**, exported from `@vibe-agent-toolkit/resources`:
  - `rewriteBodyLinks(body, rewriteHref)` — inline links + reference
    definitions in the markdown body.
  - `rewriteFrontmatterFieldsAtPaths(editor, paths, rewriteHref)` — when you
    know the field paths by convention (`'meta.parent'`, `'adrs-cited[]'`).
  - `rewriteFrontmatterUriReferencesFromSchema(editor, schema, rewriteHref)`
    — when you have a JSON Schema and want every `format: uri-reference`
    field walked automatically. Compose with `rewriteBodyLinks` for the
    common file/folder-rename case.

- **New `markdown-rewriting` skill in the `vibe-agent-toolkit` Claude Code
  plugin** — steers any session about to programmatically edit markdown or
  frontmatter toward the comment-preserving primitives above. Includes the
  canonical file-move recipe (body + frontmatter together) and the
  schema-driven variant. Triggers on prompts like "rewrite references
  across these docs", "rename `/docs/specs/` to `/docs/architecture/`",
  "batch-update parent_spec".

- **URI-references in frontmatter are now a documented affordance.** Updates
  to two existing skills:
  - `vat-knowledge-resources` — explains the leading-`/` resolution
    + comment-preservation story for schema-annotated URI-ref fields.
  - `vat-skill-authoring` — recommends leading-`/` URI-refs for cross-document
    references in SKILL.md frontmatter and cross-links `markdown-rewriting`
    for programmatic edits.

- **Per-command `projectRoot` and config policies, documented and enforced.**
  Every `vat` command now declares its `projectRoot` policy (`required` /
  `tolerate null` / `loud-cwd` / `N/A`) and config policy (`required file` /
  `required fields` / `accept defaults` / `not used`) in `--help` output and
  in its CLI reference doc under `packages/cli/docs/` or `docs/cli/`. The
  canonical source is the new [Roots and Config — Canonical
  Concepts](docs/concepts/roots-and-config.md) doc. Run `vat <cmd> --help` to
  see the `Requirements:` block for any command.

- **Loud-cwd fallback for `vat resources scan` and `vat resources validate`.**
  When invoked without an explicit path and no `vibe-agent-toolkit.config.yaml`
  or `.git/` ancestor is found, these commands now fall back to `cwd` and emit
  a single stderr warning (`warn: no vibe-agent-toolkit.config.yaml or .git/
  ancestor; using <cwd> as projectRoot`) instead of failing silently or
  surprising the user. With an explicit path argument the path is used and no
  warning fires.

- **`docs/concepts/roots-and-config.md`** — single source of truth for the
  three-root model (`projectRoot` / `gitRoot` / `nodeWorkspaceRoot`), the
  config-then-git discovery ladder, the CLI-boundary discovery rule, the
  per-command policy matrix, and the loud-cwd fallback contract. Every
  command's `Requirements:` help block links to this doc.

### Removed

- `findConfigPath`, `findConfigFile` (from `packages/resources/src/config-parser.ts`),
  `findGoverningConfig`, `resetGoverningConfigCache`. Use `findConfigFile`
  from `@vibe-agent-toolkit/utils` for config discovery, and `findProjectRoot`
  + `loadConfigCached` for root + config loading at CLI boundaries. Cache
  resets: `resetGoverningConfigCache()` → `resetProjectRootCaches() +
  resetLoadedConfigCache()`.

### Performance

- **`vat audit` is faster on large scan targets.** Per-skill `projectRoot`
  lookup now hits a module-level cache pre-warmed during the scan descent, so
  large multi-skill audits no longer repeat filesystem walk-ups per skill.

### Fixed

- **Markdown links to directories now surface as `broken_file`.** Previously, links resolving to an existing directory (e.g., `/docs/`, `../`, or any href whose resolved path is a directory rather than a file) silently passed validation. They now emit `broken_file` with `Link target is a directory: <path>` and a suggestion to link to a file inside the directory.

- **Leading-`/` links no longer false-flag as path-traversal escapes when the project root traverses a symlink.** `isWithinProject` now canonicalizes both sides of the within-check symmetrically (via `realpathSync`). Previously, when `projectRoot` was a symlinked path — common on macOS (`/tmp` → `/private/tmp`), bind mounts, and CI containers — a legitimate `/foo.md` resolution to `projectRoot/foo.md` was incorrectly reported as `absolute_escapes_root` because only the file side was realpath'd. The same fix also corrects the latent identical bug in the pre-existing gitignore-safety gate of `validateLocalFile`.

- **`vat claude plugin install` post-install hints now point to the correct Claude Code slash command.** Both the standard and `--dev` install paths previously suggested `/reload-skills`, which is not a registered Claude Code CLI command — the real one is `/reload-plugins`. Docs (`packages/cli/docs/skills.md`, `docs/guides/distributing-vat-skills.md`, plugin READMEs, `vat-example-cat-agents` distribution doc) updated to match.

- **`vat resources validate` no longer floods stderr with `unknown format
  "uri-reference" ignored` warnings.** Ajv's default vocabulary doesn't
  include URI-family formats; with `format: uri-reference` first-class in
  frontmatter, the validator used to log one warning per occurrence (often 20+
  per validate run). The validator now registers `ajv-formats` against its
  Ajv instance, which silences the warnings without changing semantics — VAT's
  own walker validates URI-ref hrefs against `resolveLocalHref`, not Ajv's
  format definitions. Adopter-surfaced cleanup.

## [0.1.37] - 2026-05-16

### Fixed
- **`vat resources validate` no longer rejects unquoted ISO dates in frontmatter.** `js-yaml`'s default schema still applies the YAML 1.1 `!!timestamp` tag, silently promoting `date: 2026-04-15` to a JavaScript `Date` object. Schemas typed `{ "type": "string" }` then failed with `got: "2026-04-15T00:00:00.000Z". Expected type: "string"`. VAT now parses frontmatter (and all internal YAML) with the YAML 1.2 spec (js-yaml's `CORE_SCHEMA`), so unquoted ISO dates stay as strings — matching `yaml` (eemeli/yaml) and YAML 1.2 defaults across the ecosystem. Adopters with ADR/PRD frontmatter using the conventional unquoted date format no longer have to quote every date field. Norway-style booleans (`yes`/`no`/`on`/`off`) and octal literals were already handled correctly by js-yaml v4 defaults.

- **Clearer diagnosis when a `frontmatterSchema` resolves to a missing file.** When a `frontmatterSchema` configured as an npm bare specifier resolves through the package's `exports` map to a path that doesn't exist on disk (typically because the publishing package shipped its `exports` field but its build never wrote the artifact — e.g. a broken Windows-only main-module check in the publisher's `gen-schemas` script), `vat resources validate` now names the missing file, says "does not exist on disk", and points at the publisher's build. The previous generic "Cannot find module … Check the package's exports field, or run install in `<baseDir>`" message sent adopters hunting for install-state or path-separator bugs. `ERR_PACKAGE_PATH_NOT_EXPORTED` and "package not installed" remain distinct failure modes with their own messages.
- **`validation.allow` entries now match paths under dotfile directories.** `validation.allow[CODE].paths` globs like `**/*` and `**/SKILL.md` previously failed to match any path traversing a dotfile directory (`.claude/skills/...`, `.worktrees/<branch>/...`, `.config/...`). Allow entries on skills under those locations silently never applied, so suppressed `CAPABILITY_*` issues kept emitting and `unused` records stayed empty even when the allow was correct. Latent since `0.1.30`.
- **`excludeReferencesFromBundle` rules now match links under dotfile directories.** Same root cause: `excludeReferencesFromBundle` patterns silently failed to drop bundle references whose paths traversed a dotfile dir. Bundles included files the config asked to exclude.
- **`vat audit --exclude` patterns now match paths under dotfile directories.** Same root cause: `vat audit ~/.claude/plugins --exclude '**/foo'` silently ignored the exclude on dotfile-traversing paths.

## [0.1.36] - 2026-05-16

### Added
- **Frontmatter URI-reference link validation.** `vat resources validate` now walks frontmatter values at JSON Schema positions with a URI-family format (`uri-reference`, `uri`, `iri-reference`, `iri`) and validates them through the same engine as markdown links — file existence, anchor resolution, gitignore safety. Absolute URLs in those fields feed into the existing external URL health-check pass when enabled on the collection. Default-on for any collection whose schema declares those formats; opt out via `validation.checkFrontmatterLinks: false` per collection or the global CLI flag `--no-check-frontmatter-links`. Four new issue codes (`frontmatter_link_broken`, `frontmatter_anchor_missing`, `frontmatter_link_to_gitignored`, `frontmatter_unknown_link`) — see [`docs/validation-codes.md`](docs/validation-codes.md). Full guide: [`docs/guides/collection-validation.md#frontmatter-link-validation`](docs/guides/collection-validation.md#frontmatter-link-validation).
- **npm bare specifiers for `frontmatterSchema`.** Collection `frontmatterSchema` in `vibe-agent-toolkit.config.yaml` and the `vat resources validate --frontmatter-schema` flag now accept npm bare specifiers (`@scope/pkg/schemas/foo.json` or `pkg/schemas/foo.json`) in addition to filesystem paths. VAT resolves them from your project's `node_modules`, honoring the target package's `exports` map — so schema-publishing packages own their internal layout and consumers don't hardcode `dist/` paths. Filesystem-path behavior is unchanged. Full guide: [`docs/guides/collection-validation.md#schema-paths`](docs/guides/collection-validation.md#schema-paths).

## [0.1.35] - 2026-05-09

### Added
- **Multi-plugin marketplaces with independent versioning.** Each plugin in a marketplace can now declare its own version (in `plugins/<name>/.claude-plugin/plugin.json:version` or via the marketplace config's per-plugin `version` field), get its own per-plugin source-repo tag (`<plugin>-v<version>`) on `vat claude marketplace publish`, and ship its own CHANGELOG (default `<plugin.source>/CHANGELOG.md`, override via the per-plugin `changelog` field) bundled into the published marketplace at `plugins/<name>/CHANGELOG.md`. The published `marketplace.json` includes `version` per plugin entry when defined. Marketplaces with no per-plugin version inherit the root `package.json:version` (backwards compatible — exercised by integration test scenario 3 against an existing adopter marketplace shape). Unblocks a multi-plugin adopter marketplace where each topical plugin must version and release independently.

### Changed
- **Version precedence in `mergePluginJson` flipped.** When both a marketplace-config version and a `plugin.json:version` are present, config wins (with a reconciliation warning); when only `plugin.json:version` is present, it now wins over the root `package.json` version. Previously the root version always won. Single-version marketplaces (no per-plugin version anywhere) are unaffected.

## [0.1.34] - 2026-05-06

### Added
- **`vat inventory <path>`** — new top-level command emitting structural YAML/JSON for plugins, marketplaces, skills, and installs (`schema: vat.inventory/v1alpha`). Runs no validators; pure structural enumeration. Supports `--user`, `--shallow`, and `--format json|yaml`. The same inventory model is now the single substrate for `vat audit` — adopters who want to script structural questions about their plugins (declared vs. discovered components, parse errors, cross-references) can do so without re-walking the filesystem.
- **`vat corpus scan [seed-file] --out <dir>`** — audit and (with `--with-review`) review multiple plugins in one run. Reads a YAML seed of tracked plugins, audits each, and aggregates per-plugin output. Per-entry `validation:` overrides silence findings on a per-plugin basis. Ships with a starter `corpus/seed.yaml` of 11 plugins.
- **`vat audit` accepts a git URL.** Pass HTTPS, SSH, GitHub-shorthand (`owner/repo`), GitHub web URL, or `file://`, optionally with `#ref:subpath`. Shallow-clones, audits, cleans up. Auth is passthrough to your local `git` — VAT reads no tokens. `--debug` preserves the cloned tempdir.
- **`vat claude plugin build`** — bundle commands, hooks, agents, MCP servers, scripts, plugin-local `SKILL.md` files, and `plugin.json` from a `plugins/<name>/` directory into a self-contained Claude Code plugin (tree-copied verbatim, `.gitignore`-respecting). Pool-skill import via `marketplace.plugins[].skills` (`"*"` or `[names]`) preserved. New marketplace fields: `source` (path override) and `files[]` (compiled-artifact mappings). Case mismatches between declared plugin names and on-disk dirs fail the build.
- **`skill-claude-plugin` recognized as a distinct artifact shape.** A skill that self-publishes as a Claude plugin by co-locating `.claude-plugin/plugin.json` alongside its root `SKILL.md` now produces independent `agent-skill` and `claude-plugin` validation results. New `SKILL_CLAUDE_PLUGIN_NAME_MISMATCH` warning fires when the manifest name disagrees with the SKILL.md `name`.
- **Eleven new validation codes.**
  - Seven cross-walked from Anthropic's `plugin-dev` skill, all `info` severity per the rule-addition policy: `PLUGIN_MISSING_DESCRIPTION`, `PLUGIN_MISSING_AUTHOR`, `PLUGIN_MISSING_LICENSE`, `PLUGIN_NAME_NOT_KEBAB_CASE`, `SKILL_NAME_NOT_KEBAB_CASE`, `SKILL_REFERENCES_BUT_NO_LINKS`, `SKILL_BODY_NOT_IMPERATIVE`. Additive observability — no existing audit will newly fail.
  - Four structural codes derived from the inventory model:
    - `COMPONENT_DECLARED_BUT_MISSING` (warning) — manifest declares a component path that's absent on disk.
    - `COMPONENT_PRESENT_BUT_UNDECLARED` (info) — component exists under canonical layout but the manifest's explicit list omits it; the runtime will silently skip it. Fires only when `declared !== null`; auto-discovery (a missing field) is intentional and not flagged.
    - `REFERENCE_TARGET_MISSING` (error) — a manifest-resolved cross-component reference (hook script, MCP path) points at a missing file.
    - `MARKETPLACE_PLUGIN_SOURCE_MISSING` (error) — a marketplace declares a path-source plugin that doesn't exist.
- **Three `[VAT]` manual checklist items in `vat-skill-review.md`** for judgment calls automation can't make: description names concrete trigger phrases, description disambiguates from sibling skills, body avoids duplicating reference content.

### Changed
- **`vat audit <marketplace-dir>` now recurses into co-located, path-source plugins.** Previously a marketplace audit scanned only the manifest; plugins declared via `./plugins/<name>` were silently skipped. Each path-source plugin in `discovered.plugins[]` is now audited via the same plugin pipeline. Adopters who run `vat audit` against a marketplace directory in CI will see findings for the contained plugins and their skills (e.g., `vibe-validate.git#claude-marketplace`: 1 file scanned → 10). Git/npm sources stay out of scope.
- **Breaking (pre-1.0):** `ClaudePluginSchema`, `ClaudePlugin`, `ClaudePluginJsonSchema`, and `validatePlugin` moved from `@vibe-agent-toolkit/agent-skills` to `@vibe-agent-toolkit/claude-marketplace`. `agent-skills` is now vendor-neutral. Update imports.

### Documentation
- New `docs/architecture/skill-packaging.md` enumerates the four packaging shapes (standalone skill / skill-claude-plugin / claude-plugin / claude-marketplace) and the inventory model.
- New "Plugin Inventory Codes" section in `docs/validation-codes.md` and a "Declared vs discovered components" subsection in `docs/skill-quality-and-compatibility.md` document the tri-state declared/discovered model and the empirical Claude Code loader behavior behind it.

## [0.1.33] - 2026-04-21

### Added
- **Cross-platform ESM helpers in `@vibe-agent-toolkit/utils`.** Two new exports address Windows path footguns that can bite adopters once their code runs on Windows CI:
  - `resolveFromImportMeta(importMetaUrl, ...segments)`: OS-native absolute path from a module's `import.meta.url` and optional relative segments. Use instead of `new URL(rel, import.meta.url).pathname`, which returns `/D:/...` on Windows and breaks `fs` operations.
  - `dynamicImportPath<T>(absPath)`: wraps `await import(pathToFileURL(absPath).href)`. Use instead of `await import(absPath)` on an OS-native filesystem path — the bare form throws on Windows (ESM dynamic import requires a `file://` URL there).
- **Two new local ESLint rules** (registered in `@vibe-agent-toolkit/dev-tools/eslint-local-rules` and wired as `error` in the root `eslint.config.js`):
  - `local/no-url-pathname-for-fs`: flags `.pathname` access on `new URL(..., import.meta.url)`. Message points at the new `resolveFromImportMeta()` helper or `fileURLToPath()`.
  - `local/no-bare-dynamic-import-path`: flags `await import(expr)` where `expr` is a computed filesystem path (absolute literal, `path.join/resolve` result, path-shaped identifier). Message points at the new `dynamicImportPath()` helper or `pathToFileURL(p).href`. Intentionally narrow heuristic with one documented false-positive escape hatch (suppress per-line with `eslint-disable-next-line local/no-bare-dynamic-import-path` when the identifier already holds a `file://` URL).
  - RuleTester-based unit tests land alongside the rules via a shared harness (`packages/dev-tools/test/eslint-rule-test-harness.ts`). Adding a new local rule is now one row in `local-eslint-rules.test.ts`, not a new test file.
- Three new skill-smell validation codes (all default `warning`, per skill-smell philosophy):
  - `SKILL_FRONTMATTER_EXTRA_FIELDS`: frontmatter contains keys beyond the standard agentskills.io + Claude Code set. Allowed keys derive from `AgentSkillFrontmatterSchema` at module load, so the rule tracks the schema. Actionable when adopters put project-specific fields (`version:`, `tools:`, `permissions:`) at top level — `metadata.*` is the right home for custom data.
  - `SKILL_CROSS_SKILL_AUTH_UNDECLARED`: body prose declares a sibling-skill or `ANTHROPIC_*_KEY` dependency (e.g., "Requires `vibe-agent-toolkit:vat-enterprise-org`", "Requires `ANTHROPIC_ADMIN_API_KEY`") but the description omits it. Narrow heuristic to keep false-positive rate low; bare `ANTHROPIC_API_KEY` (the universal Claude-API default) is explicitly excluded.
  - `SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE`: detects mixed YAML scalar styles across sibling skills' `description` frontmatter in the same package. Detector registered and documented; pipeline wiring deferred to a follow-up RC (requires a package-level aggregation pass that the current single-file validator pipeline does not provide).

### Changed
- **Config model clarified: one `vibe-agent-toolkit.config.yaml` per VAT project; no composition across projects.** `vat audit` no longer walks the filesystem looking for every nested config under the scan path. Instead, for each SKILL.md it discovers, it walks up to the skill's nearest-ancestor config (if any) and applies only that skill's `skills.config.<name>` packaging rules to the finding. This removes the federated-skill-discovery behavior that was never a documented or intended feature. Lifecycle commands (`vat build`, `vat verify`, `vat skills validate`, `vat skills build`) continue to use exactly one config — the one at their cwd — as they have all along. Adopters who ran `vat audit <ancestor-path>` against monorepos with multiple per-package configs should now run `vat audit` inside each project directory (or use `--cwd`) for per-project validation. When audit encounters a non-scan-root `vibe-agent-toolkit.config.yaml`, it emits a one-time info breadcrumb so operators see which configs were observed. Performance: `vat audit .` on the VAT monorepo drops into the sub-second range because the tree walk is bounded to skill discovery, not to config discovery.
- `actions/checkout` and `actions/setup-node` bumped from `@v4` to `@v6` across `.github/workflows/*.yml`. Runs on Node 24; removes the Sept-2026 deprecation warning on `v4` runners.

### Fixed
- **Windows path-normalization regression in `GitTracker.isIgnored()`.** The cache was populated at init with `safePath.resolve(projectRoot, relPath)` (which drive-prefixes on Windows, e.g. `C:/project/README.md`), but `isIgnored()` queried the cache with the raw caller-supplied path. Every lookup missed on Windows and fell through to spawn `git check-ignore`, triggering three `packages/utils/test/git-tracker.test.ts` performance-assertion failures on every Windows CI run since rc.2. Fix normalizes the lookup key to match population. Sibling methods `hasActiveDescendant` and `isIgnoredByActiveSet` already normalized correctly; `isIgnored` was the outlier. Added a POSIX-visible regression test using a non-canonical path (containing `..`) so the invariant is guarded against future changes that might reintroduce raw-path lookups.
- **Windows infinite loop in `findConfigPath()` when scanning paths outside a VAT-configured project.** The root-detection used a hardcoded `/`, which never matches Windows drive roots (`C:\`, `D:\`), causing the walk-up loop to spin indefinitely. Fixed via `path.parse(dir).root` + `dirname()` with a `parent === currentDir` safety break so traversal halts at the filesystem root on every OS. Manifested as `vat audit` hangs on Windows whenever the scan target (or the caller's cwd for a `.` scan) had no `vibe-agent-toolkit.config.yaml` ancestor — common for temp-directory test fixtures and any audit run outside a project.
- Stale JSDoc examples referencing `vibe-agent-toolkit:resources` (renamed to `vibe-agent-toolkit:vat-knowledge-resources` during the 0.1.32 plugin restructure) replaced with `vibe-agent-toolkit:vat-audit` in `packages/cli/src/commands/claude/plugin/build.ts`, `packages/cli/src/commands/skills/build.ts`, `packages/agent-schema/src/package-metadata.ts`, and the companion test constant.
- **`duplication-check` now runs on Windows.** Previously it was skipped because `@jscpd/finder` calls `realpathSync()` on the input patterns, which on Windows fails when paths contain `..`/glob patterns and prevents the report from being generated (upstream issue [jscpd#143](https://github.com/kucherenko/jscpd/issues/143), unfixed since 2020). The fix ships as a Bun `patchedDependencies` entry at `patches/@jscpd%2Ffinder@4.0.4.patch` — Bun applies it automatically on `bun install`. The patch is a two-line removal of the `realpathSync()` call; jscpd doesn't depend on the resolved path for anything downstream. Cross-platform baseline portability is ensured by a companion change: `jscpd-check-new.ts` and `jscpd-update-baseline.ts` now normalize clone paths to forward slashes via `toForwardSlash()`, so a baseline captured on Linux/CI matches when `duplication-check` runs on Windows (where jscpd reports backslashes).
- **`safeExecSync` / `safeExecResult` in `@vibe-agent-toolkit/utils` no longer silently fail on Windows under Node 24+.** When the resolved command was a shell wrapper (`.cmd`/`.bat`) — e.g. `npx.cmd`, `bunx.cmd`, `npm.cmd` — the previous code passed args through `shell:true` as a separate array, which Node 24 rejects with `EINVAL` per [DEP0190](https://nodejs.org/api/deprecations.html#DEP0190) whenever any arg contains a shell metacharacter (`*`, `?`, `(`, `)` …). Symptom: the spawned process would fail immediately and produce no output, leaving callers to misattribute the crash to the downstream tool. Fix joins the command and args into a single string when the shell path is needed, keeping `shell:false` + absolute-path spawning as the default for all non-wrapper commands (the secure path). Was the actual reason `bun run duplication-check` failed on Windows CI even after the jscpd patch landed.
- **Windows `bun install` postinstall failures from `link-workspace-packages.ts`.** The postinstall script created workspace symlinks with `symlinkSync(target, link, 'dir')`, which requires the `SeCreateSymbolicLinkPrivilege` admin right on Windows and fails with `EPERM` in non-elevated shells. Fix uses directory **junctions** on Windows (`symlinkSync(absoluteTarget, link, 'junction')`) — junctions don't require elevation and are transparent to both Node's ESM resolver and Bun's workspace linking. POSIX platforms continue to use relative-path `'dir'` symlinks as before. Windows developers can now `bun install` in a standard (non-admin) shell.

### Performance
- **Walker unification on `GitTracker`.** Every `vat audit` / `vat skills validate` / `vat verify` scan now shares one pre-populated `GitTracker` per repo. The tracker pre-loads the full active file set (tracked + untracked-not-ignored) via `git ls-files --cached --others --exclude-standard`, precomputes the ancestor directory set, and answers every ignore check from an in-memory `Set` instead of spawning `git check-ignore`. Per-directory `gitCheckIgnoredBatch` calls and per-link `isGitIgnored` calls are gone from the hot paths in `packages/cli/src/commands/audit.ts`, `packages/agent-skills/src/walk-link-graph.ts`, `packages/agent-skills/src/validators/packaging-validator.ts`, and `packages/discovery/src/scanners/local-scanner.ts`. `@vibe-agent-toolkit/utils` **removes the `gitCheckIgnoredBatch` export** (no remaining in-tree or external callers); `isGitIgnored` is kept as the single-spawn fallback for code paths that don't have a tracker threaded in (e.g. one-off callers in `link-validator.ts` and `walk-link-graph.ts`).
- **Shared `ResourceRegistry` across skills in `vat skills validate`.** When a single `vat skills validate` invocation covers multiple skills that share one project root, the command now builds one crawled/link-resolved `ResourceRegistry` once and reuses it for every skill's validation instead of re-parsing the same markdown per skill. Heterogeneous scans (mixed project roots) transparently fall back to per-skill registries.
- **Measured wall-time (median of 3 runs on the VAT monorepo, M-series laptop):**
  - `vat audit .`: 6.85s → 2.50s (~2.7x, under the 3s target set in the rc.1 plan)
  - `vat verify --cwd packages/vat-development-agents`: 12.68s → 2.85s (~4.4x)
  - `vat skills validate packages/vat-development-agents`: 10.05s → 1.44s (~7x)
- No observable output changes for `vat audit` / `vat skills validate` / `vat verify` — YAML output diffs clean pre/post across all three commands except wall-time fields. One internal shift worth noting: `@vibe-agent-toolkit/discovery`'s `LocalScanner.scan()` now instantiates and eagerly `initialize()`s a `GitTracker` on every call so in-project gitignore checks are O(1); this adds a single `git ls-files` spawn per scan invocation (was effectively a no-op when only one file was scanned). New `GitTracker` APIs (`hasActiveDescendant`, `isIgnoredByActiveSet`) are non-breaking additions; `initialize()` accepts an options bag with `includeUntracked` defaulting to `true`.
- **Final spawn sweep (post-rc.3).** Two independent spawn-eliminations that together recover the rc.2 baseline and beat it for single-config projects. (1) `vat audit` now caches `discoverSkillsFromConfig` by governing-config root, so per-skill walk-up resolution no longer re-expands the same config's globs N times for an N-skill package. (2) `packages/resources/src/link-validator.ts` switched both `gitTracker.isIgnored()` call sites (source + target) to `isIgnoredByActiveSet`, which answers O(1) against the pre-populated active set for in-project paths. Link validation fires per link and skills typically have dozens of links, so this was the largest remaining spawn source in the audit hot path. Post-fix medians (M-series Mac, 3 runs): VAT self `vat audit .` ~2.5s (recovered rc.2 baseline after rc.3's ~12% regression); vibe-validate `vat audit .` 0.96s → ~0.20s (~5x faster); a large adopter monorepo `vat audit .` 5.43s → ~4.0s. Windows sees roughly 2x these wins since process-spawn overhead there is ~10x higher than on Linux.

## [0.1.32] - 2026-04-19

### Added
- **Evidence substrate** (`@vibe-agent-toolkit/agent-skills/evidence`). Parsers produce neutral `EvidenceRecord`s with stable pattern IDs from `PATTERN_REGISTRY`; a derivation step rolls evidence into capability `Observation`s; a verdict engine compares observations against declared targets. Designed so pattern refinement never changes the observation contract.
- **`vat audit --verbose`** renders the evidence chain beneath each `CAPABILITY_*` observation — pattern ID, file, line, match text — and includes an `evidence[]` array in YAML output. Use it to debug false positives or confirm what a detector actually saw.
- **Runtime profile table** (`RUNTIME_PROFILES` in `@vibe-agent-toolkit/claude-marketplace`) is the single source of truth for what each Claude runtime provides and lacks (local shell, browser, network level, preinstalled binaries).
- **Verdict engine** (`computeVerdicts`) combines capability observations with declared targets to produce `COMPAT_TARGET_*` issues. Four states: expected (silent), `COMPAT_TARGET_INCOMPATIBLE` (warning), `COMPAT_TARGET_NEEDS_REVIEW` (warning), `COMPAT_TARGET_UNDECLARED` (info).
- **Config-level `targets` declaration** in `vibe-agent-toolkit.config.yaml` under `skills.defaults.targets` and `skills.config.<name>.targets`. Declaring targets suppresses non-applicable compat verdicts.
- **Marketplace-level `defaults.targets`** in `.claude-plugin/marketplace.json`. Layer priority (highest to lowest): `plugin.json` → `marketplace.json` → `vibe-agent-toolkit.config.yaml`.
- **Post-build validation**: `vat skills build` runs the full validation suite against built `dist/skills/*/SKILL.md` (skipping source-only codes like `LINK_OUTSIDE_PROJECT`). Build failures surface identically to source failures.
- **`info` severity** in the validation framework. `CAPABILITY_*` and `COMPAT_TARGET_UNDECLARED` emit as info; they appear in output and respect `validation.severity` overrides but do not contribute to build failure status.
- New validation codes: `CAPABILITY_LOCAL_SHELL`, `CAPABILITY_EXTERNAL_CLI`, `CAPABILITY_BROWSER_AUTH` (info); `COMPAT_TARGET_INCOMPATIBLE`, `COMPAT_TARGET_NEEDS_REVIEW` (warning); `COMPAT_TARGET_UNDECLARED` (info).
- Validation-rule-design doc at `docs/validation-rule-design.md` articulating rule-addition bar, default severity posture, graduation path, and data-driven evolution. Referenced from `docs/validation-codes.md`.
- Cached Anthropic skill-authoring best-practices doc at `docs/external/anthropic-skill-authoring-best-practices.md` with attribution, source URL, and fetch date. Provides a diffable reference so VAT's tooling stays aligned with upstream Anthropic guidance. CLAUDE.md documents the periodic-refresh policy.
- `vat-skill-review.md` (formerly `skill-quality-checklist.md`) rewritten with `[A]` / `[VAT]` tags distinguishing Anthropic-aligned items from VAT-opinionated additions. Added gerund-form naming guidance (Anthropic's preferred pattern), frontmatter-key conservatism, cross-skill dependency disclosure, in-package YAML-styling consistency, and large-tables-to-reference-files guidance — all from dogfood findings across 17 real skills (8 from an adopter repo + 1 vibe-validate + 8 VAT dev-agents).
- Five new skill-quality validation codes, all non-blocking:
  - `SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT` (warning): description > 250 chars — Claude Code's `/skills` listing truncation limit since v2.1.86.
  - `SKILL_DESCRIPTION_FILLER_OPENER` (warning): description opens with `This skill...`, `A skill that...`, `Used to...`, `Use when you want to...`, or `Use when you need to...`.
  - `SKILL_DESCRIPTION_WRONG_PERSON` (warning): description uses first- or second-person voice (Anthropic: "Always write in third person").
  - `SKILL_NAME_MISMATCHES_DIR` (warning): frontmatter `name` differs from the parent directory name.
  - `SKILL_TIME_SENSITIVE_CONTENT` (info): body contains `as of <month> <year>`, `after <month> <year>`, etc. — will go stale.
- `vat audit` and `vat skills validate` now print a checklist-discovery footer when skill-level findings are present, pointing at the `vat-skill-review` skill for rationale and judgment-call items.
- **`vat skill review <path>` command**: deep-review a single skill. Combines `validateSkillForPackaging` output, config-aware compat verdicts (when inside a VAT project), and a manual-checklist walkthrough into one report. Groups automated findings by checklist section (Naming / Description / Body structure / References / Frontmatter hygiene / Compatibility). Supports `--yaml` for machine-readable output. Designed as a thin composition over existing primitives, not a new validation pipeline.
- **MCP interpreter observations**: the `.mcp.json` scanner's `MCP_SERVER_COMMAND` evidence now rolls up into a `CAPABILITY_EXTERNAL_CLI` observation when the command is a python interpreter (`python`, `python3`, `python3.11`, absolute paths) or a node interpreter (`node`, `nodejs`, absolute paths). Closes the gap where python3-MCP plugins produced no capability signal and verdicts couldn't fire against them. Bespoke commands (e.g. `./scripts/my-server.sh`) remain un-rolled-up by design.
- **`RESERVED_WORD_IN_NAME` (warning)** — code-registry-framework replacement for the legacy non-overridable error `SKILL_NAME_RESERVED_WORD`. Fires when a skill frontmatter `name` contains `anthropic` or `claude` (reserved for Anthropic's certified skills). Overridable via `validation.severity` / `validation.allow` like any other framework code. Per the skill-smell philosophy, reserved-word naming is a fix-before-publish smell, not a genuine build breaker, so default severity is `warning`.

### Changed
- **`vibe-agent-toolkit` plugin restructured into 10 sub-skills + a router.** Each sub-skill now has a sharp single responsibility and a name that aligns with its CLI command. Published skill names changed:
  - `resources` → `vat-knowledge-resources`
  - `distribution` → `vat-skill-distribution`
  - `authoring` → split into `vat-skill-authoring` (SKILL.md authoring) and `vat-agent-authoring` (TypeScript agents)
  - `org-admin` → `vat-enterprise-org` (also avoids the reserved word `claude` in the previous filename)
  - `audit` → `vat-audit`
  - `skill-quality-checklist` → `vat-skill-review` (now a first-class skill, no longer transcluded)
  - New: `vat-adoption-and-configuration`, `vat-skill-authoring`, `vat-rag`
  - Root `SKILL.md` (`vibe-agent-toolkit`) is now a thin discovery router (~60 lines, prose references to sub-skills only, no transclusion).
  - Pre-1.0: no backwards-compatibility shims for the old skill names. Adopters with pinned references to the old names should update to the new ones.
- **Contributor-only reference docs moved out of the plugin** to `docs/contributing/` (`vat-debugging.md`, `vat-install-architecture.md`). These are not installed with the plugin — they're for people working on VAT itself.
- Shortened over-limit descriptions on three VAT development-agent skills (renamed above: `vat-enterprise-org`, `vat-skill-distribution`) to stay under Claude Code's 250-character truncation limit.
- **BREAKING: Runtime target rename.** `claude-desktop` → `claude-chat`, `cowork` → `claude-cowork`. Update `plugin.json`, `marketplace.json`, and any config references. The `claude-desktop` name was architecturally wrong — Claude Desktop is a host application, not a runtime.
- **BREAKING: `runCompatDetectors` returns `DetectorOutput { evidence, observations }`** instead of `ValidationIssue[]`. The skill-validator converts observations to issues via `observationToIssue`; external callers must do the same or consume observations directly.
- **BREAKING: `CompatibilityResult` restructured.** Old shape: `{ declared, analyzed: Record<Target, Verdict>, evidence: CompatibilityEvidence[] }`. New: `{ declaredTargets, evidence: EvidenceRecord[], observations: Observation[], verdicts: Verdict[] }`.
- **BREAKING: Scanner output shape.** Scanners in `@vibe-agent-toolkit/claude-marketplace` now return `EvidenceRecord[]` with registered pattern IDs; `ScannerOutput { evidence, observations }` replaces `CompatibilityEvidence`.

### Fixed
- `vat audit --compat` now honors config-layer `targets` declared in `vibe-agent-toolkit.config.yaml`, matching `vat skills validate` verdicts inside a VAT project. Previously only `plugin.json` / `marketplace.json` targets flowed into plugin-level compat analysis. Multi-skill plugins use the union of every in-plugin skill's targets.
- `vat-skill-review.md` (formerly `skill-quality-checklist.md`): description-opener rule no longer contradicts Anthropic's official skill-description guidance. `Use when <concrete trigger>` is now explicitly allowed (it's the recommended pattern); only vague filler like `Use when you want to...` / `Use when you need to...` is banned. Prior wording banned all `Use when...` openers, which contradicted VAT's own authoring guidance.
- `readMarketplaceDefaultTargets()` now walks upward from the starting directory to find the enclosing `.claude-plugin/marketplace.json`, instead of only checking the parent directory. Canonical layouts (`~/.claude/plugins/marketplaces/<m>/<p>/`) still work identically; deeper nested layouts now resolve correctly. Safeguarded against runaway walks by max depth (10 levels) and `node_modules` / `.git` boundaries. Closes limitation #1 from the 0.1.32-rc.1 plan Outcome.
- **`vat audit` now walks to the nearest config per SKILL.md** instead of loading a single top-level config. In monorepos with per-package `vibe-agent-toolkit.config.yaml` files (e.g. `packages/<pkg>/vibe-agent-toolkit.config.yaml`), each skill's validation now honors its own package's config — eliminating cross-package config bleed where a root config was silently applied to skills owned by other packages.
- **`vat audit` now honors `resources.exclude` from the config.** Previously the `exclude` list in the `resources` section only affected `vat resources validate`; audit ignored it and reported findings against files the author had explicitly opted out of validation for.
- **`vat skill review <path>` accepts single-file skills** (any `.md` file), not just `SKILL.md` inside a directory. Useful when reviewing loose skill drafts or checklist-style skills that don't live in a dedicated directory.
- **`SKILL_NAME_MISMATCHES_DIR` false positive:** the mismatch check no longer fires when `SKILL.md` lives directly inside a generic container directory (`skills/`, `resources/`). The parent directory name in those layouts carries no signal about what the skill is named.
- Three directory-targeted markdown links in VAT docs (`CLAUDE.md`, `docs/README.md`, `docs/getting-started.md`) now point at specific files, silencing the corresponding `LINK_TARGETS_DIRECTORY` errors on VAT's own docs.

### Performance
- **~4x speedup on monorepo-scale `vat audit`.** `gitCheckIgnoredBatch` (used by the audit walker for every directory it visits) was unconditionally running a per-path `isGitIgnored` fallback after the batch `git check-ignore --stdin` call — spawning one git subprocess per non-ignored path even when the batch's results were authoritative. The fallback now only runs when the batch exits 128 (the fatal "beyond a symbolic link" case it was designed for), per git's documented exit-code semantics. Measurements on the VAT monorepo: `vat audit .` drops from ~30s → ~7s on this laptop. Correctness verified on an adopter repo that has gitignored symlinks into cloud-synced storage — audit produces the same zero-error, same-warning output in ~7s.

### Removed
- **BREAKING:** `COMPAT_REQUIRES_BROWSER_AUTH`, `COMPAT_REQUIRES_LOCAL_SHELL`, `COMPAT_REQUIRES_EXTERNAL_CLI` codes (replaced by `CAPABILITY_*` + `COMPAT_TARGET_*`).
- **BREAKING:** `CompatibilityEvidence` type, legacy `Verdict` string union (`'compatible' | 'needs-review' | 'incompatible'`), `ImpactLevel` type, `ALL_TARGETS` export, `aggregateVerdicts`, `hasNonOkImpact` helpers.
- **BREAKING:** Hardcoded `IMPACT_*` constants and `packages/claude-marketplace/src/scanners/impact-constants.ts` module. Impact logic now lives in the runtime profile table and verdict engine.
- `yaml` runtime dependency from `@vibe-agent-toolkit/claude-marketplace` (YAML parsing now lives in agent-skills via frontmatter delegation).
- Unused `FRONTMATTER_ALLOWED_TOOLS_ENTRY` pattern-registry entry (never emitted by any scanner).

### Migration Notes
Pre-1.0 breaking. Callers must:
1. Update `plugin.json` `targets` arrays to use `claude-chat` / `claude-cowork` / `claude-code`.
2. Replace `COMPAT_REQUIRES_*` entries in `validation.severity` / `validation.allow` with the matching `CAPABILITY_*` or `COMPAT_TARGET_*` code.
3. If consuming `CompatibilityResult` programmatically, migrate from `analyzed`/`declared` fields to `verdicts`/`declaredTargets`.
4. Declare runtime targets in at least one layer (plugin, marketplace defaults, or config) or accept `COMPAT_TARGET_UNDECLARED` info emissions.
5. Run `vat audit --verbose` to inspect evidence and confirm the refactor's output matches intent.
6. If any prompt, CLAUDE.md, or repo-level doc references the `vibe-agent-toolkit` Claude plugin skills by their old names, update them:
   - `vibe-agent-toolkit:authoring` → `vibe-agent-toolkit:vat-skill-authoring` (SKILL.md side) or `vibe-agent-toolkit:vat-agent-authoring` (TypeScript-agent side)
   - `vibe-agent-toolkit:resources` → `vibe-agent-toolkit:vat-knowledge-resources`
   - `vibe-agent-toolkit:distribution` → `vibe-agent-toolkit:vat-skill-distribution`
   - `vibe-agent-toolkit:org-admin` → `vibe-agent-toolkit:vat-enterprise-org`
   - `vibe-agent-toolkit:audit` → `vibe-agent-toolkit:vat-audit`
   - `vibe-agent-toolkit:debugging` — retired from the plugin; the contributor guide lives at `docs/contributing/vat-debugging.md` in the VAT repo.
   - `vibe-agent-toolkit:install` — retired from the plugin; the architecture doc lives at `docs/contributing/vat-install-architecture.md` in the VAT repo.
   - The `skill-quality-checklist` skill is now `vibe-agent-toolkit:vat-skill-review` (also accessible via `vat skill review <path>` CLI).
   Adopter repos that don't invoke the VAT plugin skills by name need no changes.
7. Replace any `SKILL_NAME_RESERVED_WORD` references in `validation.severity` / `validation.allow` with `RESERVED_WORD_IN_NAME`. Default severity is now `warning` (was error); re-override if your policy demands `error`.

## [0.1.31] - 2026-04-17

### Added
- **v1 compat smells.** Three new `COMPAT_*` codes — `COMPAT_REQUIRES_BROWSER_AUTH`, `COMPAT_REQUIRES_LOCAL_SHELL`, `COMPAT_REQUIRES_EXTERNAL_CLI` — detect per-skill runtime capabilities (browser auth, local shell, external CLI) via static analysis of SKILL.md and its transitively linked markdown. Default severity `warning`; configure per-skill via `validation.severity` / `validation.allow` like any other framework code. Full rationale and when-to-allow guidance in `docs/validation-codes.md`.
- **`vat audit --user` now documents `CLAUDE_CONFIG_DIR`.** Help text and `packages/cli/docs/audit.md` name the env var, mark `~/.claude` as the default rather than unconditional, and document a shell-loop pattern for multi-directory workflows. No code change — `CLAUDE_CONFIG_DIR` has always been honored in `packages/claude-marketplace/src/paths/claude-paths.ts` — but the UX gap closes.
- `vat audit`: gitignore-aware scanning. When scanning inside a git repository, paths matched by `.gitignore` are skipped by default — no hardcoded directory list needed. `--include-artifacts` opts back in. When the user explicitly targets a gitignored path (e.g., `vat audit dist/skills/`), filtering is disabled for that subtree.
- `vat audit`: config-aware validation in VAT projects. When `vibe-agent-toolkit.config.yaml` is found at the scan root, audit uses the project's build settings (`linkFollowDepth`, `files`, `excludeReferencesFromBundle`) to validate skills — eliminating false `LINK_OUTSIDE_PROJECT` warnings for links the build pipeline resolves. Audit never applies `validation.allow` (always shows all issues).
- `docs/skill-quality-and-compatibility.md`: new project stance doc articulating what VAT believes makes a skill good and compatible. Linked from the `authoring` skill and cross-referenced from `docs/validation-codes.md`.

### Changed
- `vat audit` now skips gitignored paths by default. Before this change, running `vat audit` in a TypeScript project scanned every SKILL.md in `node_modules/`, `dist/`, and other artifact directories (often hundreds of duplicate files). The new behavior uses the project's `.gitignore` rules, which adapts to each project's layout automatically. Use `--include-artifacts` to opt back in for deliberate artifact audits.

- **`SKILL_CONSOLE_INCOMPATIBLE` retired.** The Bash/Edit/Write/NotebookEdit tool-mention warning is replaced by the new `COMPAT_REQUIRES_LOCAL_SHELL`, giving adopters a single canonical detector with configurable severity and per-path allow entries.

### Removed
- **Top-level `parsed['targets']` reader in `claude-marketplace/src/scanners/frontmatter-scanner.ts`.** The reader violated VAT's `metadata.*`-for-extensions convention and served no concrete downstream use case after the unified validation framework landed in `0.1.30`. Information it captured migrates to framework codes and `validation.allow`.

## [0.1.30] - 2026-04-16

### Changed
- **BREAKING: Unified validation framework replaces `ignoreValidationErrors`.** Every overridable integrity check now flows through a single `validation` block (`severity` + `allow`) under `skills.defaults` / `skills.config.<name>` in `vibe-agent-toolkit.config.yaml`. The previous non-overridable error tier (`OUTSIDE_PROJECT_BOUNDARY`, `LINK_TARGETS_DIRECTORY`, `LINKS_TO_NAVIGATION_FILES`) is removed and replaced by unified `LINK_*` codes that accept the same overrides as everything else. Project-config schemas are now strict — configs containing the removed `ignoreValidationErrors` field (or any other unknown key) fail at parse time with `"Unrecognized key(s) in object"` instead of silently dropping, so upgrades surface the migration work immediately. See [jdutton/vibe-agent-toolkit#83](https://github.com/jdutton/vibe-agent-toolkit/issues/83) for full design rationale and the canonical code reference at `docs/validation-codes.md`.
- **BREAKING: `PACKAGED_UNREFERENCED_FILE` and `PACKAGED_BROKEN_LINK` now block the build.** Previously logged at info level without affecting exit code; now default severity `error` with `vat skills build` exiting `1`. Downgrade via `validation.severity: { PACKAGED_UNREFERENCED_FILE: warning }` if needed.
- **BREAKING: Expired `allow` entries no longer silently re-fire the underlying error.** The allow entry still applies; VAT emits a new `ALLOW_EXPIRED` warning to surface the stale date for re-review. Opt in to strict expiry with `validation.severity: { ALLOW_EXPIRED: error }`.
- **`vat audit` is now advisory.** Audit always exits `0` regardless of validation severity, honors `validation.severity` for display grouping only, and ignores `validation.allow`. Use `vat skills validate` or `vat skills build` for gated checks with per-path allow entries.

### Added
- **New validation codes** — `LINK_OUTSIDE_PROJECT`, `LINK_TARGETS_DIRECTORY`, `LINK_TO_NAVIGATION_FILE`, `LINK_TO_GITIGNORED_FILE`, `LINK_MISSING_TARGET`, `LINK_TO_SKILL_DEFINITION`, `LINK_DROPPED_BY_DEPTH`, `ALLOW_EXPIRED`, `ALLOW_UNUSED`. Full reference at `docs/validation-codes.md` with defaults, descriptions, and fix hints. `LINK_TO_SKILL_DEFINITION` fires only for cross-skill SKILL.md references; transitive self-references (a bundled resource linking back to the skill's own SKILL.md) are treated as no-ops.
- **`LINK_MISSING_TARGET`** closes a previously silent walker drop path: links to non-existent (non-deferred) files are now reported at the walker with a clear message, rather than only surfacing post-build as a generic `PACKAGED_BROKEN_LINK`.
- **`ALLOW_UNUSED`** — analogous to ESLint's unused-disable — surfaces `allow` entries that match no emitted issues.
- **Per-path `validation.allow`** with required `reason` and optional `expires` date, providing an audit trail for legitimate exceptions. `paths` is optional and defaults to `["**/*"]` (the whole skill) — so concerns that apply to an entire skill can omit the paths array entirely.
- **Canonical code reference** at `docs/validation-codes.md`, test-locked against the code registry so new codes cannot ship without documentation.

### Migration

| Old | New |
|---|---|
| `ignoreValidationErrors: { CODE: "reason" }` | `validation.severity: { CODE: ignore }` |
| `ignoreValidationErrors: { CODE: { reason, expires } }` | `validation.severity: { CODE: ignore }` for code-wide silence, OR `validation.allow: { CODE: [{ paths, reason, expires }] }` for scoped allow entries with re-review on expiry |

## [0.1.29] - 2026-04-16

### Added
- **`vat verify --consistency-check`** — post-build verification that skill distribution config in `vibe-agent-toolkit.config.yaml` and `package.json` are consistent. Detects skills missing from `package.json`, orphaned entries, and publish opt-out mismatches. Runs automatically as part of `vat verify`.
- **Post-build integrity checks for packaged skills** — `packageSkill()` now runs `PACKAGED_UNREFERENCED_FILE` and `PACKAGED_BROKEN_LINK` checks after copying files and rewriting links. Both are best-practice (overridable) errors surfaced via `PackageSkillResult.postBuildIssues`; the CLI logs them at info level (non-blocking). Suppress via `packagingOptions.ignoreValidationErrors`. Broken-link detection skips fenced code blocks and inline code spans so template strings aren't false-flagged. Unreferenced-file detection counts any mention of a packaged file's output-relative path — inside code blocks, inline code, or prose — as documented; CLI invocations like `node scripts/cli.mjs` are legitimate references even though they aren't `[text](href)` links.
- **Skill quality checklist** — new `skill-quality-checklist.md` resource bundled with the agent-authoring skill. 21-item checklist covering general skill authoring (description triggering, length limits, third-person voice, time-sensitive content, references one-level-deep, TOCs on long files) plus CLI-backed skill specifics (env guards, auth checks, cross-platform commands, `files` config). Reviewed against external best practices (Anthropic docs, anthropics/skills, superpowers conventions, Claude Code release notes through 2026-04-15).

### Fixed
- **Link rewriting now handles links with inline-formatted text correctly** — `transformContent` keyed its link lookup by `[text](href)` where `text` came from remark (formatting stripped) while the regex captured the raw source (formatting preserved). Any link whose text contained backticks, emphasis, or other inline markup silently fell through the rewriter, leaving the original (now-broken) relative path in the packaged output. Lookup is now keyed by `href`, which the regex and parser report identically. Templates also gain a new `link.rawText` variable exposing the original formatted text (falls back to `link.text` when raw text is unavailable), and the default bundled-link template uses it so `` [`foo.yaml`](…) `` survives rewriting as `` [`foo.yaml`](new/path) `` rather than losing its code styling.
- **`excludeReferencesFromBundle` patterns now apply to terminal non-markdown links** — links to YAML, JSON, images, and other assets that are not indexed by the registry were falling through the bundled-link rule and rendering as `[text]()` because `matchesPattern` short-circuited to `false` whenever the target resource was unresolved. `matchesPattern` now falls back to matching the link's raw href when no resolved resource is available, and `buildRewriteRules` evaluates per-pattern excludes before the bundled-link rule so terminal assets resolve to the user's template.
- **`files` config in `skills.config.<name>.files` was parsed but not applied at build time** — `vat skills build` merged the `files` entries from `vibe-agent-toolkit.config.yaml` and validated them (`vat verify` correctly reported missing dests), but never passed them into `packageSkill()`, so declared files were silently skipped. Now CLI binaries and other build artifacts declared via `files` config are copied into skill output as intended.
- **Skill bundler strips links to non-markdown bundled files** — links to YAML, JSON, and script files routed to `templates/`, `assets/`, or `scripts/` were rewritten to empty `()` because non-markdown assets weren't added to the output registry. Now all files in the path map are added to the output registry with their mapped output paths, including the duplicate-ID edge case for paired markdown/non-markdown files (e.g. `config.md` + `config.yaml`).
- **Skill bundler strips depth-boundary links to already-bundled resources** — when resource D linked to resource C and C was already bundled via a shorter path from SKILL.md, the link from D→C was stripped because depth-exceeded exclusions were unconditionally added to `excludedIds`. Bundle membership now wins: `excludedIds` filters out resources already in `bundledResources`.
- **Discovery scanner no longer traverses git worktrees** — `.worktrees/` and `.claude/worktrees/` added to `PERFORMANCE_POISON` exclusions, preventing the crawler from physically walking into worktree copies of the repo during scans.
- **System tests no longer flaky from vitest worker timeout** — refactored `skills-list.system.test.ts` to run CLI spawns once in `beforeAll` instead of 5 redundant full-project scans. Same coverage, 70% faster (90s → 27s), eliminates the `onTaskUpdate` timeout.

## [0.1.28] - 2026-04-14

### Fixed
- **Skill bundler no longer silently bundles gitignored files** — when a SKILL.md links to files inside a gitignored directory (e.g., `data/`), those files are now excluded from the bundle instead of being silently packaged and published. This includes files reached through symlinks in gitignored directories (e.g., OneDrive/shared drive mounts). Previously required manual `excludeReferencesFromBundle` workarounds; now handled automatically.

## [0.1.27] - 2026-04-11

### Breaking
- **Removed top-level `vat install` command.** Install of flat skills now uses `vat skills install <source> --target <target> --scope <user|project>`. Install of Claude plugins uses `vat claude plugin install <source>`.

### Added
- `vat skills install <source> --target <target> --scope <user|project>` — cross-platform flat skill installer. Supports 7 targets (claude, codex, copilot, gemini, cursor, windsurf, agents) and 2 scopes (user, project). Sources: local directory, `.zip`, `.tgz`, or `npm:@scope/package`. Pre-verifies all skills before touching the filesystem (all-or-nothing).
- `vat skills list npm:@scope/package` — inspect what skills are in an npm package without installing.
- `bun run pre-release` — pre-tag validation command that confirms CHANGELOG is stamped, no stale tags exist on remote, marketplace dry-run passes, and version section has content. Prevents failed CI publishes from unready state.
- `bun run bump-version` now auto-stamps CHANGELOG.md for stable versions — moves `[Unreleased]` content under a new `## [X.Y.Z] - date` heading. Safety guards: fails if `[Unreleased]` is empty, refuses to stamp if version already exists in CHANGELOG (prevents corruption from backward bumps or re-stamps). Skips for RC/prerelease versions.
- **Content-type routing** — auto-discovered files now route to `scripts/`, `templates/`, `assets/`, or `resources/` based on file extension instead of all going to `resources/`.
- **Skill files config** — declare `files` entries in `vibe-agent-toolkit.config.yaml` for build artifacts, unlinked files, or routing overrides. Supports default + per-skill merge with dest-based override. See `docs/guides/skill-files-and-routing.md`.
- **Deferred verification** — validation chain recognizes declared build artifacts at source time (deferred), enforces hard gates at build time (source must exist) and verify time (dest must exist in output).
- **`vat verify` files check** — post-build verification now confirms all `files[].dest` paths exist in the built output.

### Fixed
- **CHANGELOG check in pre-publish no longer skipped during `bun run validate`** — the CHANGELOG stamp check was incorrectly gated behind `--skip-git-checks` (a git check flag), but it's a content check. Now runs unconditionally.

### Changed
- Published VAT skills updated to describe the new `vat skills install` command surface.

## [0.1.26] - 2026-04-10

### Added
- **Cross-skill SKILL.md bundling prevention** — VAT now detects when a skill links to another skill's `SKILL.md` and excludes it from the bundle. A `SKILL.md` is a skill definition marker, not a resource — bundling one inside another skill creates duplicate definitions that break marketplace sync and confuse skill consumers. Two layers of protection: link-follow filtering (prevents the bad state) and post-build validation (safety net). The exclusion appears in build output as `skill-definition` reason.
- **ESLint rule: `no-fs-promises-cp`** — Prevents usage of async `cp()` from `node:fs/promises` in favor of `cpSync()` from `node:fs`. Node 22's async `cp({ recursive: true })` silently drops files in nested directories. The rule auto-fixes and explains the issue so developers can make an informed eslint-disable decision if async is truly needed.

### Fixed
- **Marketplace publish drops non-markdown files on Node 22** — `composePublishTree` used async `cp()` from `node:fs/promises` which silently drops `.mjs` files in nested directories on Node 22. Replaced with `cpSync` which works correctly across all Node versions. Added a system test that verifies `.mjs` scripts survive the full compose→publish pipeline.
- **Marketplace publish `--debug` flag not reaching logger** — `--debug` was defined on the publish command but consumed by a parent command in the Commander hierarchy. Options are now read via `optsWithGlobals()` so `--debug` works correctly.
- **Marketplace publish debug logging** — `vat claude marketplace publish --debug` now logs the full file list at each stage of the publish pipeline (cpSync output, git tracked files, git ignored files, early-exit tree). Diagnoses files disappearing between build output and published commit.

## [0.1.25] - 2026-04-09

### Security
- **Marketplace publish no longer logs git remote credentials.** `vat claude marketplace publish` previously echoed the full remote URL — including any credentials embedded by the user's config OR injected at runtime from `GH_TOKEN`/`GITHUB_TOKEN` — to stdout via its `Remote:` and `Pushed to …` log lines. In CI, GitHub Actions auto-masked the secret, but local runs (including adopter dry-runs) emitted the raw token to the terminal. All URL logging now passes through a `redactUrlCredentials()` helper that strips userinfo before logging. Git commands still receive the tokenized URL for authentication — only the logged copy is redacted.

### Changed
- **BREAKING: Marketplace publish no longer rewrites `CHANGELOG.md`.** `vat claude marketplace publish` now mirrors the source `CHANGELOG.md` byte-for-byte into the publish tree and extracts release notes for the commit body only. Accepts both Keep a Changelog workflows: a pre-stamped `[X.Y.Z]` section matching `package.json` (preferred) or a non-empty `[Unreleased]` section (fallback). Fails if neither is present. Workflow A adopters whose `main` branch CHANGELOG continues to carry `[Unreleased]` at publish time will see that heading on the publish branch too — stamp `CHANGELOG.md` on `main` before tagging if you want a stamped heading in the published file. Side benefit: corrections/typo-fixes to `CHANGELOG.md` on `main` now propagate to the publish branch on the next publish.

### Fixed
- **`toAbsolutePath()` and `getRelativePath()` now return forward-slash paths on Windows** — previously these returned backslash paths, bypassing cross-platform normalization.

## [0.1.24] - 2026-04-06

### Feature
- **Safe path normalization** — added `safePath.join()`, `safePath.resolve()`, `safePath.relative()` wrappers in `@vibe-agent-toolkit/utils` that always return forward-slash paths. New ESLint rules (`no-path-join`, `no-path-resolve`, `no-path-relative`) enforce their use over raw `node:path` functions, with auto-fix support. Adopters can copy these rules from `packages/dev-tools/eslint-local-rules/` into their own projects. Closes #38.
- **Cross-platform ESLint rule parity with vibe-validate** — ported `no-path-resolve-dirname` (enforces `normalizePath()` over `path.resolve(__dirname)` in tests for Windows 8.3 short name safety) and `no-test-scoped-functions` (enforces module-scope helper functions in test files, SonarQube S1515). VAT now ships 15 custom ESLint rules for cross-platform safety.

## [0.1.23] - 2026-04-02

### Feature
- **Marketplace publishing** — distribute Claude plugin marketplaces via Git branches. `vat claude marketplace publish` composes built artifacts with changelog, readme, and license into a squashed commit on a configurable branch. Consumers install with `/plugin marketplace add owner/repo#branch`. Includes standalone strict validation (`vat claude marketplace validate`) and automatic marketplace verification in `vat verify`.

### Docs
- **Marketplace testing guide** — added "Testing Your Marketplace" section to marketplace-distribution.md with full local test flow (`marketplace add` → `install` → `validate` → verify skills), known issues (name collision, `$schema` validation), and update workflow.
- **Marketplace README** — rewrote marketplace branch README as a developer-facing landing page with two-step install, skill descriptions, and architecture link.
- **Main README** — added "Claude Plugin Marketplace" section with install commands and links to marketplace branch and distribution guide.
- **Distribution skill** — added local marketplace testing subsection with commands and known-issue notes.

### Changed
- **Publish workflow** — added marketplace publish step to CI; stable tags push to `claude-marketplace` branch, RC tags push to `claude-marketplace-next`.
- **Pre-publish checks** — added marketplace dry-run validation (Check 12) to catch build/changelog issues before any npm mutations.

## [0.1.22] - 2026-04-01

### Added
- `vat claude org info` — org identity from Admin API (`/v1/organizations/me`).
- `vat claude org users list/get` — list and retrieve org members.
- `vat claude org invites list` — list pending and accepted invitations.
- `vat claude org workspaces list/get` — list and retrieve API workspaces.
- `vat claude org workspaces members list` — list workspace members.
- `vat claude org api-keys list` — inventory of org API keys with status and workspace scope.
- `vat claude org usage` — daily token usage report (model/workspace/key breakdown); autopaginates by advancing `starting_at`.
- `vat claude org cost` — USD cost report; `amount` field is string decimal. Valid `group_by[]` values: `description`, `workspace`.
- `vat claude org code-analytics` — Claude Code productivity metrics; `starting_at` is date-only `YYYY-MM-DD`.
- `vat claude org skills list` — workspace-scoped skills from `/v1/skills` (beta); skill IDs are slugs not UUIDs.
- `vat claude org skills install <source>` — upload a built skill directory or ZIP to the organization via Skills API (`POST /v1/skills`). Reads `display_title` from SKILL.md frontmatter; `--title` to override. Supports `--from-npm <pkg>@<version>` to download and upload all skills from an npm package (with optional `--skill <name>` filter).
- `vat claude org skills delete <skill-id>` — delete a skill from the organization via Skills API (`DELETE /v1/skills/{id}`).
- `OrgApiClient.uploadSkill()` / `OrgApiClient.deleteSkill()` — programmatic multipart upload and delete for Skills API.
- `buildMultipartFormData()` — zero-dependency multipart/form-data builder exported from `@vibe-agent-toolkit/claude-marketplace`.
- `vat claude org skills versions list <skill-id>` — list all versions of a skill.
- `vat claude org skills versions delete <skill-id> <version>` — delete a specific skill version (required before deleting the skill itself).
- `OrgApiClient.deleteSkillVersion()` — programmatic version deletion for Skills API.
- All other mutating org commands (`users update/remove`, `invites create/delete`, `workspaces create/archive`, `api-keys update`) return structured `not-yet-implemented` stubs.
- All `vat claude org` commands require `ANTHROPIC_ADMIN_API_KEY`; `org skills` commands require `ANTHROPIC_API_KEY`.
- `vibe-agent-toolkit:org-admin` skill — documents OrgApiClient programmatic API, CLI commands, report pagination quirks, and common recipes (cost summaries, API key audits, invite tracking).

### Fixed
- **Plugin version in plugin.json** — `vat claude plugin build` now includes `version` from package.json in generated plugin.json. Without it, Claude Code caches plugins under an `unknown/` directory, causing stale skill resolution across version upgrades.
- **`PLUGIN_MISSING_VERSION` audit check** — `vat audit` now warns when a plugin's plugin.json is missing the `version` field, explaining the stale cache impact.
- **Semver pre-release in plugin.json schema** — version field now accepts pre-release suffixes (e.g., `1.0.0-rc.3`) in addition to strict semver.
- **System test isolation** — `fakeHomeEnv()` now overrides `CLAUDE_CONFIG_DIR` to prevent shell-level environment variables from leaking into spawned test processes. Fixes false test failures when `CLAUDE_CONFIG_DIR` is set in the developer's shell.
- **`unknown_link` false positives** — `vat resources validate` no longer reports `unknown_link` errors for changelog headings (`## [Unreleased]`, `## [0.1.0] - 2026-01-01`) or bare filenames with extensions (`config.schema.json`, `image.png`). Unresolved `linkReference` nodes are now skipped, and bare filenames are classified as `local_file`.
- **Collection matching in dot-directories** — picomatch `**` globs now match paths containing dot-directory segments (e.g., `.claude/worktrees/`). Previously, collection validation silently returned 0 matches when the project path included a dotfile directory.
## [0.1.21] - 2026-03-31

### Breaking Changes
- **`vat skills install` removed** — replaced by `vat claude plugin install`. Update postinstall scripts to use `vat claude plugin install --npm-postinstall || exit 0` and add `vibe-agent-toolkit` to your package's `dependencies` (runtime, not devDependencies) so that `vat` is available via `./node_modules/.bin/` during postinstall.
- **`vat skills uninstall` removed** — replaced by `vat claude plugin uninstall`.
- **`vat claude build` replaced** — superseded by `vat claude plugin build` (same function, new location under the plugin command group). `vat build` now runs both `skills` and `claude` phases automatically; no separate step needed.
- **`vat claude verify` removed** — use `vat verify` (config-driven top-level command).
- **`vat-development-agents` plugin renamed to `vibe-agent-toolkit`** — the installed plugin name changes. Skill short names also updated: `agent-authoring` → `authoring`, `skills-distribution` → `distribution`, `install-architecture` → `install`. Installed skill IDs are now `vibe-agent-toolkit:authoring`, `vibe-agent-toolkit:distribution`, etc.

### Added
- `vat claude plugin install` — installs skill packages into Claude Code. Accepts `--target code|api.anthropic.com|claude.ai` (`code` is default; `claude.ai` returns a structured not-available stub). Correct postinstall pattern uses the local `node_modules` binary, never assumes a global `vat`.
- `vat claude plugin build` — generates `dist/.claude/plugins/marketplaces/` from `dist/skills/` and `vibe-agent-toolkit.config.yaml`. Cleans stale output before each build. Replaces `vat claude build`; now runs automatically as the `claude` phase of `vat build`.
- `vat claude plugin list` — lists installed plugins from the plugin registry and legacy skills directory.
- `vat claude plugin uninstall` — removes a plugin and all 5 install artifacts (marketplace dir, cache dir, `installed_plugins.json`, `known_marketplaces.json`, `settings.json`). Idempotent; `--all` finds plugins by npm package name; `--dry-run` previews without changes.
- **`vat build` now runs `skills → claude` phases** — full pipeline in one command; `claude` phase skipped automatically if no `claude.marketplaces` config is present.
- **`vat claude plugin install --dev` uses plugin tree symlinks** — skills appear as `{plugin}:{skill}` in Claude Code (e.g. `vibe-agent-toolkit:authoring`) instead of flat names. Requires `vat build` first. Gracefully rejects on Windows with a clear error.
- `vat-development-agents` self-adoption: postinstall now uses `vat claude plugin install --npm-postinstall` via `.bin/vat` (no path guessing, no global `vat` assumption).
- **`CLAUDE_CONFIG_DIR` env var support** — `getClaudeUserPaths()` now respects `CLAUDE_CONFIG_DIR` to override the default `~/.claude` location. Enables multiple Claude installations and non-standard config paths.

### Fixed
-**`vat skills build` cleans `dist/skills/` before rebuilding** — stale skill directories from renamed or removed skills no longer accumulate between builds.
- **`@next` dist-tag now updated on stable npm releases** — `publish.yml` now runs `determine-publish-tags.ts` to compute `update_next` and passes it to `publish-with-rollback.ts` via `UPDATE_NEXT` env; `publish-with-rollback.ts` now has a Phase 2 that applies `npm dist-tag add <pkg>@<version> next` to all packages when `UPDATE_NEXT=true`, with rollback on failure

## [0.1.20] - 2026-03-26

### Fixed
- **Plugin reinstall now removes stale skills** — reinstalling a plugin package that has fewer skills than the previous version no longer leaves orphaned skill directories in the Claude installation; the marketplace directory is fully replaced on each install rather than merged additively

## [0.1.19] - 2026-03-23

### Fixed
- **Audit: resolve URL-encoded paths in skill link traversal** — `vat audit` now correctly resolves `%20`, `%26`, and other percent-encoded characters in markdown link paths during skill link traversal; previously reported false `LINK_INTEGRITY_BROKEN` errors for files in directories with spaces or special characters (e.g., SharePoint-synced folders)

### Changed
- **Shared `resolveLocalHref` utility** — extracted common href → filesystem path resolution (anchor stripping, URL-decoding, relative path resolution) into `@vibe-agent-toolkit/resources` so both the audit and validate code paths use a single implementation

## [0.1.18] - 2026-03-20

### Added
- **`success` boolean on `SafeExecResult`** — convenience field (`success: exitCode === 0`) for cleaner conditional checks in callers of `safeExecSync()` and `safeExec()`

## [0.1.17] - 2026-03-20

### Fixed
- **Link validator: resolve percent-encoded paths** (fixes #59) — `%20` and other URL-encoded characters in markdown link paths are now decoded before filesystem resolution; bare relative paths with slashes (e.g., `files/doc.pdf`) are correctly classified as `local_file` instead of `unknown`
- **Windows Node.js v24+ compatibility** — fixed `ERR_UNSUPPORTED_ESM_URL_SCHEME` when running `vat` on Windows with Node.js v24, where bare absolute paths require `file://` URLs for dynamic imports

### Breaking Changes
- **Redesigned skill config and plugin distribution** (PR #55) — `vat.skills[]` in package.json is now an array of skill name strings (not objects); all config lives in `vibe-agent-toolkit.config.yaml`
  - `dist/.claude/` directory structure now mirrors `~/.claude/plugins/` directly — plugin install is a recursive copy, no manifest parsing needed
  - New `PluginJsonSchema` (strict: `name`, `description`, `author` only)
  - Removed `MarketplaceSchema`, `marketplace-validator.ts`, and all related code

### Added
- **marketplace.json build, validate, and audit** (PR #57) — full marketplace manifest lifecycle
  - `MarketplaceManifestSchema` in agent-skills with passthrough for all official source types (string, github, url, npm, pip)
  - `validateMarketplace()` validator mirroring the plugin-validator pattern
  - `vat claude build` now generates `.claude-plugin/marketplace.json` with relative source paths
  - `vat claude verify` validates marketplace.json against the schema
  - Unified validator routes marketplace type to `validateMarketplace()` (replaces placeholder UNKNOWN_FORMAT error)
  - `vat audit --user` now correctly validates marketplace directories
  - Plugin `description` is now optional in VAT project config (adopter compatibility)
  - Added marketplace-level `skills` selector to config schema
- **Transitive link traversal for `vat audit`** (PR #56) — follows all local file links from SKILL.md via BFS with cycle detection
  - Reports broken links (`LINK_INTEGRITY_BROKEN` error), boundary escapes (`OUTSIDE_PROJECT_BOUNDARY` warning), and unreferenced markdown files (`SKILL_UNREFERENCED_FILE` info with `--warn-unreferenced-files`)
  - Excludes CLAUDE.md, README.md, and other navigation files from unreferenced file detection
- **Implicit reference detection** — `extractImplicitReferences()` scans for non-markdown-link file references (backtick-quoted, bold, DOT graphviz, bare prose, `@`-prefix)
  - New `SKILL_IMPLICIT_REFERENCE` issue code for files referenced implicitly but not via `[text](path)` links
  - Reduces false-positive unreferenced file warnings from 18 to 9 when auditing real installed plugins
- **Settings schemas synced with official Claude Code docs** — `vat audit settings` now recognizes ~30 additional fields including sandbox filesystem/network controls, permission modes (`askEdits`, `readOnly`), and managed-only lockdown settings; fixes `autoUpdatesChannel` enum to match the official values (`stable`, `latest`)

## [0.1.15] - 2026-03-02

### Added
- **`vat build` and `vat verify` top-level commands** — orchestrate the full build and verification pipeline in dependency order
  - `vat build`: skills → claude plugins (future: cursor, etc.)
  - `vat verify`: resources → skills → claude artifacts
  - `--only <phase>` flag to run a single phase; `--marketplace <name>` to target a specific marketplace
- **`vat claude build`** — generates Claude plugin marketplace artifacts from pre-built skills
  - Reads `claude:` section from `vibe-agent-toolkit.config.yaml`; resolves skill selectors (exact names and globs)
  - Copies pre-built `dist/skills/<name>/` into `dist/plugins/<plugin>/skills/` (no re-bundling)
  - Generates `dist/plugins/<plugin>/.claude-plugin/plugin.json` and `dist/.claude-plugin/marketplace.json`
  - Sanitizes colon-namespaced skill names (e.g. `plugin:skill`) to double-underscore for Windows filesystem safety
- **`vat claude verify`** — validates Claude marketplace and plugin artifacts against schemas
  - Validates `marketplace.json` against `MarketplaceSchema`, `plugin.json` against `ClaudePluginSchema`
  - Validates `managed-settings.json` against `ManagedSettingsSchema` when `claude.managedSettings` is configured
  - Supports both source-layout (`file:`) and build-to-dist patterns
- **`claude:` config section in `vibe-agent-toolkit.config.yaml`** — configure Claude plugin distribution
  - `claude.marketplaces` — named map of marketplace definitions (inline or `file:` source-layout)
  - `claude.managedSettings` — path to managed-settings.json for schema validation
  - Marketplace config: `owner`, `skills` selector (exact or glob), `plugins` grouping, `output` paths
- **Claude plugin registry installer** (`packages/claude-marketplace`) — writes directly to Claude Code's plugin registry
  - Five-step install: copies plugin files to `~/.claude/plugins/marketplaces/` and `cache/`, updates `known_marketplaces.json`, `installed_plugins.json`, and `settings.json enabledPlugins`
  - Called automatically by `vat skills install --npm-postinstall` when `dist/.claude-plugin/marketplace.json` exists
- **`vat skills install` now routes through Claude plugin system** when package ships a plugin
  - If `dist/.claude-plugin/marketplace.json` exists: installs via plugin registry (namespaced, version-tracked)
  - If marketplace.json is absent: emits guidance to run `vat build` and exits 0 (no raw skill install)
  - `--user-install-without-plugin` flag: explicit opt-in to force `~/.claude/skills/` install
- **`vat --cwd <dir>` root flag** — change working directory before any command runs
  - Enables CI pipelines to run `vat build --cwd packages/my-agents` from the monorepo root
- **Marketplace settings schema fields** in `ClaudeSettingsSchema` and `ManagedSettingsSchema`
  - `extraKnownMarketplaces`, `enabledPlugins` added to settings/settings.local
  - `strictKnownMarketplaces` added to managed-settings only
  - `vat audit settings` output gains `marketplaces:` section showing registered marketplaces and enabled plugins
- **`plugin:skill` colon notation in skill names** - Skill names may now include a plugin namespace prefix (e.g., `vibe-agent-toolkit:audit`)
  - Format: `plugin-name:skill-name`; the prefix is the plugin/package namespace, the suffix is the skill's local name
  - Supported in both SKILL.md `name:` frontmatter and `package.json` `vat.skills[].name`
- **`vibe-agent-toolkit` skill package split** - Replaced the 1310-line monolith with an umbrella + 4 focused action skills
  - Umbrella `vibe-agent-toolkit` (~179 lines): concepts, archetypes overview, routing table, CLI quick reference
  - `vibe-agent-toolkit:resources` — resource collections, per-directory schema validation, `vat resources` commands
  - `vibe-agent-toolkit:distribution` — packaging, `--target claude-web`, `vat install`, npm and private distribution
  - `vibe-agent-toolkit:agent-authoring` — SKILL.md authoring, 4 archetypes with examples, packaging options reference
  - `vibe-agent-toolkit:audit` — `vat audit` flags, auto-detection table, `--compat` output, CI usage patterns
- **`vat audit --exclude <glob>`** - Filter paths from recursive scans (repeatable flag)
  - Example: `vat audit plugins/ --exclude "dist/**" --exclude "node_modules/**"`
  - Prunes directory traversal early for performance; does not just filter output
- **Unified `vat install` command** - Single command for installing any VAT resource type
  - Auto-detects resource type from source: `SKILL.md` → agent-skill, `.claude-plugin/plugin.json` → claude-plugin, `.claude-plugin/marketplace.json` → claude-marketplace
  - Routes to the correct `~/.claude/` subdirectory automatically
  - Flags: `--type` (explicit override), `--force`, `--dry-run`; YAML output includes `sourceType` field
  - `vat skills install` remains as an alias constrained to agent skills only
- **`vat audit --compat`** - Per-surface compatibility analysis for plugins and skills
  - Reports compatibility with `claude-code`, `cowork`, and `claude-desktop` surfaces with supporting evidence
  - Detects Python scripts, bash hooks, sqlite dependencies, and other surface-specific constraints
  - Works in both path mode and `--user` mode; combinable with recursive scanning for full marketplace matrices
- **`vat skills package --target <target>`** - Target-specific packaging for Claude.ai web upload
  - `--target claude-web` produces a ZIP with `references/` instead of `resources/`, matching the Claude.ai web upload spec
  - `--target claude-code` (default) preserves existing behavior unchanged
  - ZIP size validation for `claude-web`: warn at 4MB, error at 8MB

### Changed
- **`vat audit` is recursive by default** (**BREAKING**) - `vat audit <path>` now walks the full directory tree automatically
  - `--recursive` / `-r` flag removed; use `--no-recursive` to scan the top-level directory only
  - `--user` behavior unchanged: scans `~/.claude/` directories, exit code remains 0 (informational)
- **`CLAUDE.md` documentation additions** - Resource collections and licensing conventions added to the contributor guide
  - Resource collections: per-directory schema validation config, `permissive` vs `strict` modes, `vat resources validate` usage
  - Licensing conventions: table for open source / proprietary / not-yet-licensed packages with enterprise LICENSE template

## [0.1.14] - 2026-02-11

### Added
- **Content transform pipeline** - Shared `transformContent()` engine in `@vibe-agent-toolkit/resources` for rewriting markdown links before persistence
  - `LinkRewriteRule[]` configuration with match criteria (type, glob pattern, excludeResourceIds) and Handlebars templates
  - Template variables: `{{link.text}}`, `{{link.href}}`, `{{link.fragment}}`, `{{link.resource.*}}` (id, filePath, extension, mimeType, sizeBytes, estimatedTokenCount, frontmatter.*)
  - Consumer context variables for skill/project-specific data (e.g., `{{skill.name}}`, `{{kb.baseUrl}}`)
  - `ResourceLookup` interface decouples transform from full ResourceRegistry
  - First-match-wins rule ordering; unmatched links preserved as-is
- **Full document storage** (`rag_documents` table) - Optional `storeDocuments: true` config on LanceDB RAG provider
  - Stores complete document content alongside vector chunks for retrieval after search
  - `getDocument(resourceId)` returns full content, metadata, token count, chunk count, and indexing timestamp
  - Content transforms applied to stored documents
  - Incremental updates: changed content updates the document record
  - Cascading deletes: `deleteResource()` removes both chunks and document record
  - `DocumentResult` interface added to `@vibe-agent-toolkit/rag` provider interfaces
- **Content transform support in RAG indexing** - `contentTransform` option on LanceDB provider rewrites links before chunking
  - Content hash computed on transformed output for accurate change detection
  - Re-indexes automatically when transform rules change
- **OnnxEmbeddingProvider** - Local ONNX-based embedding generation (#45)
  - Makes `@lancedb/vectordb` and `onnxruntime-node` optional peer dependencies
  - Falls back gracefully when native dependencies unavailable

### Fixed
- **tokenCount in enrichChunks** - `tokenCount` field now populated on enriched chunks; chunk position metadata (`chunkIndex`, `totalChunks`, `isFirstChunk`, `isLastChunk`) added (#46)
- **Custom metadata overwriting core chunk fields** - `chunkToLanceRow()` now spreads metadata before core fields so `chunkIndex`, `totalChunks`, and other core columns cannot be overwritten by user-defined metadata schemas with colliding names
- **Path-relative resource IDs** - `ResourceRegistry` generates IDs relative to `baseDir` (e.g., `docs-guide` instead of `guide`), preventing collisions for same-named files in different directories

## [0.1.13] - 2026-02-10

### Added
- **Skills development install** (`vat skills install --dev`) - Symlink-based installation reads `vat.skills[]` from `package.json` and symlinks built skills into `~/.claude/skills/`
  - After rebuild, skills update immediately (no re-install needed)
  - `--build` flag auto-runs `vat skills build` before symlinking
  - `--name` flag to install a specific skill from multi-skill packages
  - `--force` to overwrite existing installations
  - `--dry-run` to preview without creating symlinks
- **Skills uninstall** (`vat skills uninstall <name>`) - Remove installed skills (directories or symlinks)
  - `--all` flag reads `package.json` and removes all declared skills
  - `--dry-run` to preview without removing
  - Reports `wasSymlink` in YAML output for each removed skill
- **MCP test client harness** - Reusable `MCPTestClient` class for reliable MCP server testing
  - Waits for server readiness signal before sending requests (eliminates race conditions)
  - Auto-incrementing request IDs with ID-based promise resolution
  - Graceful shutdown with SIGTERM/SIGKILL fallback

### Fixed
- **npm install installs ALL skills** - `vat skills install <npm-package>` now installs all skills from multi-skill packages instead of only the first one
- **Broken symlink detection** - `vat skills install --force` now correctly detects and removes broken symlinks using `lstatSync` instead of `existsSync`
- **MCP test reliability** - Replaced timing-based test approach with readiness-signal pattern; tests now complete in ~600ms instead of flaking at 2-3.5s

## [0.1.12] - 2026-02-10

### Added
- **External URL validation with caching** (#41)
  - Optional external URL validation via `--check-external-urls` flag
  - Filesystem-based cache with TTLs (24h alive, 1h dead)
  - Per-collection configuration for timeout, retry, ignore patterns
  - New issue types: `external_url_dead`, `external_url_timeout`, `external_url_error`
  - Cache stored in `.vat-cache/external-urls.json`
  - Uses `markdown-link-check` library for robust HTTP checking
- **Link Depth Control for Skills** - Control how deep to follow markdown links during skill packaging
  - `linkFollowDepth` in `packagingOptions`: `0` (skill only), `1` (direct links), `2` (default), `N`, or `"full"` (unlimited)
  - Prevents transitive link explosion in large knowledge bases (e.g., 493 files → ~10 files with depth 1)
- **Rule-Based Link Exclusion** - Selectively exclude files from bundles with per-pattern link rewriting
  - `excludeReferencesFromBundle` with ordered rules: each rule specifies glob patterns and optional Handlebars template
  - `defaultTemplate` for depth-boundary links that don't match explicit rules (default: `"{{link.text}}"`)
  - Template variables: `{{link.text}}`, `{{link.href}}`, `{{link.fragment}}`, `{{link.type}}`, `{{link.resource.id}}`, `{{link.resource.fileName}}`, `{{link.resource.relativePath}}`, `{{skill.name}}`
  - No dead links in output: every non-bundled link target is rewritten per its matched template
- **Resource Naming Strategies for Skills** - Flexible control over packaged resource file naming
  - Three strategies: `basename` (default, simple), `resource-id` (flatten to kebab-case), `preserve-path` (maintain directory structure)
  - Universal `stripPrefix` option removes path prefixes before applying naming strategy
  - Filename collision detection prevents duplicate names in flat output
  - Configure via `packagingOptions` in skill metadata (package.json `vat.skills[]`)
- **Non-Markdown Asset Bundling** - JSON schemas, images, and other non-markdown files linked from bundled markdown are now included in skill packages
- **Handlebars Template Utility** - Shared template rendering in `@vibe-agent-toolkit/utils` with compiled template caching
- **Directory Link Detection** - Links targeting directories now produce actionable validation errors suggesting README.md/index.md alternatives (previously crashed with ENOTSUP)
- **Expanded Validation Metadata** - `directFileCount`, `excludedReferenceCount`, and `excludedReferences` in validation results
  - `--verbose` flag on `vat skills validate` shows excluded reference details with reason (`depth-exceeded` / `pattern-matched`) and matched pattern
- **Packaging Options Documentation** - Comprehensive reference in VAT SKILL.md covering linkFollowDepth, resourceNaming, excludeReferencesFromBundle, and ignoreValidationErrors

### Changed
- **Default link follow depth is now 2** (was unlimited). Use `linkFollowDepth: "full"` to restore unlimited behavior.
- `LINK_TARGETS_DIRECTORY` validation is now overridable (transitively-bundled docs may contain directory links the skill author cannot control)

### Improved
- **Navigation file errors** now include full resolved paths and line numbers (not just basename)
- **Depth terminology** clarified as "link-chain hops" instead of misleading "levels deep"

### Internal
- **npm link reliability** - Topological sort, `--install-strategy=shallow`, and retry logic for workspace package linking

## [0.1.11] - 2026-02-09

**Note:** Version 0.1.10 was deprecated due to incomplete publish (phantom package in publish list caused partial release).

### Performance
- **Discovery Scan: 540x Faster** - File discovery now completes in ~0.5 seconds instead of 5+ minutes
  - Added `PERFORMANCE_POISON` patterns to exclude `.git`, `node_modules`, and `coverage` directories
  - Batch git-ignore checking reduces 794 subprocess calls to 1 (`git check-ignore --stdin`)
  - Skills list command that previously timed out now completes in seconds
- **Skills Validation: 12x Faster** - Validation improved from 13.5s to 1.13s
  - Introduced `GitTracker` to cache git-ignore checks across validations
  - Eliminates 174 redundant git subprocess calls during link validation
  - Pre-populates cache from `git ls-files` for instant lookups

### Fixed
- **LanceDB Database Size** - `getStats()` now accurately reports database disk usage
  - Previously always showed "0.00 MB" regardless of actual size
  - Implements recursive directory traversal to calculate true size in bytes
  - Helps users monitor disk usage and verify successful index builds
- **Phantom Package Validation** - Pre-publish check now catches packages declared but not existing
  - Previously only checked for undeclared packages (exist but not in lists)
  - Now validates both directions: undeclared packages AND phantom packages
  - Prevents publish failures from stale package list entries
  - Root cause of 0.1.10 publish failure

### Changed
- **Test Suite Reorganization**: Separated integration tests from unit tests for faster development feedback
  - Moved 15 integration tests (testing file I/O, git, databases, ML models) to separate test phase
  - Unit test execution time improved from 121s to 27-41s (63% faster)
  - Integration tests run separately in ~34-38s
  - Coverage thresholds adjusted to reflect unit test reality: 70% for project coverage, 80% for new code (patches)
  - Clearer separation enables faster development iteration and better CI parallelization

### Internal
- **Turborepo Integration**: Build orchestration with intelligent caching and parallel execution
- **Circular Dependency Resolution**: Removed circular dependencies between packages for cleaner architecture
- **Shared Test Infrastructure**: `@vibe-agent-toolkit/test-agents` package for consistent testing across runtime adapters
- **Test Parallelism**: Adaptive test parallelism with `availableParallelism()` for 2x dev speedup

## [0.1.9] - 2026-02-07

- **Resource Compiler** (`@vibe-agent-toolkit/resource-compiler`) - Compile markdown to TypeScript with full IDE support
  - Direct `.md` imports in TypeScript with type safety
  - H2 headings become typed fragment properties for granular access
  - Frontmatter parsing to typed objects
  - IDE autocomplete, go-to-definition, and hover tooltips
  - `vat-compile-resources` CLI: compile markdown to JS/TS modules
  - TypeScript Language Service Plugin for seamless `.md` imports
  - Build integration: copy generated resources to dist during build
  - Dog-fooded in vat-example-cat-agents package

- **VAT Distribution Standard** - Package-based skill distribution with build and install infrastructure
  - `vat skills build` command: Builds skills from source into `dist/skills/` during package build
  - `vat skills install` command: Smart installation from npm packages, local directories, or zip files
  - Package.json `vat` metadata convention for declaring skills, agents, pure functions, and runtimes
  - Automatic skill installation via npm postinstall hooks
  - Two distributable skills:
    - `vibe-agent-toolkit`: User adoption guide for VAT CLI and agent creation (from vat-development-agents)
    - `vat-example-cat-agents`: Orchestration guide for 8 example cat agents (from vat-example-cat-agents)
  - See [Distributing VAT Skills Guide](./docs/guides/distributing-vat-skills.md) for usage

- **Audit Misconfiguration Detection** - `vat audit` now detects misconfigured standalone skills
  - Identifies standalone SKILL.md files in ~/.claude/plugins/ that won't be recognized by Claude Code
  - Error code: SKILL_MISCONFIGURED_LOCATION with actionable fix suggestions
  - Helps users correct common installation mistakes

- `--user` flag for `vat skills validate` to validate installed user skills
- Shared utilities: claude-paths, skill-discovery, user-context-scanner, config-loader
- Case-insensitive skill discovery (finds malformed SKILL.md variations)

### Changed
- **BREAKING**: `vat skills list` now defaults to project skills (use `--user` for installed skills)
- **Plugin Schema Updated to Official Claude Code Spec** - Updated ClaudePluginSchema to match official documentation
  - Made `description` and `version` optional (only `name` required if manifest exists)
  - Added component path fields: `commands`, `skills`, `agents`, `hooks`, `mcpServers`, `outputStyles`, `lspServers`
  - Renamed types for clarity: `PluginSchema` → `ClaudePluginSchema`, `Plugin` → `ClaudePlugin`
  - Updated plugin-validator to handle optional version field with exactOptionalPropertyTypes
  - Tests updated to validate actual errors instead of missing optional fields
- **CLI Dependency Cleanup** - Removed example agent packages from automatic installation
  - Removed `@vibe-agent-toolkit/vat-example-cat-agents` from CLI dependencies
  - Added `@vibe-agent-toolkit/vat-development-agents` to CLI dependencies
  - Added comment warning against adding example packages to CLI dependencies
  - Example agents now opt-in via separate `npm install -g @vibe-agent-toolkit/vat-example-cat-agents`
- **Skill Naming Consistency** - Skill names now match package names
  - `vat-example-cat-agents` skill renamed from `cat-agents-skill` for consistency
- Refactored `vat skills validate` to use shared utilities and respect resource config boundaries
- Refactored `vat skills list` to use shared utilities

### Fixed
- **RAG Metadata Filtering**: Now works correctly regardless of which Zod version (v3 or v4) you have installed
  - Previously: Metadata filters returned 0 results if your Zod version differed from the library's
  - Now: Automatically detects and works with both Zod v3.25.0+ and v4.0.0+
  - No code changes required - filtering just works
- **RAG Line Number Tracking**: Chunks now preserve exact line ranges from source documents
  - Previously all chunks from the same section had identical line numbers
  - Fixed off-by-one error in line position calculation (1-based to 0-based conversion)
  - Properly flattens nested heading hierarchy during section extraction
  - Handles large paragraphs by splitting into line-level chunks
  - Enables accurate IDE navigation and source citations
- **BREAKING CHANGE**: RAG database column names are now lowercase (SQL standard)
  - Existing LanceDB indexes must be rebuilt - run `await provider.clear()` then re-index
  - Your code doesn't change - still use camelCase in queries: `{ metadata: { contentType: 'docs' } }`
  - Why: Prevents case-sensitivity issues, no quotes needed in queries, follows SQL conventions
  - See migration guide: `packages/rag-lancedb/README.md#upgrading-from-v018-to-v019`
- Eliminated path duplication across audit, install, and other commands
- `vat audit --user` now finds standalone skills in ~/.claude/skills

### Added
- **RAG Similarity Scores**: Search results now include confidence scores (0-1, higher is better)
  - Filter results by confidence threshold
  - Compare result relevance
  - Build smarter retrieval logic
- **RAG Progress Tracking**: See real-time progress when building large indexes
  - Shows resources indexed, chunks created, time elapsed/remaining
  - Add progress bars to your CLI tools
  - Monitor long-running index builds
- **Accurate Line Numbers**: Chunks now track exact line ranges in source files
  - Jump directly to source in your IDE
  - Show precise code citations
  - Build better documentation tools

### Internal
- Deleted obsolete skill-finder.ts (replaced by skill-discovery.ts)
- Removed registry tracking from skills install command (architectural simplification)
- Preserved audit.ts custom scanning logic (architectural decision for independence)

## [0.1.8] - 2026-02-06

### Fixed
- **RAG Metadata Filtering at Scale**: Fixed metadata filtering returning empty results on production-scale indexes (>1000 chunks)
  - Root cause: LanceDB struct column access (`metadata['field']`) doesn't scale
  - Solution: Store metadata as top-level columns with direct access (`` `field` ``)
  - All metadata fields now stored as top-level LanceDB columns instead of nested struct
  - Filter builder updated to use direct column access for efficient queries
  - Added system test validating metadata filtering with flattened schema
  - Fixes issue reported by an adopter project (753 docs, 4,321 chunks)

### Changed
- **BREAKING CHANGE**: Existing LanceDB indexes must be rebuilt
  - Metadata storage format changed from nested struct to top-level columns
  - Run `await ragProvider.clear()` then re-index resources
  - API remains backward compatible - no code changes required beyond index rebuild
  - See migration guide in `packages/rag-lancedb/README.md`

## [0.1.7] - 2026-02-05

### Added
- **RAG Extensible Metadata Schema Support**: Custom metadata fields with full type safety
  - Generic provider interfaces with `TMetadata` type parameter for compile-time type safety
  - Zod schema introspection for automatic serialization/deserialization
  - Support for arrays (CSV), objects (JSON), dates (timestamps), and primitives
  - Type-safe query filtering on custom metadata fields
  - `DefaultRAGMetadata` schema with standard fields (tags, title, description, category)
  - See `packages/rag-lancedb/README.md` for usage examples

## [0.1.6] - 2026-02-04

### Fixed
- Umbrella package now works with `npx vibe-agent-toolkit` by adding ESM type declaration
- Version output now shows project root for local installs instead of "unknown"

## [0.1.5] - 2026-02-04

### Fixed
- CLI now works correctly with `npx` commands in CI environments without global installation
- Link validation detects case mismatches in filenames, preventing failures on case-sensitive filesystems (Linux)

## [0.1.4] - 2026-02-03

### Added
- **Multi-Collection Resource Validation System**: Comprehensive resource type system with frontmatter validation
  - Multi-collection support via `vibe-agent-toolkit.config.yaml` with pattern resolution
  - Per-collection frontmatter validation with JSON Schema
  - Validation modes: strict vs permissive
  - Collection filtering via `--collection <id>` flag in scan/validate commands
  - Format options: `--format yaml|json|text` for structured or human-readable output
  - Package-based schema references (e.g., `@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json`)
  - Enhanced validation error messages with actual/expected values
  - Enhanced `vat doctor` command validates config file schema and checks schema file existence
- **Agent Skills Package Rename**: `@vibe-agent-toolkit/runtime-claude-skills` → `@vibe-agent-toolkit/agent-skills`
  - Exported JSON schemas: `skill-frontmatter.json` and `vat-skill-frontmatter.json`

### Changed
- **Output Format Improvements**: Enhanced validation and scan output
  - Added error summary by type
  - Added per-collection error tracking (filesWithErrors, errorCount)
  - Simplified scan output with `--verbose` flag for file details
  - Errors grouped by file in structured output (YAML/JSON)

## [0.1.3] - 2026-02-01

### Added
- **Frontmatter Validation**: Parse and validate YAML frontmatter in markdown files
  - CLI flag `--frontmatter-schema` for `vat resources validate` to validate against JSON Schema
  - Reports YAML syntax errors and schema validation failures
  - `ResourceMetadata` includes parsed frontmatter data when present

## [0.1.2] - 2026-01-30

### Added
- **Session Management System**: Pluggable session persistence for stateful agents
  - `RuntimeSession<TState>` type with id, history, state, and metadata
  - `SessionStore<TState>` interface for pluggable persistence strategies
  - `MemorySessionStore` - in-memory sessions with TTL support and sliding window expiration
  - `FileSessionStore` - file-based persistence in `~/.vat-sessions/` (runtime-agnostic)
  - CLI transport integration with `--session-store` and `--session-id` flags
  - Session management commands: `/clear` (or `/restart`), `/state`
  - Commands shown upfront in CLI welcome message for better UX
  - Conversational demo supports session resumption across restarts
  - Session helpers: `validateSessionId`, `createInitialSession`, `updateSessionAccess`, `isSessionExpired`
  - Reusable test helpers to eliminate duplication across store implementations
- **Audit Command Enhancements**: Comprehensive validation of Claude skills
  - Transitive link validation - recursively follows and validates all linked markdown files
  - Unreferenced file detection with `--check-unreferenced` flag
  - BFS traversal to discover entire skill structure
  - Comprehensive statistics for all files in skill
  - Handles circular references gracefully
- **MCP Gateway**: Expose VAT agents through Model Context Protocol (`@vibe-agent-toolkit/gateway-mcp`)
  - Stdio transport for Claude Desktop integration
  - Stateless agent support (Pure Function Tools, One-Shot LLM Analyzers)
  - Multi-agent server support (expose multiple agents through single gateway)
  - Runtime-agnostic architecture with adapter pattern
  - Observability hooks (console logger, OpenTelemetry-aligned interfaces)
  - Error classification (retryable vs non-retryable)
  - Complete documentation and examples (haiku-validator, photo-analyzer, combined server)
  - Integration and system tests
- **Agent Runtime Architecture**: Core VAT agent archetype system
  - Pure function agents: Deterministic, synchronous tools
  - LLM analyzer agents: AI-powered analysis with structured I/O
  - Function orchestrator, event consumer, agentic researcher, conversational assistant archetypes
  - Provider-agnostic LLM integration via context.callLLM()
  - Shared validation and execution wrappers
- **Example Cat Agents**: Comprehensive agent examples for testing
  - Haiku generator/validator, name generator/validator
  - Photo analyzer, description parser
  - Human approval workflow
- **Runtime Adapters**: Convert VAT agents to framework-specific formats
  - `@vibe-agent-toolkit/runtime-vercel-ai-sdk`: Vercel AI SDK tools and functions
  - `@vibe-agent-toolkit/runtime-langchain`: LangChain DynamicStructuredTool
  - `@vibe-agent-toolkit/runtime-openai`: OpenAI function calling tools
  - `@vibe-agent-toolkit/runtime-claude-agent-sdk`: Claude Agent SDK MCP tools
  - All support both pure function and LLM analyzer archetypes
  - Multi-provider demos (Anthropic Claude, OpenAI GPT)
- **Shared Test Factories**: Zero-duplication test infrastructure in dev-tools
  - `createPureFunctionTestSuite()` and `createLLMAnalyzerTestSuite()` factories
  - Consistent testing across all runtime adapters
  - Runtime-specific behavior through config interfaces
- **Common Demo Infrastructure**: Runtime-agnostic demo framework
  - Single demo implementation works with any runtime adapter
  - Demonstrates agent portability across frameworks
  - Multi-provider comparison support
- **Documentation**: Guide for adding new runtime adapters
  - Package structure and configuration patterns
  - Adapter implementation best practices
  - Testing with shared factories
  - Validation checklist and common pitfalls
- **Result Constructors Re-exported**: Convenience exports from `@vibe-agent-toolkit/agent-runtime`
  - `createSuccess`, `createError`, `createInProgress`
  - Error constants: `LLM_REFUSAL`, `LLM_INVALID_OUTPUT`, `LLM_TIMEOUT`, etc.
  - All result types and metadata types re-exported for single-package convenience

### Changed
- Upgraded vibe-validate from 0.18.2-rc.1 to 0.18.4-rc.1 (fixes caching bug)
- Migrated from deprecated `vectordb@0.4.20` to `@lancedb/lancedb@0.23.0`
  - Resolves Bun compatibility issues with Apache Arrow
  - Changed nullable number fields to use -1 sentinel values instead of null
  - API changes: `search().execute()` → `vectorSearch().toArray()`, `filter().execute()` → `query().where().toArray()`
- Updated OpenAI SDK from 4.67.0 to 6.16.0 (resolves node-domexception deprecation warnings)
- **BREAKING: Pure Function Agent API Simplified** - Consolidated to single `definePureFunction` API
  - **Removed**: `createPureFunctionAgent` and `createSafePureFunctionAgent` (use `definePureFunction` instead)
  - **API Change**: Agents now return output directly (unwrapped) instead of `OneShotAgentOutput` envelopes
  - **API Change**: Pure function agents are now synchronous (`execute(input): TOutput`) instead of async
  - **API Change**: Invalid input throws exceptions instead of returning error envelopes
  - **API Change**: Handler function receives validated input, returns output directly (no manual wrapping)
  - **Archetype renamed**: `pure-function-tool` → `pure-function` for consistency
  - **Migration Path**: Replace `createPureFunctionAgent((input) => createSuccess(output), manifest)` with `definePureFunction(config, (input) => output)`
  - **Runtime adapters updated**: All four runtime packages handle new unwrapped API
  - **Documentation updated**: `docs/agent-authoring.md` shows only `definePureFunction` pattern

## [0.1.1] - 2026-01-12

### Added
- **`vat doctor` Diagnostic Command**: System health checks and troubleshooting
  - Validates Node.js, Bun, Git, TypeScript installations
  - Checks database connectivity (LanceDB)
  - Validates configuration files
  - Verifies installation integrity
  - Exit codes: 0 (all checks passed), 1 (issues found), 2 (system errors)
- **Resource Collection System**: Advanced resource querying with checksums
  - Content checksumming for change detection
  - Advanced filtering and querying capabilities
  - Test isolation infrastructure for improved reliability
- **Plugin & Marketplace Audit System** (`vat audit`): Comprehensive plugin ecosystem validation
  - Validates `plugin.json` manifests (name, version, description, metadata)
  - Validates `marketplace.json` with bundled skills, git repos, LSP servers
  - Registry tracking for installed plugins and known marketplaces
  - Cache staleness detection - detects stale cached skills vs installed plugins
  - Compares checksums between cache and source
  - Identifies cache-only and installed-only resources
  - Hierarchical output with cache status indicators (stale/fresh/orphaned)
  - `--verbose` flag for detailed diagnostic output
  - Filter plugin/marketplace results from skill-only scans
  - Performance optimizations for large plugin collections

## [0.1.0] - 2026-01-04

### Added
- **Publishing System**: Automated npm publishing with rollback safety
  - `validate-version`: Ensures all packages have unified version
  - `publish-with-rollback`: Publishes 11 packages in dependency order with automatic rollback/deprecation on failure
  - `extract-changelog`: Extracts version-specific changelog for GitHub releases
  - GitHub Actions workflow triggered by version tags (v*)
  - Smart npm dist-tag handling: RC versions → @next, stable versions → @latest
  - Manifest tracking for publish progress and rollback capability
  - Cross-platform test helpers with security validation
- **Agent Runtime**: Execute agents with `vat agent run <name> "input"` using Anthropic API
- **Agent Discovery**: List all agents in your project with `vat agent list`
- **Agent Validation**: Validate manifests and resources with `vat agent validate <name>`
- **Claude Skills Audit**: Comprehensive validation of Claude Skills with `vat agent audit [path] --recursive`
  - Validates frontmatter fields (name, description, license, compatibility)
  - Enforces naming conventions (lowercase, hyphens, reserved words)
  - Checks link integrity (broken links, Windows paths)
  - Detects console-incompatible tool usage (Write, Edit, Bash)
  - Exit codes: 0 (success), 1 (validation errors), 2 (system errors)
- **Claude Skills Import**: Convert SKILL.md to agent.yaml with `vat agent import <skillPath> [options]`
  - Extracts frontmatter metadata to agent manifest
  - Validates before conversion
  - Supports custom output paths with `--output`
  - Force overwrite with `--force`
- **Claude Skills Packaging**: Build agents as Claude Skills with `vat agent build <name>`
- **Installation Management**: Install/uninstall Claude Skills locally with `vat agent install/uninstall <name>`
- **Installation Scopes**: Control installation location with `--scope user|project`
- **Dev Mode**: Symlink-based development workflow with `--dev` flag
- **Gitignore Support**: File crawler and link validator now respect `.gitignore` patterns
- **RAG System**: Document indexing and semantic search with LanceDB
- New package: `@vibe-agent-toolkit/agent-config` - agent manifest loading and validation
- New package: `@vibe-agent-toolkit/runtime-claude-skills` - Claude Skills builder, installer, validator, and import/export
- New package: `@vibe-agent-toolkit/discovery` - format detection and file scanning utilities
- New documentation: [Agent Skills Best Practices Guide](./docs/guides/agent-skills-best-practices.md)
- New documentation: [Audit Command Reference](./docs/cli/audit.md)
- New documentation: [Import Command Reference](./docs/cli/import.md)
- **Resources System**: Markdown resource scanning and validation of link integrity

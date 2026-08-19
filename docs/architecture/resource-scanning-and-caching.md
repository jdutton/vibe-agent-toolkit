# Resource Scanning and Object Caching

**Status markers used throughout:** ✅ shipped — 🔷 proposed, not yet built.

## 1. Overview

Every VAT resource-scanning verb (`vat resources scan`, `vat resources validate`, `vat audit`,
`vat skills build`, ...) asks the same question before doing anything expensive: *has this exact
content been parsed before?* How cheaply that question can be answered depends on two things: whether
the corpus lives inside a git working tree, and whether VAT has a stable identity to persist a "what
changed" manifest against between runs.

This document covers the **input side** — discovering what bytes exist and reading them cheaply and
correctly. See [Resource Projection](./resource-projection.md) for the **output side** — what gets
built from those bytes, the schema it's stored as, and how that result is cached.

## 2. The scanning taxonomy, and the rule it is scored against

### 2.1 The rule — declared here

**The population a VAT command scans is `tracked ∪ (untracked ∧ ¬ignored)`: what a commit made right
now *would* contain.** That is a repo-wide obligation, not a per-caller preference. A brand-new,
uncommitted, un-ignored file MUST be visible to any crawler; a command that cannot see one has a
**defect**, not a narrower scope. A gitignored path is never part of a prospective commit and stays
out, so the exclusion binds the same way the inclusion does.

This repository has no ADRs — a decision lives in an architecture document, in `CHANGELOG.md`, or in
the docstring of the thing it governs. So this section is where that rule lives, and it is a binding
statement rather than a note. [Command Population Matrix](./command-population-matrix.md) scores
every command against it, cell by cell; this paragraph is the standard those cells cite.

**Three bounds the rule does not claim**, each an open question in that document rather than a silent
extension of this one:

- **Packaging populations — what *ships* — are not settled by it.** `vat claude plugin build` copies
  tracked files only and warns about untracked skill directories, by declared intent. Under the set
  above an untracked-not-ignored skill *would* be in a commit and so should ship; under "you ship what
  you committed" it should not.
- **Populations with no git behind them are not settled by it.** Outside a working tree neither
  "tracked" nor "ignored" exists, a `.gitignore` sitting there is inert, and the population is
  whatever the globs admit. That is today's behaviour; this section does not ratify it.
- **A population that is deliberately build output is a different subject.** `vat claude marketplace
  validate` reads `dist/`, which is normally gitignored, and must — a verify verb that could not see
  what was built would be useless. The exclusion half above governs the **source corpus**, not a tree
  whose whole purpose is to be generated.

### 2.2 The taxonomy

| state | in a git working tree? | does VAT see it today? |
|---|---|---|
| git-tracked, clean | yes | yes — always |
| git-tracked, dirty (edited, uncommitted) | yes | yes — always |
| git-untracked, not gitignored | yes | **yes — required by §2.1**. Every `crawlDirectory`-backed scanning lane passes `includeUntracked: true`; the routes that never consult git at all see it incidentally |
| git-ignored | yes | **split, and the split is deliberate** — the scanning lanes never scan them (§3.1); the projection's `filesystem` extent always does |
| non-git entirely (SharePoint, OneDrive, iCloud, `~/.claude/*`, ...) | no | yes, via filesystem crawl — no git shortcut available |

**The untracked row used to read "depends on the caller", and that inconsistency is what §2.1
resolves.** `gitLsFiles()` (`packages/utils/src/git-utils.ts`) spawns `git ls-files -z` by
default — tracked files only. Passing `includeUntracked: true` adds `--cached --others
--exclude-standard`, pulling in untracked-but-not-ignored files too, and *keeping* the fast path,
unlike `respectGitignore: false` which costs the whole walk and also admits ignored files.
`crawlDirectorySync()` (`packages/utils/src/file-crawler.ts`) still defaults
`includeUntracked` to `false` — it is a general-purpose crawler with callers that are not scanning a
corpus — so each scanning lane sets it: `ResourceRegistry.crawl()`
(`packages/resources/src/resource-registry.ts`) and `crawlOneBase()`
(`packages/cli/src/commands/skills/skill-discovery.ts:97-116`) both do, the latter with a comment
noting skills must be discoverable before being committed.

**Demonstrated, not merely reasoned about** (2026-08-16, against the pre-rule code): on a two-file
repository with one committed and one uncommitted markdown file, each carrying a broken link, `vat
resources validate` reported `filesScanned: 1` and one finding. The uncommitted file's broken link
was not missed *quietly* — it was invisible, and the command exited green about the half it could
see. That measurement is the evidence behind §2.1, and it is what the registry's
`includeUntracked: true` now fixes on the default lane; §3.4's opt-in projection lane reaches the
same population by a different mechanism.

If `gitFindRoot()` finds no repository, or `gitLsFiles` returns `null`, `crawlDirectorySync` falls
through to a manual `fs.readdirSync` walk (`file-crawler.ts:239-417`) — the non-git lane, §3.2.

**The gitignored row is why the git lane cannot simply replace the projection's `filesystem`
extent.** That extent exists precisely to model "Claude sees gitignored build output that the git
extent cannot" (zones §2, and `filesystem-extent.ts`'s own header), and it is the only contributor
that can ever write `gitignored: true` — the `git` extent enumerates `tracked ∪ (untracked ∧
¬ignored)` and so emits `false` by construction. A tree snapshot (§3.1) excludes ignored paths by
design, so it can accelerate the *tracked* portion of that extent and nothing more. Sourcing the
ignored remainder is §6 work, not something §3.1 already covers.

## 3. Two lanes, two cost models

### 3.1 The git lane

Git is already the source of truth for a working tree's exact state. Three git-plumbing facts make
this lane structurally cheaper than a filesystem crawl, and none of them are VAT inventions:

- **`git ls-files -s`** returns every tracked path and its *index* blob SHA in one call, no per-file
  stat. Cheap, but the SHA it returns names the committed bytes — for a dirty file that is stale, not
  what's on disk.
- **A deterministic, dirty-corrected tree snapshot closes that gap.** `@vibe-validate/git`'s
  `getGitTreeHash()` (`packages/git/src/tree-hash.ts:188-327` in the `vibe-validate` repo, published
  to npm as `@vibe-validate/git`) copies the real git index to a process-scoped temp file, runs
  `git add --all` against it via a `GIT_INDEX_FILE` env override (the real index and working tree are
  never touched), then `git write-tree` against that temp index. The result is a real, immutable git
  tree object whose blob SHAs reflect **actual on-disk content** for every tracked and
  untracked-not-ignored path — dirty files included, correctly. This property (a tree snapshot's blob
  SHA for a dirty file matches its actual on-disk content, not the stale committed-index SHA) was
  verified directly against `write-tree` itself, against this repo: `git hash-object` on a dirtied
  tracked file matched the blob SHA inside the resulting write-tree, differed from the committed-index
  SHA, and two separate `write-tree` calls against the same dirty state returned the identical tree SHA.
  - **Not `git stash create`.** An earlier iteration of this design assumed stash was the mechanism.
    It is not, deliberately: a stash is a commit object, and every commit carries an
    author/committer timestamp baked into its hash. Git commit timestamps have one-second granularity,
    so two `stash create` calls against byte-identical content produce the **same** commit SHA within
    one second and a **different** one across a second boundary — intermittent nondeterminism, which
    is arguably a worse failure mode than a reliably different result would be, since it makes the bug
    look like a flake rather than a mechanism. `write-tree` has no timestamp field at all.
    `@vibe-validate/git`'s own source comments this explicitly as a "CRITICAL FIX" over an earlier
    stash-based approach.
  - **Untracked-but-not-ignored files are included** (via `git add --all`, no `--force`); gitignored
    files are explicitly excluded — deliberately, for the same reason resource scanning excludes
    them: checksumming secrets or build artifacts is a liability, not a feature.
- **Reading captured content immutably.** Once a blob SHA is in a tree snapshot, its bytes live in
  `.git/objects` and cannot change under that SHA by construction. Reading via `git cat-file --batch`
  (one long-lived process, fed SHAs over stdin — never one `cat-file -p <sha>` invocation per blob) is
  therefore both faster and race-free for anything the snapshot already named: no re-check needed,
  because the read source is immutable rather than merely unlikely to change.

  Measured on this repo (1,939 tracked blobs, warm OS cache, macOS): a single `cat-file --batch`
  process took 0.139s against 0.253s for a single-process read of the same 1,939 files by path — a
  modest 1.8× on this platform. `git count-objects -v` on the same repo shows most objects already
  live in packfiles (`in-pack: 33633` vs `count: 1829` loose, across 29 packs), meaning most of that
  batch read was served from a small, fixed number of already-open packfile handles rather than 1,939
  separate `open()` calls.
  That's expected to matter far more on Windows, where per-file `open()` carries NTFS
  metadata-lookup and antivirus minifilter-scan overhead that a small number of packfile reads mostly
  sidesteps. **Expected, not yet measured** — verifying this on an actual Windows box is follow-up
  work (§6).

**What's genuinely new VAT work, not inherited for free:** `@vibe-validate/git` gives VAT the tree
snapshot primitive. It does not give VAT a blob-SHA → content-key memo — no such per-file cache exists
anywhere in `vibe-validate` today (its only content-keyed cache is the whole-tree hash itself, used to
look up validation history in git notes) — and it does not give VAT the logic to diff one snapshot's
manifest against the previous run's to find exactly which paths changed. Both are 🔷 proposed, unbuilt
VAT-side work; see §6.

### 3.2 The non-git lane

No git object store exists to shortcut against — SharePoint, OneDrive, iCloud-synced folders,
`~/.claude/*`, any directory that isn't a git working tree. Reading and content-hashing every file is
the only way to know what's there; this is exactly what the shipped stage-2 parse cache already does
today (hash-on-read — see [Resource Projection §5](./resource-projection.md)).

Within this lane, whether it's worth **persisting** a manifest between runs — the non-git equivalent of
a saved tree hash — depends on whether the target has a stable identity to persist against:

- **Ad hoc** (e.g. `vat audit /some/one-off/path`): no config file, no promise anyone returns to this
  path. Crawl in memory, every run, full cost. The content-addressed *object* cache (§5) still
  applies — if the exact same bytes were seen on some other path or a prior run, the parse is still
  free — but there is no shortcut for *discovering what changed*, because there's nowhere to remember
  what the tree looked like last time.
- **Anchored** (the directory has its own `vibe-agent-toolkit.config.yaml`): a recognized, returned-to
  project. Worth persisting both the object cache *and* a resource-tree manifest analogous to the git
  lane's tree hash, so a repeat run over the same anchored root can skip re-crawling unchanged files
  the same way the git lane does. 🔷 **Proposed, not yet built** — no such persisted non-git manifest
  exists today.

### 3.3 One crawl API, two implementations — and none of it needs a columnar store

The two lanes above are cost models. The shape they should take in code is **one crawl API with two
implementations behind it**, selected by whether the root is a git working tree — not two call paths
chosen ad hoc at each site. Stated as the contract:

| | git implementation | non-git implementation |
|---|---|---|
| enumerate + content key | `getGitTreeHash()` temp index → `ls-files -s`: paths, blob SHAs, and file modes in one call | `readdir` walk + hash-on-read |
| gitignored remainder | `ls-files --others --ignored --directory` prune list (369 entries / 60 ms on an 8,496-path adopter), descend only where a lens asks | already enumerated by the walk |
| symlink detection | free — mode `120000` arrives with the path (§4) | per-entry `lstat` |
| cache key | `write-tree` — exact, whole-tree, free | anchored manifest (§3.2, 🔷 unbuilt) or none |

Three constraints this table encodes, each of which has already been got wrong once:

- **The git implementation is not purely git.** It must still emit `gitignored: true` rows, because
  that is the one thing the projection's `filesystem` extent exists to provide and the one thing a
  tree snapshot structurally cannot see (§2). A git lane that silently drops ignored paths would be
  faster and would delete the capability.
- **Both lanes are cacheable, but their keys differ in kind, not merely in cost.** The git lane's key
  is exact and free. The non-git lane has no free snapshot, so "is caching worth it" is a genuinely
  different question per lane and should not be answered once for both — see §3.2's ad-hoc vs
  anchored split.
- **The API is the seam that makes the choice reviewable.** Two implementations of one interface can
  be differentially tested against each other on the same root; two ad-hoc code paths cannot, and a
  divergence between them shows up only as a wrong answer somewhere downstream.

**None of this depends on a columnar store.** Sourcing (this section) and persistence (a
`ProjectionStore` substrate) are separable: the git lane already yields a content key per path and an exact whole-tree
invalidation key, which is the entire input a persisted table would need. Doing the sourcing work
first is what makes the persistence work worth doing — and it banks most of the win on its own.

#### ✅ Built — `packages/resources/src/projection/crawl-source.ts`

`CrawlSource` is the interface; `FilesystemCrawlSource` is the incumbent walk unchanged, and
`GitCrawlSource` is git plus a bounded walk of only what git cannot see. `FilesystemExtentContributor`
takes one, chosen at the seam by `crawlSourceFor()` behind `VAT_EXTENT_SOURCE=git` — **the walk is
still the default**, because the git route reaches the same population by a different mechanism and
that is a change to measure before taking (§3.4 makes the same argument for `VAT_RESOURCES_CRAWL`).

The git implementation composes four questions, and the last two are not optional extras — they are
what makes it return the same set rather than a faster smaller one:

1. `getGitTreeSnapshot` → `tracked ∪ (untracked ∧ ¬ignored)`, with on-disk blob OIDs.
2. `ls-files --others --ignored --exclude-standard --directory` → the prune list, descended into.
3. `ls-files --others --directory` → wholly-untracked directories, **including the empty ones** that
   appear in no tree object because git tracks content and an empty directory has none.
4. Ancestor directories derived from every path, since a tree object records files and implies dirs.

**Two behaviours the parity harness forced, both of which the design above missed.** Writing the
differential test is what surfaced them, which is the argument for the seam restated as evidence:

- **A committed symlink is excluded from the git source.** `crawlDirectory`'s manual walk runs with
  `followSymlinks: false` and never records a link's own path, so the filesystem extent has never
  contained one. Git reports mode `120000` like any other entry. Admitting it would have imported
  `file-crawler.ts`'s KNOWN DIVERGENCE into an extent that does not have it — silently, as rows that
  look like files whose bytes are a path string.
- **A submodule is descended into.** It is one mode-`160000` entry whose OID is a *commit*, and none
  of its files appear in the outer snapshot; the outer walk simply reads the directory. Matching it
  means expanding it.

Verified three ways: `crawl-source-parity.integration.test.ts` differences the two sources and then
the two extents' realization rows (`path` **and** `contentKey`) on one fixture built so that each row
of the table above is reached differently by each source; five mutations were run to confirm the
right assertions redden. End to end, `vat resources scan --format json --verbose` over this
repository returns byte-identical `path + checksum` sets on both arms — 176 files.

### 3.4 ✅ The resources lane on the projection — shipped opt-in, and what it measured

`ResourceRegistry.crawl()` takes an optional `populationSource`. Supplied, the file list comes from
a base-only projection (`buildResourcePopulation` → `FilesystemExtentContributor`) instead of from
`crawlDirectory`; omitted, nothing changes. The CLI selects the lane at its boundary with
`VAT_RESOURCES_CRAWL=projection`, which covers `vat resources scan`/`validate`, `vat rag index` and
the pipeline oracles in one place — they all load through `loadResourcesWithConfig`.

**`include`/`exclude` are still applied by the registry, using `crawlPathFilter` — the same compiled
matcher `crawlDirectory` uses on its `git ls-files` branch.** The source answers enumeration only.
That split is what makes the two lanes reviewable: a difference in the output is a difference in the
population, never a difference in what the project's globs were taken to mean.

**A source carries the ONE root it may answer for, and `populationFrom` checks it.** A source built
against tree A but asked about tree B would build B's population with A's ignore oracle and file it
under **A's extent key**, which the next run reads back and believes — worse than a wrong answer in
one run. So `ResourcePopulationSource` is `{ root, enumerate }` rather than a bare function, and the
registry compares the two roots *resolved* (trailing separator, `a/../a`, symlinked ancestor, and
case where the filesystem folds it, all compare equal — `sameDirectory` in `resources/src/utils.ts`).
A mismatch **declines back to the walk** and warns on stderr naming both roots. It does not throw:
`packaging-validator.ts`'s `findProjectRoot(...) ?? dirname(skillPath)` legitimately lands on a build
output directory in an adopter layout with no config and no `.git` above it. And it never declines to
an *empty* population, which would report a confident green over a corpus nothing looked at.

**What it changes.** The population is `tracked ∪ (untracked ∧ ¬ignored)` — §2.1's rule, reached by a
different mechanism. ⚠️ **This used to be the lane's distinguishing property and no longer is:** the
default walk now passes `includeUntracked: true` too, so an uncommitted markdown file is visible to
validation on *both* lanes. The measurements below were taken before that, and are kept as the
evidence that produced §2.1 rather than as a live description of the difference. Gitignored rows are
enumerated by the extent and **declined by this consumer**, deliberately: admitting them would start
emitting findings about files the project told git to forget.

**What it loses: committed symlinks — and this is the third symlink behaviour in the codebase, not
a variation on the two already documented in §4.** `FilesystemExtentContributor` crawls with
`followSymlinks: false`, and the manual walk under it skips symlink entries entirely rather than
recording them unresolved. So a committed symlink is enumerated by the default lane and is *not a
member at all* here.

- **In-tree target** — arguably an improvement. The default lane reaches the same bytes twice, once
  per path, and reports the same defect twice.
- **Out-of-tree target** — a genuine capability loss, not deduplication. Those bytes have no other
  path into the population, so a broken link the default lane reports goes unreported. This is the
  case that keeps the lane opt-in independently of the cost.

⚠️ `crawlDirectory`'s git branch already carries a documented known divergence about symlinks,
pinned by `packages/cli/test/integration/enumeration-symlink-divergence.integration.test.ts`. That
pin covers the git-vs-manual-walk pair. **This lane is a third behaviour and is not covered by it** —
resolving §4's proposed within-snapshot resolution is what would collapse all three.

**Measured 2026-08-16.**

| subject | walker | projection | note |
|---|---|---|---|
| git repo, 1 committed + 1 untracked broken link | `filesScanned: 1` | `filesScanned: 2` | the untracked file's real broken link, found. ⚠️ **The walker column is pre-§2.1**; both arms are 2 today |
| git repo, 2 committed symlinks | `filesScanned: 3` | `filesScanned: 1` | the symlink paths are not members |
| non-git anchored corpus, 198 files / 90 HTML / 3,950 links | 112 files, 0.085 s | 112 files, 0.926 s | output **byte-identical** but for `durationSecs` |
| ...its `resource-registry:enumerate` row | 2.7 ms | 851.9 ms | **316×** |
| adopter git working tree, 1,378 resource files across 8 collections | 1.02 s | 4.99 s | **4.9×**, output byte-identical but for `durationSecs` |
| ...its `resource-registry:enumerate` row | 24.2 ms | 4,580.7 ms | **189×** |

**The adopter row is the blast-radius measurement, and it needs its precondition stated to mean
anything** — including that it, too, is a pre-§2.1 walker arm. That tree carried zero untracked files and zero committed symlinks at measurement time,
so the two lanes had no population to disagree over — "byte-identical" there is agreement on
*today's tree state*, not a property of the lanes. Re-measured with one untracked `roadmap.md`
carrying a broken link added to it, the same tree gives `filesScanned` 1,378 → **1,379**,
`errorsFound` 0 → **1**, and `status: success` → **`error`**. **So on that adopter the flip costs
~4× wall clock and changes no finding until somebody has uncommitted work — at which point it turns
a green run red, which is the entire point of the lane.** Sizing the flip from the clean-tree run
alone would be sizing a fixture that cannot distinguish.

⚠️ **The `base` rows are NESTED inside `resource-registry:enumerate`, not additive to it** (675.3 ms
`builtin:filesystem` + 174.8 ms `blob-population:derive` = 850.1 ms of the 851.9 ms). Summing them
per arm inflates the projection arm alone and corrupts the ratio. Compare `enumerate` to `enumerate`.

**It is opt-in, and the asymmetry with `vat inventory`'s default-on selector is the point.** The
inventory flip was defensible as a default because it was provably a byte-for-byte no-op. This lane
cannot claim that, because it deliberately does not agree: it drops committed symlinks (§4), and for
an out-of-tree target those bytes have no other path into the population. It used to disagree in the
other direction too, by adding findings on untracked files — §2.1 closed that half by moving the
default walk onto the same population, leaving the symlink loss as the whole of the remaining
disagreement. That blast radius is a product call, not a correctness argument.

#### The defect this lane found: every file was being handed to the markdown parser

`parserKindForPath` routes `.html`/`.htm` to the HTML parser and **everything else to markdown**.
That is deliberate — narrowing the parse to markdown would blind the closure to references emitted
from a skill's bundled scripts — but nothing bounded it, and the `filesystem` extent enumerates a
whole tree rather than a glob. So `remark-parse` was being handed every zip, PDF and `.docx` under
the root. It does not *fail* on binary input; it succeeds, slowly.

Measured: a project of one 13-byte markdown file plus one 8 MB zip cost **4.83 s against the
walker's 0.035 s — 138×** — for the identical answer, because the zip was never a member of the
result. On the 86 MB adopter corpus above (77 MB of it PDFs and archives) the command did not finish
in five minutes at 100% CPU.

Fixed by a **content sniff, not an extension list**: a NUL byte inside the first 8000 bytes (git's
own heuristic) means the blob is not text, and `populateBlobs` records a `BLOB_NOT_TEXT` condition
instead of parsing. An extension rule would be a claim about a filename — a renamed archive would
still hang, and a bundled `.sh` the closure genuinely wants read shares no extension with markdown.
The blob stays keyed and stays a member; only the parse is declined, and the refusal is a row rather
than a silence. The 8 MB-zip probe went 4.83 s → 0.111 s.

**This was never resources-specific.** `vat inventory` on any plugin shipping a binary asset paid
the same cost; the resources lane merely pointed the projection at trees big enough to notice.

## 4. Symlinks

Detection is free in the git lane: `git ls-files -s` (and the write-tree manifest built from it)
already carries the file mode alongside path and blob SHA in the same call — mode `120000` names a
symlink, no extra `lstat` needed.

Handling has converged toward resolving **within the same snapshot**, rather than treating a
symlink's own blob (which git stores as the link-target *string*, not the resolved file — a
documented collision source, see §5) as meaningful on its own: if the symlink's target path lands
inside the same tree snapshot, look the target up in that already-fetched manifest and use *its* blob
SHA. That sidesteps the original collision — two symlinks sharing identical target text but resolving
to different real locations — because resolution now depends on the symlink's own location within the
tree, not the literal string alone. If the target lands outside the snapshot (outside the repository,
or gitignored), that's not a special symlink case anymore, it's the non-git lane's problem: the
target's bytes have no git-tracked home to be looked up in.

🔷 **Proposed; not fully specified.** Remaining open fallbacks: multi-hop symlink chains, and the exact
non-git-lane handoff for an out-of-tree target. (A dangling target is already `RESOURCE_UNREADABLE`,
handled independently of this design.)

**Three shipped behaviours today, and the design above collapses all three.** Nothing in this
section is built yet, so an author asking "does VAT see my symlink?" gets a different answer per
lane:

| lane | committed symlink | pinned by |
|---|---|---|
| `crawlDirectory`, git branch (`git ls-files`) | enumerated as a path | `enumeration-symlink-divergence.integration.test.ts` |
| `crawlDirectory`, manual walk (`followSymlinks` default off) | skipped | same test — this is the documented divergence |
| projection population (§3.4, `FilesystemExtentContributor`) | skipped, in a git tree too | §3.4's measured probe |

The third row is the one that matters for the §3.4 product call: it makes the *git* lane behave like
the *non-git* one, which for an out-of-tree target loses bytes nothing else enumerates.

## 5. What's shared, what's not

Two layers, deliberately kept apart:

- **The object-level content cache** (✅ shipped, stage 2) — given bytes, produce parsed facts once,
  keyed by a hash of the bytes actually handed to the parser. This layer is lane-agnostic by
  construction: it has never cared whether the bytes came from a git blob, a SharePoint download, or a
  loose file on disk, only that the same bytes produce the same key.
- **Change detection — "did anything happen since last time"** — lane-specific, because the mechanism
  differs: the git lane can ask git for a cheap, correct, deterministic answer (§3.1); the non-git lane
  cannot, and either crawls fresh every time (ad hoc) or maintains its own persisted manifest
  (anchored, proposed).

This split is why the blob-SHA memo (mapping a git blob SHA to a content key, so a re-seen blob skips
even the read) is layered **on top of**, not **instead of**, the existing hash-on-read mechanism — a
lane-specific shortcut into a lane-agnostic cache. The cache itself doesn't change shape to accommodate
it. See [Resource Projection §4](./resource-projection.md) for the corresponding split on the output
side (tree-shape caching vs. the blob-keyed tables).

## 6. Follow-up work this document surfaces

- **Benchmark the git-lane batch-read advantage on Windows.** The packfile/small-file reasoning in
  §3.1 is mechanistically sound but unmeasured on the platform it matters most for.
- **Build the blob-SHA memo and manifest-diff logic**, VAT-side, using `@vibe-validate/git`'s
  `getGitTreeHash()` as the underlying primitive. **Half-built** — read this bullet's ⚠️ correction
  below before extending it, then note precisely where the line now falls:

  ✅ The *within-run* half exists. `GitCrawlSource` carries each path's on-disk blob OID as
  `EnumeratedPath.contentHint`, and `RunContentCache.read()` uses it as a `(hint, parserKind)` lookup
  so a second path holding identical bytes costs no read at all — reported as `hintHits`, separately
  from `hits`, because it is the one saving whose soundness rests on something outside that class.
  All three conditions the correction imposes are enforced structurally: the stored key is still
  hashed from bytes, a hint hit returns the content so no row goes back to disk, and mode-`120000`
  entries never reach the field because they are not members at all (§3.3).

  🔷 The *cross-run* half — a persisted `(blobSha, parserKind) → contentKey` memo, and the
  snapshot-to-snapshot manifest diff — remains unbuilt. That is where the warm-cache prize in the
  table below actually lives: within one run a hint only pays where a corpus holds duplicate bytes.

  Measured 2026-08-16 on an adopter working tree (8,496 tracked paths, macOS, warm), which sizes the
  prize against the `filesystem` extent this would accelerate (`builtin:filesystem`, 1,537 ms warm /
  2,948 ms cold on that tree):

  | step | cost | yield |
  |---|---|---|
  | `cp .git/index` + `git add --all` via `GIT_INDEX_FILE` | 100 ms cold, 70 ms warm | dirty + untracked hashed |
  | `git ls-files -s` against the temp index | **10 ms** | 8,496 paths **with real content OIDs** |
  | `git write-tree` | 30 ms | deterministic snapshot key |
  | **total** | **~140 ms** | replaces enumeration *and* the SHA-256 read |

  So the enumerate-and-key half is ~10× cheaper via git, and the content key arrives already
  computed — which is also the join key the memo above would use. `git add --all` re-hashes only
  what the index's stat cache shows as changed, so a clean tree reads nothing. Two costs worth
  naming: it writes loose blob objects into the target repo's `.git/objects` (not a pure read), and
  git OIDs are SHA-1 against VAT's `<parserKind>.<sha256>`, so adopting them is a key-format change
  to be compared as sorted multisets, not a swap.

  **⚠️ Correction — "replaces the SHA-256 read" is warm-only and bounded. Read `content-key.ts`
  before building this.** That module's docstring ("Why there is no git rung here") already
  considered and rejected a git OID as the content key, on three grounds: the *index* SHA is stale
  for a dirty file (the temp-index snapshot above fixes this one, and only this one); git stores a
  symlink as a blob holding the link **target string**, so two symlinks with the same relative
  target but different resolutions share an OID while VAT follows them and the parser reads
  through; and a key derived at enumeration and used to file a parse performed later binds the old
  key to new bytes. Its rule: **a git SHA may be used as a *lookup hint* whose miss is free — it
  must never be the key.**

  The `(blobSha, parserKind) → contentKey` memo proposed above *is* that permitted hint, so the two
  documents do agree — but only under three conditions the table above does not state:

  - **The saving is warm-only.** A cold memo misses on every path and hashes on read anyway.
    "Replaces enumeration *and* the SHA-256 read" is a warm-cache claim written as an unconditional
    one.
  - **Mode `120000` entries must be excluded from the memo**, or the symlink defect lands. §3.3's
    table already supplies the mode for free, so this is cheap — but it is not automatic.
  - **Once a row's key came from the memo, those bytes must not be re-read from disk in the same
    run**, or the stale-binding defect lands by a different route.

  **A harder bound the table misses entirely:** `ParseResult` carries *required* `content` and
  `sizeBytes`, and `parse-cache.ts`'s `rehydrate()` fills both from the fresh read, deliberately
  never from the stored entry (`sizeBytes` is a raw byte count that the decoded string cannot
  recover). **So a parse-cache hit still reads the file.** The read is skippable only for a path
  that is keyed and *never parsed*. Measured on the same adopter tree: **9,974 keyed paths against
  1,378 resource files**, so ~8,600 (86%) are keyed-only and could skip the read while ~1,374 must
  be read regardless. That puts the git lane's syscall prize at ≈ 1,998 `readdir` + ~8,600 keying
  reads ≈ **15% of that command's filesystem calls** — real, and worth building, but neither a
  drop-in nor the largest remaining term.

- ✅ **Source the gitignored remainder without a full crawl** (see §2). The tree snapshot excludes
  ignored paths, so the projection's `filesystem` extent still needs them. `git ls-files --others
  --ignored --exclude-standard` costs 1.19 s and returns 533,557 paths on that tree — worse than the
  crawl. Adding `--directory` collapses each wholly-ignored directory to a single entry: **369
  entries in 60 ms**, which is a prune list rather than a file list, and lets a caller descend only
  into the ignored territory a lens actually wants (`dist/`) while skipping `.turbo/cache`
  (418,518 of those paths) by name without ever entering it.

  Built as `gitLsOthers()` (`packages/utils/src/git-utils.ts`) and consumed by `GitCrawlSource`
  (§3.3). ⚠️ **What shipped descends into every ignored directory the prune list names**, because the
  extent's contract is to report `gitignored: true` rows and dropping them would delete the
  capability. `NEVER_CRAWL_GLOBS` is applied to the *collapsed* entry, so a pruned directory is
  skipped by name and never entered — that is where the saving is today. "Descend only where a lens
  asks" is a further, unbuilt step, and it is a population change rather than a re-sourcing.
- ✅ **Decide the resources-vs-skills untracked-file inconsistency** (§2). Decided and declared at
  §2.1: the population is `tracked ∪ (untracked ∧ ¬ignored)` for every scanning lane, and
  `ResourceRegistry.crawl` passes `includeUntracked: true` so the default walk carries it — the
  projection lane (§3.4) is no longer the only route to that population. What remains is the separate
  product call on the projection lane's own default, which now turns only on the symlink loss and the
  cost, and the three scope bounds §2.1 does not claim (packaging, non-git, build output), open in
  the [Command Population Matrix](./command-population-matrix.md) §8.
- **Design the anchored non-git manifest** (§3.2). Nothing exists yet; SharePoint/OneDrive/iCloud
  connectors are explicitly in scope for this design, unbuilt.
- **Finish symlink-handling fallbacks** (§4): multi-hop chains, the precise non-git-lane handoff.

## 7. Depending on `@vibe-validate/git`

VAT can add a genuine **runtime** dependency on `@vibe-validate/git` (already published, `0.19.6` on
npm) without creating a circular dependency — but the reasoning is specific enough to spell out rather
than take on faith:

- VAT's existing relationship with `vibe-validate` (`@vibe-validate/cli` and `vibe-validate` in this
  repo's root `package.json`) is **dev-time only** — used to orchestrate `bun run validate` locally,
  never shipped as a dependency of any published VAT package.
- The **umbrella** `vibe-validate` package has a genuine **runtime** dependency back on
  `vibe-agent-toolkit` (`packages/vibe-validate/package.json`, `dependencies.vibe-agent-toolkit`).
  Depending on that umbrella package from VAT at runtime would be a real cycle.
- `@vibe-validate/git` specifically does not have that problem: its own dependencies are
  `@vibe-validate/utils` and `yaml` only (confirmed via both its source `package.json` and
  `npm view @vibe-validate/git dependencies`) — no path back to VAT at all, dev or runtime.

So the dependency chain is a straight line with no way back: VAT → `@vibe-validate/git` →
`@vibe-validate/utils` (+ `yaml`). One honest cost worth naming, not a blocker: `@vibe-validate/git`
also ships branch-sync-checker and post-merge-cleanup utilities VAT has no use for — a minor footprint
cost for a CLI dependency, not a browser bundle.

## Related

- [Resource Projection](./resource-projection.md) — the output side: the shipped parse-cache output
  shape, the proposed blob-keyed and path-dependent schema targeted for stage 3, and tree-shape
  caching.
- The design journey behind this document — rejected approaches, measurements, and the session that
  produced it — lives in the (gitignored, not committed) design spec; see that file's pointer back to
  this one.

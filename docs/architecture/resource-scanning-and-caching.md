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

## 2. The scanning taxonomy

| state | in a git working tree? | does VAT see it today? |
|---|---|---|
| git-tracked, clean | yes | yes — always |
| git-tracked, dirty (edited, uncommitted) | yes | yes — always |
| git-untracked, not gitignored | yes | **depends on the caller** — see below |
| git-ignored | yes | no, by design (never scanned; see §3.1) |
| non-git entirely (SharePoint, OneDrive, iCloud, `~/.claude/*`, ...) | no | yes, via filesystem crawl — no git shortcut available |

**The "depends on the caller" row is a real, load-bearing inconsistency, recorded here as fact rather
than resolved.** `gitLsFiles()` (`packages/utils/src/git-utils.ts:72-121`) spawns `git ls-files -z` by
default — tracked files only. Passing `includeUntracked: true` adds `--cached --others
--exclude-standard`, pulling in untracked-but-not-ignored files too. `crawlDirectorySync()`
(`packages/utils/src/file-crawler.ts:156-237`) defaults `includeUntracked` to `false`, and
`ResourceRegistry.crawl()` (`packages/resources/src/resource-registry.ts:755-782`) never overrides
it — so **`vat resources scan`/`validate` cannot see a brand-new, uncommitted `.md` file.**
`crawlOneBase()` (`packages/cli/src/commands/skills/skill-discovery.ts:97-116`) explicitly sets
`includeUntracked: true`, with a comment noting skills must be discoverable before being committed.
Whether resources scanning should also see untracked files is a separate product decision this
document does not make — it only names the split precisely so nobody assumes uniform behavior.

If `gitFindRoot()` finds no repository, or `gitLsFiles` returns `null`, `crawlDirectorySync` falls
through to a manual `fs.readdirSync` walk (`file-crawler.ts:239-417`) — the non-git lane, §3.2.

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
  `getGitTreeHash()` as the underlying primitive.
- **Decide the resources-vs-skills untracked-file inconsistency** (§2) — a separate product question
  from this document's scope, surfaced by writing the taxonomy down explicitly.
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

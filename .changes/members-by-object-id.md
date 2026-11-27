### Breaking

- **With the projection store on, the cached validation lanes key a snapshot member by its git
  object id** (`git-sha1` or `git-sha256`) in `vat resources scan` and `vat resources query` output,
  and read its bytes from git. The lanes are `vat validate`, `vat verify`, `vat resources scan`,
  `query` and `check`, `vat skill review`, `vat claude context` and `vat inventory`. A member is
  every regular file the snapshot lists inside the run's root: tracked files, modified or not, and
  untracked files no ignore rule covers (`git add --all` stages them). Validation parses a member in
  git's stored form (eol-normalized, clean-filtered), so a Windows checkout with
  `core.autocrlf=true` now validates those files with LF line endings. Store-off runs, and files outside
  the run's root even when the snapshot lists them, are keyed and read from disk.
- **Builds read the working tree.** `vat skills build`, `vat skills package`, `vat build`'s skills
  lane, `vat claude plugin build`, `vat skill test run` and `vat rag index` read every file from
  disk and key it by its checksum, once per file per build. A build ships working-tree bytes (CRLF
  on an autocrlf checkout), and the packager's link rewrite uses facts parsed from those same bytes.
- **Library (`@vibe-agent-toolkit/rag`, `@vibe-agent-toolkit/rag-lancedb`):
  `indexResources(resources, content: RunContentCache, onProgress?)` takes the run's content
  reader.** Each resource's text is read through it and checked against the content key the crawl
  gave it. A caller outside a VAT run passes `new RunContentCache(NO_GIT_MEMBERS)`.
- **Library (`@vibe-agent-toolkit/resources`): `diskRunContentSource` is renamed
  `runContentSource`.** It reads through the run's content cache, from git or disk as the run keys
  each file.
- **Library (`@vibe-agent-toolkit/resources`): `readContentByKey` is removed.** Every lane reads
  through the run's `RunContentCache`.
- **Library (`@vibe-agent-toolkit/resources`): `new RunContentCache(membersOf)` takes a required
  members provider** (`RunMembersOf`: `{ root, resolve }`, or `NO_GIT_MEMBERS` to key every file
  from disk), and **`RunPopulationOptions.membersOf` is required** (`PopulationMembersOf`, or
  `null`).
- **Library (`@vibe-agent-toolkit/resources`, `@vibe-agent-toolkit/agent-skills`):
  `withPopulationRun` takes a required members provider before its work, and `RunSkillRegistries`
  needs a dispatcher that parses through a run's content cache.** It reads through that one cache
  and throws for a dispatcher that serves no run.
- **Two new refusal mappings.** A member's object missing from git's store
  (`GIT_OBJECT_MISSING`) refuses as `INPUT_UNREADABLE`; an object reader that exited or could not
  start (`GIT_OBJECT_READ_FAILED`) refuses as `BACKEND_UNAVAILABLE`. A missing object does not
  decline the store key: it marks that one path unreadable and the run continues.

### Added

- **`@vibe-agent-toolkit/utils/git`:**
  - `OBJECT_READ_ENV`: the environment every object read runs with (`GIT_NO_REPLACE_OBJECTS=1`).
  - `openGitObjectReaders()` and `GitObjectReaders` (with `GitObjectReadersOptions`, `GitVersion`):
    one long-lived `git cat-file --batch` per repository, at most four live, lazy fetch refused.
  - `gitMembersOf()` and `GitMembers` (with `GitMember`, `GitMemberKeyKind`): a tree key's members,
    each with its object id and key kind.
  - `GitObjectMissingError` (code `GIT_OBJECT_MISSING`) and `GitObjectReadError` (code
    `GIT_OBJECT_READ_FAILED`).
  - `parseBatchHeader()`, `frameBatchRecord()` and `batchCheckOf()` (with `BatchHeader`,
    `BatchFrame`): the one `git cat-file` framer.
  - A `case-collision` failure kind on `GitTreeKeyFailure`, and an `absent` field on `GitTreeKey`
    (the absent skip-worktree entries, as git listed them).
- **`@vibe-agent-toolkit/resources`:** `NO_GIT_MEMBERS`, `isPlainUtf8Decoding()` (whether a
  read decoded as plain UTF-8), `RunContentCache.memberKeysUnder(root)` (how the run keyed files
  under a root, `git` or `disk`), `RunContentCache.readPastCap(path)` (a counted read of a file past
  the parse cap, from git for a member, never held or keyed), and the types `RunMembersOf` and
  `PopulationMembersOf`.
- **The `VAT_GIT_MEMBERS_PARTIAL_CLONE` notice.** On a git older than 2.45, which has no
  `--no-lazy-fetch`, a partial clone has no members: VAT keys and reads its files from disk, so no
  read can fetch from the remote, and says so once per repository. A repository whose partial-clone
  probe gets no answer from git is treated the same way, and the notice says it "may be a partial
  clone".

### Changed

- **A one-file edit on a large repository makes VAT read and hash about one file instead of every
  file.** Unchanged members are keyed from git's snapshot with no read. Measured on a large adopter
  repository, a warm `vat validate` after a one-file edit went from 24,827 file reads and 446 MB
  hashed to one object read from git and nothing hashed. The claim covers VAT's own reads: VAT still
  opens each member once per run for its readability check (counted as `fs.stat`), and git's own
  hashing inside the snapshot is not counted by any VAT counter. A run reads one git object once per
  parser kind, however many paths hold it: two files with identical bytes cost one object read.
- **assume-unchanged, and skip-worktree on a file present on disk, no longer decline the projection
  store's key or refuse `changed_files`.** The one remaining index-flag decline is a skip-worktree
  file on disk inside a directory a sparse index holds collapsed while
  `sparse.expectFilesOutsideOfPatterns` is true; unset that setting to clear it.
- **A tree whose index holds two paths the volume stores as one file (`A.md` and `a.md` on a
  case-folding volume) runs without the store, with a notice naming both.** Every pair of paths that
  fold alike is compared, and a volume that reports an inode of 0 cannot prove two spellings
  distinct, so such a pair also runs without the store unless the two are on different devices.
  Remove one from the index (`git rm --cached -- <path>`) to restore it.
- **A validation run and a build no longer share stored work.** `vat validate` keys git members by
  object id and a build keys every file from disk, so each files its own extent and parse entries:
  `vat validate` followed by `vat build` re-parses in the build what validation parsed.
- **Git filters other than Git LFS are out of scope.** VAT neither refuses nor declines for them; a
  cached validation lane reads a filtered member in git's stored form.

### Fixed

- **A replace ref could answer for an object VAT reads from git.** Every object read, the content
  reader and the Git LFS pass, now runs with `GIT_NO_REPLACE_OBJECTS=1`, so VAT reads the object the
  snapshot names. Fixed; no action needed.

### Removed

- **`GIT_SNAPSHOT_OUTSIDE_SPARSE` and its refusal.** An untracked file outside a sparse checkout's
  definition is now part of the snapshot: `changed_files` lists it as `added`.

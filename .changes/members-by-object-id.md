### Breaking

- **With the projection store on, a tracked regular file's content key is its git object id**
  (`git-sha1` or `git-sha256`) in `vat resources scan` and `vat resources query` output, and the
  file is parsed, and shipped by the packager's markdown link rewrite and by `vat rag index`, in
  git's stored form (eol-normalized, clean-filtered). Plain asset copies in `vat build` and
  store-off runs still use the bytes on disk. A Windows checkout with `core.autocrlf=true` now
  parses and ships those files with LF line endings.
- **Library (`@vibe-agent-toolkit/rag`): `RAGAdminProvider.indexResources(resources, objects,
  onProgress?)` takes a required `GitObjectReaders`** (`openGitObjectReaders()` from
  `@vibe-agent-toolkit/utils/git`); close it after indexing.
- **Library (`@vibe-agent-toolkit/resources`, `@vibe-agent-toolkit/agent-skills`):
  `withPopulationRun` takes a required members provider before its work (`{ root, resolve }`, or
  `NO_GIT_MEMBERS` to key every file from disk), and `RunSkillRegistries` takes the run's required `objects`.**

### Changed

- **A one-file edit on a large repository reads and hashes about one file instead of every file.**
  Unchanged tracked files are keyed from git's snapshot with no read. Measured on the adopter's
  repository, a warm `vat validate` after a one-file edit went from 24,827 file reads
  and 446 MB hashed to one object read from git and nothing hashed.
- **assume-unchanged, and skip-worktree on a file present on disk, no longer decline the projection
  store's key or refuse `changed_files`.** The one remaining index-flag decline is a skip-worktree
  file on disk inside a directory a sparse index holds collapsed while
  `sparse.expectFilesOutsideOfPatterns` is true; unset that setting to clear it.
- **A tree whose index holds two paths the volume stores as one file (`A.md` and `a.md` on a
  case-folding volume) runs without the store, with a notice naming both.** Remove one from the
  index (`git rm --cached -- <path>`) to restore it.

### Removed

- **`GIT_SNAPSHOT_OUTSIDE_SPARSE` and its refusal.** An untracked file outside a sparse checkout's
  definition is now part of the snapshot: `changed_files` lists it as `added`.

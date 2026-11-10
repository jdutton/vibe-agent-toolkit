### Added

- **`changed_files`: what changed since a base commit, as a derived relation.** Columns `path`,
  `status` (`added` | `modified` | `deleted` | `renamed` | `type-changed`), `oldPath` and
  `similarity` (set for a rename). It lists what the change touched: a snapshot of the working tree
  — staged or not, plus untracked non-ignored files — compared in one `git diff-tree` with the
  MERGE BASE of `--base <ref>` and `HEAD` (GitHub's "files changed" — a branch behind its base never
  lists what the base moved since), restricted to the project root and relative to it. A move is
  `renamed` whether or not it was `git add`-ed; a copy is `added`; a file only `git rm --cached` is
  no row; a rename across the root's boundary is seen from inside it (in = `added`, out =
  `deleted`). A submodule, or a nested repository with a commit, is one row naming its directory,
  listed when the commit it records moved. A conflicted file mid-merge is listed as it stands on
  disk, markers and all. A file on disk marked assume-unchanged or skip-worktree refuses the
  relation, naming it and the flag to clear (`git update-index --no-assume-unchanged` /
  `--no-skip-worktree`), since git would hide an edit to it. Paths are read from git as bytes; a path under the root that is not
  UTF-8 refuses the relation, naming its bytes. Lets a `resources.checks` entry judge
  only what a change touched.
- **`--base <ref>` on `vat resources query`, `vat resources check` and `vat validate`** (which
  forwards it to its checks phase). A statement reading `changed_files` is refused naming the fix,
  never answered with an empty relation, with a code naming the fault: `USAGE_INVALID` without
  `--base`, with a ref that names no commit, or with one that has more than one merge base with
  `HEAD` (a criss-cross history: pass one of them as the base); `BACKEND_UNAVAILABLE` when git did
  not run to completion (not on PATH; out of time or over the output VAT reads — compare against a
  nearer base) or could not snapshot the working tree (past the snapshot's 30 s limit, or a nested
  repository with no commit); `INPUT_UNREADABLE` when the repository cannot answer — outside a git
  working tree (a bare repository or a directory inside `.git` included), no commits yet, no merge
  base (unrelated histories), a shallow clone whose history may hide a nearer merge base (fetch
  full history, e.g. `actions/checkout` `fetch-depth: 0`, or deepen until the history between the
  merge base and the tips is complete), a partial clone missing blobs the diff needs
  (`git fetch --refetch`), a snapshot git refuses (git's message quoted), a flagged file as above,
  a file under the root git cannot read, a listing
  VAT cannot read, or, where git ignores case, a changed path that spells the root in another case
  or Unicode normalisation (both spellings named). The exit code does not tell these faults apart; the code does — `query`
  publishes it as `error.code`, and for `check` and `validate` it is `RESOURCE_CHECK_BROKEN` on
  exactly the checks that read it, carrying `reason: {refusal: <code>}` beside a message naming the
  cause. `--base` is read only when a statement names `changed_files`.
- **`gitChangedFiles()` on `@vibe-agent-toolkit/utils/git`**, the reader behind the relation, and
  `ChangedFileRowSchema` (with its JSON Schema, `projection-changed-files.json`) on
  `@vibe-agent-toolkit/resources`. It returns every refusal as a value carrying its kind, and never
  throws one.
- **The refusal code of a statement that reads a relation which could not be evaluated is decided
  from the relations the statement names, before it runs** — never from SQLite's error text — so a
  check reading a missing table beside `changed_files`, run without `--base`, is
  `RESOURCE_CHECK_BROKEN` with `reason: {refusal: USAGE_INVALID}` and the `--base` remedy, not
  SQLite's "no such table" about the first name it tripped on. (`vat resources query` compiles its
  statement before any lens runs, so there the typo itself is the `USAGE_INVALID` it names.)

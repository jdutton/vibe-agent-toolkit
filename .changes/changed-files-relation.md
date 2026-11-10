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
  disk, markers and all. A file marked assume-unchanged or skip-worktree refuses the relation,
  naming it and every flag to clear (`git update-index --no-assume-unchanged` /
  `--no-skip-worktree`, both for a file carrying both), since git would hide an edit to it or its
  deletion; the one exemption is a skip-worktree file absent from disk in a sparse checkout
  (`core.sparseCheckout` true). Paths are read from git as bytes; a path under the root that is not
  UTF-8 refuses the relation, naming its bytes. Lets a `resources.checks` entry judge
  only what a change touched.
- **`--base <ref>` on `vat resources query`, `vat resources check` and `vat validate`** (which
  forwards it to its checks phase). A statement reading `changed_files` is refused naming the fix,
  never answered with an empty relation, with a code naming the fault: `USAGE_INVALID` without
  `--base`, with a ref that names no commit, with one that shares no history with `HEAD` in a
  whole (not shallow) history, with one that has more than one merge base with `HEAD` (a
  criss-cross history: pass one of them as the base), or for a statement defining a CTE named
  `changed_files`; `BACKEND_UNAVAILABLE` when git did not run to completion (git was not found on
  PATH; out of time or over the output VAT reads — compare against a nearer base) or could not
  snapshot the working tree for a cause git does not state (a second `git add --all` into a
  throwaway index is run to ask; a time-out is named only when that attempt was seen to time out);
  `INPUT_UNREADABLE` when the repository cannot answer — outside a git working tree (a bare
  repository or a directory inside `.git` included), no commits yet, a git that cannot resolve
  `HEAD`, a shallow clone cut off before the base and `HEAD` meet or whose history may hide a
  nearer merge base (fetch full history, e.g. `actions/checkout` `fetch-depth: 0`, or deepen until
  the history between the merge base and the tips is complete), a partial clone missing blobs the
  diff needs (`git fetch --refetch`), a snapshot git refuses (an object it cannot write, a clean
  filter that fails, a nested repository with no commit: git's `fatal:`/`error:` quoted), a flagged
  file as above, a file under the root git cannot read, a listing VAT cannot read, a filesystem
  that folds case (probed at the root) whose `core.ignorecase` is not true
  (`git config core.ignorecase true`), or, on such a filesystem, a changed path that spells the
  root in another case or Unicode normalisation (both spellings named; on a case-sensitive
  filesystem a sibling such as `Docs/` beside a `docs/` root is simply another directory). The exit code does not tell these faults apart; the code does — `query`
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

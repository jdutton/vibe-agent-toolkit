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
  listed when the commit it records moved. Paths are read from git as bytes; a path under the root
  that is not UTF-8 refuses the relation, naming its bytes. Lets a `resources.checks` entry judge
  only what a change touched.
- **`--base <ref>` on `vat resources query`, `vat resources check` and `vat validate`** (which
  forwards it to its checks phase). A statement reading `changed_files` is refused naming the fix,
  never answered with an empty relation, with a code naming the fault: `USAGE_INVALID` only without
  `--base` or with a ref that names no commit; `BACKEND_UNAVAILABLE` when git did not run to
  completion (not on PATH; out of time or over the output VAT reads — compare against a nearer
  base); `INPUT_UNREADABLE` when the repository cannot answer — outside a git working tree, no
  commits yet, no merge base (a shallow clone or unrelated histories: fetch more history), more than
  one merge base (a criss-cross history: pass one of them as the base), a working tree git cannot
  snapshot, or, where git ignores case, a changed path that spells the root in another case (both
  spellings named). The exit code does not tell these faults apart; the code does — `query`
  publishes it as `error.code`, and for `check` and `validate` it is `RESOURCE_CHECK_BROKEN` on
  exactly the checks that read it, carrying `reason: {refusal: <code>}` beside a message naming the
  cause. `--base` is read only when a statement names `changed_files`.
- **`gitChangedFiles()` on `@vibe-agent-toolkit/utils/git`**, the reader behind the relation, and
  `ChangedFileRowSchema` (with its JSON Schema, `projection-changed-files.json`) on
  `@vibe-agent-toolkit/resources`.

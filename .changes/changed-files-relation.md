### Added

- **`changed_files`: what changed since a base commit, as a derived relation.** Columns `path`,
  `status` (`added` | `modified` | `deleted` | `renamed` | `copied` | `type-changed`), `oldPath` and
  `similarity` (set for a rename or copy). It lists what the change touched: the working tree,
  staged or not, plus untracked non-ignored files, compared with the MERGE BASE of `--base <ref>`
  and `HEAD` (GitHub's "files changed" — a branch behind its base never lists what the base moved
  since), restricted to the project root and relative to it; a rename across the root's boundary is
  seen from inside it (in = `added`, out = `deleted`). A file only `git rm --cached` is one
  `modified` row. A submodule is listed only when its recorded commit moved, as one `modified` row
  naming its directory; a dirty submodule worktree is not a change. An untracked nested repository
  is not listed. Paths are read from git as bytes; a path under the root that is not UTF-8 refuses
  the relation, naming its bytes. Lets a `resources.checks` entry judge only what a change touched.
- **`--base <ref>` on `vat resources query`, `vat resources check` and `vat validate`** (which
  forwards it to its checks phase). A statement reading `changed_files` is refused naming the fix,
  never answered with an empty relation. For `query` the code names the fault: `USAGE_INVALID` only
  without `--base` or with a ref that names no commit; `BACKEND_UNAVAILABLE` when git did not run to
  completion; `INPUT_UNREADABLE` when the repository cannot answer — outside a git working tree, no
  commits yet, no merge base (a shallow clone or unrelated histories: fetch more history), git
  skipped rename detection, or a root (or untracked file under it) spelled in a case other than the
  one git lists. For `check` and `validate` it is `RESOURCE_CHECK_BROKEN` on exactly the checks that
  read it, its message naming the cause. `--base` is read only when a statement names
  `changed_files`.
- **`gitChangedFiles()` on `@vibe-agent-toolkit/utils/git`**, the reader behind the relation, and
  `ChangedFileRowSchema` (with its JSON Schema, `projection-changed-files.json`) on
  `@vibe-agent-toolkit/resources`.

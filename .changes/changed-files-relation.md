### Added

- **`changed_files`: what changed since a base commit, as a derived relation.** Columns `path`,
  `status` (`added` | `modified` | `deleted` | `renamed` | `copied` | `type-changed`), `oldPath` and
  `similarity` (set for a rename or copy). It compares the working tree, staged or not, plus
  untracked non-ignored files with the commit `--base <ref>` names, restricted to the project root
  and relative to it; a rename across the root's boundary is seen from inside it (in = `added`, out
  = `deleted`). Paths are read from git as bytes; a path under the root that is not UTF-8 refuses
  the relation, naming its bytes. Lets a `resources.checks` entry judge only what a change touched.
- **`--base <ref>` on `vat resources query`, `vat resources check` and `vat validate`** (which
  forwards it to its checks phase). Without it — or with a ref that names no commit, or outside a
  git working tree — a statement reading `changed_files` is refused naming the fix: `USAGE_INVALID`
  for `query`, `RESOURCE_CHECK_BROKEN` on exactly the checks that read it for `check` and
  `validate`. Never an empty relation.
- **`gitChangedFiles()` on `@vibe-agent-toolkit/utils/git`**, the reader behind the relation, and
  `ChangedFileRowSchema` (with its JSON Schema, `projection-changed-files.json`) on
  `@vibe-agent-toolkit/resources`.

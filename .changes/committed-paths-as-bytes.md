### Security

- **A git skill source (`url:`, `vat audit <git url>`) holding a committed path that is not UTF-8 is
  refused before checkout** (`GIT_CLONE_FAILED`, `INPUT_UNREADABLE`), naming the path's bytes: VAT
  judged and read such a path under a spelling that is not the file the checkout writes. Rename it in
  the repository.

### Added

- **(library) `runGitBytes()` on `@vibe-agent-toolkit/utils/git`**: `runGit()` with stdout returned
  as the bytes git wrote, for output that carries committed paths or object contents. The opt-in lint
  rule `@vibe-agent-toolkit/no-text-git-object-read` reports an `ls-tree` or `cat-file` argv handed
  to anything else.

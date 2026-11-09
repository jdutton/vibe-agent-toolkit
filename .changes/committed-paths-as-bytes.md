### Security

- **A git skill source (`url:`, `vat audit <git url>`) holding a committed path that is not UTF-8 is
  refused before checkout** (`GIT_CLONE_FAILED`, `INPUT_UNREADABLE`), naming the path's bytes.
  Rename the path in the repository.
- **Refusals no longer print a name or a link text raw.** Control, bidirectional and invisible
  characters in a path, a link's text or git's own words are shown as `\uHHHH` escapes; a git
  source's refusals also quote the names they show.

### Added

- **(library) `runGitBytes()` on `@vibe-agent-toolkit/utils/git`** — `runGit()` with stdout as the
  bytes git wrote, for reads of the object store — and **`decodeUtf8Exactly()`, `shownName()` and
  `visibleText()`** on the barrel. The opt-in rule `@vibe-agent-toolkit/no-text-git-object-read`
  reports an `ls-tree`, `cat-file`, `diff-tree`, `rev-list` or `show` argv handed to a git runner
  other than `runGitBytes()`.

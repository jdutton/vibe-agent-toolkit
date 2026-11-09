### Breaking

- **A git skill source (`url:`, `vat audit <git url>`) whose commit holds a path that is not UTF-8
  is refused before checkout** (`GIT_CLONE_FAILED`, `INPUT_UNREADABLE`), naming the path's bytes —
  a path anywhere in the commit, not only under the selected subpath. It was cloned before, and
  judged under a re-spelled name. Rename the path in the repository.

### Security

- **Refusals that show a name a repository chose no longer print it raw.** Control, bidirectional
  and invisible characters in a path, a link's text or git's own words are shown as escapes
  (`\uHHHH`, `\u{HHHHH}` past U+FFFF; bytes that are not UTF-8 as `\xHH`), and a name past 8192
  characters is cut, with how much was left out. Covered: a git source's refusals before checkout
  (names quoted, git's own words keeping their line breaks), the link walk's and the followed
  walk's refusals, staging's symlink refusal, a refused directory listing, and every
  `FsFaultError`. Other refusals that show a path still print it as it is.

### Added

- **(library) `runGitBytes()` on `@vibe-agent-toolkit/utils/git`** — `runGit()` with stdout as the
  bytes git wrote, for reads of the object store — and **`decodeUtf8Exactly()`, `shownName()` and
  `visibleText()`** on the barrel. The opt-in rule `@vibe-agent-toolkit/no-text-git-object-read`
  reports an `ls-tree`, `cat-file`, `diff-tree`, `rev-list` or `show` argv handed to a git runner
  other than `runGitBytes()`.

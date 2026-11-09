### Breaking

- **A git skill source (`url:`, `vat audit <git url>`) whose commit holds a path that is not UTF-8
  is refused before checkout** (`GIT_CLONE_FAILED`, `INPUT_UNREADABLE`), naming the path's bytes —
  a path anywhere in the commit, not only under the selected subpath. It was cloned before, and
  judged under a re-spelled name. Rename the path in the repository.

### Security

- **Refusals that show a name a repository chose no longer print it raw.** Control, bidirectional
  and invisible characters in a path, a link's text or git's own words are shown as escapes
  (`\uHHHH`, `\u{HHHHH}` past U+FFFF; in a name that is not UTF-8, every byte at or above 0x80 as
  `\xHH`), and a name past 8192 characters is cut, with how much was left out. Covered: a git
  source's own refusals (names quoted; an absent subpath lists the first 50 root names; git's
  words cut to their last 4096 characters, each line shown on its own line behind `git:`, so a
  line break a repository wrote cannot start a line that reads as VAT's), the link walk's and the
  followed walk's refusals, staging's symlink refusal, a refused directory listing, and every
  `FsFaultError`. Other refusals that show a path still print it as it is.

### Added

- **(library) `runGitBytes()` and its `GitBytesRunResult` on `@vibe-agent-toolkit/utils/git`** —
  `runGit()` with stdout as the bytes git wrote, for reads of the object store — and
  **`decodeUtf8Exactly()`, `shownName()` and `visibleText()`** on the barrel. The opt-in rule
  `@vibe-agent-toolkit/no-text-git-object-read` reports an `ls-tree`, `cat-file`, `diff-tree`,
  `rev-list` or `show` argv literal that reaches a call other than as `runGitBytes()`'s first
  argument, written there inline — unless the call is a spawner naming another program first
  (`spawnSync('npm', […])`).

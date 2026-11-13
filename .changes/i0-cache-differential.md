### Fixed

- **`GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS` or `GIT_ICASE_PATHSPECS`
  set in the operator's environment re-scoped the paths VAT hands git as pathspecs** (the
  `ls-files` patterns and the `check-ignore` paths), so a crawl or an ignore check could match other
  files than the ones asked about. Every call through `runGit` now sets all four to `0`, and each
  such path is read as git reads it with none set. No action needed.

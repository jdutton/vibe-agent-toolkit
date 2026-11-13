### Fixed

- **`GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS` or `GIT_ICASE_PATHSPECS`
  set in the operator's environment re-scoped every path VAT hands git**, so a crawl, a changed-files
  list or a blob read could match other files than the ones asked about. VAT now sets all four to
  `0` on every git call it makes about a project, and each path is read as git reads it with none set.
  No action needed.

### Security

- **A git source whose repository commits a symbolic link out of the clone is refused.** The
  `#ref:subpath` containment check was lexical, so a committed `skills -> /somewhere/outside`
  passed and `vat audit <git-url>` / a git `url:` skill source read files on the operator's machine
  as the repository's. `cloneGitSource` now judges the subpath on real paths (`GIT_SUBPATH_INVALID`,
  `USAGE_INVALID`) and refuses any link in the selected subtree — followed through inside links,
  dangling ones included — whose target resolves outside the clone (`COPY_LINK_ESCAPES_SOURCE`,
  `INPUT_UNREADABLE`, exit 2). Links that stay inside the clone are still followed.

### Fixed

- **A `plugin.json`, `marketplace.json` or registry file the operating system will not read is
  `SCAN_PATH_UNREADABLE`** (warning, naming the errno), no longer `*_INVALID_JSON` with "fix the JSON
  syntax". A manifest under a directory that refuses access is no longer reported as missing.
- **`@vibe-agent-toolkit/discovery` `scan()` reports a root it may not examine as "Path cannot be
  read (EACCES)"**, carrying the OS error as `cause`, instead of "Path does not exist".
- **`vat agent validate` no longer puts absolute paths in finding messages**: a missing RAG
  database is shown as `.rag-db`, and `AGENT_REFERENCE_UNREADABLE` names the errno instead of the
  OS message (which spelled the absolute path).

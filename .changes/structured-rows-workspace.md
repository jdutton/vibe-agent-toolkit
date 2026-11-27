### Added

- **`.npmrc` as data rows.** Every `**/.npmrc` is read as the new `data__*` variant `ini`, storing
  only allowlisted keys (today `link-workspace-packages`); credentials and `[section]` contents never
  reach the store. `${VAR}` is stored literally. Only `exclude` keeps an `.npmrc` out; `include`
  never routes another file as `ini`.
- **Workspace relations.** `workspace_packages`, `workspace_dependencies` (`targetPath`: the member
  a dependency links) and `workspace_conditions`, computed per run for npm, yarn, bun and pnpm
  workspaces (pnpm's rules read with its `packageManager` version), catalogs and
  `link-workspace-packages` included. A root that cannot be answered (a pnpm file pnpm would read
  differently, a root input with no rows or routed away, a workspace root above the analysis root)
  has no rows and a `WORKSPACE_ROOT_REFUSED` condition; the family refuses (`INPUT_UNREADABLE`) only
  when no root answers. See `docs/validation-codes.md` for every condition and refusal code.
- **A query naming only `workspace_*` relations reports `DATA_FILE_NO_ROWS`** for any broken routed
  data file, as a `data__*` query does: the workspace step reads the same extraction.
- **Library (`@vibe-agent-toolkit/resources`):** the types `WorkspaceAnswer`, `WorkspaceRefusal`,
  `WorkspaceRefusalCode`, `WorkspacePackageRow`, `WorkspaceDependencyRow`, `WorkspaceConditionRow`,
  `WorkspaceConditionCode`, `WorkspaceProtocol` (`DataStageResult.workspace`), and
  `DeclaredReads`, `DeclaredPair`, `DeclaredAnswer`, `DataRequestUnroutedReason`
  (`DataStageResult.declaredReads`).

### Changed

- **The projection store keeps the most recently used trees, not the most recently written.** A
  tree served recently is kept, so switching back to it after a few edits is a warm run. The store
  shape moves, so the first run after upgrading is one cold start.

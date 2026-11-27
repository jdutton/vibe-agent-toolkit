### Added

- **`.npmrc` as data rows.** Every `**/.npmrc` is read as the new `data__*` variant `ini`, storing
  only allowlisted keys (today `link-workspace-packages`); credentials and `[section]` contents never
  reach the store. `${VAR}` is stored literally. Only `exclude` keeps an `.npmrc` out; `include`
  never routes another file as `ini`.
- **Workspace relations.** `workspace_packages`, `workspace_dependencies` and
  `workspace_conditions`, computed per run for npm, yarn, bun and pnpm workspaces.
  `targetPath` is the member a dependency names, a structural fact of the repository, never what an
  install would link (that depends on registry versions, version checks, user-global settings and
  catalogs, none of which a repository holds): a `workspace:` path, `file:` or `link:` names the
  member at that directory, anything else the member of the dependency's name, with no version
  check and no catalog or `.npmrc` read; `range` is as written. Judge policy in SQL over
  `protocol`, e.g. `protocol <> 'workspace' AND targetPath IS NOT NULL`. Where the answer depends
  on what VAT cannot see, it says so in a condition and leaves `targetPath` null: two members with
  one name (`WORKSPACE_DUPLICATE_NAME`), a path naming no member (`WORKSPACE_PATH_UNRESOLVED`), a
  member of unknown name (`WORKSPACE_TARGET_UNKNOWN`), or an unknown manager
  (`WORKSPACE_MANAGER_UNKNOWN`); no `packageManager` reads the manager from which lockfile exists,
  by path only (`WORKSPACE_MANAGER_INFERRED`). A yarn 1 root with `workspaces` but no
  `private: true` declares no workspace (`WORKSPACE_NOT_DECLARED`). A `workspace:` dependency
  under a root that declares no workspace is a condition at that manifest. A root that cannot be
  answered (a `pnpm-workspace.yaml` whose `packages` pnpm would read differently, a root
  `package.json` or `pnpm-workspace.yaml` with no rows or routed away) has no rows and a
  `WORKSPACE_ROOT_REFUSED`
  condition; the family refuses only when no root
  answers: `RUN_INCOMPLETE` when a root input was refused this run (a rerun may answer, and a
  broken check's `reason.refusal` can carry it), `INPUT_UNREADABLE` otherwise. See `docs/validation-codes.md` for every condition and refusal code.
- **A query naming only `workspace_*` relations reports `DATA_FILE_NO_ROWS`** for any broken routed
  data file, as a `data__*` query does: the workspace step reads the same extraction. A query the
  family refuses carries them in its exit-2 document, as `vat resources check` does.
- **Library (`@vibe-agent-toolkit/resources`):** the types `WorkspaceAnswer`, `WorkspaceRefusal`,
  `WorkspaceRefusalCode`, `WorkspacePackageRow`, `WorkspaceDependencyRow`, `WorkspaceConditionRow`,
  `WorkspaceConditionCode`, `WorkspaceProtocol` (`DataStageResult.workspace`), and
  `DeclaredReads`, `DeclaredPair`, `DeclaredAnswer`, `DataRequestUnroutedReason`
  (`DataStageResult.declaredReads`).

### Changed

- **The projection store keeps the most recently used trees, not the most recently written.** A
  tree served recently is kept, so switching back to it after a few edits is a warm run. The store
  shape moves, so the first run after upgrading is one cold start.

### Added

- **`.npmrc` as data rows.** Every `**/.npmrc` is read as the new `data__*` variant `ini`, storing
  only allowlisted keys (today `link-workspace-packages`); credentials and `[section]` contents never
  reach the store. `${VAR}` is stored literally. Only `exclude` keeps an `.npmrc` out; `include`
  never routes another file as `ini`.
- **Workspace relations.** `workspace_packages`, `workspace_dependencies` (`targetPath`: the member
  a dependency links) and `workspace_conditions`, computed per run for npm, yarn, bun and pnpm
  workspaces (pnpm's rules read with its `packageManager` version), catalogs and
  `link-workspace-packages` included. Where VAT cannot tell what the manager would do, it says so in
  a condition and links nothing rather than pick: no `packageManager` reads the manager from which
  lockfile exists, by path only, or is unknown; an unknown or unchecked pnpm version (pnpm 12) is
  said; under pnpm a name links only when exactly one same-named member satisfies the range; a
  `pnpm-workspace.yaml` setting pnpm never reads (kebab case, or any before 10.5) is not read; an
  unreadable root `.npmrc` makes plain-range links unknown, not the root refused. A `workspace:`
  dependency under a root that declares no workspace is a condition at that manifest. A root that
  cannot be answered (a pnpm file pnpm would read differently, a root `package.json` or
  `pnpm-workspace.yaml` with no rows or routed away) has no rows and a `WORKSPACE_ROOT_REFUSED`
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

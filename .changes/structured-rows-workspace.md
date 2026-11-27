### Added

- **`.npmrc` as data rows.** Every `**/.npmrc` is read as the new `data__*` variant `ini`, storing
  only allowlisted keys (today `link-workspace-packages`); credentials and `[section]` contents never
  reach the store. `${VAR}` is stored literally. Only `exclude` keeps an `.npmrc` out; `include`
  never routes another file as `ini`.
- **Workspace relations.** `workspace_packages`, `workspace_dependencies` and
  `workspace_conditions`, computed per run for npm, yarn, bun and pnpm workspaces.
  `targetPath` is the member a dependency names, a structural fact of the repository, never what an
  install would link (that depends on registry versions, version checks, user-global settings and
  catalogs, none of which a repository holds): a `workspace:` path, `file:`, `link:` or a bare path
  names the member at that directory, anything else the member of the dependency's name
  (`npm:<name>@`, and pnpm's and bun's `workspace:<name>@`, name `<name>`; npm names a member with
  no `name` by its folder), with no version check and no catalog or `.npmrc` read; `range` is as
  written, and a bare path's `protocol` is `file` or `link` as its manager reads it. Judge policy in
  SQL over `protocol`, e.g. `protocol <> 'workspace' AND targetPath IS NOT NULL`. Where the answer
  depends on what VAT cannot see, it says so in a condition and leaves `targetPath` null: two
  members with one name (`WORKSPACE_DUPLICATE_NAME`), a path naming no member or bun's
  `link:<package name>` (`WORKSPACE_PATH_UNRESOLVED`), or an unknown manager
  (`WORKSPACE_MANAGER_UNKNOWN`). A member of unknown name makes every name match in its root
  uncertain: one `WORKSPACE_TARGET_UNKNOWN` per root, at the root `package.json`. A member with no
  name under a manager that names none by folder is `WORKSPACE_MEMBER_NAMELESS`; a `package.json`
  routed as `jsonc` is `WORKSPACE_READ_AS_JSONC`. No `packageManager` reads the manager from which
  lockfile exists, by path only (`WORKSPACE_MANAGER_INFERRED`); the manager's conditions sit at the
  root `package.json`. A yarn 1 root listing workspace packages without a truthy `private` declares
  no workspace (`WORKSPACE_NOT_DECLARED`). A `workspace:` dependency under a root that declares no
  workspace is a condition at that manifest. A root that cannot be answered (a
  `pnpm-workspace.yaml` whose `packages` pnpm would read differently, a root `package.json` or
  `pnpm-workspace.yaml` with no rows or routed away) has no rows and a `WORKSPACE_ROOT_REFUSED`
  condition; the family refuses only when no root answers: `RUN_INCOMPLETE` when a rerun may answer
  (a broken check's `reason.refusal` can carry it), `INPUT_UNREADABLE` otherwise. See
  `docs/validation-codes.md` for every condition and refusal code.
- **A root input with no rows is never told to route itself away.** The root `package.json` or
  `pnpm-workspace.yaml` gets one remedy in its `DATA_FILE_NO_ROWS` finding and in its root's
  `WORKSPACE_ROOT_NO_ROWS` refusal: fix it, make it smaller or simpler for a cap its bytes, heap or
  stack reach, or run again for a time cap, a file that changed under the run, a parse worker that
  died, or a busy or exhausted machine. Only those run-again causes are `RUN_INCOMPLETE`.
- **A query naming only `workspace_*` relations reports `DATA_FILE_NO_ROWS`** for each broken file
  the workspace step reads (every `package.json` outside `node_modules`, and `pnpm-workspace.yaml`);
  a statement that also names a `data__*` relation reports every broken routed file. Either way the
  stage still extracts every routed file. A query the family refuses carries them in its exit-2
  document, as `vat resources check` does.
- **Library (`@vibe-agent-toolkit/resources`):** the type `WorkspaceAnswer`
  (`DataStageResult.workspace`); its refusal and row types are reached through it, not exported by
  name.

### Changed

- **The projection store keeps the most recently used trees, not the most recently written.** A
  tree served recently is kept, so switching back to it after a few edits is a warm run. The store
  shape moves, so the first run after upgrading is one cold start.

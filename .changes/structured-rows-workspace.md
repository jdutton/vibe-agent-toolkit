### Added

- **`.npmrc` as data rows.** Every `**/.npmrc` is read as the new `data__*` variant `ini`, storing
  only allowlisted keys (today `link-workspace-packages`); credentials and `[section]` contents never
  reach the store. `${VAR}` is stored literally. Only `exclude` keeps an `.npmrc` out; `include`
  never routes another file as `ini`.
- **Workspace relations.** `workspace_packages`, `workspace_dependencies` (`targetPath`: the member
  a dependency links) and `workspace_conditions`, computed per run for npm, yarn, bun and pnpm
  workspaces, catalogs and `link-workspace-packages` included. A pnpm file pnpm would read
  differently, a root input with no rows, a needed file routed away, or a workspace root above the
  analysis root refuses all three (`INPUT_UNREADABLE`, a `WORKSPACE_*` or `DATA_REQUEST_UNROUTED`
  code leading the message); see `docs/validation-codes.md`.

### Changed

- **The projection store keeps the most recently used trees, not the most recently written.** A
  tree served recently is kept, so switching back to it after a few edits is a warm run. The store
  shape moves, so the first run after upgrading is one cold start.

### Added

- **`git_content`**, a relation for `vat resources query` and `vat resources check`: every tracked
  file present in the worktree and every untracked file no ignore rule covers, under each root.
- **TypeScript config relations.** `tsconfig_invocations`, `tsconfig_references`,
  `tsconfig_closure`, `tsconfig_configs`, `tsconfig_extends`, `tsconfig_files`, `tsconfig_paths` and
  `tsconfig_conditions`: which configs the `package.json` scripts compile, and what TypeScript's own
  config parser makes of them, answered over `git_content` only by the TypeScript VAT ships (never
  the project's). The version that answered is `data.typescriptVersion` and a stderr line. A config
  that cannot be read, fails to parse or reaches outside the analysis root refuses all eight: with a
  `TSCONFIG_*` code, `DATA_REQUEST_UNROUTED` for a config that is unrouted or excluded, or the
  pair's own code (for example `DATA_PARSE_ERROR`) for a file with no rows; a parse stopped by a
  limit of the run, or a worker that died, refuses them as `RUN_INCOMPLETE` and nothing else in the
  run. A tree with no git, or no `git` on `PATH`, refuses only the statements naming `git_content`
  or a `tsconfig_*` relation. See `docs/validation-codes.md`.
- **`resources.typescript.compilers`** in `vibe-agent-toolkit.config.yaml`: the commands a script
  segment is read as compiling with. Default `tsc`, `tsc-native`, `ngc`; a list replaces it.
- **Library (`@vibe-agent-toolkit/resources`):** `gitContentListing`, `gitContentDemanded`,
  `compilersFromConfig`, and the type `TsconfigAnswer`
  (`DataStageResult.tsconfig`).

### Changed

- **An unreadable directory named `coverage/`, `.test-output/` or `.turbo/` that holds git content
  now refuses the run** (`INPUT_UNREADABLE`), as any other directory git cannot list does, instead
  of its files going missing at exit 0. Fix its permissions or ignore it.

### Added

- **`git_content`**, a relation for `vat resources query` and `vat resources check`: every tracked
  file present in the worktree and every untracked file no ignore rule covers, under each root.
- **TypeScript config relations.** `tsconfig_invocations`, `tsconfig_references`,
  `tsconfig_closure`, `tsconfig_configs`, `tsconfig_extends`, `tsconfig_files`, `tsconfig_paths` and
  `tsconfig_conditions`: which configs the `package.json` scripts compile, and what TypeScript's own
  config parser makes of them, answered over `git_content` only by the TypeScript VAT ships (never
  the project's). The version that answered is `data.typescriptVersion` and a stderr line. A config
  that cannot be read, fails to parse or reaches outside the analysis root refuses all eight with a
  `TSCONFIG_*` code; see `docs/validation-codes.md`.
- **`resources.typescript.compilers`** in `vibe-agent-toolkit.config.yaml`: the commands a script
  segment is read as compiling with. Default `tsc`, `tsc-native`, `ngc`; a list replaces it.
- **Library (`@vibe-agent-toolkit/resources`):** `gitContentListing`, `gitContentDemanded`,
  `compilersFromConfig`, and the types `GitContentRow` and `TsconfigAnswer`
  (`DataStageResult.tsconfig`).

### Changed

- **An unreadable directory named `coverage/`, `.test-output/` or `.turbo/` that holds git content
  now refuses the run** (`INPUT_UNREADABLE`), as any other directory git cannot list does, instead
  of its files going missing at exit 0. Fix its permissions or ignore it.

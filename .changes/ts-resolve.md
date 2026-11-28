### Added

- **The resolved import graph** for `vat resources query` and `check`: `ts_import_targets` (what
  TypeScript resolves each module reference to, per compiled config), `ts_program_files` and
  `ts_import_conditions`. It is the compiler's view, not a runtime's. See `packages/cli/docs/resources.md`.
- **`tsconfig_*` relations resolve a package-name `extends` into a declared workspace member**,
  read from the member's git content.
- **Library (`@vibe-agent-toolkit/resources`):** the type `TsResolveAnswer`
  (`DataStageResult.tsResolve`) and `RowSetDemand.tsResolve`.

### Added

- **TypeScript and JavaScript files as queryable rows.** `vat resources query` and `vat resources
  check` gain `ts__files`, `ts__imports`, `ts__import_names`, `ts__exports` (stored, keyed by
  content and variant) and `ts__routes`, `ts_imports` (computed for the run). Every git-content
  `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` file outside `node_modules` is
  read, only when a statement names one, by the TypeScript VAT ships (never the project's).
  `ts_imports` is the one a check reads: every import with its `package`, `builtin` and
  `lexicalTarget`. Their JSON Schemas ship in `packages/resources/schemas/`.
- **`resources.extractors.ts` in `vibe-agent-toolkit.config.yaml`** (`exclude`, `allowEmpty`):
  which files the `ts` instance never reads. A declared block that routes nothing is
  `CONFIG_INVALID` for a statement naming a `ts__*` relation or `ts_imports`, unless it sets
  `allowEmpty: true`.
- **`TS_FILE_NO_ROWS` and `TS_PARSE_ERROR`.** A routed file TypeScript reports any parse
  diagnostic for (JSX in a `.ts` file included) is `TS_PARSE_ERROR` with no rows; every routed
  file with no rows is one `TS_FILE_NO_ROWS` error at its path, which fails the run while every
  other file answers. Fix the file or `exclude` it. See `docs/validation-codes.md`.
- **Library (`@vibe-agent-toolkit/resources`):** `tsRoutingFor`, `rowSetIdOf`, `instanceDemanded`,
  and the types `TsRouting`, `RowSetIdOf`, `RowSetVariants`, `RowSetDefect` and the `ts__*` and
  `ts_imports` row types (`TsFileRow`, `TsImportRow`, `TsImportNameRow`, `TsExportRow`,
  `TsRouteRow`, `TsImportsRow`, `TsVariant`, `TsInstance`).

### Breaking

- **The projection store rebuilds once.** Its shape now covers the four `ts` row-set tables, so the
  first run after upgrading starts cold in a new store directory.

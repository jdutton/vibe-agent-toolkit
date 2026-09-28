### Breaking

- **`Report<T>` is now a discriminated union of `ok` / `findings` / `error`, and every document
  requires `gate`.** `error` carries `{ code, message }` (`code` is a registered refusal code);
  `data` is never `null` on `ok`/`findings` and may be partial on `error`. `exitCodeForReport`
  reads `gate` from the document — it no longer takes a `{ strict }` option.
- **Refusal codes are registered and rejected as `validation.severity`/`validation.allow` keys.**
  New refusal codes: `USAGE_INVALID`, `CONFIG_INVALID`, `INPUT_UNREADABLE`, `BACKEND_UNAVAILABLE`,
  `EXTERNAL_API_FAILED`, `NOT_IMPLEMENTED`, `RUN_INCOMPLETE`, `INTERNAL_ERROR`,
  `RESOURCE_CHECK_BROKEN`, `ARD_NOT_CONFIGURED`, `ARD_DERIVATION_FAILED`. A config that names one
  as a severity override or an allow entry is now rejected.
- **`vat ard emit` over an `ard:` block that reaches no surface now exits 1, not 0.** The
  zero-examined case is decided once, by the writer, from each verb's declared denominator.
- **User mistakes across `okf validate`, `skill review`, `resources check` and `ard emit` publish
  `USAGE_INVALID` / `CONFIG_INVALID` / `INPUT_UNREADABLE` instead of `INTERNAL_ERROR`.** A genuine
  VAT defect still publishes `INTERNAL_ERROR`, with its stack on stderr.
- **Refusal documents no longer carry `durationMs`.**
- **`vat skill review` without `--yaml` now prints nothing on stdout when it refuses** (its
  human-readable report has always gone to stderr).
- **`@vibe-agent-toolkit/resources` `parseConfigFile` and `parseConfigAllowingUnknownKeys` now
  throw a coded `VatError` (`CONFIG_LOAD`)** instead of a plain `Error`; the barrel now exports
  `CONFIG_LOAD_CODE`. Messages are unchanged.
- **`packages/cli` removed `handleReportCommandError`, `handleReportExpectedFailure`, and the old
  `report-schemas.ts` types `ReportEntry`, `UnmigratedEntry`, `ReportSchemaEntry`,
  `REPORT_SCHEMAS`**, replaced by `PUBLISHED_SHAPES` and `endWithReport`/`endWithRefusal`
  (library-only; no CLI-facing change).

### Added

- **`no-stdout-outside-writer` ESLint rule** makes `packages/cli/src/utils/document-writer.ts`
  the one place under `commands/` that writes stdout for a document.
- **`PUBLISHED_SHAPES` registry** (`packages/cli/src/report-schemas.ts`) lists every shape VAT
  publishes — stdout reports, file artifacts, exported library types, and committed JSON Schemas —
  asserted against the tree both ways.

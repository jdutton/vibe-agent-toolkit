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
- **`vat audit` publishes the report contract.** `status: success|warning|error` becomes
  `ok|findings|error` (an error-severity finding is `findings`, exit 1 as before; `error` means only
  "did not finish", exit 2, with `error: { code, message }`). `issueCounts` -> `summary`;
  `summary.filesScanned` -> `examined`; `summary.{filesPassed, filesWithWarnings, filesWithErrors,
  pathsUnreadable}` -> `data.counts.*`; `duration: "123ms"` -> `durationMs`; `root` -> `data.root`
  (`null` for a URL audit, whose `# Audited:` / `# Subpath:` comment header becomes
  `data.provenance: { url, ref, commit, subpath? }`); `hierarchical` -> `data.hierarchical` (`null`
  outside `--user`), and the `--user` header counts `marketplaces`, `cachedPlugins`,
  `standalonePlugins`, `standaloneSkills` are removed (use the array lengths). `files[].issues[]`
  -> top-level `findings[]`, each with `location`. `files[]` -> `data.files[]` with rows
  `{ path, type, status: ok|findings, summary, compatibility?, settings? }`; a row's `description`,
  `issues`, `metadata`, `linkedFiles` and `evidence` are removed (`--verbose` evidence prints on
  stderr). The run-level `RESOURCE_CHECK_BROKEN` issue is one entry in `findings[]` (exit 1).
  Under `--compat`, `compatibility.summary` -> `compatibility.fileCounts`, and
  `observations[].summary` / `verdicts[].summary` (sentences) -> `description`.
- **`vat audit` refusals and exit codes.** Every refusal is an envelope with a code: a missing path,
  an unrecognised file, `--user` with no Claude directories, an unparseable URL, or a bad subpath
  in a `url#ref:subpath` -> `USAGE_INVALID`; a root the OS will not list, a path under a parent the
  process may not traverse (before: scanned, published `findings`, exit 1), or a failed clone ->
  `INPUT_UNREADABLE` (exit 2). `--user` now counts `SKILL_MISCONFIGURED_LOCATION` in `summary` and
  in the exit code, and no longer raises it for a skill inside a `claude-plugin` install.
- **`vat audit settings` publishes the report contract.** `status` -> `ok|findings|error`,
  `issueCounts` -> `summary`, `duration` -> `durationMs`; `examined`, `gate`, `data.root` and
  `data.mode` (`file` | `paths` | `effective`) are added. `file`, `detectedType`, `typeConfidence`,
  `fields`, `paths`, `layers`, `effectiveSettings` and `conflicts` move under `data`
  (`conflicts` is always present). `findings[]` is always present and carries
  `{ code, severity, message, location, field }` with codes `SETTINGS_FILE_INVALID`,
  `SETTINGS_TYPE_AMBIGUOUS`, `SETTINGS_PATH_DEPRECATED`, `SETTINGS_RULE_SHADOWED`,
  `SETTINGS_MARKETPLACE_TOKEN_MISSING` (and `SCAN_PATH_UNREADABLE` for `--show-paths`); `location`
  was a key path and is now the file, and `field` is the key path. Every path in `data` and every
  `location` is relative to `data.root`, the working directory. Exit codes: effective mode with no
  readable settings file 0 -> 1; `--show-paths` with every probe undetermined 0 -> 1; unknown
  `--type` -> 2 `USAGE_INVALID`; `--file` naming a missing path 1 -> 2 `USAGE_INVALID`; `--file`
  naming an unreadable file -> 2 `INPUT_UNREADABLE`.
- **`vat corpus scan` writes report-shaped audit files.** `<name>-audit.yaml` is the `vat audit`
  report (`packages/cli/schemas/corpus-audit.json`). In `summary.yaml`, `audit.status` is
  `ok|findings|unloadable` (an empty tree is `findings`, was `error`), the totals `audit_clean` /
  `audit_warning` / `audit_error` become `audit_ok` / `audit_findings` / `audit_with_errors`, and
  `audit.summary.files_scanned` -> `audit.files_scanned`.
- **`vat skills validate` publishes the report contract.** `status` -> `ok|findings|error`;
  `issueCounts` -> `summary`; `skillsValidated` -> `examined`; `durationSecs` -> `durationMs`;
  `runIssueCounts` is removed. `results[]` -> `data.skills[]` `{ name, status: ok|findings,
  summary, allowed }`, one row per validated skill at every verbosity (before: only skills with
  findings unless `--verbose`). `results[].allErrors` and `runIssues[]` -> flat top-level
  `findings[]` with `location` relative to `data.root`; `ignoredErrors` -> `allowed` (a count).
  `observations`, `evidence` and `metadata` leave the document. `--verbose` now changes stderr
  only (allow records and excluded reference paths). Exit codes: no `skills:` block, no document
  and exit 0 -> `RESOURCE_CHECK_BROKEN`, exit 1; discovery globs matching nothing stays exit 1 but
  is `status: findings`; unknown `--skill` -> 2 `USAGE_INVALID`; a mis-scoped `[path]` -> envelope
  `USAGE_INVALID`, and one the OS will not list -> `INPUT_UNREADABLE`. Scope refusals read
  `Path does not exist: <abs>` / `Path is not a directory: <abs>`. On stderr an info-only skill
  is rated with the success glyph, as `vat validate` rates an info-only phase.
- **`vat claude marketplace validate` publishes the report contract.** `status` ->
  `ok|findings|error`; `issueCounts` -> `summary`; `duration` -> `durationMs`; the `summary`
  sentence is removed; `pluginsValidated` -> `data.plugins.length`. `root`, `marketplace`
  (`null` when absent), `plugins`, `undeclared` and `refused` move under `data`. Plugin rows are
  `{ name, source, path, manifestRead, status: ok|findings, summary }` (an unread manifest is
  `manifestRead: false`, no longer `status: error`); `issues` -> flat `findings[]` at every
  verbosity, and `--verbose` no longer changes stdout. `examined` is remote entries plus local
  plugins walked, so a manifest with no plugin entries now exits 1 (was 0), and a missing or
  invalid manifest publishes `RESOURCE_CHECK_BROKEN` beside `MARKETPLACE_MISSING_MANIFEST` (exit 1
  as before). A typed `[path]` that is absent or not a directory -> exit 2 `USAGE_INVALID` (was
  1); one the OS will not list -> exit 2 `INPUT_UNREADABLE`. The `vat verify` phase over an
  unbuilt directory is unchanged (finding, exit 1).
- **`vat agent validate` publishes the report contract.** `status` -> `ok|findings|error`;
  `duration` -> `durationMs`; `examined: 1`, `gate` and `data.root` are added.
  `manifest { name, version: 'unknown'?, path }` -> `data.manifest { name|null, version|null,
  path }` (`path` relative to `data.root`). `validation.errors[]` / `validation.warnings[]`
  (strings) -> `findings[]` with codes `AGENT_MANIFEST_INVALID` (one per schema violation, with
  `field`), `AGENT_REFERENCE_MISSING`, `AGENT_REFERENCE_UNREADABLE`, `AGENT_RAG_NO_SOURCES`
  (warning). Manifest not found 1 -> 2 `USAGE_INVALID`; manifest unreadable or not YAML 1 -> 2
  `INPUT_UNREADABLE`; a schema-invalid manifest stays exit 1.
- **`vat resources validate` publishes the report contract.** `status` -> `ok|findings|error`
  (info- or warning-only runs are `findings`, exit 0); `filesScanned` -> `examined`;
  `issueCounts` -> `summary`; `errorsFound` -> `summary.errors`; `durationSecs` -> `durationMs`;
  `data.root` and `gate` are added. `issues[]` (per-file count rows, or per-issue rows under
  `--verbose`) -> flat top-level `findings[]` `{ code, severity, message, location, line?, link?,
  fix?, reference? }`. `collections` -> `data.collections` (always present; `errorCount` -> a
  `summary`; `filesWithErrors` kept per collection); `--verbose` adds `data.files[]` `{ path,
  status, summary }` for every resource. `issueSummary`, top-level `filesWithErrors`,
  `linksChecked`, `validationMode` and `frontmatterSchema` are removed (derive `issueSummary` from
  `findings[].code`). `--format text` now prints `location:line: severity: message [code]` and a
  status line on stdout (before: `file:line:col:` on stderr). Exit codes: `--collection X` is
  scoped, so an error only outside X no longer fails it (1 -> 0), while an unreadable file matched
  by X's own patterns still does; a `--collection` the project does not declare -> 2
  `USAGE_INVALID` (was 0 or 1); `--frontmatter-schema` with a missing file or unsupported
  extension -> `USAGE_INVALID`, and one the OS will not read or that does not parse ->
  `INPUT_UNREADABLE`; a linkAuth provider that does not compile -> `CONFIG_INVALID` (was
  `INTERNAL_ERROR`).
- **`vat resources scan` publishes the report contract.** `status: success` -> `ok`;
  `filesScanned` -> `examined`; `durationSecs` -> `durationMs`; `root`, `lane`, `extentSource`,
  `collections` and `files` move under `data`; `linksFound` and `anchorsFound` are removed.
  `data.collections` is always present and lists only collections with members (a declared, empty
  `--collection` gives `{}`). A scan of zero files now exits 1 with `RESOURCE_CHECK_BROKEN` (was
  0); an undeclared `--collection` -> 2 `USAGE_INVALID` (was 0).
- **`vat resources query` publishes the report contract.** `status: success` -> `ok`;
  `durationSecs` -> `durationMs`; `rows` -> `data.rows` (`rowCount` removed; use
  `data.rows.length`); `root`, `population`, `populationSecs`, `lensSecs`, `lensesEvaluated`,
  `boundsStatement` and `limits` move under `data`; `data.columns` (the statement's real column
  names, so an empty answer still has them), `examined` (resources in the population) and `gate`
  are added. An empty population now exits 1 with `RESOURCE_CHECK_BROKEN` (was 0); zero rows over
  a populated tree is `ok`. A refused statement is `USAGE_INVALID` (exit 2); an engine fault such
  as a corrupt or busy store is `INTERNAL_ERROR`.
- **`vat validate` and `vat verify` phase output follows the report contract for the `resources`
  and `skills` phases.** A phase's `report` is the exact document the verb writes, refusals
  included. A warnings-only phase is now rated `warning` (the `resources` phase had read
  `success`), and the header issue counts read the phase's `summary`; exit codes are unaffected.
- **`vat skill review <path>` under a directory the process may not traverse now refuses
  `INPUT_UNREADABLE` (exit 2)**; it was `USAGE_INVALID` "Path does not exist". A truly absent
  path is still `USAGE_INVALID`, and its message names the resolved absolute path.
- **A path under a parent the process may not traverse is `INPUT_UNREADABLE` in every path-taking
  report verb** (`resources validate|scan|check|query`, `claude marketplace validate`,
  `skills validate`, plus `audit` and `skill review` above), where it was `USAGE_INVALID` "does
  not exist"; exit stays 2. An unknown `--skill` on `vat skills build` is coded `USAGE_INVALID`
  (exit 2, same message).
- **`@vibe-agent-toolkit/agent-skills` `ValidationResult` (also returned by claude-marketplace
  `validatePlugin`) changes shape** (library-only). `status: success|warning|error` ->
  `ok|findings` (`findings` iff any non-suppressed issue); `issueCounts` -> `summary` (severity
  counts); the sentence `summary: string` -> `description`. The gate is `summary.errors > 0`.
  `description` for a result with findings is now `N errors, N warnings, N info` (was
  `Found N issue(s)`), early exits append the counts (`Plugin manifest missing: N errors, N
  warnings, N info`, likewise for marketplace manifests and registry files), and the clean
  registry sentence is `Valid registry`.
- **`PackagingValidationResult` (agent-skills) and `SettingsValidateResult` (claude-marketplace)
  change shape** (library-only). Both use `status: ok|findings` plus `summary` counts (the packaging
  result's old two-valued `status` gate is now `summary.errors > 0`); `SettingsValidateResult`'s
  `issueCounts` -> `summary`. `SettingsFinding` is now `{ code, severity, message, field? }` (was
  `{ path | location, message, severity }`). `validateSettingsFile` now throws when the file is
  absent or unreadable (was a `SETTINGS_FILE_INVALID` finding); only content that does not parse
  or violates the schema is that finding. `summarizeSettingsFindings` is removed from
  claude-marketplace.
- **Library observations, verdicts and compatibility counts rename `summary`** (library-only).
  agent-skills `Observation.summary` and claude-marketplace `Verdict.summary` (sentences) ->
  `description`; `CompatibilityResult.summary` (counts) -> `fileCounts`. The dev-tools
  compat-empirical static-prediction JSON follows (`ObservationCodeSchema` and
  `VerdictCodeEntrySchema`: `summary` -> `description`).
- **`@vibe-agent-toolkit/agent-config` `validateAgent` and its loader change** (library-only).
  `ValidationResult` `{ valid, errors, warnings, manifest }` -> `{ status, summary, issues,
  manifest }`; `validateAgent(path)` -> `validateAgent(path, { locationRoot })` (required option);
  a load failure now throws a coded `VatError` (`AGENT_MANIFEST_NOT_FOUND`,
  `AGENT_MANIFEST_UNREADABLE`, `AGENT_MANIFEST_INVALID`) instead of returning `valid: false`, and
  `findManifestPath` / `loadAgentManifest` throw the same coded errors (messages unchanged).
- **`@vibe-agent-toolkit/projection-sqlite` statement refusals are coded** (library-only). A
  refused statement from `query()` or the compile probe throws a `VatError` with code
  `PROJECTION_STATEMENT_REFUSED`, messages unchanged; only SQLite result codes 1, 8, 25 and 257
  count as a refusal, and any other engine fault propagates uncoded.

### Added

- **`no-stdout-outside-writer` ESLint rule** makes `packages/cli/src/utils/document-writer.ts`
  the one place under `commands/` that writes stdout for a document.
- **`PUBLISHED_SHAPES` registry** (`packages/cli/src/report-schemas.ts`) lists every shape VAT
  publishes — stdout reports, file artifacts, exported library types, and committed JSON Schemas —
  asserted against the tree both ways.
- **New finding codes**, each documented in `docs/validation-codes.md`:
  `SETTINGS_FILE_INVALID`, `SETTINGS_TYPE_AMBIGUOUS`, `SETTINGS_PATH_DEPRECATED`,
  `SETTINGS_RULE_SHADOWED`, `SETTINGS_MARKETPLACE_TOKEN_MISSING`, `AGENT_MANIFEST_INVALID`,
  `AGENT_REFERENCE_MISSING`, `AGENT_REFERENCE_UNREADABLE`, `AGENT_RAG_NO_SOURCES`.
- **New library exports** (library-only). `@vibe-agent-toolkit/schema`: `resultStatus`,
  `summarizeIssues`. `@vibe-agent-toolkit/agent-skills`: `describeIssues`,
  `GIT_SUBPATH_INVALID_CODE`. `@vibe-agent-toolkit/resources`: `PROJECTION_STATEMENT_REFUSED_CODE`,
  `LINK_AUTH_CONFIG_CODE`, `matchesCollection`. `@vibe-agent-toolkit/agent-config`:
  `AGENT_MANIFEST_NOT_FOUND_CODE`, `AGENT_MANIFEST_UNREADABLE_CODE`, `AGENT_MANIFEST_INVALID_CODE`,
  `ValidateAgentOptions`. `@vibe-agent-toolkit/projection-sqlite`:
  `SqlQueryableStore.columns(sql, ...params)`.

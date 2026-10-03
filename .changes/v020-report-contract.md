### Breaking

- **`Report<T>` is now a discriminated union of `ok` / `findings` / `error`, and every document
  requires `gate`.** `error` carries `{ code, message }` (`code` is a registered refusal code);
  `data` is never `null` on `ok`/`findings` and may be partial on `error`. `exitCodeForReport`
  reads `gate` from the document — it no longer takes a `{ strict }` option.
  <!-- verdict-delta:report-union-and-gate -->
- **Refusal codes are registered and rejected as `validation.severity`/`validation.allow` keys.**
  New refusal codes: `USAGE_INVALID`, `CONFIG_INVALID`, `INPUT_UNREADABLE`, `BACKEND_UNAVAILABLE`,
  `EXTERNAL_API_FAILED`, `NOT_IMPLEMENTED`, `RUN_INCOMPLETE`, `INTERNAL_ERROR`,
  `RESOURCE_CHECK_BROKEN`, `ARD_NOT_CONFIGURED`, `ARD_DERIVATION_FAILED`. A config that names one
  as a severity override or an allow entry is now rejected.

  Exit code per code: `exitCodeForReport` returns 2 for any `status: error` document, so the
  eight refusals that end a run publish 2. The last three are refusal-as-finding: the run
  completed, they publish at `error` severity inside a `findings` document, and exit 1.

  | Code | Meaning | Exit code |
  | --- | --- | --- |
  | `USAGE_INVALID` | The command line could not be acted on (missing or conflicting argument, unknown option value, path naming nothing). | 2 |
  | `CONFIG_INVALID` | The project config is missing where needed, does not parse, or fails its schema. | 2 |
  | `INPUT_UNREADABLE` | An input the command must read could not be read. | 2 |
  | `BACKEND_UNAVAILABLE` | A local backend (optional package, vector store, database file, binary) is not installed or could not be opened. | 2 |
  | `EXTERNAL_API_FAILED` | A remote API call failed or was refused. | 2 |
  | `NOT_IMPLEMENTED` | The requested mode, target or format is not implemented. | 2 |
  | `RUN_INCOMPLETE` | The run started and stopped before finishing; the report carries what finished. | 2 |
  | `INTERNAL_ERROR` | A defect in VAT itself, not in the project. | 2 |
  | `RESOURCE_CHECK_BROKEN` | A declared check could not run, or a gate examined nothing. Published as an error-severity finding, not a `status: error` document. | 1 |
  | `ARD_NOT_CONFIGURED` | The project declares no `ard:` block, so no manifest was built. Published as an error-severity finding. | 1 |
  | `ARD_DERIVATION_FAILED` | A declared `ard:` surface could not be derived into a conformant entry. Published as an error-severity finding. | 1 |
- **`vat ard emit` over an `ard:` block that reaches no surface now exits 1, not 0.** The
  zero-examined case is decided once, by the writer, from each verb's declared denominator.
- **User mistakes across `okf validate`, `skill review`, `resources check` and `ard emit` publish
  `USAGE_INVALID` / `CONFIG_INVALID` / `INPUT_UNREADABLE` instead of `INTERNAL_ERROR`.** A genuine
  VAT defect still publishes `INTERNAL_ERROR`, with its stack on stderr.
- **Refusal documents (`status: error`) no longer carry `durationMs`** — every one, including the
  orchestrators' `RUN_INCOMPLETE` and `resources check`'s population-never-completed refusal.
- **`vat skill review` without `--yaml` now prints nothing on stdout when it refuses** (its
  human-readable report has always gone to stderr).
- **`@vibe-agent-toolkit/resources` `parseConfigFile` and `parseConfigAllowingUnknownKeys` now
  throw a coded `VatError`** instead of a plain `Error`: `CONFIG_LOAD` for a config that does not
  parse or validate, and (`parseConfigFile`, `loadConfig`) `CONFIG_UNREADABLE` for one the OS will
  not read (was a raw errno). The barrel exports `CONFIG_LOAD_CODE` and `CONFIG_UNREADABLE_CODE`
  (moved from the CLI). Parse and validation messages are unchanged.
- **A project config the OS will not read is `INPUT_UNREADABLE`, exit 2, on every verb** (one
  shared read, `readConfigText`): `vat okf validate`, `vat claude plugin build` and
  `vat claude marketplace publish` published `INTERNAL_ERROR` with a stack. The CLI's own config
  loader now decodes a UTF-16LE or BOM-prefixed config, as `parseConfigFile` always did.
- **`vat ard emit` with an `--output` the OS will not write is `RUN_INCOMPLETE`, exit 2** (was
  `INTERNAL_ERROR` with a stack).
- **`vat claude plugin build` (and `vat build`'s `claude` phase): the packager refusing a
  plugin-local skill's content is `RUN_INCOMPLETE`, exit 2, with a `SKILL_PACKAGING_FAILED` error
  finding at the skill's `SKILL.md`** — a skill `files:` source that does not exist, a bundled
  nested `SKILL.md`, a name that is not one path segment. It was an uncoded exit 2 whose reason
  was on stderr only. Same refusal `vat agent build` and `vat skill test run` publish for the
  same cause; the build still stops at that skill.
  <!-- verdict-delta:plugin-build-packaging-refusal -->
- **`vat claude marketplace publish` over build output that holds no
  `.claude-plugin/marketplace.json`, or one that is not a JSON manifest, is `INPUT_UNREADABLE`, exit 2**
  (was an uncoded exit 2 carrying a raw `ENOENT` under a temp directory). Run `vat build` first.
  <!-- verdict-delta:publish-unbuilt-marketplace -->
- **A path with no relative spelling (on Windows, another drive than its root) no longer kills the
  document.** `vat agent validate` with a manifest on another drive than the working directory
  refuses `USAGE_INVALID` (it died on its own document, printing nothing); a `vat okf validate`
  finding in a bundle on another drive than the project, and a `vat skills build` packaging
  finding for a skill on another drive than the working directory, omit `location` (the OKF one
  names the document in its message).
- **Help `Exit Codes:` blocks now state what the code does.** `vat claude context` no longer
  promises exit 1 for an unknown option or unsupported `--format` (Commander rejects those at 2,
  with no document); `vat agent run` documents 0 or 2 (it never exits 1); `vat corpus scan` no
  longer advertises exit 130 (VAT installs no SIGINT handler there).
- **`@vibe-agent-toolkit/schema` library breaks** (library-only):
  - `reportSchema(dataSchema)` takes a second, required argument: `reportSchema(dataSchema,
    findingSchema)`.
  - `buildErrorReport(error: string, durationMs)` becomes `buildErrorReport({ error, gate,
    examined, findings, data })` (no `durationMs`), with `error` a `{ code, message }` and the
    result a generic `ErrorReport<T>`.
  - `buildReport` requires `gate`, and returns `OkReport<T> | FindingsReport<T>`.
  - `CodeRegistryEntry` gains a required `kind: 'finding' | 'refusal'`.
  - `REPORT_ENVELOPE_KEYS` gains `gate`.
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
  <!-- verdict-delta:audit-report-contract -->
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
  <!-- verdict-delta:skills-validate-report-contract -->
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
- **`vat agent build` publishes the report contract** (schema `packages/cli/schemas/agent-build.json`).
  `status: success` -> `ok`; `duration` -> `durationMs`; `agent`, `target`, `output`, `files` move
  under `data`; `examined: 1` and `gate` are added. A failure's `error: <string>` -> `error: { code,
  message }` (exit 2 as before): `--target` other than `skill`, or no `package.json` for the
  default output -> `USAGE_INVALID`; a manifest with no `spec.prompts.system.$ref`, or whose `$ref`
  names no file -> `CONFIG_INVALID` (all three were uncoded, so they now stop reading as VAT
  defects). A system prompt, `scripts/`, `LICENSE.txt` or `package.json` the OS will not read or
  stat -> `INPUT_UNREADABLE` (a refused `scripts/`/`LICENSE.txt` was skipped silently, a refused
  `package.json` walked past, an unreadable prompt was `INTERNAL_ERROR`). A packager refusal of the
  bundle's content -> `RUN_INCOMPLETE` with one `SKILL_PACKAGING_FAILED` finding at the agent (was
  `INTERNAL_ERROR`).
- **`vat agent import` publishes the report contract** (schema `packages/cli/schemas/agent-import.json`).
  `status: success` -> `ok` with `data: { agentPath }`; `duration` -> `durationMs`; `examined: 1`.
  `status: error` + `error: <string>` -> `error: { code, message }`, exit 2 as before: no SKILL.md at
  the path, or agent.yaml present without `--force` -> `USAGE_INVALID`; a SKILL.md that cannot be
  read, whose frontmatter is not YAML or that no schema accepts -> `INPUT_UNREADABLE`; an `--output`
  whose directory does not exist -> `USAGE_INVALID`; any other failed write -> `RUN_INCOMPLETE`. A directory or EACCES SKILL.md is now refused (was an uncoded throw).
- **`vat agent installed` publishes the report contract** (schema
  `packages/cli/schemas/agent-installed.json`). `status: success` -> `ok`; `duration` (a number) ->
  `durationMs`; `skills` and `scanned` move under `data`; `examined` is the scopes scanned.
  `skills[].type: installed` -> `directory`. A scope directory the OS will not list is a
  `SCAN_PATH_UNREADABLE` warning finding (`status: findings`, exit 0; was `status: error`, exit 2),
  `field` naming the scope and `location` `.claude/skills` under that scope's base; a
  failure's `error: <string>` -> `error: { code, message }`: an unknown `--runtime` ->
  `USAGE_INVALID`, and an unknown `--scope` -> `USAGE_INVALID` (was scanned as nothing, exit 0).
- **`vat agent list` publishes the report contract** (schema `packages/cli/schemas/agent-list.json`).
  `status: success` -> `ok`; `duration` (`"<n>ms"`) -> `durationMs`; `root` and `agents` move under
  `data`; `count` is removed (`data.agents.length`); `examined` is the search paths scanned (3). A
  search path, agent directory or manifest the OS will not read is a `SCAN_PATH_UNREADABLE` warning
  finding relative to `root` (`status: findings`, exit 0; was an uncoded failure document, exit 2).
- **`vat agent install` and `vat agent uninstall` publish a document** (schemas
  `packages/cli/schemas/agent-install.json`, `agent-uninstall.json`; they published nothing).
  `examined: 1`; `data: { agent, installPath, symlink }` / `{ agent, installPath, wasSymlink }`.
  Every failure publishes `error: { code, message }`, exit 2 as before (install "already installed"
  and uninstall "not installed" were exit 2 with nothing on stdout): an unknown `--scope`/`--runtime`,
  a name that is not one path segment, already installed without `--force`, not installed, or no
  `package.json` around the agent -> `USAGE_INVALID`; `--dev` on Windows -> `NOT_IMPLEMENTED`; an
  unbuilt bundle or a path the OS will not read -> `INPUT_UNREADABLE`; a failed write under the
  scope directory -> `RUN_INCOMPLETE`. `uninstall` now removes a dangling `--dev` link (was "not
  installed", exit 2). Agent discovery (every verb that takes an agent name) refuses an unreadable
  search path or manifest as `INPUT_UNREADABLE` (was an uncoded errno, `INTERNAL_ERROR`).
- **`@vibe-agent-toolkit/agent-skills` `ImportError` carries `refusal: RefusalCode`** (library-only),
  and `importSkillToAgent` no longer throws on a SKILL.md it cannot read: it returns
  `INPUT_UNREADABLE`. `buildAgentSkill` throws coded `VatError`s: `AGENT_MANIFEST_INVALID` (from
  agent-config) for a missing or absent system prompt, and the new `AGENT_PACKAGE_ROOT_MISSING_CODE`
  when no output path is given and no `package.json` encloses the agent, and the new
  `AGENT_SOURCE_UNREADABLE_CODE` for a system prompt, `scripts/`, `LICENSE.txt` or `package.json`
  the OS will not read or stat (`scripts/`/`LICENSE.txt`/`package.json` were probed with `existsSync`).
  `ImportError.refusal` is `USAGE_INVALID` for an `--output` directory that is not there.
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
  <!-- verdict-delta:resources-validate-report-contract -->
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
  <!-- verdict-delta:resources-query-report-contract -->
- **The Node floor is now `>=22.16.0` (was `>=22.13.0`) in every package's `engines.node`.**
  `vat resources query` failed on 22.13–22.15 (`statement.columns is not a function`). Upgrade
  Node to 22.16.0 or newer; `vat doctor` reports the range.
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

- **`vat claude plugin list`, `install` and `uninstall` publish the report contract.**
  `status: success` -> `ok`; every other field moves under `data`; `duration` -> `durationMs`.
  A refusal exits 2 with `error: { code, message }`: `list --target <not code>` and
  `install --target <unknown>` -> `USAGE_INVALID`, `install --target claude.ai` -> `NOT_IMPLEMENTED`.
- **`vat claude plugin list`: `sources.pluginRegistry` / `sources.legacySkillsDir` are now the paths
  read, not counts** (count `data.plugins` / `data.legacySkills`); `legacySkills` is always present.
- **`vat claude plugin install`: `skillsInstalled` is removed** (count `data.skills`); `data.dryRun`,
  `data.symlink` and `data.skills[].sourcePath` (`null` for a copy) are always present; the `--dev`
  lane's `package` is `data.source`. A `--dev` skill with no build is a `COMPONENT_DECLARED_BUT_MISSING`
  warning (exit 0). A plugin that could not be registered now fails the run (exit 2,
  `INPUT_UNREADABLE` or `RUN_INCOMPLETE`) instead of reporting success; a refusal lists the skills
  already installed. `--npm-postinstall` now prints its report on stdout (a skip is `ok`,
  `data.skills: []`, exit 0); `--build`'s build output moved to stderr.
- **`vat claude plugin uninstall`: `pluginsRemoved` is removed** (count `data.plugins[].removed`);
  a per-plugin `warning` is now a `PLUGIN_UNINSTALL_INCOMPLETE` warning finding at the plugin key
  (new code). A missing or malformed key (including `p@`) exits 2 with `USAGE_INVALID`.
- **`@vibe-agent-toolkit/claude-marketplace`: `installPlugin` throws instead of warning on stderr**
  (library-only). An unreadable or non-JSON registry, settings file or skills directory throws a
  `VatError` coded `CLAUDE_USER_STATE_UNREADABLE` (also from `listLocalPlugins` and the registry
  readers); a failed copy, write or removal (from `installPlugin` or `uninstallPlugin`) throws
  `CLAUDE_USER_STATE_WRITE_FAILED`. New exports: those codes,
  `parsePluginKey` and `PLUGIN_KEY_INVALID_CODE` (a key with an empty name or marketplace is refused).
- **`vat claude plugin build` publishes the report contract** (schema
  `packages/cli/schemas/claude-plugin-build.json`). `status: success` -> `ok|findings|error`;
  `issueCounts` (top level and per plugin) -> `summary`, and every finding is now named in
  `findings[]` with a project-relative `location`; `duration` -> `durationMs`;
  `marketplacesBuilt`, `pluginsBuilt`, `pluginsReferenced`, `skillsPackaged`, `marketplaces[]`
  move under `data`. `marketplaces[].status: built` -> `ok|findings`. Plugin rows are now
  `{ name, outputPath, skills }`: `dir` (absolute) -> `outputPath`, relative to the directory
  holding `vibe-agent-toolkit.config.yaml`; `commandsCopied`, `hooksCopied`, `agentsCopied`,
  `mcpCopied`, `treeFilesCopied`, `symlinksCopied`, `explicitFilesCopied`, `localSkillsPackaged`
  and `issueCounts` are removed. `externalPlugins[]` is unchanged, under `data`.
- **`vat claude plugin build` exit codes.** A plugin-local skill failing the post-build gate
  exits 1 with the error findings and `data.marketplaces[].reason` (was exit 2 with
  `status: error`); the build still stops at that plugin. No `claude.marketplaces` exits 1 with
  `RESOURCE_CHECK_BROKEN` (was `status: success`, exit 0) — `vat build` runs no `claude` phase for
  such a project, unchanged. An undeclared `--marketplace` exits 2 `USAGE_INVALID` (was a
  successful build of nothing). Refusals carry codes: `CONFIG_INVALID` (no config, empty plugin,
  two skills claiming one directory, duplicate or case-colliding plugin names, plugin dir case
  mismatch, invalid `files[].dest`), `INPUT_UNREADABLE` (hooks.json, .mcp.json or plugin.json not
  JSON; a pool skill or `files[].source` nothing built; a symlink no bundle can ship). Under
  `vat build` the claude phase's gate failure is a `findings` phase and the build exits 1 (was
  `system-error`, exit 2).
- **`vat claude marketplace publish` publishes the report contract** (schema
  `packages/cli/schemas/claude-marketplace-publish.json`). `status: success` -> `ok`;
  `published[]` -> `data.published[]` of `{ marketplace, version, branch, files, dryRun }` —
  `version` is now always present, `null` for a multi-plugin marketplace (was omitted). No
  marketplace with a `publish:` block (including no `claude.marketplaces`) exits 1 with
  `RESOURCE_CHECK_BROKEN` (was exit 2, uncoded). An undeclared `--marketplace` exits 2
  `USAGE_INVALID`; a declared one without `publish:` exits 1 as above. Refusals carry codes:
  `CONFIG_INVALID` (no config; an unrenderable license; a configured changelog, readme or license
  file that does not exist; an unknown git remote), `INPUT_UNREADABLE` (no build output; a
  changelog with no release notes), `EXTERNAL_API_FAILED` (push), `RUN_INCOMPLETE` (another git
  step). A refusal after a marketplace was published lists it in `data.published`. Build-output
  messages name `dist/...` relative to the project, not an absolute path.
- **`vat skills build` publishes the report contract** (schema
  `packages/cli/schemas/skills-build.json`). `status: success|warning|error` -> `ok|findings|error`;
  `issueCounts`, `runIssueCounts` and every per-row `issueCounts` -> the envelope `summary`; every
  finding (per-skill `issues`, `runIssues`, and — newly — the pre-build findings that rejected a
  skill) is in `findings[]`; `duration` -> `durationMs`. Under `data`: `skillsBuilt`,
  `skillsFailed`, `skillsFailedValidation`, `outputCommitted`, `promotionError` keep their names;
  `skillsInPlaceNames` / `skillsPluginOnlyNames` -> `skillsInPlace` / `skillsPluginOnly` (the counts
  are removed — count the arrays); `skillsWithErrors` and `skillsWithErrorNames` are removed (read
  the error findings); `skills`, `skillsStaged`, `failedSkills` and `validationFailedSkills` become
  one `skills[]` of `{ name, source, output, status: ok|findings }` — `outputPath` (absolute) ->
  `output`, and `source` is new, both relative to the directory holding
  `vibe-agent-toolkit.config.yaml`; `output` exists only when `outputCommitted`; `filesPackaged` is
  removed; a skill whose packaging threw is a `SKILL_PACKAGING_FAILED` error finding (new, non-overridable: refused as a `validation.severity` / `allow` key)
  instead of a `failedSkills[].error` string. `--dry-run` publishes the same report
  (`data.dryRun: true`, `validated: false`, `examined` = skills discovered); `skillsFound` is
  removed (read `examined`).
- **`vat skills build` exit codes.** `--skill` naming a `publish: false` skill is a
  `SKILL_BUILD_TARGET_NOT_BUILDABLE` error finding (new, non-overridable), `status: findings`, exit 1 (was
  `status: error`, exit 1). No `skills:` block exits 1 with `RESOURCE_CHECK_BROKEN` (was exit 0) —
  under `vat build` that skills phase examines 0 and the run is judged on the sum (see `vat build`
  below). Globs matching no SKILL.md exit 1 with `RESOURCE_CHECK_BROKEN` (was exit 2, uncoded). A promotion failure exits 2
  with `error.code: RUN_INCOMPLETE`, the findings and `data.promotionError` (was `status: error`
  beside the whole legacy document). Refusals carry codes: `USAGE_INVALID` (a `[path]` naming no
  directory or none holding a config, an unknown `--skill`, no project root), `INPUT_UNREADABLE`
  (a `[path]`, or a previous `dist/skills`, the OS will not stat — was read as absent),
  `CONFIG_INVALID`, `RUN_INCOMPLETE` (the staging area under `dist/` could not be created, or the
  previous output could not be set aside — was an uncoded `INTERNAL_ERROR`).
- **`vat skills package` publishes the report contract** (schema
  `packages/cli/schemas/skills-package.json`). `status: success|warning|error` -> `ok|findings|error`;
  `issueCounts` -> the envelope `summary`, and every validation finding (stderr-only before) is in
  `findings[]`; `duration` -> `durationMs`. Under `data`: `skill` and `dryRun` keep their names;
  `version` is `null` for a skill declaring none (was the string `unspecified`); `outputPath` is
  relative to the working directory (was absolute) and `null` when the gate stopped the run;
  `filesPackaged`, `artifacts` and the dry run's `formats` are removed. The validation-gate failure
  is the same report at `status: findings`, exit 1 (was `{ status: error, issueCounts, skill }`); a
  `--target claude-web` ZIP over 8 MB is a `SKILL_PACKAGE_TOO_LARGE` error finding (new,
  non-overridable: refused as a `validation.severity` / `allow` key), `status: findings`, exit 1
  (was `{ status: error, error, duration }`). A packager refusal of the skill's own content (a
  `SKILL.md` bundled as a resource, a name that is not one path segment) is a
  `SKILL_PACKAGING_FAILED` error finding, `outputPath: null`, exit 1 (was an uncoded failure
  document, exit 2); any other packaging throw stays exit 2, now `INTERNAL_ERROR`. A `<skill-path>`
  naming nothing is `USAGE_INVALID`, exit 2, in both lanes — the packaging lane moves 1 -> 2 (it was
  a `SKILL_MISSING_FRONTMATTER` finding over a skill that was never there), `--dry-run` was an
  uncoded exit 2; one the OS will not stat or read (an untraversable parent, an unreadable file) is
  `INPUT_UNREADABLE`, exit 2 (was read as absent, or an uncoded crash). `<skill-path>` may now also
  name the skill's directory, as `vat skill review` accepts. An invalid `--target` is
  `USAGE_INVALID`, exit 2 (was an uncoded failure document, exit 2).
- **`vat skill test configure` publishes the report contract** (schema
  `packages/cli/schemas/skill-test-configure.json`): `status: ok`, `examined: 1`,
  `data: { configPath, skill }` (stdout was empty). `--print` is unchanged — the config text and
  nothing else. Refusals carry codes (were an uncoded `{ status: error, error, duration }`):
  `USAGE_INVALID` (an invalid knob or `--auth` value, no project root), `CONFIG_INVALID` (no
  config file at the project root — was an unhandled read error — a config that is not YAML or has a
  collection or scalar where the knob path goes — was an uncoded crash — or an edit the schema
  rejects),
  `INPUT_UNREADABLE`, `RUN_INCOMPLETE` (the write failed). `vat skill test run`'s invalid
  `--auth` / `--require-auth` values are now coded `USAGE_INVALID` too (same helper).
- **`@vibe-agent-toolkit/utils` `updateYamlIn` input-shape throws are coded** (library-only): input
  that is not YAML, a collection at the path, or a scalar ancestor throws a `VatError` coded
  `YAML_EDIT_INPUT_REFUSED_CODE` (was a plain `Error`; message unchanged). An empty path stays uncoded.
- **`@vibe-agent-toolkit/agent-skills` packaging refusals of a skill's content are coded**
  (library-only): `files:` source/dest/glob refusals and a bundled nested `SKILL.md` throw a
  `VatError` coded `SKILL_PACKAGING_INPUT_INVALID_CODE` (was a plain `Error`; messages unchanged);
  `isSkillPackagingInputError(error)` also recognises `SKILL_NAME_NOT_A_SEGMENT`. The `files:`
  integrity post-conditions stay uncoded (a defect).
- **`packages/cli` removed `handleValidationGateFailure`, `buildValidationGateFailure` and
  `ValidationGateFailure`** (internal; their last caller was `vat skills package`).
- **`vat build`, `vat validate` and `vat verify` publish the report contract** — one shape for the
  three (registry entry `orchestrator`, schema `packages/cli/schemas/orchestrator.json`).
  `status: success|warning|error|system-error` -> `ok|findings|error`; the header `issueCounts` ->
  the envelope `summary`; every phase's findings are flat in `findings[]` with their `location`
  unchanged; `examined` is the sum of the phases' own; `duration` -> `durationMs`. `phases[]` ->
  `data.phases[]` of `{ name, status: ok|findings|error, examined, summary, error?, data }`:
  `phases[].report` -> the phase's own `data` (its findings are on the envelope, its status and
  summary on the entry); `phases[].exitCode`, `phases[].error` (a string) and `phases[].issueCounts`
  / `issues` are removed — `error` is now `{ code, message }` on a phase that did not finish.
  `vat build`'s `phasesCompleted`, `phase` and `error` header fields are removed (read
  `data.phases`), and its shipped-plugin-tree link check is a phase of its own, `shipped-links`
  (examined = shipped skill dirs; its findings' `location` is relative to the skill dir). Verify's
  in-process phases publish `data`: `packaged-content` `{ bundlesExpected, bundlesInPlace,
  bundlesMissing }` (were top-level on the phase; `bundlesInspected` -> the entry's `examined`),
  `files-config-dests` and `consistency` `null`. `files-config-dests` now always appears when
  `skills:` is configured (was: only when a dest was missing) and publishes one
  `FILES_CONFIG_DEST_MISSING` error finding per missing dest (new code, never overridable —
  `validation.severity` / `validation.allow` refuse it as a key; was a per-skill error COUNT with
  no finding). Every phase's report is now validated against its own verb's schema before it is
  folded — a phase whose report does not match is that phase's `INTERNAL_ERROR`.
  <!-- verdict-delta:orchestrators-report-contract -->
- **Orchestrator exit codes.** Run integrity is judged ONCE, on the sum over every phase: a phase
  that examined nothing no longer fails a run whose other phases examined something (a `vat build`
  of a marketplace with no `skills:` pool exits 0; a per-phase `RESOURCE_CHECK_BROKEN` for zero
  examined is gone — `packaged-content` keeps its own, which names the unbuilt bundles). A run
  that examined nothing at all — including a project configuring no surface, which was a warned
  `status: success`, exit 0 — exits 1 with `RESOURCE_CHECK_BROKEN`. A phase that did not finish
  makes the run `error` with `error.code: RUN_INCOMPLETE` (exit 2) and the finished phases in
  `data.phases` (was `system-error` beside the phases). Refusals of the run itself carry codes and
  publish the envelope (they printed stderr only, or an uncoded `{status: error}`): a positional
  path argument, the retired `--only`, and `vat build --only` naming an unknown or unconfigured
  phase -> `USAGE_INVALID` (help text said exit 1 for the last; it was, and is, 2); a config
  that does not parse or validate -> `CONFIG_INVALID`, one the OS will not read ->
  `INPUT_UNREADABLE`; discovery that cannot list the tree -> `INPUT_UNREADABLE`; a throw in
  a verify in-process phase (e.g. a `package.json` the OS will not read) is that phase's refusal
  with its own code (was always an uncoded exit 2).
- **Phase functions return `{ report }`.** `runResourcesValidatePhase`, `runSkillsValidatePhase`,
  `runSkillsBuildPhase`, `runClaudePluginBuildPhase` and `runMarketplaceValidatePhase` return the
  report BEFORE the writer's run-integrity pass (was `{ document, exitCode, failed? }` of the
  published document). `vat skills build` and `vat claude plugin build` publish the same
  zero-examined refusal as before on their own command lines.
- **`calculateValidationStatus` is removed** from `@vibe-agent-toolkit/schema` — the second status
  vocabulary (`success | warning | error`) is gone; derive a status with `resultStatus` /
  `summarizeIssues` (`ok | findings`) and read `countBySeverity` for the distribution. Also
  removed from `packages/cli/src/commands/phase-utils.ts`: `PhaseStatus`, `SYSTEM_ERROR`,
  `worseOf`, `aggregatePhaseStatus`, `phaseIssueCounts`, `aggregatePhaseIssueCounts`,
  `exitCodeForPhases`, `phaseResultFromOutcome`, `finishCommand`; `validateShippedPluginSkillLinks`
  -> `checkShippedPluginSkillLinks` (returns a report); verify's `toPublishedIssue` is removed.
- **`vat claude org` publishes the Admin API payload verbatim, and a failed write exits 2.**
  The `status: success|error` and `duration` fields VAT wrapped around the payload are removed
  (the exit code is the verdict). A partial or failed write (`skills install --from-npm` with a
  failed upload, `skills delete` the API did not confirm or `--all` could not finish, `skills
  versions delete` the API did not confirm) still publishes its payload and now exits **2** (was
  1). A run that threw publishes `{ error: { code, message } }` (was `status: error`, `error:
  <string>`, `duration`): `USAGE_INVALID` for a missing `ANTHROPIC_ADMIN_API_KEY` /
  `ANTHROPIC_API_KEY`, a bad argument or no such source; `INPUT_UNREADABLE` for a source the OS
  will not read (including a source under a parent the process may not traverse — was
  `Source not found`); `EXTERNAL_API_FAILED` for a refused, unusable or unanswered API call. The
  half-finished `skills delete --all` payload's `error: <string>` is renamed `reason` (on this verb
  `error` is the refusal's `{ code, message }`).
- **The ten `vat claude org` not-implemented stubs publish the report contract** (schema
  `claude-org-not-implemented.json`): `status: not-yet-implemented`, `command`, `guidance` ->
  `status: error`, `error: { code: NOT_IMPLEMENTED, message }`, `examined: 0`, `data: null`,
  `gate: { strict: false }`; exit stays 2.
- **`packages/cli` org helpers** (library-internal): `writeNotYetImplementedStub` is removed
  (`NOT_IMPLEMENTED_MESSAGE` in `claude/org/stubs.ts`); `executeOrgCommand` takes the registered
  verb (`'claude org info'`, was `'OrgInfo'`); `orgCommandFailure(document, outcome)` requires the
  outcome (`partial` / `failed`); `buildOrgCommandEnding(result)` drops its `durationMs` argument
  and returns `{ document, outcome }` (was `{ document, exitCode }`).
- **`@vibe-agent-toolkit/claude-marketplace` `OrgApiClient` missing-key throws are coded**
  (library-only): `buildAdminHeaders` / `buildSkillsHeaders` throw a `VatError` with code
  `ORG_API_KEY_MISSING` (exported as `ORG_API_KEY_MISSING_CODE`), was a plain `Error`;
  `ApiRequestError` / `ApiTransportError` codes are exported as `API_REQUEST_CODE` /
  `API_TRANSPORT_CODE`.

- **`vat skills list` publishes the report contract** (schema `packages/cli/schemas/skills-list.json`).
  `status: success` -> `ok`; `status: warning` and the `unreadable[]` list -> one
  `SCAN_PATH_UNREADABLE` warning finding per unlistable directory at its root-relative `location`
  (`status: findings`, exit 0); `root`, `context` and `skills[]` move under `data`; `skillsFound` is
  removed (count `data.skills`); `examined` is the search roots scanned (1, or 2 under `--user`).
  A `[path]` that names no directory now exits 2 with `USAGE_INVALID` (one the OS will not read:
  `INPUT_UNREADABLE`) instead of listing nothing; a `.tgz` or `npm:` source that is not a skill
  package exits 2 with `USAGE_INVALID`, and an unreadable archive with `INPUT_UNREADABLE`, instead
  of an uncoded error.
- **`vat skills install` publishes the report contract** (schema `packages/cli/schemas/skills-install.json`).
  `status: success` / `dry-run` -> `ok` with `data.dryRun`; `source`, `target`, `scope` and
  `skills[]` move under `data` (`skills[].alreadyInstalled` stays, `--dry-run` only);
  `skillsInstalled` is removed (count `data.skills`); `duration` -> `durationMs`. A skill that fails
  its pre-install validation is now its own error findings at exit 1 with nothing installed (was a
  refusal message, exit 2). Every refusal exits 2 with `error: { code, message }` in place of
  `error: <first line>`: a bad `--target`/`--scope`/`--name`, a source with no `SKILL.md`, a name
  collision or an existing skill without `--force` -> `USAGE_INVALID`; a source the OS or archive
  reader will not read, or an install path the OS will not let VAT `lstat`, -> `INPUT_UNREADABLE`; an npm registry failure -> `EXTERNAL_API_FAILED`; a copy
  that fails partway -> `RUN_INCOMPLETE`, listing the skills already installed. The `InstallError`
  class is removed. A source that is a symlink to a directory is now followed.
- **`vat skill test run` publishes the report contract** (schema
  `packages/cli/schemas/skill-test-run.json`). The stdout `Summary: <line>` is gone: stdout is the
  YAML report alone, and the line moves to stderr (`Summary: <line>`) beside `Harness:` /
  `Results:` / `Workspaces:` / `Reason:`. `examined` is the evals graded (the evals staged, on
  `--dry-run`); each failed eval is a `SKILL_TEST_EVAL_FAILED` finding (`location` the suite's `evals.json`
  relative to the project root, omitted outside it; `field` the eval id), `error`
  (exit 1) — or `warning` (exit 0) under `--allow-eval-failure`, which used to leave no trace
  beyond the summary; `data: { skill, description, evals: [{ id, passed }], artifacts: {
  frictionReport, outputDir } }` (`description` is the old summary line). A harness that could
  not run publishes `status: error` at exit 2 with `error.code` decided at its cause (was a
  `Summary:` line and exit 2): no `claude` binary or one too old for a spawn flag ->
  `BACKEND_UNAVAILABLE`; a flag, auth guard, missing ack, unsafe `--workdir`, held lock, a skill
  name the config does not declare (or `--no-build` with no dist), bad `env` token or failing
  `test.build` hook -> `USAGE_INVALID`; a broken project config -> `CONFIG_INVALID`; a skill build
  that threw keeps its cause's code (was `Reason: preflight` whatever it threw) — the packager
  refusing the skill's own content -> `RUN_INCOMPLETE` with a `SKILL_PACKAGING_FAILED` finding at
  its `SKILL.md`, an uncoded defect -> `INTERNAL_ERROR`; a missing eval input or dependency, an invalid suite,
  a vendored manifest mismatch, and bootstrap (no `evals.json`) -> `INPUT_UNREADABLE`; a harness
  defect -> `INTERNAL_ERROR`. `Reason:` stays on stderr and now follows the code — so an invalid
  `--with` / `--env` pair, which read `Reason: internal`, reads `preflight`. A subject or companion
  dist the OS will not `stat` is `INPUT_UNREADABLE` (was read as absent), and a dangling dist link
  is absent. The stderr `Error: `
  prefix on a refusal message is gone.
- **`@vibe-agent-toolkit/agent-skills` `RunHarnessResult` is a union on `exitCode`**
  (library-only): `summary` -> `description`; an `ERROR` result carries required `reason` and
  `refusal: RefusalCode`; an `OK` / `FINDINGS` result carries `examined`, `evals: [{ id, passed }]`
  (the composite per-eval verdict, WITH arm, fail-fast-skipped evals absent), `frictionReportPath`
  and `evalsPath`. `RunHarnessOptions.tolerateEvalFailure` and `verdictExitCode` are removed:
  the harness verdict is never softened, and `--allow-eval-failure` is the CLI's severity choice.
  `SkillBuildError` takes `{ cause, sourcePath }` for a build that threw. `PreflightCheck` is a union on `passed`, and a failed check carries its
  `refusal`.
- **`friction.json` severities are `error|warning|info`** (was `high|medium|low`): `FrictionSeveritySchema`
  is now the shared `SeveritySchema` and `schemas/friction-report.json` is regenerated. The grader is still
  asked for `high|medium|low`; VAT maps it (`high`->`error`, `medium`->`warning`,
  `low`->`info`) at fragment ingestion (`GraderFrictionItemSchema`, internal). `EvalFragment.friction` carries the
  mapped values, and `formatFrictionReport` renders `[error]`/`[warning]`/`[info]`. A `friction.json` left by
  an older run no longer validates.
- **`vat doctor` publishes the report contract** (schema `packages/cli/schemas/doctor.json`). Its
  default stdout changes from the human check block to the YAML report; the block moves to stderr,
  and `--format text` (new, with `yaml` default and `json`) puts it on stdout instead, listing every
  check. `data: { currentDir, projectRoot, configPath, checks: [{ name, outcome, message, suggestion? }] }`;
  `outcome` is `pass|fail|undetermined|skipped`. `examined` is the checks run; each `fail` is a
  `DOCTOR_CHECK_FAILED` finding (error, exit 1 as before) and each `undetermined` a
  `DOCTOR_CHECK_WARNED` finding (warning, exit 0 as before). A doctor that could not run publishes
  `status: error` (`INTERNAL_ERROR`, exit 2) instead of a stderr line. `DoctorResult` drops
  `totalChecks` and `outcomeCounts`; `countByOutcome`, `selectDisplayChecks` and
  `formatDoctorSummary` move to `commands/doctor-render.ts`, and `DoctorOutcome` /
  `DoctorCheckResult` to `commands/doctor-schema.ts` (cli-internal).
- **`vat cache clear` publishes the report contract** (schema
  `packages/cli/schemas/cache-clear.json`). `status: success` -> `ok`; `status: partial` -> the error
  branch, `error.code: RUN_INCOMPLETE` (exit 2, unchanged; the help said 1), with `reason` moved to
  `error.message` and `data` still naming what went and what stayed. `data: { cacheDir, existed,
  removed, remaining, entriesRemoved, bytesRemoved }` — `remaining` is now always present (`[]` on
  a complete clear). `examined` is 1, the one cache root considered; an absent root is `ok` with
  `existed: false`. A cache entry the OS will not list or stat is `INPUT_UNREADABLE` (was an uncoded
  errno), before anything is deleted; a delete that stopped part-way and whose survivors cannot be read
  back stays `RUN_INCOMPLETE`, with `data: null` and both errors in the message. `clearCacheDirectory` (cli-internal) returns `{ complete,
  data, reason? }` instead of `CacheClearReport`.
- **`vat rag index` publishes the report contract** (schema `packages/cli/schemas/rag-index.json`).
  `status: success` -> `ok`; `status: partial` -> `findings` (exit 1 as before); `duration` ->
  `durationMs`; the six counters move under `data`; `errors[]` (`{ resourceId, error }`) is removed —
  each document not in the index is a `RAG_DOCUMENT_INDEX_FAILED` error finding whose `location` is
  its path relative to the crawl root (was the registry id for a provider failure) and whose message
  carries the reason. `examined` is the files submitted, read or not; a run that found no file is
  now a `RESOURCE_CHECK_BROKEN` finding (exit 1; was `success`, exit 0). A path argument that names
  nothing is `USAGE_INVALID` and one the OS will not list `INPUT_UNREADABLE` (exit 2, checked before
  any database opens); no `--db` and no project root is `USAGE_INVALID`.
- **`vat rag query` publishes the report contract** (schema `packages/cli/schemas/rag-query.json`).
  `status: success` -> `ok`; `duration` -> `durationMs`; `root`, `query`, `stats` and `chunks` move
  under `data`; `chunks[].embeddedAt` is an ISO 8601 string. `examined` is the chunks in the index,
  so a query matching nothing is `ok`. A database with nothing indexed — no chunk table, or zero chunks — is `INPUT_UNREADABLE`
  (exit 2; was an uncoded failure document, and a zero-chunk table answered `success` with no
  chunks) — `LanceDBRAGProvider.query` throws it as a `VatError` with code `RAG_INDEX_EMPTY`
  (`RAG_INDEX_EMPTY_CODE`, exported from `@vibe-agent-toolkit/utils`).
- **ONNX model download progress goes to stderr.** `ensureModelFiles` (`@vibe-agent-toolkit/rag`)
  printed its five `[vat-onnx]` progress lines with `console.log`, so a first `vat rag index`/`query`
  with no cached model put them on stdout ahead of the YAML report.
- **`vat rag stats` and `vat rag clear` publish the report contract** (schemas
  `packages/cli/schemas/rag-stats.json`, `rag-clear.json`). `status: success` -> `ok`; `duration`
  -> `durationMs`; stats' five fields move under `data` (`lastIndexed` ISO 8601); clear's
  `message: Database cleared` -> `data: { cleared: true }`. `examined` is 1, the database opened.
- **`vat mcp list-collections` publishes the report contract** (schema
  `packages/cli/schemas/mcp-list-collections.json`). `status: success` -> `ok`; `duration` ->
  `durationMs`; `packages` moves under `data`; `count` is removed (`data.packages.length`).
  `examined` is 1, the built-in package list.
- **An uninstalled optional backend is the `BACKEND_UNAVAILABLE` refusal.** Every `vat rag` leaf
  without `@vibe-agent-toolkit/rag-lancedb` publishes its own report's error branch
  (`error.code: BACKEND_UNAVAILABLE`, exit 2 as before; was `{ status: error, error, fix }`), the
  message naming the package and the install command. A missing projection store reached from a
  report verb (`resources query`, `resources check`, …) publishes that verb's `BACKEND_UNAVAILABLE`
  refusal instead of the same legacy document. `reportMissingBackend` (cli-internal) is replaced by
  `missingBackendError`, which returns the refusal for the caller to throw; `lazyAction` takes the
  report verb first.
- **`vat corpus scan` publishes the report contract on stdout** (schema
  `packages/cli/schemas/corpus-scan.json`; before, stdout was empty). `examined` counts the seed
  entries; `data` is `{ outDir, entries[] }`, each entry `{ name, audit: ok|findings|unloadable,
  review: ok|skipped|error, outputPath }`. The schema's `review` enum is exactly those three;
  `outputPath` is the audit file relative to `outDir`, `null` when unloadable. An entry whose
  audit could not run, or whose `--with-review` review did not finish, is a
  `CORPUS_ENTRY_INCOMPLETE` warning (status `findings`, still exit 0). Refusals
  are coded and exit 2 as before: a seed file that is not there -> `USAGE_INVALID`; malformed YAML,
  a schema violation or a duplicate `source`/`name` -> `CONFIG_INVALID` (both were an uncoded
  error); an unreadable seed -> `INPUT_UNREADABLE`; a write under `--out` the OS refuses (a full
  disk included) -> `RUN_INCOMPLETE` for local and git-URL entries alike, publishing the entries
  that finished — before, a refused `<name>-audit.yaml` write was recorded as an `unloadable` row.
  A validation overlay the SOURCE refuses is that entry's `unloadable` row in both lanes (a local
  source's used to abort the scan uncoded). `summary.yaml` is written
  through the document writer, so it renders at the writer's YAML line width (120; was unwrapped).
  A local source the OS will not stat is an `unloadable` row naming the errno (was "Source path
  not found").
- **`vat claude context` refusals publish the report envelope's error branch** (exit 2 as before)
  instead of the legacy `{ status: error, error: <string> }` block: `error: { code, message }` and
  `gate`. A path outside the corpus root -> `USAGE_INVALID`; an uninstalled projection backend ->
  `BACKEND_UNAVAILABLE`; a reached memory file with no derived harness facts -> `INTERNAL_ERROR`
  with its stack on stderr (the stderr label `claude context (HARNESS_FACTS_ABSENT) failed` is
  gone). The answer document is unchanged — it stays the one legacy shape until wave C.
- **`vat mcp serve` failures no longer print a document on stdout** (stdout is the MCP protocol):
  the message goes to stderr (the stack under `--debug`) and the exit stays 2. `--print-config`
  writes only the JSON config on stdout, through the writer.
- **`packages/cli` `writeLegacyDocument` takes the verb's text rendering** (cli-internal): a
  required fourth argument, `text: string | undefined`, written as-is under `--format text`.
- **`vat inventory` publishes the report contract** (schema `packages/cli/schemas/inventory.json`).
  The inventory document that was the whole of stdout moves to `data.inventory` unchanged (`kind`,
  `vendor`, `declared`/`discovered`/`references`/`unexpected`, `parseErrors[]`); under `--shallow`
  the `projection: shallow` marker and the `null` unwalked lists move with it. `examined` counts the
  subject and every marketplace, plugin and skill inventory nested under it. A `parseErrors[]` row
  marked `unreadable` (a path the OS refused) is now also a `SCAN_PATH_UNREADABLE` warning
  finding (`status: findings`, exit 0); a manifest that does not parse stays data only (`ok`,
  exit 0 as before). A path that does not exist -> `USAGE_INVALID` refusal, exit 2 (was an `ok`
  plugin inventory whose one parse error said so, exit 0); a path that is neither a directory nor
  a SKILL.md -> `USAGE_INVALID` (was inventoried as a plugin); a path the OS will not stat or list
  -> `INPUT_UNREADABLE`; no path and no `--user` -> `USAGE_INVALID`; `--system` ->
  `NOT_IMPLEMENTED`; an unknown `--format` -> `USAGE_INVALID` (was silently YAML); an uninstalled
  projection backend -> `BACKEND_UNAVAILABLE`. Every refusal is `error: { code, message }` (was the
  legacy `{ status: error, error: <string> }`), exit 2 as before.
- **`@vibe-agent-toolkit/agent-skills` `serializeInventory` / `serializeInventoryShallow` are
  removed**: they returned a rendered YAML/JSON string. `serializedInventory(inv, 'full' | 'shallow')`
  returns the object to publish (same content), `InventorySerializedSchema` is its strict Zod schema,
  and `countInventories` / `unreadableParseErrors` answer the report's denominator and refusals.
  The unused `ShallowInventory` type is gone (`InventorySerialized` is the published type).
  `HookRef` / `McpRef` / `LspRef` `inline` is `Record<string, unknown>` (was `object`). Every
  extractor's read or listing refused by the OS now carries `unreadable: true` on its `parseErrors[]`
  row (install, plugin, marketplace, skill), and an unreadable `~/.claude/plugins` level is a row
  (was read as absent). `vat inventory <unreadable SKILL.md>` -> `INPUT_UNREADABLE` (was `ok`).
- **`writeYamlOutput` is no longer exported from `@vibe-agent-toolkit/cli`.** A command document
  leaves through the CLI's one writer; the YAML and JSON stdout writers are private to it.
- **`@vibe-agent-toolkit/utils/eslint` `no-literal-process-exit` drops the `derived.legacy`
  option** (its schema now refuses it; the `staleLegacy` message is gone): every file under
  `derived.paths` derives its exit code. `no-stdout-outside-writer` no longer names
  `writeYamlOutput` / `writeJsonOutput` / `writeStructuredOutput` (they no longer exist); it still
  flags `writeStdoutSync` and `writeAllSync`.
- **`vat agent run` failures no longer print a document on stdout** (stdout is the agent's reply):
  the message goes to stderr (the stack under `--debug`) and the exit stays 2.
- **`vat okf validate` over nothing is refused by the writer**: the `RESOURCE_CHECK_BROKEN`
  message is the registry's (`Nothing was examined: 0 bundle documents. …`); `data.notice` still
  names the empty bundles.
- **`vat okf validate` with a bundle root the OS will not list is refused as `INPUT_UNREADABLE`,
  exit 2** (was an `OKF_BUNDLE_ROOT_UNREADABLE` finding, exit 1), as a directory the OS will not
  list is in every verb. The refusal's `error.message` is that finding's message; every other
  bundle's findings, `examined` and `data` are still published with it.
- **`vat resources check` under a budget validates the child's document before forwarding it**,
  and ends on the code that document derives (was the child's exit code). One that does not parse
  or fails the `resources-check` schema (a truncated write) is read like a child that published
  nothing: the interrupted document from the progress log, `RESOURCE_CHECK_BROKEN`, exit 1 (was
  forwarded verbatim with the child's code).

### Added

- **`no-stdout-outside-writer` ESLint rule** makes `packages/cli/src/utils/document-writer.ts`
  the one place under `commands/` that writes stdout for a document.
- **`PUBLISHED_SHAPES` registry** (`packages/cli/src/report-schemas.ts`) lists every shape VAT
  publishes — stdout reports, file artifacts, exported library types, and committed JSON Schemas —
  asserted against the tree both ways.
- **New finding codes**, each documented in `docs/validation-codes.md`:
  `SETTINGS_FILE_INVALID`, `SETTINGS_TYPE_AMBIGUOUS`, `SETTINGS_PATH_DEPRECATED`,
  `SETTINGS_RULE_SHADOWED`, `SETTINGS_MARKETPLACE_TOKEN_MISSING`, `AGENT_MANIFEST_INVALID`,
  `AGENT_REFERENCE_MISSING`, `AGENT_REFERENCE_UNREADABLE`, `AGENT_RAG_NO_SOURCES`,
  `SKILL_TEST_EVAL_FAILED`, `DOCTOR_CHECK_FAILED`, `DOCTOR_CHECK_WARNED`,
  `CORPUS_ENTRY_INCOMPLETE` (non-overridable), `SKILL_PACKAGING_FAILED`,
  `SKILL_BUILD_TARGET_NOT_BUILDABLE`, `SKILL_PACKAGE_TOO_LARGE`, `FILES_CONFIG_DEST_MISSING`,
  `RAG_DOCUMENT_INDEX_FAILED`, `PLUGIN_UNINSTALL_INCOMPLETE`.
- **New library exports** (library-only). `@vibe-agent-toolkit/schema`: `resultStatus`,
  `summarizeIssues`, `CodeKind`, `RefusalCode`, `FindingCode`, `REFUSAL_CODES`,
  `RefusalCodeSchema`, `FindingCodeSchema`, `GateSchema`, `Gate`, `ReportError`, `OkReport`,
  `FindingsReport`, `ErrorReportInput`. `@vibe-agent-toolkit/claude-marketplace`:
  `codedUserStateWrite`. `@vibe-agent-toolkit/agent-skills`: `describeIssues`,
  `GIT_SUBPATH_INVALID_CODE`, `SKILL_PACKAGING_INPUT_INVALID_CODE`, `isSkillPackagingInputError`,
  `SKILL_TEST_REFUSAL_BY_ERROR_CODE`.
  `@vibe-agent-toolkit/utils/yaml`: `YAML_EDIT_INPUT_REFUSED_CODE`. `@vibe-agent-toolkit/resources`: `PROJECTION_STATEMENT_REFUSED_CODE`,
  `LINK_AUTH_CONFIG_CODE`, `matchesCollection`, `ExternalPluginSourceSchema`, `CONFIG_UNREADABLE_CODE`,
  `readConfigText`, `readConfigTextSync`. `@vibe-agent-toolkit/agent-config`:
  `AGENT_MANIFEST_NOT_FOUND_CODE`, `AGENT_MANIFEST_UNREADABLE_CODE`, `AGENT_MANIFEST_INVALID_CODE`,
  `ValidateAgentOptions`. `@vibe-agent-toolkit/projection-sqlite`:
  `SqlQueryableStore.columns(sql, ...params)`.

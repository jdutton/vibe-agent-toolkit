### Breaking

- **`vat audit --settings` without `--compat` is refused (`USAGE_INVALID`, exit 2)** instead of
  printing a warning and auditing without the settings check. Add `--compat`, or drop `--settings`.
  `--settings` under `--user`, which was silently ignored, is refused the same way.
- **`vat audit --compat --settings <file>` refuses a file it cannot use.** A path that does not
  exist is `USAGE_INVALID`; a directory, an unreadable file, or one that does not parse or fails the
  settings schema is `INPUT_UNREADABLE` (exit 2 either way). It used to read a missing file as "no
  settings" and publish `findings: []` at exit 0, and to downgrade a malformed one to a stderr
  warning. An auto-discovered settings layer (`--settings` with no file) that does not parse is
  refused the same way.

- **`vat claude org skills install --from-npm` reports each failed skill as
  `{ skill, error: { code, message } }`** (was `{ skill, error: "<message>" }`): the same
  `{ code, message }` shape the run's own refusal publishes, so one payload carries one error
  shape. `code` is mapped exactly as a run-level refusal's is (`EXTERNAL_API_FAILED` for a
  refused or unanswered API call, `INTERNAL_ERROR` for a VAT defect).

- **`vat claude plugin install <dir>` refuses a plain directory with no `SKILL.md`**, `USAGE_INVALID`,
  exit 2, installing nothing. A directory with no plugin tree, no `package.json` and no `SKILL.md`
  used to be copied whole into `~/.claude/skills/` and reported installed.
- **`vat claude plugin uninstall <key> --all` is refused**, `USAGE_INVALID`, exit 2, removing nothing:
  `--all` ignored the key, uninstalled the plugins of the package in the current directory, and
  exited 0 with the named plugin still installed.

- **`vat skill test configure <skill>` refuses a skill the config does not declare**, exit 2
  `USAGE_INVALID`, naming the skill and the skills `skills.include` does discover, and writes
  nothing (`--print` included). A typo used to be written as `skills.config.<typo>.test`, exit 0,
  and only the next `vat skill test run <typo>` refused it. Declare the skill before configuring
  its tests.
- **`vat claude context --all` refuses a named path or `--discoverable`**, exit 2 `USAGE_INVALID`.
  `--all` answers the whole tree and emits no per-path document, and it used to drop both without a
  word: the cost map, exit 0, with no mention of what was named. Drop `--all` to answer for paths.

- **`vat skills package --formats` refuses an unknown or empty format name**, `USAGE_INVALID`,
  exit 2, naming it and the valid set (`directory`, `zip`, `npm`, `marketplace`). An unknown name
  used to be dropped, so `--formats zpi` wrote only the directory and exited 0. The refusal comes
  before validation and before anything is written, and `--dry-run` applies it too.

- **`Report<T>` is now a discriminated union of `ok` / `findings` / `error`, and every document
  requires `gate`.** `error` carries `{ code, message }` (`code` is a registered refusal code);
  `data` is never `null` on `ok`/`findings` and may be partial on `error`. `exitCodeForReport`
  reads `gate` from the document — it no longer takes a `{ strict }` option.
  <!-- verdict-delta:report-union-and-gate -->
- **`vat ard emit` over an `ard:` block that reaches no surface now exits 1, not 0.** The
  zero-examined case is decided once, by the writer, from each verb's declared denominator.
- **User mistakes across `okf validate`, `skill review`, `resources check` and `ard emit` publish
  `USAGE_INVALID` / `CONFIG_INVALID` / `INPUT_UNREADABLE` instead of an uncoded failure document.** A genuine
  VAT defect publishes the new `INTERNAL_ERROR` refusal, with its stack on stderr.
- **Refusal documents (`status: error`) no longer carry `durationMs`** — every one, including the
  orchestrators' `RUN_INCOMPLETE` and `resources check`'s population-never-completed refusal.
- **`vat skill review` without `--yaml` now prints nothing on stdout when it refuses** (its
  human-readable report has always gone to stderr).
- **`@vibe-agent-toolkit/resources` `parseConfigFile` and `parseConfigAllowingUnknownKeys` now
  throw a coded `VatError`** instead of a plain `Error`: `CONFIG_LOAD` for a config that does not
  parse or validate, and (`parseConfigFile`, `loadConfig`) a classified `FsFaultError` (side
  `source`, origin `config`) for one the OS will not read (was a raw errno). The barrel exports
  `CONFIG_LOAD_CODE` (moved from the CLI). Parse and validation messages are unchanged.
- **A project config the OS will not read is `INPUT_UNREADABLE`, exit 2, on every verb that
  reads it** (one shared read, `readConfigText`): `vat okf validate`, `vat claude plugin build`
  and `vat claude marketplace publish` published an uncoded failure with a stack. `vat skill test
  configure` edits the config in place, so for it the config is the run's destination: a config
  it cannot read is `RUN_INCOMPLETE`, exit 2 (`INPUT_UNREADABLE` under `--print`, which writes
  nothing). The CLI's own config
  loader now decodes a UTF-16LE or BOM-prefixed config, as `parseConfigFile` always did.
- **`vat ard emit` with an `--output` the OS will not write is `RUN_INCOMPLETE`, exit 2** (was
  an uncoded failure with a stack).
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
- **`@vibe-agent-toolkit/schema` library breaks** (library-only):
  - `reportSchema(dataSchema)` takes a second, required argument: `reportSchema(dataSchema,
    findingSchema)`.
  - `buildErrorReport(error: string, durationMs)` becomes `buildErrorReport({ error, gate,
    examined, findings, data })` (no `durationMs`), with `error` a `{ code, message }` and the
    result a generic `ErrorReport<T>`.
  - `buildReport` requires `gate`, and returns `OkReport<T> | FindingsReport<T>`.
  - `CodeRegistryEntry` gains a required `kind: 'finding' | 'refusal'`.
  - `REPORT_ENVELOPE_KEYS` gains `gate`.
  - `ValidationConfig.severity` is keyed by `FindingCode | CustomCheckCode` (was `IssueCode |
    CustomCheckCode`) and `.allow` by `FindingCode` alone (was `IssueCode`; it never accepted `CUSTOM:`
    keys). Neither takes a refusal-kind code, and `ValidationConfigSchema` rejects one.
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
  `package.json` walked past, an unreadable prompt was an uncoded failure). A packager refusal of the
  bundle's content -> `RUN_INCOMPLETE` with one `SKILL_PACKAGING_FAILED` finding at the agent (was
  an uncoded failure).
- **`vat agent import` publishes the report contract** (schema `packages/cli/schemas/agent-import.json`).
  `status: success` -> `ok` with `data: { agentPath }`; `duration` -> `durationMs`; `examined: 1`.
  `status: error` + `error: <string>` -> `error: { code, message }`, exit 2 as before: no SKILL.md at
  the path, or agent.yaml present without `--force` -> `USAGE_INVALID`; a SKILL.md that cannot be
  read, whose frontmatter is not YAML or that no schema accepts -> `INPUT_UNREADABLE`; a failed
  write -> `RUN_INCOMPLETE` (an `--output` whose directory does not exist yet is made). A directory or EACCES SKILL.md is now refused (was an uncoded throw).
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
  `package.json` around the agent -> `USAGE_INVALID`; `--dev` on Windows -> `NOT_IMPLEMENTED`; a manifest that does not
  validate -> `CONFIG_INVALID`; an unbuilt bundle or a path the OS will not read -> `INPUT_UNREADABLE`; a failed write under the
  scope directory -> `RUN_INCOMPLETE`. `uninstall` now removes a dangling `--dev` link (was "not
  installed", exit 2). Agent discovery (every verb that takes an agent name) refuses an unreadable
  search path or manifest as `INPUT_UNREADABLE` (was an uncoded errno).
- **`@vibe-agent-toolkit/agent-skills` `ImportError` carries `refusal: RefusalCode`** (library-only),
  and `importSkillToAgent` no longer throws on a SKILL.md it cannot read: it returns
  `INPUT_UNREADABLE`. `buildAgentSkill` throws coded `VatError`s: `AGENT_MANIFEST_INVALID` (from
  agent-config) for a missing system prompt `$ref`, and the new `AGENT_PACKAGE_ROOT_MISSING_CODE`
  when no output path is given and no `package.json` encloses the agent. A system prompt,
  `scripts/` file or `LICENSE.txt` that is a named pipe, socket or device, or that the OS will not
  read or stat, is a classified `FsFaultError` (`scripts/`/`LICENSE.txt`/`package.json` were
  probed with `existsSync`).
- **`vat resources validate` publishes the report contract.** `status` -> `ok|findings|error`
  (info- or warning-only runs are `findings`, exit 0); `filesScanned` -> `examined`;
  `issueCounts` -> `summary`; `errorsFound` -> `summary.errors`; `durationSecs` -> `durationMs`;
  `data.root` and `gate` are added. `issues[]` (per-file count rows, or per-issue rows under
  `--verbose`) -> flat top-level `findings[]` `{ code, severity, message, location, line?, link?,
  fix?, reference? }`. `collections` -> `data.collections` (always present; `errorCount` -> a
  `summary`; `filesWithErrors` kept per collection); `--verbose` adds `data.files[]` `{ path,
  status, summary }` for every resource. `issueSummary`, top-level `filesWithErrors`,
  `linksChecked`, `validationMode` and `frontmatterSchema` are removed (each collection keeps its own
  `validationMode`) (derive `issueSummary` from
  `findings[].code`). `--format text` now prints `location:line: severity: message [code]` and a
  status line on stdout (before: `file:line:col:` on stderr). Exit codes: `--collection X` is
  scoped, so an error only outside X no longer fails it (1 -> 0), while an unreadable file matched
  by X's own patterns still does; a `--collection` the project does not declare -> 2
  `USAGE_INVALID` (was 0 or 1); `--frontmatter-schema` with a missing file or unsupported
  extension -> `USAGE_INVALID`, and one the OS will not read or that does not parse ->
  `INPUT_UNREADABLE`; a linkAuth provider that does not compile -> `CONFIG_INVALID` (was
  an uncoded failure).
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
- **The Node floor is now `>=22.16.0` (was `>=22.0.0` in 0.1.42) in every package's `engines.node`.**
  `vat resources query` needs `node:sqlite`'s `statement.columns`, which Node gained in 22.16.
  Upgrade Node to 22.16.0 or newer; `vat doctor` reports the range.
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
  `description`; `CompatibilityResult.summary` (counts) -> `fileCounts`.
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
  `install --target <unknown>` -> `USAGE_INVALID`, `install --target claude.ai` -> `NOT_IMPLEMENTED`; an unreadable registry (`list`, `install`) or
  source -> `INPUT_UNREADABLE`; a failing `npm pack` -> `EXTERNAL_API_FAILED`; a failed `--build` or
  a copy or registry write that fails partway -> `RUN_INCOMPLETE`. `uninstall --all` over an unreadable
  `package.json` or registry -> `INPUT_UNREADABLE`; a removal that fails -> `RUN_INCOMPLETE`
  (every directory and registry file is put back, for every key; when only a moved-aside directory
  would not then delete, every plugin is uninstalled and listed, with a warning naming it).
- **`vat claude plugin list`: `sources.pluginRegistry` / `sources.legacySkillsDir` are now the paths
  read, not counts** (count `data.plugins` / `data.legacySkills`); `legacySkills` is always present.
- **`vat claude plugin install`: `skillsInstalled` is removed** (count `data.skills`); `data.dryRun`,
  `data.symlink` and `data.skills[].sourcePath` (`null` for a copy) are always present; the `--dev`
  lane's `package` is `data.source`. A `--dev` skill with no build is a `COMPONENT_DECLARED_BUT_MISSING`
  warning (exit 0). A plugin that could not be registered now fails the run (exit 2,
  `INPUT_UNREADABLE` or `RUN_INCOMPLETE`) instead of reporting success; a refusal before the registry is
  written changes nothing under `~/.claude` and lists no skills, and one after it (a replaced plugin the OS
  will not delete) lists what was installed. `--npm-postinstall` now prints its report on stdout (a skip is `ok`,
  `data.skills: []`, exit 0); `--build`'s build output moved to stderr.
- **`vat claude plugin uninstall`: `pluginsRemoved` is removed** (count `data.plugins[].removed`);
  a per-plugin `warning` is now a `PLUGIN_UNINSTALL_INCOMPLETE` warning finding at the plugin key
  (new code). A missing or malformed key (including `p@`) exits 2 with `USAGE_INVALID`.
- **`@vibe-agent-toolkit/claude-marketplace`: an install or uninstall throws instead of warning on
  stderr** (library-only). A non-JSON registry or settings file throws a `VatError` coded
  `CLAUDE_USER_STATE_UNREADABLE` (also from `listLocalPlugins` and the registry readers); one the OS
  refuses, and a failed copy, write or removal, throws a
  classified filesystem fault (`FS_FAULT`). New exports: that code, `writeUserState`,
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
  JSON; a pool skill or `files[].source` nothing built; a symlink no bundle can ship; a
  `files[].dest` that lands on a directory of the built plugin, or under one of its files — a later
  entry still overwrites an earlier one's FILE). Under
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
  removed; a skill whose content the packager refused is a `SKILL_PACKAGING_FAILED` error finding (new, non-overridable: refused as a `validation.severity` / `allow` key)
  instead of a `failedSkills[].error` string — any other packager throw stops the run at exit 2 with `dist/skills` left untouched, under its own refusal code or `INTERNAL_ERROR` when it carries none (was a `failedSkills[]` row at exit 1). A source file the OS will not let the build read is a finding against the skill — the packager's coded refusal, `SKILL_PACKAGING_FAILED`, in every packaging lane, or `LINK_TARGET_UNREADABLE` at a bundled markdown file the pre-build validation reads first; an output it cannot write stops the run instead (`RUN_INCOMPLETE`, exit 2). `--dry-run` publishes the same report
  (`data.dryRun: true`, `validated: false`, `examined` = skills discovered); `skillsFound` is
  removed (read `examined`).
- **`vat skills build` exit codes.** `--skill` naming a `publish: false` skill is a
  `SKILL_BUILD_TARGET_NOT_BUILDABLE` error finding (new, non-overridable), `status: findings`, exit 1 (was
  `status: error`, exit 1). No `skills:` block exits 1 with `RESOURCE_CHECK_BROKEN` (was exit 0) —
  under `vat build` that skills phase examines 0 and the run is judged on the sum (see `vat build`
  below). Globs matching no SKILL.md exit 1 with `RESOURCE_CHECK_BROKEN` (was exit 2, uncoded). A failed swap of
  `dist/skills` exits 2 under the swap's own code (`RUN_INCOMPLETE` for a refused write), with the findings and
  `data.promotionError` (was `status: error` beside the whole legacy document). Refusals carry codes: `USAGE_INVALID` (a `[path]` naming no
  directory or none holding a config, an unknown `--skill`, no project root), `INPUT_UNREADABLE`
  (a `[path]` the OS will not stat — was read as absent),
  `CONFIG_INVALID`, `RUN_INCOMPLETE` (a previous `dist/skills` the OS will not examine — was read as
  absent — the staging tree beside it could not be made, or the previous output could not be set
  aside — was an uncoded failure).
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
  document, exit 2); any other packaging throw stays exit 2 under its own refusal code (`RUN_INCOMPLETE`
  for an output the OS will not write), or `INTERNAL_ERROR` when it carries none. A `<skill-path>`
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
- **`calculateValidationStatus` is removed** from `@vibe-agent-toolkit/schema` — the second status
  vocabulary (`success | warning | error`) is gone; derive a status with `resultStatus` /
  `summarizeIssues` (`ok | findings`) and read `countBySeverity` for the distribution.
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
  reader will not read -> `INPUT_UNREADABLE`; an install path the OS will not examine ->
  `RUN_INCOMPLETE`; an npm registry failure -> `EXTERNAL_API_FAILED`; a copy
  that fails partway -> `RUN_INCOMPLETE`, with nothing installed and `data: null`. The `InstallError`
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
  `status: error` (`INTERNAL_ERROR`, exit 2) instead of a stderr line.
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
  refusal instead of the same legacy document.
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
  gone). The answer document is unchanged — it stays the one legacy shape for now.
- **`vat mcp serve` failures no longer print a document on stdout** (stdout is the MCP protocol):
  the message goes to stderr (the stack under `--debug`) and the exit stays 2. `--print-config`
  writes only the JSON config on stdout, through the writer.
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

- **RAG query fields no provider implemented are deleted.** `RAGQuery` / `RAGQuerySchema` no longer
  declare `hybridSearch`, `filters.dateRange`, or the top-level `filters.tags` / `filters.type` /
  `filters.headingPath`; the schema is strict, so a query carrying any of them is a schema error.
  `hybridSearch: { enabled: false }` is now an error too (omit the field). Move metadata filters
  under `filters.metadata`. `buildWhereClause` and `query()` validate against the strict
  `RAGQuerySchema`, so a query carrying a removed field or an unknown filter key throws a `ZodError`
  (was silently ignored, which widened the search to the whole index).

- **`SKILL_NAME_XML_TAGS` is removed.** A skill name containing `<` already fails the
  `^[a-z0-9]+(-[a-z0-9]+)*$` pattern, so it reports `SKILL_NAME_INVALID` alone. Drop any
  `SKILL_NAME_XML_TAGS` override or reference. `SKILL_DESCRIPTION_XML_TAGS` stays, documented as
  VAT's reading of the vendor's "cannot contain XML tags".

- **`VAT_ROOT_DIR` naming a tree with no built CLI (`packages/cli/dist/bin.js`) now exits 2**
  with a message instead of silently falling through to the local install. Likewise a `VAT_BIN`
  that does not exist, or that names the wrapper itself (`dist/bin/vat.js`).

- **`vat rag stats`, `vat rag query` and `vat rag clear` refuse a database that is not there**, exit
  2, and no longer create it: `USAGE_INVALID` for a `--db` that names nothing (or names a file),
  `INPUT_UNREADABLE` when the project has no database yet or the directory cannot be read (was:
  `stats` reported zeros and `clear` reported `cleared: true`, exit 0). Run `vat rag index` first.
- **`vat rag stats`, `query` and `clear` refuse a directory that is not a RAG database**,
  `USAGE_INVALID`, exit 2, naming what it holds, and remove nothing: a database is a directory
  holding only the tables `vat rag index` writes (or nothing), operating-system litter (`.DS_Store`,
  `Thumbs.db`, `desktop.ini`, `._*`) aside. The project's own `.rag-db` holding anything else is
  `INPUT_UNREADABLE` (no `--db` was given to correct). `vat rag clear --db <any directory>`
  used to delete it recursively and report `cleared: true` (`vat rag clear --db ..` from `docs/`
  deleted the project); `stats` reported zeros for `$HOME`. A project whose `.rag-db` is a file is
  `INPUT_UNREADABLE` saying so (was "nothing indexed yet"). Library: `LanceDBRAGProvider.clear()`
  throws instead of removing such a directory; `@vibe-agent-toolkit/rag-lancedb` exports
  `removeRagDatabase` and `foreignDatabaseEntries`.
- **`vat rag clear` refuses a database path that is a symbolic link**, exit 2, naming the real path
  to clear (`USAGE_INVALID` for `--db`, `INPUT_UNREADABLE` for the project's `.rag-db`): it removed
  only the link and reported `cleared: true` while the index stayed on disk. A clear the OS stops
  is `RUN_INCOMPLETE` (was `INTERNAL_ERROR`). `removeRagDatabase` refuses a link or foreign entries
  with a coded `VatError` (`TREE_DEST_NOT_OWNED`; was an uncoded `Error`) and the OS refusing to
  examine the database with a classified `FsFaultError` (side `destination`) — see the tree-change
  remove entry for its async shape and leftover.
- **`claude.marketplaces` names must be one path segment** — not empty, `.`, `..`, and no `/`, `\`,
  NUL or drive prefix — or the config is `CONFIG_INVALID`. A marketplace named
  `"../../../../victim"` made `vat claude plugin build` (and `vat build`) delete that directory,
  outside `dist/`, and write the marketplace over it, exit 0.
- **A plugin `files[].dest` is refused by the place it names, however it is spelled.**
  `vat claude plugin build` (and `vat build`) refused `skills/x` and `.claude-plugin/plugin.json`
  by comparing text. So `./skills/x` — and `Skills/x` or `skills./x`, which are `skills/x` on a
  volume that folds names — was written into a packaged skill; and `./.claude-plugin/plugin.json`
  was accepted, written, and then silently discarded when the build generated `plugin.json` over
  it. Every such spelling is now `CONFIG_INVALID`, exit 2, naming the `dest`, on every host, as is
  a `dest` under `.claude-plugin/plugin.json`. Write the file somewhere else in the plugin, or ship
  it with the skill through that skill's own `files:`.
- **`vat skills package` refuses an `--output` that is, or contains, the skill's own source** — the
  SKILL.md or any file it bundles — `USAGE_INVALID`, exit 2, `--force` or not, and writes nothing.
  It skipped every occupancy check then and overwrote the author's SKILL.md and the files beside it.
  Library: `packageSkill` refuses it with a coded `VatError` (`TREE_DEST_NOT_OWNED`, or
  `TREE_DEST_HOLDS_SOURCE` under `replaceExistingOutput`).
- **`vat claude plugin install` refuses a package whose plugin or marketplace directory, version or
  `vat.replaces.plugins` entry is not one path segment, or whose version begins with `.`**,
  `INPUT_UNREADABLE`, exit 2, before anything under `~/.claude` changes. A hostile version used to
  be refused `USAGE_INVALID` only after the marketplace directory was already replaced, leaving it
  out of step with the registry; a dot-led version installed and was then invisible to
  `vat inventory --user`. The library install (`planPackageInstall`) refuses a dot-led version
  (`PLUGIN_KEY_INVALID`), and `@vibe-agent-toolkit/claude-marketplace` exports
  `requirePluginInstallNames`, the check it runs.
- **`vat claude plugin uninstall --all` refuses a registry key of the package that is not
  `<plugin>@<marketplace>`**, `INPUT_UNREADABLE` (the key came from `installed_plugins.json`, not
  the command line), before removing anything — it was `USAGE_INVALID` mid-loop, after the plugins
  ahead of it were already gone. `findPluginsByPackage` throws `CLAUDE_USER_STATE_UNREADABLE` for it.
- **`vat claude plugin uninstall` refuses a plugin key whose plugin or marketplace name is not one
  path segment** (`/`, `\`, `.`, `..`, absolute or drive-letter), `USAGE_INVALID`, exit 2:
  `'../../../../../victim@x'` used to resolve outside the Claude config dir and delete that
  directory as an "orphan", exit 0. The library install refuses a plugin name, marketplace name or
  version (the package's own) that is not one segment, coded `PLUGIN_KEY_INVALID`, before writing
  anything; `parsePluginKey` no longer accepts `@scope/name@marketplace`.
- **Every `vat` verb refuses a positional argument it does not declare**, exit 2 (`too many
  arguments`); it was silently discarded and the run reported success (`vat audit a b` audited
  only `a`). Drop the extra argument, or run the verb once per path.
- **`vat skills package` no longer deletes what is already at `--output`.** It used to `rm -rf`
  whatever `-o` named — a directory's unrelated contents, or a file — and exit 0. An `--output` that
  already holds anything (a non-empty directory, a file, or the `<output>.zip` /
  `<name>.marketplace.json` a requested format writes beside it) is now refused, `USAGE_INVALID`,
  exit 2, and left exactly as it was, the message naming `--force`; an empty directory is used
  as-is. Pass the new `--force` to replace a previous package: it replaces the `--output` and
  a `<output>.zip` / `<name>.marketplace.json` FILE beside it, but never removes a
  directory standing where an archive goes (refused `USAGE_INVALID` before anything is written).
  `--dry-run` runs the same check, so a preview no longer reports `ok` for an output the real run
  refuses. Library: `packageSkill` refuses an occupied explicit `outputPath` with a `VatError` coded
  `TREE_DEST_NOT_OWNED` unless `replaceExistingOutput: true` (the default `dist/skills/<name>`
  location, and every lane converting through `packagingConfigToPackageOptions`, still replace
  their own previous build).
- **`vat skill test run` no longer changes the mode of an existing `--out`.** It re-moded any
  `--out` to `0700` — which ADDED owner write to a read-only directory, so a run wrote where its
  owner had forbidden it and exited 0. An existing `--out` that is not a directory (a file: was
  `RUN_INCOMPLETE`), or on POSIX is not `0700`, is now refused, `USAGE_INVALID`, exit 2, naming the
  fix (`chmod 700` it, or name one that does not exist yet; VAT creates a new one `0700`). Windows
  has no mode check. A harness root, lockfile, staged skill copy, staged manifest or `results/`
  file the OS will not let the run write (a full disk, a read-only directory) is `RUN_INCOMPLETE`,
  exit 2 (was an uncoded `INTERNAL_ERROR`).
- **`vat resources query` and `vat resources check` refuse SQL whose result has two columns of the
  same name**, `USAGE_INVALID`, exit 2 (was: silently returned one of the two values). A statement
  that builds an over-length value (`SQLITE_TOOBIG`) moved from `INTERNAL_ERROR` to `USAGE_INVALID`.

- **`LanceDBRAGProvider.indexResources` (`@vibe-agent-toolkit/rag-lancedb`) rejects the whole batch
  with `RAG_DATABASE_UNREADABLE` when the chunk table cannot be read.** It used to resolve with one
  `errors` entry per resource carrying LanceDB's raw message. A caller that read `result.errors` for
  this case must now catch the rejection.

- **`vat agent build --output <dir>` refuses a `<dir>/<agent-name>/` that already holds anything**
  (`USAGE_INVALID`, exit 2, naming the path) and leaves it exactly as it was. It used to write over a
  user's own `SKILL.md` and `scripts/` there and exit 0. The new `--force` says it is a previous build:
  that directory is replaced. An empty directory is used as-is; an output that is, or
  holds, the agent's own source is refused even with `--force`. The default location
  (`dist/vat-bundles/skill/<agent>/`) is VAT's and is replaced whole. Library: the same
  rule in `buildAgentSkill`, lifted by the new `replaceExistingOutput: true` — the check is the one
  `vat skills package -o` applies (`TREE_DEST_NOT_OWNED`).
- **`vat skills package --dry-run` is the real run's own packaging pass, stopped before its first
  write** (`packageSkill(…, { dryRun: true })`, new): the project crawl, the link walk and the
  `--output` check all run. A directory in the project the OS will not list is now
  `INPUT_UNREADABLE` in the dry run too — it exited 0 while the real run refused — and the file list
  it prints is the one the real run copies (non-markdown assets included), not a separate
  markdown-only walk. `PackageSkillResult` gains `plannedSources` (dry run only).

- **`readSettingsLayers` / `readEffectiveSettings` / `auditSettings`
  (`@vibe-agent-toolkit/claude-marketplace`) reject a settings file the OS refuses** (EACCES or
  EPERM) instead of skipping it as absent: a file the OS refuses is a classified filesystem fault
  (`FS_FAULT`) naming the file, and one that does not parse or fails its schema is a `VatError`
  coded `CLAUDE_USER_STATE_UNREADABLE`, naming the file. Only an absent file is still skipped.

- **`LanceDBRAGProvider.indexResources()` (`@vibe-agent-toolkit/rag-lancedb`) rejects a chunk table
  this build does not write before it changes anything.** A table that lacks a column this build
  writes, or that holds vectors of a different size than the embedding model makes, is a `VatError`
  coded `RAG_DATABASE_UNREADABLE` for the whole batch, naming the difference. Before, a missing
  column surfaced as one `errors` entry per resource ("Found field not in schema"), after an update
  had already deleted that resource's chunks. `query()` and `getStats()` make the same check.

- **A filesystem refusal thrown by a VAT library is one classified `FsFaultError`, code `FS_FAULT`.**
  Test `isFsFaultError(e)` and read `e.side` (`source`, `destination`, `environment`) and
  `e.faultClass`; `fsFaultOf(e)` reads the errno facts off any thrown value. No library code classifies
  an errno by hand any more (the one table and the special-file refusal still spell them): a named pipe, socket or device in a tree being read, copied or built is an
  `FsFaultError` of side `source`, class `wrong-type`, errno `EFTYPE`, naming the entry (`vat` still
  refuses it `INPUT_UNREADABLE`); a full disk or an exhausted descriptor table is `RUN_INCOMPLETE`
  on every side, a read included — the machine's fault, never the input's; something already at a
  destination the user named is `USAGE_INVALID` (`TREE_DEST_OCCUPIED` / `TREE_DEST_NOT_OWNED`),
  decided before anything is written, never inferred from an `EEXIST`.
- **`importSkillToAgent` throws a refused `agent.yaml` write** (an `FsFaultError`) instead of
  returning it.
- **`@vibe-agent-toolkit/utils/eslint`: the `no-fs-promises-cp` rule is removed.** It was in
  `configs.recommended` at `error`, so a config or an `eslint-disable` that names it now reports an
  unknown rule: delete the reference. `no-destructive-fs` subsumes it inside VAT and is not in
  `configs.recommended`.
- **`copyDirectory` is removed from `@vibe-agent-toolkit/utils`** (and from the `./fs` subpath); use
  `copyTree(source, root, relative, { links, side, onto, filter? })`. `copyDirectory(src, dest)` is
  `copyTree(src, dest, '', { links: 'follow-contained', side: 'source', onto: 'merge' })` — except
  that a `dest` which is itself a symbolic link (or a file) is refused `EEXIST`, where
  `copyDirectory` copied into the link's target.
- **`readKnownMarketplaces(paths, side)`, `readInstalledPlugins(paths, side)` and
  `readUserSettings(paths, side)` (`@vibe-agent-toolkit/claude-marketplace`) take the caller's side**,
  the side a fault reading the file is classified on.
- **`validateSkill` options (`ValidateOptions`, `@vibe-agent-toolkit/agent-skills`) take a required `side`**, and
  `detectBundledResourceWithoutLinks` a required `side` argument: the side of the caller's verb the skill tree
  is on (`source` for an author's skill, `environment` for one VAT extracted into `$TMPDIR`). A directory the
  validator's walk cannot resolve is a fault there.

- **`vat claude plugin install` is one transaction per run:**
  a previous tree the install replaced and could not remove — or its `$TMPDIR` staging, once the install is
  complete — is a `TREE_CLEANUP_INCOMPLETE` warning whose `link` is the leftover, the one code every verb uses.
  A refusal before the registry is written changes nothing under `~/.claude`, so its report lists no skills
  (one after it lists what was installed): a later skill that is
  already installed (without `--force`) installs none of the package's skills, where the first ones used to
  stay; a registry file that is not JSON is refused before anything is copied. A skills directory (`-s`)
  the OS will not let it examine is `RUN_INCOMPLETE` (the destination's), not `INPUT_UNREADABLE`.
  `--dry-run` prints the plan, one `[dry-run] create|replace|remove|keep|subsumed <what> <path>` line per
  change, instead of the old "Would copy" lines. An empty directory where a skill installs is replaced
  without `--force` (a directory holding anything, dotfiles included, still needs it). A source path the
  probe answers `ENOENT` for while its parent still lists it is `INPUT_UNREADABLE` (it read as absent:
  `USAGE_INVALID`).
- **Every verb's `TREE_CLEANUP_INCOMPLETE` leftover finding carries the leftover in `link`, not `location`:**
  it is an absolute path (a temporary directory, a staged tree), which `location` (project-relative) may not
  hold — a report naming one there failed its own schema (`INTERNAL_ERROR`).
- **`@vibe-agent-toolkit/claude-marketplace`: `planPackageInstall` is the one install** (with the
  `PackageInstallOptions`, `PackageInstallPlan`, `PackageMarketplaceInstall`, `PackagePluginInstall` types): a
  package's marketplaces (each replaced whole, VAT's `.vat-marketplace` marker in its own fill), every
  plugin's cache, every `vat.replaces` plugin's removal and the registry edit, as one plan. `installPlugin`
  is removed; `InstallPluginOptions` is narrowed to `{ marketplaceName, pluginName, version, source }`
  (no `pluginDir`, `paths`).
- **`@vibe-agent-toolkit/claude-marketplace` installs and uninstalls through the tree-change primitive.**
  Removed: `writeInstalledPlugins`, `writeKnownMarketplaces` (registry files are written only by a plan's
  registry edit), and `uninstallPlugin`.
  Added: `planPluginUninstall`, `uninstallPlugins` and the `PluginUninstallPlan` and `RegistryEdit` types.
- **`uninstallPlugins({ pluginKeys, paths, dryRun? })` replaces `uninstallPlugin({ pluginKey, … })`** and
  resolves `{ results, changes, leftover? }`: one result per distinct key, the plan's `describe()` lines, and
  — when a moved-aside directory will not delete after the registry was rewritten — the fault, every key
  uninstalled. A failure before that puts back every directory and registry file, for every key, and is thrown.
- `UninstallPluginResult` gains a required `keptForSibling` (`{ path, sibling }[]`).
  `vat claude plugin uninstall`, and the `vat.replaces` uninstall of `vat claude plugin install`, publish
  each directory kept because the OS refused to examine the entry it may be as a
  `PLUGIN_KEPT_SIBLING_UNEXAMINED` warning whose `link` is the directory.
- `UninstallPluginResult.artifacts` gains `marketplaceDir`. `VAT_MARKETPLACE_MARKER` (`.vat-marketplace`) is exported.

- **`vat skills install` installs the whole batch or nothing.** Every skill of a source is staged
  beside its install path and swapped in together. A copy that fails partway, a source file the OS
  will not read, or a later skill whose install path is taken (without `--force`) now installs none
  of the batch, where the skills before it used to stay installed and be listed. A refusal's `data`
  is `null`; the validation it finished (`examined`, its findings) is still published.
- **`vat skills install --dry-run` refuses what the real run would refuse**, an install path that
  is already taken without `--force` included, and prints the plan — one
  `[dry-run] create|replace skill <name> <path>` line per skill. `alreadyInstalled: true` now
  appears only beside `--force` (the plan replaces what is there).
- **`vat skills install`'s occupied-path refusal reads "Something already exists where the install
  goes: … Use --force to overwrite."**, the same sentence as `vat claude plugin install`, and an
  empty directory at an install path is replaced without `--force`.
- **`vat skills build` names what it could not clean up as a `TREE_CLEANUP_INCOMPLETE` warning, not
  in `data.promotionError`.** A previous `dist/skills` the run replaced and the OS will not remove
  (parked as `dist/.skills.vat-staged-*.previous`) is a warning whose `link` is that path: the
  build exits 0 with `outputCommitted: true`, where it used to exit 2. `data.promotionError` is set
  only when the swap itself failed, and the refusal then carries the swap's own code.
- **`vat skills build` stages beside `dist/skills` as `dist/.skills.vat-staged-*`** (one bundle under
  `--skill`: `dist/skills/.<name>.vat-staged-*`), not `dist/.vat-skills-*`, and leaves the previous
  `dist/skills` in place until the build has earned the swap: a run killed mid-build no longer leaves
  `dist/skills` absent.

- **A crawl takes `outputs`, the one declaration of what the calling verb writes** (`[]` for a verb
  that only reads), as a required option. Every side a crawl fault is classified on is derived from it: a
  directory that is an output, lies inside one or holds one — the base of a project a build writes into
  included — is the destination's (`RUN_INCOMPLETE`), any other the input's. `crawlDirectory`
  (`@vibe-agent-toolkit/utils/crawl`) and `ResourceRegistry.crawl` require it; so do
  `createProjectRegistry`, `crawlAndResolveRegistry`, the packaging validator's shared context,
  `packageSkills`'s now-required run options and `detectPackagedAgentInstructionFiles`
  (`@vibe-agent-toolkit/agent-skills`).

- **`vat skills package` writes its package as one transaction.** The `--output` directory is built
  whole beside it and swapped in together with the `<output>.zip` and `<name>.marketplace.json` a
  format writes beside it: a failure partway — a refused write, an unreadable source, a ZIP over the
  claude.ai ceiling — leaves a previous package exactly as it was, where `--force` used to remove it
  first. `--dry-run` decides by the same plan and prints one `[dry-run] create|replace <what> <path>`
  line per change.
- **`vat skills package` no longer lands a package its own post-build checks fail.** An
  error-severity post-build finding (a packaged link to nothing, a cross-skill `SKILL.md` link, …) is
  now published as a finding (exit 1, `data.outputPath: null`) and nothing is written; it used to be
  dropped from the report while the package was written (exit 0). The library's `packageSkill`
  THROWS `SkillPackageChecksFailedError` (code `SKILL_PACKAGE_CHECKS_FAILED`, the findings on
  `.result`) and changes nothing on disk — never a resolved result a caller could take for a build.
  Every lane that publishes `SKILL_PACKAGING_FAILED` reads it as that finding
  (`isSkillPackagingInputError`): `vat skill test run`'s pool build now fails naming the findings
  instead of testing a previous dist it reported as rebuilt, and a `workspace:` skill source refuses
  coded instead of failing on a bundle that was never written. `vat agent build` keeps landing such a
  package (registered in known-defects.md: its own `scripts/` / `LICENSE.txt` trip
  `PACKAGED_UNREFERENCED_FILE`).
- **An occupied `vat skills package -o` / `vat agent build --output` is refused as
  `TREE_DEST_NOT_OWNED`** (`USAGE_INVALID`), and an output that is or holds the source with
  `--force` as `TREE_DEST_HOLDS_SOURCE`. `--force` never
  replaces a directory standing where an archive goes: that is refused `USAGE_INVALID` before
  anything is written (it used to end `RUN_INCOMPLETE` after the directory was written). An empty
  directory at the output is replaced as-is.
- **`vat agent build` writes its build as one transaction**, staged beside `<output>/<agent>` and
  swapped in: `--force` no longer removes the previous build first, and a failure partway leaves it
  byte-equal. The default location (no `--output`) is replaced whole, where it used to be built into
  in place (stale files of an earlier build no longer survive). A previous build the swap replaced
  that the OS will not remove is a `TREE_CLEANUP_INCOMPLETE` warning naming it (exit 0).
- **`vat claude plugin build` replaces each marketplace as one transaction.** The marketplace is
  built whole beside `dist/.claude/plugins/marketplaces/<name>` and swapped in once every plugin
  passed the gate: a failed or gated build leaves the previous marketplace byte-equal, where it used
  to be removed before the build started.
- **`vat agent import` writes `agent.yaml` through the tree-change plan.** Something already at the
  output without `--force` is refused before anything is written as `TREE_DEST_OCCUPIED`
  (`USAGE_INVALID`, "… Use --force to overwrite."); a destination the OS will not examine is now
  `RUN_INCOMPLETE` (it was `INPUT_UNREADABLE`); a `--output` whose directory does not exist yet is
  made (it used to end `RUN_INCOMPLETE`). The file is written beside its destination and renamed
  into place, so a link there is replaced, not written through.
- **A crawl believes a subdirectory "vanished" only when its parent agrees.** An `ENOENT` /
  `ENOTDIR` listing (or canonicalising) a subdirectory the parent just listed was skipped as a race;
  it is now confirmed by re-reading the parent (`requireConfirmedAbsent`): an entry the parent still
  names is a refused listing under the caller's `unreadable` policy (refused or reported as a gap),
  never a silently shorter population. `vat claude plugin build` no longer ships a plugin without a
  directory whose listing failed that way (exit 0). A genuinely vanished entry is still skipped.
- **`vat agent import -o <existing empty directory>` is refused** (`TREE_DEST_OCCUPIED`), never
  replaced by a file: under `must-be-free` an empty directory is free for a tree, not for a file.
- **`vat claude plugin build` / `vat build` refuse a path they cannot examine instead of building
  without it.** A project `LICENSE`, `README.md` or `CHANGELOG.md` (or a `publish.readme` /
  `publish.changelog` target), a plugin's source directory (`plugins/<name>`) or `dist/skills` whose
  `stat` the OS refuses (`EACCES` on a parent, `ELOOP`, …) is `INPUT_UNREADABLE`. Each used to read as
  absent: the marketplace shipped without the file, the plugin built without its own directory (or
  failed `CONFIG_INVALID` "has no content"), or the run reported no skills built — exit 0.
- **`vat inventory` (and `vat audit` through it) records a path it cannot examine as unreadable, not
  as missing.** A `marketplace.json`, `plugin.json`, plugin path, `SKILL.md`, `skills/`, `commands/`,
  `agents/`, `hooks/hooks.json`, `.mcp.json` or manifest-declared component path that cannot be
  statted yields one `parseErrors[]` row with `unreadable: true` and the errno message, where it used
  to yield "marketplace.json not found", "plugin path does not exist", or nothing.
- **`vat build` declares every tree the run writes to each phase**: its skills phase is told the
  marketplaces the claude phase replaces, and the claude phase that `dist/skills` is the run's own
  output — so a fault on either is `RUN_INCOMPLETE`, never the `INPUT_UNREADABLE` of an input.
- **`@vibe-agent-toolkit/agent-skills`:**
  - added `packageSkillInto` (package in place into a directory the caller's own plan stages —
    `vat skills build`, `vat claude plugin build`), `stagedPathMapper` / `reanchorStagedResult` (moved
    from the CLI's `skills/build`), `getMarketplaceOutputDir`, `pluginDirInMarketplace`;
  - `PackageSkillResult` gains a required `residue` (the plan's `TREE_CLEANUP_INCOMPLETE` warnings)
    and, for a dry run, `plannedChanges`; `BuildResult` gains a required `residue`;
  - `packageSkills` writes each bundle in place into its spec's (now required) `outputPath` and
    refuses a spec asking for a ZIP or marketplace manifest; `packagingConfigToPackageOptions`
    returns a required `outputPath`;
  - a ZIP's size is judged in memory, before anything lands, and a refused artifact write no longer
    leaves a partial file to remove.
- **`@vibe-agent-toolkit/utils`:** a `replace-file` change's `contents` may be a function, called when
  the file is staged (after every earlier change of the plan has staged); new `copyRegularFile`
  (one file, judged by `fstat` on the handle it is read from, created exclusively under a root
  and never through a link); `onCrawlOutput` on the `./crawl`
  subpath.

- **`vat agent install` changes the install as one transaction, `--dev` included.** The copy, or the
  `--dev` link, is staged beside `~/.claude/skills/<agent>` and swapped in whole: `--force --dev` no
  longer removes the previous install before linking, so a link that cannot be made leaves the
  previous install as it was. A refused install no longer leaves the `~/.claude/skills` directory it
  made. A previous install the swap replaced and the OS would not let VAT remove is now a
  `TREE_CLEANUP_INCOMPLETE` warning in the report (it was only logged). Without `--force`, anything
  but an empty directory at the install path is refused `USAGE_INVALID` by the plan's preflight
  ("Something already exists where the install goes: … Use --force to overwrite."), where an empty
  directory used to be refused too; an install path the OS will not examine is `RUN_INCOMPLETE`
  (the help said `INPUT_UNREADABLE`).
- **`vat agent uninstall`, `vat rag clear` and `vat cache clear` move what they remove off its path
  whole, then delete it.** A deletion the OS stops never leaves part of an install, a database or a
  cache at the path the user knows. It is still `RUN_INCOMPLETE`, but the removal is done: the
  report carries the verb's `data` (the uninstall, `cleared: true`, the cache's counts) and a
  `TREE_CLEANUP_INCOMPLETE` warning whose `link` is the moved-aside `.<name>.vat-staged-*.previous`
  entry. A read-only directory the user owns no longer stops the removal (it is made owner-writable
  on the way down). `vat claude plugin uninstall`'s leftover now carries the same warning.
- **`vat cache clear` never reports a cache that is still there as gone.** A cache listing or entry the OS answers `ENOENT`
  while its parent still lists it is a refusal (`RUN_INCOMPLETE`), never "no cache" / "vanished" —
  `existed: false, exit 0` with the cache still on disk is gone. A cache root the OS will not list is
  `RUN_INCOMPLETE` (the help said so; the system test said `INPUT_UNREADABLE`).
- **`vat rag clear`'s refusals of a database it will not remove are `TREE_DEST_NOT_OWNED`.** A link
  (the refusal names what it links to) or a directory holding anything a RAG database does not:
  `USAGE_INVALID` for a `--db`, `INPUT_UNREADABLE` for the project's own `.rag-db`, nothing removed.
  A link's refusal names its resolved real path and ends `Run vat rag clear --db <real> to clear the
  database itself.` (`linkedDatabasePath` is exported from `@vibe-agent-toolkit/rag-lancedb`). A
  not-owned refusal of a remove now says "refusing to remove", not "refusing to replace".
- **`vat cache clear` racing another clear** (the cache gone between the plan and the move) reports
  `existed: false`, exit 0 — a clear of nothing, never a refusal.
- **The fetch cache sweeps previous entries a refresh left parked** (`.<entry>.vat-staged-*.previous`)
  at the start of each fetch; a staged entry another fetch may be filling is never touched.
- **`@vibe-agent-toolkit/rag-lancedb`: `LanceDBRAGProvider.clear()` throws the moved-aside database
  the OS would not delete** (the clear itself is done).
- **`@vibe-agent-toolkit/agent-skills`: the fetch cache (`url` skill sources) refreshes as one
  transaction** — a refresh whose fetch fails keeps the previous entry — and a cache root or entry
  another user owns is refused `FETCH_CACHE_NOT_OWNED` (a `VatError`; `vat skill test run` maps it to
  `RUN_INCOMPLETE`), where it was a plain `Error` (`INTERNAL_ERROR`).
- **`@vibe-agent-toolkit/utils`: `applyTreePlanOrLeftover`** (with `ApplyOutcome`) — `applyTreePlan`
  for a verb that reports a change it finished even when what it parked could not then be deleted.

- **A temporary directory VAT could not remove once a verb's work was DONE is one
  `TREE_CLEANUP_INCOMPLETE` warning in that verb's report, beside the finished work — never a
  refusal that hides the work, never only a stderr line.** It names the directory. This holds for
  `vat claude marketplace publish` (its publish tree and git staging repo — the remaining
  marketplaces still publish), `vat audit <git-url>` (its clone), `vat corpus scan` (a URL
  entry's clone), `vat resources check` (its progress log; a forwarded child document is then
  re-published with the warning added), `vat skills install` / `vat skills list` (an npm or
  tarball source's extracted package), `vat claude org skills install --from-npm` (the document
  gains `warnings` beside the uploads that landed) and `vat skill test run` (the harness root, the
  grader, hold and workspace directories, and a URL or workspace subject's temporary build).
- **`vat claude marketplace publish` disposes of its publish tree** (`vat-publish-tree-<mp>-*`
  under the temp directory), which every run used to leave behind. Its staging repo
  (`vat-marketplace-publish-*`) is still kept on `--dry-run`.
- **`vat audit <git-url>` disposes of its clone before it publishes**, instead of from an `exit`
  listener, so a clone left behind is a warning in the audit document.
- **A temp-directory disposal only ever removes a directory inside the temp directory**: one
  outside it is named in the warning and left alone.
- **`@vibe-agent-toolkit/resource-compiler`: `copyResources()` and `createPostBuildScript()` are
  async.** Await them. The copy still goes INTO `targetDir` and removes nothing there. A
  `targetDir` that is itself a symbolic link (to a directory included) is refused — `Failed to copy
  resources: EEXIST …` — where the copy used to be written into the link's target: point
  `targetDir` at the real directory.
- **`@vibe-agent-toolkit/agent-skills`:**
  - `stageEvalWorkspaces()` and `isolateEvalSuite()` are async.
  - `ResolvedSkillSource` gains a required `leftovers`, `StageHarnessResult` gains `leftovers`,
    and `RunHarnessResult` carries `leftovers` beside the run.
  - The `onSignal` callback `installSignalCleanup()` takes is async; the process exits once it
    settles, so an interrupted `vat skill test run` finishes removing what it made.
- **The resource parse cache's `clear()` moves the cache off its path whole, then deletes it**: a
  deletion the OS stops throws a classified `FS_FAULT` naming the moved-aside tree, not the raw
  errno.

- **`vat claude plugin install` refuses a marketplace directory VAT did not install from the same
  package** (`USAGE_INVALID`, exit 2, nothing changed). What stands at
  `~/.claude/plugins/marketplaces/<name>` used to be replaced whole, whoever made it: a marketplace
  Claude Code added (a git clone, with whatever the user kept in it) was deleted and re-registered
  as VAT's, and a second package shipping the same marketplace name deleted the first package's
  plugins. Now the directory is replaced only when its `.vat-marketplace` marker names this package
  — or, for an install made before the marker recorded one (0.1.42 wrote no marker), when
  `known_marketplaces.json` records the marketplace as installed from this package. An empty
  directory is taken as before. `--force` replaces it regardless. Two packages can no longer share
  one marketplace name: rename one of them.
  **If you publish a package and RENAME it** (a new name, a scope move), the renamed package is a
  different package to this check: on every machine where the old name installed the marketplace,
  the new name's install — its `postinstall` included — is refused (exit 2) until the old one is
  uninstalled (`vat claude plugin uninstall <plugin>@<marketplace>`, which the marker authorises
  whichever package wrote it) or the install is run once with `--force`. Nothing migrates a
  marketplace from one package name to another; say so in the renamed package's release notes.
- **`vat claude plugin uninstall` removes only what it can show VAT installed.** A plugin whose
  marketplace directory holds no `.vat-marketplace` marker (with `--all`: no marker naming this
  package, nor a `known_marketplaces.json` entry naming it) is left exactly as it is — directory,
  cache, registry records and settings entry — and reported `removed: false` with a
  `PLUGIN_NOT_INSTALLED_BY_VAT` warning (exit 0). It used to delete the plugin's directory out of a
  marketplace it then reported "left for its owner", drop the plugin's cache and unregister it at
  every scope. Pass the new `--force` to remove it anyway; a plugin 0.1.42 installed needs
  `--force` when named by key (`--all` recognises it).
- **`vat claude plugin install` and `uninstall` change only the user-scope record of a plugin key.**
  `installed_plugins.json` holds one record per scope; VAT replaced or deleted the whole list, so a
  project-scope install Claude Code had made of the same key was dropped. It is now kept, and an
  uninstall of a key that still has another scope's record keeps the plugin's directories (a
  `PLUGIN_UNINSTALL_INCOMPLETE` warning says so).
- **`vat claude plugin install <file.zip>` refuses an archive with no `SKILL.md` at its top level**
  (`INPUT_UNREADABLE`, exit 2), and installs under the name the `SKILL.md` declares, as a directory
  is. It used to install any ZIP — a lone `readme.txt`, or a zipped folder whose `SKILL.md` is one
  level down — as a "skill" named after the file, which Claude Code never loads. Zip the folder's
  contents, not the folder.
- **`vat agent import --output <directory>` is refused with or without `--force`** (`USAGE_INVALID`):
  `--output` names the `agent.yaml` file. Under `--force` a directory there used to be deleted with
  everything in it and replaced by the file, exit 0.
- **A registry file of the wrong shape refuses `vat claude plugin install`, `uninstall` and `list`**
  as `INPUT_UNREADABLE` naming the file (an `installed_plugins.json` with no `plugins` object, a
  `known_marketplaces.json` entry with no `source`, a `settings.json` that is not an object). The
  first two used to crash (`INTERNAL_ERROR`); a `settings.json` or `known_marketplaces.json` holding
  a JSON array was read as empty and then replaced.

### Added

- **`vat cache clear`** (new verb) removes VAT's cache directory and publishes the report contract
  (schema `packages/cli/schemas/cache-clear.json`): `data: { cacheDir, existed, removed,
  entriesRemoved, bytesRemoved }`; `examined` is 1, the one cache root considered; an absent root is
  `ok` with `existed: false`. There is no partial clear: the cache is moved off its path whole, then
  deleted. A cache root or entry the OS will not list or stat is `RUN_INCOMPLETE` (exit 2) with
  `data: null`, before anything is moved; a delete the OS stops after the move is `RUN_INCOMPLETE`
  carrying `data` and a `TREE_CLEANUP_INCOMPLETE` warning naming the moved-aside tree.
- **`vat claude plugin uninstall --force`** removes a plugin even where nothing shows VAT installed it.
- **New finding code `PLUGIN_NOT_INSTALLED_BY_VAT`** (warning, `vat claude plugin uninstall`),
  documented in `docs/validation-codes.md`.

- **`@vibe-agent-toolkit/utils`: `pathPresent(path, mode, side, absence)`**, the one presence
  predicate: only an absence answers `false` (and, with `absence: 'confirmed'`, only once the parent's
  listing agrees); a probe the OS refuses is a classified fault, never "not there". `isParkedTreeEntry(name)`
  says whether a directory entry is a previous tree a change moved aside (`….vat-staged-*.previous`).
- **`@vibe-agent-toolkit/utils/eslint` ships `no-existssync`, `no-destructive-fs` and `no-adhoc-errno`**,
  none of them in `configs.recommended` (each remedy names VAT's own primitives).
- **`findExecutable(name)` on `@vibe-agent-toolkit/utils/testing`** returns the absolute path of a
  binary found by walking `PATH` once, or `undefined` instead of a throw, so a test can skip when
  the tool is absent. It is the non-throwing sibling of `resolveExecutable(name)`.

- **Refusal codes: every `status: error` document and every refusal-as-finding carries one of eleven
  registered codes.** Eight are new (`USAGE_INVALID`, `CONFIG_INVALID`, `INPUT_UNREADABLE`,
  `BACKEND_UNAVAILABLE`, `EXTERNAL_API_FAILED`, `NOT_IMPLEMENTED`, `RUN_INCOMPLETE`, `INTERNAL_ERROR`);
  `RESOURCE_CHECK_BROKEN`, `ARD_NOT_CONFIGURED` and `ARD_DERIVATION_FAILED` are new too, published as
  error-severity findings. A refusal is never a `validation.severity` / `validation.allow` key (a config
  naming one was and is rejected; the message now says it is a refusal).

  `exitCodeForReport` returns 2 for any `status: error` document, so the eight refusals that end a run
  publish 2. The last three are refusal-as-finding: the run completed, they publish at `error` severity
  inside a `findings` document, and exit 1.

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
- **New finding codes**, each documented in `docs/validation-codes.md`:
  `SETTINGS_FILE_INVALID`, `SETTINGS_TYPE_AMBIGUOUS`, `SETTINGS_PATH_DEPRECATED`,
  `SETTINGS_RULE_SHADOWED`, `SETTINGS_MARKETPLACE_TOKEN_MISSING`, `AGENT_MANIFEST_INVALID`,
  `AGENT_REFERENCE_MISSING`, `AGENT_REFERENCE_UNREADABLE`, `AGENT_RAG_NO_SOURCES`,
  `PLUGIN_UNINSTALL_INCOMPLETE`, `SKILL_TEST_EVAL_FAILED`, `DOCTOR_CHECK_FAILED`,
  `DOCTOR_CHECK_WARNED`, `CORPUS_ENTRY_INCOMPLETE`,
  `SKILL_PACKAGING_FAILED`, `SKILL_BUILD_TARGET_NOT_BUILDABLE`, `SKILL_PACKAGE_TOO_LARGE`,
  `FILES_CONFIG_DEST_MISSING`, `RAG_DOCUMENT_INDEX_FAILED`. All are non-overridable: each keeps
  the severity its verb gives it and is refused as a `validation.severity` / `allow` key.
- **New library exports** (library-only). `@vibe-agent-toolkit/schema`: `resultStatus`,
  `summarizeIssues`, `CodeKind`, `RefusalCode`, `FindingCode`, `REFUSAL_CODES`,
  `RefusalCodeSchema`, `FindingCodeSchema`, `GateSchema`, `Gate`, `ReportError`, `OkReport`,
  `FindingsReport`, `ErrorReportInput`. `@vibe-agent-toolkit/claude-marketplace`:
  `writeUserState`. `@vibe-agent-toolkit/agent-skills`: `describeIssues`,
  `GIT_SUBPATH_INVALID_CODE`, `SKILL_PACKAGING_INPUT_INVALID_CODE`, `isSkillPackagingInputError`,
  `SKILL_TEST_REFUSAL_BY_ERROR_CODE`.
  `@vibe-agent-toolkit/utils/yaml`: `YAML_EDIT_INPUT_REFUSED_CODE`. `@vibe-agent-toolkit/resources`: `PROJECTION_STATEMENT_REFUSED_CODE`,
  `LINK_AUTH_CONFIG_CODE`, `matchesCollection`, `ExternalPluginSourceSchema`,
  `readConfigText`, `readConfigTextSync`. `@vibe-agent-toolkit/agent-config`:
  `AGENT_MANIFEST_NOT_FOUND_CODE`, `AGENT_MANIFEST_UNREADABLE_CODE`, `AGENT_MANIFEST_INVALID_CODE`,
  `ValidateAgentOptions`. `@vibe-agent-toolkit/projection-sqlite`:
  `SqlQueryableStore.columns(sql, ...params)`.

- **`@vibe-agent-toolkit/utils` exports ordered and bounded-parallel async iteration:**
  `forEachInOrder`, `mapInOrder`, `everyInOrder` (one call at a time; the first rejection, or the
  first `false` for `everyInOrder`, stops the run before any later item starts) and
  `mapWithConcurrency(items, fn, limit = FS_CONCURRENCY)` (`Promise.all`-shaped, at most `limit`
  in flight, results in input order; a limit that is not a whole number of at least 1 rejects
  with `RangeError`). They replace `await` inside a loop, which the repo's ESLint config now refuses
  (`no-await-in-loop` and core `require-await`, mirroring SonarCloud S9382 and S7503).
  Alongside them: `mapConcurrentFailingInOrder(items, fn)` (`mapWithConcurrency` that lets every
  call settle, then rethrows the failure of the EARLIEST item by position — the error a sequential
  loop would have raised) and `promised(work)` (`work()` as a promise, a synchronous throw
  arriving as a rejection — `Promise.try` until the Node floor has it).

- **`VAT_BIN`** — an explicit `bin.js` path for the `vat` wrapper, highest precedence
  (`VAT_BIN` > `VAT_ROOT_DIR` > dev-mode > local install > global install).

- `SKILL_SOURCE_UNREADABLE_CODE` and `SkillSourceUnreadableError` are exported from
  `@vibe-agent-toolkit/agent-skills`: what `resolveSkillSource` throws for a source tree that holds
  a symlink, for every source kind (path, npm, vendored, workspace, url). An absent or unreadable
  source tree is a classified `FsFaultError`.
- `openForReading` (`@vibe-agent-toolkit/utils/fs`): open a file for reading without ever blocking on
  it — a named pipe, socket or device is refused (`EFTYPE`).

- **`locateSkillSource(source, repoRoot)` (`@vibe-agent-toolkit/agent-skills`)** finds a `{ path }`
  or `{ npm }` skill source on disk without staging it. It throws `ASSET_REFERENCE_UNRESOLVED` when
  the source names nothing installed, and `SKILL_SOURCE_SPEC_INVALID` (now also thrown by
  `resolveSkillSource`) for an npm spec with no version pin.

- **`ASSET_REFERENCE_UNREADABLE_CODE` (`@vibe-agent-toolkit/utils`).** `resolveAssetReference`
  now throws it when a bare specifier's package is installed but Node cannot read it: a malformed
  or unreadable `package.json`, or an invalid `exports` map. `ASSET_REFERENCE_UNRESOLVED` is now
  only for a specifier that names nothing Node can reach.

- `@vibe-agent-toolkit/utils`: `isCapacityFault({ faultClass })`, `isTimedOutError(error)`, and
  `FsBoundary.classify(error, action, fallback)` for a catch that already holds the error.

- `@vibe-agent-toolkit/utils`: `FS_FAULT_ERRNOS_BY_CLASS`, the classifier's own table (class to
  errnos), for anything that must list them the same on every host.

- `@vibe-agent-toolkit/utils`: `writeFileUnder(root, relative, contents, { existing, writing })` and
  `makeDirectoryUnder(root, relative, writing)` — how VAT writes a file, or makes a directory, in a
  tree it copied with links kept: every directory component must be a real directory, the file is
  created exclusively, and a link (or, for `existing: 'refuse'`, anything) in the way is a `source`
  fault naming it. `copyRegularFile` makes its copy the same way, through the same code.
- `@vibe-agent-toolkit/utils`: `requireTestScratch(root, what)` and `TEST_USER_STATE_UNDER`. A test
  process that sets `VAT_TEST_USER_STATE_UNDER` to its temp tree gets an error, instead of a path,
  from every VAT resolver of user state that lands outside it: the Claude directory, a user-scope
  skills directory of any target, `FileSessionStore`'s default `~/.vat-sessions`. Unset — as it is
  for every user — nothing changes.

- `@vibe-agent-toolkit/utils`: `proveTreeReadable`, `copyTree` and `readRegularFile`, one walk with
  one link policy (`follow-contained` or `preserve`) and one special-file policy, so the proof a
  verb runs before writing and the copy it then makes cannot disagree. `copyTree` gives each
  directory its source's mode with the owner's `rwx` kept, so a read-only source never becomes a
  copy nothing can remove.

- `@vibe-agent-toolkit/utils`: `requireConfirmedAbsent(entry, absentError, ctx)` — a probe's "nothing there"
  is believed only when the parent's listing agrees.

- **`@vibe-agent-toolkit/utils`:**
  - `disposeTempDirAfterFailure(dir, failure)` disposes of a temp directory handed back on
    success and removed only when the work failed. It records a disposal fault beside the
    failure (`suppressedFaultsOf`), never thrown in its place.
  - `recordSuppressedFault(error, fault)`.
  - On the `./testing` subpath: `scratchTmpdirEnv()` / `registerScratchTmpdir()` make a scratch
    directory THE temp directory for one test, spawned children included.
  - A temp-directory disposal fault's message now names the directory itself as well as the
    entry the OS refused.
- **`@vibe-agent-toolkit/schema`: `withAddedFindings(report, findings)`**: the same report with
  findings appended, its status and summary derived again.

### Changed

- **On Windows, a filesystem refusal names its path with forward slashes** — in the message and in
  `FsFaultError.path` — as every other path VAT prints. A refusal built from the OS's own error
  carried the backslash spelling there, one built from VAT's own path the forward one.

- **For adopters on a `0.2.0-rc` build: library API that changed between release candidates.** None
  of it was in 0.1.42, so none of it breaks an upgrade from a stable release.
  - `@vibe-agent-toolkit/utils` `copyTree` requires `onto`: `'fresh'` for a new destination —
    anything already at a name it creates is `EEXIST`, never adopted or written through — or
    `'merge'` for an output directory written again (a file or link there is replaced, a real
    directory adopted). Two source entries that are one name at the destination (letter case,
    Unicode form) are refused as a `source` fault naming both.
  - `@vibe-agent-toolkit/claude-marketplace`: `planPackageInstall` requires `force`;
    `uninstallPlugins` / `planPluginUninstall` require `authority` (`{ kind: 'marker' }`,
    `{ kind: 'package', name }` or `{ kind: 'force' }`); `UninstallPluginResult` gains `notVats`.
  - `@vibe-agent-toolkit/utils/testing` no longer exports the fault harness's op table (`OPS`,
    `OpSpec`, `PathShape`); the rest of its vocabulary is exported by name. `untracedFs` is new, and
    a `FaultRule` takes `everyTry` (fail every immediate repeat of the call it failed — what a retry
    is), so a test refusing a rename asks the same thing under win32, where a rename is retried.
  - An rc's `vat claude plugin install` wrote its `.vat-marketplace` marker into the staged copy of
    the package's marketplace with a plain write. A package shipping a link of that name aimed the
    write at any file the user could write (`../../../settings.json`). The marker, and every file
    VAT composes into a tree copied with its links kept (`marketplace.json`, `plugin.json`, a
    publish tree's `README.md` / `LICENSE` / `CHANGELOG.md`), is now created exclusively and never
    through a link (`writeFileUnder`); such a package is refused `INPUT_UNREADABLE` naming the
    entry, nothing installed. 0.1.42 wrote no marker. (The files a plugin build COPIES into such a
    tree are made the same way — see Security.)
  - `@vibe-agent-toolkit/utils` `copyRegularFile(source, root, relative, { side, reading, existing,
    writing })` replaces `copyRegularFile(source, dest, { side, reading })`: the copy goes to
    `relative` under `root` as `writeFileUnder` writes a file (it is the same primitive) — real
    directories only, made when absent; an exclusive create; bytes and mode set on that handle.
    `existing: 'replace'` removes a regular file there first; a link or a directory in the way is a
    `source` fault (`occupied`) naming it. It no longer needs its directory made first, and no
    longer overwrites through whatever is at `dest`.
  - `@vibe-agent-toolkit/utils` `copyTree(source, root, relative, options)` replaces
    `copyTree(source, dest, options)`. `root` is a directory the caller made or its user named: an
    absent one is made with its parents, a real directory adopted, and a symbolic link (or a file)
    standing AT it is `EEXIST`, raw, under `fresh` and `merge` alike. What is above `root` is the
    caller's and is followed as before — nothing there is examined. `relative` (`''` for a copy
    onto `root` itself) is where under `root` the copy goes: every directory between the two must
    be a real one (made when absent), and a link or a file there is a `source` fault (`occupied`)
    naming it. A copy into a tree that already holds copied content names that tree's root.
  - Errno-only codes are gone, each replaced by the one classified fault (`FS_FAULT`):
    `SKILL_PACKAGING_OUTPUT_FAILED_CODE`, `HarnessOutputError` (`HARNESS_OUTPUT_UNWRITABLE`),
    `AGENT_SOURCE_UNREADABLE_CODE`, `COPY_SOURCE_NOT_REGULAR_CODE`, `CLAUDE_USER_STATE_WRITE_FAILED_CODE`,
    `PLUGIN_SOURCE_UNREADABLE_CODE`, `DIRECTORY_LISTING_REFUSED_CODE` (a `DirectoryListingRefusedError`
    is coded `FS_FAULT` and carries its fault as `cause`), `RAG_DATABASE_NOT_REMOVABLE_CODE` and
    `PLUGIN_INSTALL_CLEANUP_INCOMPLETE` (now the `TREE_CLEANUP_INCOMPLETE` warning). What remains means
    content only: `SKILL_SOURCE_UNREADABLE` a refused symlink, `CLAUDE_USER_STATE_UNREADABLE` a registry
    or settings file that is not JSON (or the wrong shape), `AGENT_MANIFEST_UNREADABLE` a manifest that is
    not YAML.
  - `SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE`, `checkPackageOutput`, `PackageOutputCheck` and
    `PackageSkillOptions.sourceGeneratedInOutput` are gone: an occupied output is `TREE_DEST_NOT_OWNED`.
  - `@vibe-agent-toolkit/utils`: `isFilesystemAccessError` → `fsFaultOf(e) !== undefined`;
    `openEachFileForReading` → `proveTreeReadable(root, { links, filter?, side })`; `copyTree` and a
    `copy` fill (`TreeFill`) take a required `side`; `new FollowedWalk(side)` takes the side its tree
    is on, and a directory it cannot resolve is an `FsFaultError` there; `requireConfirmedAbsent` takes
    `{ follows }`; `TreeRollbackIncompleteError` (with `stranded`) and `TreeRollbackStranded` are
    exported; `withTempDir()` returns `TempDirOutcome { value, leftover }` and no longer throws when
    only the disposal failed, and `disposeTempDir()` answers the leftover fault (or `undefined`), not
    a message string; a `{ refuse }` listing policy's `side` (`RefuseListingContext`) is required;
    `fsBoundary` and its `FsBoundary` / `FsRoots` types live in their own module (barrel names
    unchanged).
  - `@vibe-agent-toolkit/utils/crawl` and `@vibe-agent-toolkit/resources`: the crawl's `baseSide` and
    `ListingSides` are replaced by the required `outputs` — `settleCrawlRefusal(policy, refusal, outputs)`,
    `crawlSourceFor(root, outputs)`, the `FilesystemCrawlSource` / `GitCrawlSource` constructors,
    `buildResourcePopulation({ root, outputs })`, `ResourcePopulationSource.enumerate(root, outputs)`;
    the `FilesystemExtentContributor` `sourceFor` argument is required; `projectRootSide` and
    `detectPackagedAgentInstructionFiles`'s `rootSide` are gone.
  - `@vibe-agent-toolkit/claude-marketplace`: `codedUserStateWrite` → `writeUserState(action, mutate)`;
    `requirePluginSource` → `proveTreeReadable(dir, { links: 'preserve', side })`; `replaceDirectory`,
    `replaceDirectoryWith`, `planPluginInstall`, `PluginRegistryPlan` are gone (the install is
    `planPackageInstall`); `isStagedReplaceLeftover` → `isTreeChangeResidue` from `@vibe-agent-toolkit/utils`;
    a tree plan's `PlannedChange` gains `unexaminedSibling`.
  - `@vibe-agent-toolkit/rag-lancedb`: `foreignDatabaseEntries(dbPath, entries)` takes the directory
    first and a typed listing (`readdirSync(dir, { withFileTypes: true })`, the `DatabaseDirectoryEntry`
    shape); `removeRagDatabase` is async and returns `RagDatabaseRemoval` (`{ leftover? }`).
- **Help `Exit Codes:` blocks now state what the code does.** `vat claude context` no longer
  promises exit 1 for an unknown option or unsupported `--format` (Commander rejects those at 2,
  with no document); `vat agent run` documents 0 or 2 (it never exits 1); `vat corpus scan` no
  longer advertises exit 130 (VAT installs no SIGINT handler there).

- **`version:` in `vibe-agent-toolkit.config.yaml` is now an unrecognized key, like any other.**
  The config still loads: `version: 1` (or any value) draws a warning naming the key and the file,
  and the key is dropped (was accepted silently and ignored). Delete the `version:` line. The npm
  package version is the only version VAT has.

- **A skill build whose output cannot be written ends `RUN_INCOMPLETE`, exit 2** — a full disk, a
  read-only or unwritable output directory, a file in the way of the output path, a previous output
  it cannot move aside — in `vat skills build`, `vat skills package`, `vat build`,
  `vat claude plugin build`, `vat agent build` and `vat skill test run`. It is never a
  `SKILL_PACKAGING_FAILED` finding (that is reserved for the skill's own content) and never
  `INTERNAL_ERROR`: `vat agent build`'s own writes, `vat claude plugin build`'s marketplace-tree
  writes and removal, and `vat skills package`'s output removal were uncoded, and a file in the way
  of `vat skills package --output` was published as a `SKILL_PACKAGING_FAILED` finding at the skill,
  exit 1. Every copy `vat claude plugin build` makes into the marketplace tree — the marketplace
  `LICENSE` / `README.md` / `CHANGELOG.md`, plugin trees, plugin `files[]` entries, pool skills from
  `dist/skills`, a plugin's `CHANGELOG.md` — reads its source first: a source the OS will not read is
  `INPUT_UNREADABLE` naming it (a file in `dist/skills` too — rebuild it), and a write the OS
  refuses is `RUN_INCOMPLETE` (both were `INTERNAL_ERROR`). Known gap: a disk so full that the git
  snapshot of the project fails before anything is written still ends `INTERNAL_ERROR`, "git did
  not answer …", in every verb that crawls through the snapshot.
- **A ZIP, npm `package.json` or marketplace manifest `vat skills package` cannot write is
  `RUN_INCOMPLETE`, exit 2** (the ZIP was reported as written, `ZIP: <name>` and exit 0, with no
  archive on disk; the two manifests were `INTERNAL_ERROR`). Nothing of the package lands, so the
  next run does not refuse a partial file as a previous package, and the refusal names the file
  forward-slashed and relative to the project.
- **One file the OS will not read, anywhere in a git repository, is `INPUT_UNREADABLE` naming that
  file** in `vat skills build`, `vat skills validate`, `vat resources validate`,
  `vat claude context` and the other verbs that crawl through the git snapshot (and so in a
  `vat validate` / `vat build` phase) — was `INTERNAL_ERROR`, "it is not a git repository", about a
  directory that is one. The snapshot reads every file git does not ignore: fix the permissions, or
  ignore the path. `@vibe-agent-toolkit/utils/git` exports `unreadableSnapshotRefusal` and
  `GIT_SNAPSHOT_UNREADABLE_CODE`.
- **A bundled markdown file the pre-build validation cannot read is a `LINK_TARGET_UNREADABLE`
  error finding at that file** (exit 1) in `vat skills build` and `vat skills validate` (and so their
  `vat build` / `vat validate` phases) — was an uncoded `INTERNAL_ERROR` outside git, while the same
  unreadable file with a non-markdown extension was already the skill's finding.
  `vat skills package` runs no such validation: there it is a `SKILL_PACKAGING_FAILED` finding.
- **`vat skills build` promotes `dist/skills` with the ordinary directory mode** (was `0700`, from
  its temporary staging root, unreadable to group and other), and a refusal after discovery reports
  the skills it found in `examined` (was `0`), each row `status: not-built` (new; was `ok`, beside
  an output path that did not exist — a dry run's rows read `not-built` too). A refusal during
  validation (a git snapshot naming an unreadable file) no longer leaves a staging directory
  behind, and the previous `dist/skills` is untouched.
- **`files:` `integrity: true` codes each read by the tree it touched**: a dest the OS will not read
  is the output's (`RUN_INCOMPLETE`), a source the skill's (`SKILL_PACKAGING_FAILED`); a dest-set
  listing it cannot read was uncoded.
- **The library plugin install (`@vibe-agent-toolkit/claude-marketplace`) refuses a plugin source
  any file of which it cannot read** — anywhere in the tree, not only its top level — with a
  classified filesystem fault (`FS_FAULT`, on the side the caller declares for the source) naming
  that file, before creating anything (a nested one was reported as a failed write naming the
  `~/.claude` destination).
- **A failed plugin re-install keeps the previous plugin cache** (`vat claude plugin install`): the new copy is staged beside it and swapped in only once whole,
  where the cache the registry points at used to be deleted first. A previous tree the OS will not
  let it remove once replaced no longer fails the install — the registry and settings are still
  written, and the leftover is reported as a `TREE_CLEANUP_INCOMPLETE` warning finding linking
  the leftover (never overridable; it reached stderr only). Staged and parked trees are dot-named, and
  `vat inventory --user` no longer reads a dot-named directory under a plugin's cache as an
  installed version. The cached version directory takes the plugin's own mode (it was `0700`) —
  applied after the copy, so a read-only plugin directory installs (applying it first aborted the
  process, exit 134, with a read-only staging directory left in `~/.claude`) — and a dangling link
  at its path is replaced instead of failing the install.
- **A RAG database whose table files are damaged is `INPUT_UNREADABLE`** in `vat rag stats` and
  `vat rag query` (was `INTERNAL_ERROR`) — a table manifest that will not open, or data files that
  fail on the first read behind an intact manifest — and **`vat rag clear` removes it**: `clear` no
  longer opens the database it removes, so the documented remedy works. `LanceDBRAGProvider` throws
  a `VatError` coded `RAG_DATABASE_UNREADABLE` (`RAG_DATABASE_UNREADABLE_CODE`, from
  `@vibe-agent-toolkit/utils`) for every failed read of the chunk table.
- **`vat rag index` codes where its database cannot go**: a `--db` that is, or lies under, a file is
  `USAGE_INVALID`; a project `.rag-db` that is a file is `INPUT_UNREADABLE`; a database directory
  it cannot create or write (a read-only parent) is `RUN_INCOMPLETE` — all were `INTERNAL_ERROR`
  from LanceDB.
- **`vat corpus scan` declares `[seed-file]` once**: it registered it twice, so a second operand
  was silently ignored, exit 0, and `--help` printed `[seed-file] [seed-file]`.

- **`resolveAssetReference` (`@vibe-agent-toolkit/utils`) throws a `VatError` coded
  `ASSET_REFERENCE_UNRESOLVED`** when a bare specifier does not resolve. Node's error is kept as
  `cause`. Callers can now classify the failure by code instead of by message.

- **A crawl base that vanishes now refuses instead of reading as empty.** When the directory a
  crawl starts from disappears between the check that it exists and its listing (`ENOENT` or
  `ENOTDIR`), the crawl throws a classified `FsFaultError` on the side its caller's `outputs`
  give the base: `source` for a tree the verb only reads, `destination` for a project the verb
  writes its output into — so the packaging verbs refuse a vanished project `RUN_INCOMPLETE`, and
  `vat skills validate` refuses it `INPUT_UNREADABLE`. It used to return an empty population and
  exit 0, so `vat skills package` could ship a skill without its bundled reference, and
  `vat build` could produce an empty `dist/skills`. A subdirectory that vanishes mid-walk is
  still skipped.
- **Raw filesystem errors on crawl and markdown reads are now classified refusals, not
  `INTERNAL_ERROR`.** A crawl base the OS will not `stat`, and a markdown document
  (`parseFileCached`) the OS will not read, refuse by the fault table:
  - `INPUT_UNREADABLE` for an input;
  - `RUN_INCOMPLETE` for VAT's own output re-read after a build, or for a machine out of files,
    disk or quota.

  `parseFileCached`'s third parameter is now an options object, `{ cache?, side? }`.
- **The set of directory-listing refusals treated as transient changed.** "Transient" means the
  refusal is not memoized and the finding says "re-run first". The set is now `EMFILE`, `ENFILE`,
  `EAGAIN`, `EBUSY` and `ETXTBSY`, where it used to be `EMFILE`, `ENFILE` and `EAGAIN`. A full
  disk or quota (`ENOSPC`, `EDQUOT`) is not transient: re-running frees no space.
- **The resource registry records a special file as unreadable.** A named pipe, socket or device
  enumerated as a resource (`EFTYPE`) is now a `RESOURCE_UNREADABLE` finding instead of an aborted
  run.
- **The registry no longer files a machine-wide shortage as a per-file finding.** Descriptor,
  disk or quota exhaustion while reading a resource (`EMFILE`, `ENFILE`, `ENOSPC`, `EDQUOT`) now
  refuses the run `RUN_INCOMPLETE`. As a per-file finding, config could have downgraded it to
  exit 0.

- **A bundle layout the skill's `files:` makes impossible (one dest on or under another's file) is
  the `SKILL_PACKAGING_FAILED` finding; a refused, vanished or full output stays `RUN_INCOMPLETE`.**
  A source the machine could not read for want of disk or file descriptors is now `RUN_INCOMPLETE`,
  never that finding.
- **`vat agent build` and `vat skill test run` publish a source fault inside the packager as the
  `SKILL_PACKAGING_FAILED` finding**, as the other packaging lanes do; the finding's message now
  ends with the remedy for the fault.

- **Every CLI filesystem refusal is decided by the one table** (`docs/validation-codes.md`, "Filesystem
  faults: which refusal"). Visible differences: a disk or descriptor shortage while reading an input
  is `RUN_INCOMPLETE`; a refused write into an archive's staging directory, a refused stat of a
  `vat skills build` previous `dist/skills`, a refused probe of the install `vat agent uninstall`
  removes, and a `vat rag index` / `vat rag clear` database the OS will not examine or list are
  `RUN_INCOMPLETE` (they were `INPUT_UNREADABLE`); so are a `vat cache clear` cache the OS will not
  list or measure (the cache is VAT's own scratch) and a `vat skills install` target whose existence the
  OS will not let VAT check (it is what the install writes); a directory a listing could not open is
  refused on the side of the tree being listed.
- `vat claude plugin install <dir>` of a package with a plugin tree but no readable `package.json`
  is `INPUT_UNREADABLE` (the package's content), naming the errno; it was `USAGE_INVALID`
  "Path does not exist".
- `vat audit settings` / `vat audit --compat` read a settings file the OS refuses as a classified
  fault on the config (`INPUT_UNREADABLE`, or `RUN_INCOMPLETE` for a machine that ran out), and a
  settings path whose name is too long for the host (`ENAMETOOLONG`) is reported `undetermined`,
  never skipped as absent.


- **The fix text of a `TREE_CLEANUP_INCOMPLETE` warning from `vat claude plugin install` now reads "…;
  nothing VAT made uses it."** (was "…; the installed plugin does not use it."): every verb names a
  leftover with the one sentence.

### Security

- **A git source whose repository commits a symbolic link out of the clone is refused.** The
  `#ref:subpath` containment check was lexical, so a committed `skills -> /somewhere/outside`
  passed and `vat audit <git-url>` / a git `url:` skill source read files on the operator's machine
  as the repository's. `cloneGitSource` now judges the subpath on real paths (`GIT_SUBPATH_INVALID`,
  `USAGE_INVALID`) and refuses any link in the selected subtree — followed through inside links,
  dangling ones included — whose target resolves outside the clone (`COPY_LINK_ESCAPES_SOURCE`,
  `INPUT_UNREADABLE`, exit 2). Links that stay inside the clone are still followed.

- **A plugin build never writes through a link it copied into the plugin.** A pool skill is copied
  out of `dist/skills` with its links kept as links. Two later writes of `vat claude plugin build`
  (and `vat build`) followed such a link out of the build output: a plugin `files[]` entry whose
  `dest` named the link (or a path through it) overwrote the file it pointed at and took its mode,
  or created files in the directory it pointed at; and a pool skill sent to a nested directory
  (`skills/<group>/<skill>` or deeper, when it wins over a plugin-local skill of its name) was
  written into whatever a link an earlier pool skill left at that name, or at any directory above
  it, pointed at. It needed a `dist/skills` that VAT's own packager did not write — links placed
  there by hand or by another tool. Both are now refused, exit 2, with nothing written outside the
  build and the previous marketplace left as it was: the `files[]` entry as `CONFIG_INVALID` (its
  `dest` is inside `skills/`), the nested copy as `INPUT_UNREADABLE` naming the link. Every file
  and every skill the build copies into a plugin is now placed from the plugin's own directory
  down, through real directories only, each file created exclusively.

- **Advisories cleared from the dependency tree via root `overrides`:** `smol-toml` 1.8.0 → 1.9.0,
  `sharp` 0.35.4 → 0.35.5, and new pins `proxy-addr` 2.0.8, `source-map-js` 1.2.2 and
  `@modelcontextprotocol/sdk` 1.31.0. No action needed.

### Fixed

- **A copied tree can no longer write outside its destination.** Installing a skill, an agent or a
  plugin whose source holds two entries that are one name on the destination filesystem (`NOTES`
  and `notes` from a case-sensitive volume onto macOS or Windows), the first a link, wrote the
  second THROUGH the link — overwriting a file outside the install, exit 0. Such a source is now
  refused (`INPUT_UNREADABLE`, naming both entries) with nothing installed.
- **A source reached through a link is recognised as inside (or holding) its destination.** With
  `~/.claude/skills` a link into the skill's own source, `vat skills install` copied into itself
  until the path was too long; it is now `USAGE_INVALID` before anything is written.
- **`--force` over a `--dev` link works.** `vat skills install … --force` and `vat agent install
  <name> --force` refused when the installed entry was a link to the very build being installed
  ("replacing it would delete it" — it would only replace the link).
- **A destination that changes while VAT stages is left alone.** A file that appeared where an output
  was to be created, or in the empty directory an output was to replace, used to be overwritten or
  deleted; the run now stops (`RUN_INCOMPLETE`) with that entry as found.
- **`vat claude plugin install` and `uninstall` no longer overwrite a registry file another program
  wrote meanwhile.** `installed_plugins.json`, `known_marketplaces.json` and `settings.json` were
  rewritten from what was read before the copy; an install running beside it, or Claude Code saving
  settings, lost its change. The run now stops (`RUN_INCOMPLETE`, "changed by another program …
  re-run") with nothing installed or removed.
- **`vat claude plugin install` no longer installs a build leftover as a marketplace**, and
  `vat skills list` and `vat claude plugin list` no longer list one as a skill
  (`.<name>.vat-staged-*`, what an interrupted build leaves beside its output).
- **`vat claude plugin install` reports a malformed `package.json` as `INPUT_UNREADABLE`** naming the
  field — `vat.skills` naming a skill twice or not a list, a `version` or `name` that is not a string
  — and a `.tgz` with no `package.json` as the archive's (it was blamed on VAT's scratch space).
  The first two were `INTERNAL_ERROR`.
- **`vat skill test run` keeps stdout for its report.** A `test.build` hook's output went to stdout
  ahead of the YAML document; it now goes to stderr.
- **`vat skill test configure` cannot truncate the project config.** It rewrote
  `vibe-agent-toolkit.config.yaml` in place; a full disk or an interruption left it empty. The file
  is now replaced whole or not at all.
- **A full or read-only temp directory is reported as that** (`RUN_INCOMPLETE`) by `vat audit
  <git-url>` and `vat claude marketplace publish` (was `INTERNAL_ERROR`), and by `vat skill test run`
  while it stages eval inputs (was "Eval input error", `INPUT_UNREADABLE`).


- **`vat skill test run` reports a `workspace:` companion the packager refuses as the
  `SKILL_PACKAGING_FAILED` finding, `RUN_INCOMPLETE`** — a broken link in that skill, a `files:`
  source that does not exist. It was `INTERNAL_ERROR` with no finding, as if VAT had crashed.
- **A temporary directory left behind on a failing path is still named.** `vat skill test run` keeps
  the leftovers of the companions it had already staged when a later one fails, and of a skipped
  `--with-optional` companion; `vat corpus scan` keeps the clone of a URL entry whose audit was
  refused; an interrupted `vat audit <git-url>` names a clone it could not remove on stderr. Each
  used to vanish without a word.
- **`vat claude marketplace validate` names the errno of a `SKILL.md` it could not examine**
  (`read refused with EACCES`); the warning could read `FS_FAULT`.
- **`vat agent install`, `uninstall` and `installed` resolve their scopes when they run, through the
  same Claude-user-paths resolver every other verb uses.** The `user` scope now honours
  `CLAUDE_CONFIG_DIR` (it read `~/.claude/skills` regardless), and the `project` scope honours
  `--cwd` (it was fixed to the launch directory, so `vat --cwd ../proj agent uninstall x --scope
  project` removed from the wrong tree). A skill installed to the user scope is now visible to
  `vat skills list --user`.
- **`vat audit settings` reads the user settings layer from `$CLAUDE_CONFIG_DIR/settings.json`**
  when the variable is set, the same file `--show-paths` names. It read `~/.claude/settings.json`
  regardless, so a relocated config was audited as the wrong file or as nothing readable.

- **`vat resources validate --format` and `--validation-mode` refuse a value they do not offer**
  (exit 2, naming the accepted values). `--format bogus` used to write YAML and
  `--validation-mode bogus` ran strict, both at exit 0.
- **`vat mcp serve <package> --print-config` resolves the package first.** A package that does not
  load now fails as it does without the flag (exit 2, nothing on stdout); it used to print a
  paste-ready config for a server that could not start, at exit 0.

- **`vat corpus scan` no longer swallows a VAT defect into an `unloadable` row.** An uncoded
  throw inside an entry's audit (a validator `TypeError`) used to become a
  `CORPUS_ENTRY_INCOMPLETE` warning, and the scan exited 0; it now ends the scan as
  `INTERNAL_ERROR`, exit 2, in both the local and the URL lane. A coded refusal (a missing or
  unreadable source, a failed clone) is still that entry's `unloadable` row.

- **`vat claude plugin install <file>.zip` over a file that is not a ZIP archive is
  `INPUT_UNREADABLE`**, exit 2, naming the file (was `INTERNAL_ERROR`). The archive is opened before
  anything is replaced, so `--force` no longer removes the existing skill first.
- **A plugin re-install replaces its marketplace copy** (`~/.claude/plugins/marketplaces/<mp>/plugins/<name>`)
  the way it already replaced the cache copy: a file the plugin dropped no longer survives there. A
  previous marketplace tree the install could not remove is reported like a cache one
  (`TREE_CLEANUP_INCOMPLETE`).
- **A `--dry-run` uninstall of a plugin directory no registry recorded** says the directory would
  be removed, not that it is "cleaning up".

- **A `vat skills build` whose cleanup failed after it promoted its output names the real
  reason.** The parked previous `dist/skills` left on disk was reported as "the promotion target is
  already occupied" when the target held this run's own output and the real failure was removing
  the parked copy (for example `EACCES`). The residue line now carries that refusal.
- **A packager defect whose staging repair also failed reports the recovery in the document.** When
  `vat skills build` stops on a VAT defect and cannot restore the previous `dist/skills`, the
  refusal's `error.message` now names where the previous output is parked and the `mv` that
  recovers it, under the defect's own code. It used to reach stderr only.
- **`SKILL_PACKAGING_FAILED`'s fix text names the verb to re-run.** `vat skills package` and
  `vat skill test run` told the operator to "rebuild"; they now say to re-run themselves. The build
  lanes still say rebuild.

- **A `plugin.json`, `marketplace.json` or registry file the operating system will not read is
  `SCAN_PATH_UNREADABLE`** (warning, naming the errno), no longer `*_INVALID_JSON` with "fix the JSON
  syntax". A manifest under a directory that refuses access is no longer reported as missing.
- **`@vibe-agent-toolkit/discovery` `scan()` reports a root it may not examine as "Path cannot be
  read (EACCES)"**, carrying the OS error as `cause`, instead of "Path does not exist".
- **`vat agent validate` no longer puts absolute paths in finding messages**: a missing RAG
  database is shown as `.rag-db`, and `AGENT_REFERENCE_UNREADABLE` names the errno instead of the
  OS message (which spelled the absolute path).

- **`vat rag index` refuses a database directory that holds anything but a RAG database**, as
  `stats`, `query` and `clear` already did. It used to hand any writable directory to LanceDB, so
  `vat rag index --db .` wrote `rag_chunks.lance` and `rag_documents.lance` into the project root.
  A `--db` holding foreign entries is now `USAGE_INVALID` naming the path and its entries; the
  project's own `.rag-db` holding them is `INPUT_UNREADABLE`. Nothing is indexed either way. An
  empty directory, an existing RAG database, a directory holding only operating-system litter
  (`.DS_Store`, `Thumbs.db`) and a path that does not exist yet are still indexed into.
- **`getStats()` (and so `vat rag stats`) reads only the `resourceid` column to count resources.**
  It used to read every chunk row in full — text and embedding vector — and copy it through JSON
  only to count distinct resource ids.

- **`vat claude plugin build` prints a config's unknown-key warning once.** The verb parsed the
  config twice, through two loaders, and each printed the warning. `vat claude marketplace publish`
  now reads the config through the same loader.
- **The `skill test configure` examples no longer pass `--require-auth`.** `configure` has no
  such option, so the documented command failed with Commander's unknown-option error. The docs
  now say to set `requireAuth` under the skill's `test:` block by hand, or to pass
  `--require-auth` to each `run`.

- **A skill's `SKILL.md` that cannot be written into the bundle is named as the entry file**, not
  as a "linked file": an unwritable `--output` read "linked file skills/clean/SKILL.md, but it could
  not be written into the bundle", sending the author to look for a link that does not exist.
- **Packaging and `vat agent build` prove a source readable by opening it**, no longer by
  `access(R_OK)`, which Node documents ignores ACLs on Windows. An ACL-denied source is now the
  skill's or agent's unreadable input (`SKILL_PACKAGING_FAILED` / `INPUT_UNREADABLE`); it
  used to pass the check and fail inside the copy, as an unfinished run with a write remedy in the
  packager and as `INTERNAL_ERROR` in the agent builder.

- **A path with no relative spelling (on Windows, another drive than its root) no longer kills the
  document.** `vat agent validate` with a manifest on another drive than the working directory
  refuses `USAGE_INVALID` (it died on its own document, printing nothing); a `vat okf validate`
  finding in a bundle on another drive than the project, and a `vat skills build` packaging
  finding for a skill on another drive than the working directory, omit `location` (the OKF one
  names the document in its message).

- **`vat claude plugin install` uninstalled the plugins a package's `vat.replaces.plugins` names
  before it refused a bad `vat.replaces.flatSkills` entry.** A flat-skill entry that is not one path
  segment (`../victim`) is now refused with the package's other names, before anything under
  `~/.claude` changes (`INPUT_UNREADABLE`, "nothing was changed"); the old plugin stays installed.
- **`vat claude plugin install <zip> --force` removed the existing skill, then failed on a corrupt
  entry as `INTERNAL_ERROR`.** Every entry of the archive is now inflated and CRC-checked before the
  skill it replaces is touched; one that does not inflate is `INPUT_UNREADABLE`, as the help says,
  and the existing skill is kept.
- **A re-install whose marketplace copy the OS refused left the installed marketplace
  half-deleted** (its `marketplace.json` gone, the plugin still registered). The marketplace copy is
  now staged beside the installed one and swapped in only once whole, like the plugin cache. A
  previous marketplace tree the OS will not let it remove is reported as
  `TREE_CLEANUP_INCOMPLETE` (warning, linking the leftover) and left as
  `.<marketplace>.vat-staged-*.previous`, which `vat inventory --user` does not read as a marketplace.
- **`vat claude marketplace validate` and `vat verify` passed (exit 0) a plugin whose `plugin.json`
  the OS would not read.** The `SCAN_PATH_UNREADABLE` warning stays, and the run now also fails as
  `RESOURCE_CHECK_BROKEN` (error, exit 1) naming the manifest; the plugin's row is
  `manifestRead: false`. `vat audit` is unchanged (warning only).

- **`vat rag clear` no longer deletes a directory whose litter-named entries are the user's.** A
  `._notes/` directory (or a `.DS_Store` symbolic link) beside a database counted as Finder litter,
  so `vat rag clear --db <dir>` removed the whole tree and reported `cleared: true`. Litter is now a
  regular file only; anything else with a litter name makes the directory not a database, and
  every `vat rag` verb refuses it (`USAGE_INVALID` for `--db`, `INPUT_UNREADABLE` for the project's
  `.rag-db`), removing nothing.
- **`vat rag index` into a database whose table files are damaged is `INPUT_UNREADABLE`, exit 2**,
  naming `vat rag clear` as the remedy, as `stats` and `query` already were. It reported one
  `RAG_DOCUMENT_INDEX_FAILED` finding per file carrying LanceDB's raw IO message (exit 1), blaming
  the files for the store's failure.
- **`vat skills package` with an `--output` under a directory the OS will not let VAT examine** is
  `RUN_INCOMPLETE`, exit 2, naming the errno, in the dry run and the real run, `--force` or not: VAT
  cannot tell whether that output holds the source. It was `INTERNAL_ERROR` with a raw `EACCES`.
- **`vat skill test run --with name=path:<dir>` with a file or directory in the companion the OS
  will not read** is `INPUT_UNREADABLE`, naming the path (`Reason: preflight`). It was
  `INTERNAL_ERROR` with a raw `EACCES`. A `path:` source that does not exist is refused the same way.
- **`vat skills build` names the parked previous `dist/skills` in the published refusal when the
  build itself throws** (a git snapshot refusing an unreadable file, say) and the restore of that
  output also fails. The recovery path went to stderr only; the packager-defect lane already put it
  in the document, and both now share one path.
- **A git source whose subpath is itself a dangling symbolic link** (`#ref:skills/x` where
  `skills/x` points at nothing) is refused as the subpath, `USAGE_INVALID`: "escapes the cloned
  repository" when the link aims outside the clone, "not found" when it aims inside. It was a raw
  `ENOENT … scandir` coded `INPUT_UNREADABLE`.
- **`vat agent install|uninstall|installed --runtime constructor`** (or any other
  `Object.prototype` key) is `USAGE_INVALID`, as every other unknown runtime is. It was
  `INTERNAL_ERROR` on install and uninstall, and a "defect in VAT" exit 1 on `installed`.
- **`vat agent build` no longer hangs on a named pipe under `scripts/`.** A pipe, socket or device
  (or a link to one) under `scripts/` is refused unopened as an unreadable agent source,
  `INPUT_UNREADABLE`, naming it; opening a pipe for reading blocked forever waiting for a writer.

- **`--help` and the reference docs now name every exit-2 cause these verbs have.**
  - `vat audit --help` lists the `--settings` refusals. `--settings` without `--compat`, with
    `--user`, or naming a file that does not exist is `USAGE_INVALID`. A settings file the OS
    refuses, or one that does not parse or fails the schema, is `INPUT_UNREADABLE`.
  - `vat resources validate --help` says that a `--format` or `--validation-mode` value outside
    its choices exits 2 with Commander's message on stderr and no document.
  - `vat corpus scan --help` and `docs/validation-codes.md` say that an uncoded failure inside
    one entry's audit is a defect in VAT. It ends the whole scan as `INTERNAL_ERROR` (exit 2) and
    does not become a `CORPUS_ENTRY_INCOMPLETE` warning row.
  - The `vat rag index` reference names its refusal of a database directory that holds anything
    but a RAG database.
- **The `vat-enterprise-org` skill said `claude org skills install --from-npm` exits 1 when any
  skill fails.** It exits 2, as the skill's own exit-code table and the verb's `--help` already
  said. The prose is corrected.
- **The `skills build` reference has a dry-run example.** It shows rows with `status: not-built`.

- **`vat claude plugin install` never checked the shape of a package's `vat.replaces`.** A string
  `flatSkills` or a non-string entry crashed as `INTERNAL_ERROR`, and a string `plugins` was walked
  letter by letter, each letter uninstalled as a plugin name. `vat.replaces` must now be
  `{ plugins?: string[], flatSkills?: string[] }` (unknown keys refused too); anything else is
  `INPUT_UNREADABLE`, naming the package and the field, before anything under `~/.claude` changes.
- **`vat claude plugin install` removed what `vat.replaces` names before installing the new plugin,
  so a failed install left the user with neither.** The replaced plugins and legacy flat skills are
  now removed only after the new marketplace is copied and registered. Every check runs first: a
  legacy flat skill the OS will not let it examine, or a package file the copy could not read, is
  `INPUT_UNREADABLE` with nothing changed. A legacy flat skill the OS will not let it remove, once
  the new plugin is in place, is `RUN_INCOMPLETE` naming it (was `INTERNAL_ERROR`). A replaced plugin
  the package itself ships into that marketplace is no longer uninstalled.
- **`vat claude plugin install <x.zip> --force` removed the installed skill, then crashed extracting
  an archive whose entries clash (a file `a` beside a file `a/b`)** as `INTERNAL_ERROR`, leaving a
  partial tree. The archive is now extracted to a staging directory and swapped in whole; one that
  cannot be extracted is `INPUT_UNREADABLE` and the installed skill is kept. A skill copied from a
  directory or package is swapped in the same way, so a copy that fails no longer leaves the
  previous skill removed.
- **`vat claude marketplace validate` and `vat verify` crashed (`INTERNAL_ERROR`, exit 2) on a
  plugin skill they could not read** — a `skills/` directory the OS will not list, or a skill
  directory or `SKILL.md` it will not stat or read. Each is now a `SCAN_PATH_UNREADABLE` warning at
  that path plus the `RESOURCE_CHECK_BROKEN` finding naming it (error, exit 1), like an unreadable
  `plugin.json`.

- **`vat agent build` no longer hangs on a named pipe as the system prompt or `LICENSE.txt`.** Both
  are refused unopened, `INPUT_UNREADABLE` naming the path, as a pipe under `scripts/` already was.
- **`vat agent build` reads every source before writing anything.** A refused `scripts/`,
  `LICENSE.txt` or system prompt used to leave `SKILL.md` and the manifest guide written without the
  rest — or a previous build's `SKILL.md` overwritten beside its stale `scripts/`. The output is now
  untouched.
- **A named pipe, socket or device linked from a SKILL.md** no longer hangs `vat skills package` or
  `vat skills build`, and is no longer dropped from the package silently (status `ok`, a dangling
  link). The validator refuses it unread as a `LINK_TARGET_UNREADABLE` error (exit 1), with a remedy
  that names the file type rather than permissions. Underneath, `readDecodableBytes` /
  `readTextContent` / `readTextContentSync` (`@vibe-agent-toolkit/utils/fs`) open without blocking and
  refuse a non-regular file with the errno `EFTYPE`, which `fsFaultOf` now classifies —
  so every lane that parses a file codes it as that lane's unreadable input instead of waiting forever.
- **`vat skill test run --with name=path:<dir>` with a symlink in the companion** is
  `INPUT_UNREADABLE` (`Reason: preflight`), naming the link. It was `INTERNAL_ERROR` with a stack.
- **A `path:` skill source that does not exist** is refused saying it does not exist and to check
  the path. The message used to tell the user to check permissions.

- **`vat audit --compat --settings` no longer drops an auto-discovered settings file the OS
  refuses.** A managed, project or user settings file that exists and cannot be read was skipped
  as if absent, and the run reported `ok` with that layer missing from the compatibility check. It
  is now `INPUT_UNREADABLE`, exit 2, naming the file and the errno, as `--help` already said.
  `vat audit settings` (the default, effective-settings mode) refuses the same way, and a discovered
  layer that does not parse or fails its schema there is `INPUT_UNREADABLE` rather than
  `INTERNAL_ERROR`.
- **`vat rag clear` no longer deletes a user's file because of its name.** A regular file named
  `._notes`, `.DS_Store` or `Thumbs.db` beside a database counted as operating-system litter, so
  `vat rag clear --db <dir>` removed it with the database. A file is litter now only when it starts
  with the bytes the OS writes into it: the AppleDouble header (`._*`), Finder's `Bud1` header
  (`.DS_Store`), an OLE compound-file header (`Thumbs.db`). `desktop.ini` has no signature, so its
  name (as a regular file) still decides. Any other file of those names makes the directory not a
  database, and every `vat rag` verb refuses it, removing nothing.
- **A RAG chunk table that cannot be read names why.** `vat rag index`, `query` and `stats` said
  "its files are damaged" for every failed read of the chunk table, and recommended
  `vat rag clear`. A table whose files the OS refuses is now refused naming the path and the errno,
  with a permissions remedy — clearing it fails on the same files. A table another tool or build
  wrote is refused naming the columns it lacks (or its vector size against the embedding model's).
  Only what is left is called damaged. All three remain `INPUT_UNREADABLE`, exit 2.
- **`vat rag index`, `query`, `stats` and `clear` `--help` name `INTERNAL_ERROR`**, as the `vat rag`
  reference already did.

- **`vat claude plugin install` no longer deletes the plugin it just installed when `vat.replaces`
  names it in another letter case.** A package renaming plugin `Old` to `old` with
  `"replaces": { "plugins": ["Old"] }` installed `old@mp`, then uninstalled `Old@mp` — and on a
  case-insensitive filesystem (macOS, Windows) `plugins/Old` and `cache/<mp>/Old` ARE the new
  plugin's directories. The run exited 0, `status: ok`, with both directories gone and the registry
  pointing at a cache that no longer existed. The uninstall (`uninstallPlugins`, `@vibe-agent-toolkit/claude-marketplace`)
  now decides by on-disk identity (device + inode), never by the name: a plugin or cache directory
  that is another registered plugin's directory is kept, only the registry and settings entries
  are removed, and the result's `warning` names the plugin it belongs to. `vat claude plugin
  uninstall Old@mp` beside an installed `old@mp` had the same defect and the same fix (reported as
  `PLUGIN_UNINSTALL_INCOMPLETE`); a marketplace reached through a link is covered too.
- **`vat claude plugin install` refuses a package directory it cannot list as `INPUT_UNREADABLE`.**
  A package whose `marketplaces/` or `plugins/` directory the OS would not list (copy and `--dev`
  lanes, `--dry-run` included) exited `INTERNAL_ERROR` with a raw `EACCES`, before the readable-source
  check could run. It now names the directory and the errno.
- **`vat claude plugin install` reports a staging directory it cannot write as `RUN_INCOMPLETE`.**
  An unwritable or full `$TMPDIR` surfaced as `INTERNAL_ERROR` (npm, `.zip` and `.tgz` lanes), and a
  `.zip` extraction that ran out of disk (`ENOSPC`, `EDQUOT`, `EROFS`, `EMFILE`, `ENFILE`, `EIO`) was
  blamed on the archive as `INPUT_UNREADABLE`. Both are now `RUN_INCOMPLETE`, naming the staging
  path, with nothing changed; a corrupt or clashing archive is still `INPUT_UNREADABLE`. A full
  `$TMPDIR` while `npm pack` itself downloads is still `EXTERNAL_API_FAILED`.

- **`vat agent install --force` removed the previous install, then hung forever on a named pipe in
  the built bundle**, leaving a half-copied skill and no previous one. The copy now refuses a named
  pipe, socket or device (or a link to one) unopened, as the bundle's `INPUT_UNREADABLE`, and an
  install is copied beside the old one and swapped in only once it is whole — so any refused or
  failed copy keeps the previous install. `vat agent installed` no longer lists the staged copy an
  interrupted install leaves behind.
- **The packaged-output link checks named whichever unreadable document finished first.** When two
  documents could not be read, `vat skills package` / `vat build` reported a different one from run
  to run; they now report the first by position, as before they read in parallel.

- **`vat rag index` no longer writes into a chunk table of another vector size.** When the
  embedding model changed between runs, `index` reported success and stored the new model's vectors
  cut down to the old size, which corrupted the index. `vat rag stats` reported such a table as `ok`.
  Both now refuse it `INPUT_UNREADABLE` (exit 2), as `vat rag query` already did. The message names
  both sizes, and `index` adds and removes nothing. Remedy: `vat rag clear`, then index again.
- **A collection `frontmatterSchema` npm specifier that resolves to nothing is now a
  `FRONTMATTER_SCHEMA_ERROR` finding, not `INTERNAL_ERROR`.** This covers a package that is not
  installed and an `exports` target that is not on disk. `vat resources validate` and `vat verify`
  used to crash with a stack trace. They now report it like a schema path that names no file:
  exit 1, with a message that names the specifier and says whether to install or rebuild. The same
  specifier passed to `vat resources validate --frontmatter-schema` is `USAGE_INVALID` (exit 2),
  as a path naming no file already was.

- **`vat skill test run` refuses a skill source or eval suite that names nothing, instead of
  crashing with `INTERNAL_ERROR`.** This covers an npm package that is not installed, an npm spec
  with no version pin, and a scoped specifier given as a path. From `--with`, `--evals` or the skill
  argument it is `USAGE_INVALID`; from `test.with` or `test.evals` in the config it is
  `CONFIG_INVALID`. An optional companion (`--with-optional`, `test.optional`) that names nothing is
  skipped with a warning, like any other optional companion that cannot stage.
- **A `vat skill test run` npm source with no subpath (`npm:@scope/pkg@1.2.3`) stages the
  installed package.** It used to look for a directory named `@scope/pkg` under the project root.

- **`vat claude plugin install` and `vat skills install` no longer install a truncated or partial
  `.tgz`/npm package.** An entry the extraction could not write — a full `$TMPDIR` mid-file, a file
  `a` beside a file `a/b` — was skipped with exit 0. A full or unwritable `$TMPDIR` is now
  `RUN_INCOMPLETE`; an archive that is not a tarball or holds an unextractable entry is
  `INPUT_UNREADABLE`. Nothing is installed in either case.
- **A `.zip` install that runs out of file descriptors, quota or a writable disk while creating a
  file is `RUN_INCOMPLETE`**, not blamed on the archive as `INPUT_UNREADABLE`.
- **`vat claude plugin uninstall` is no longer blocked by another plugin's unreadable directory, and
  never half-removes.** Every keep-or-remove decision is made before anything is deleted. A
  directory that is another registered plugin's is kept, with a `PLUGIN_UNINSTALL_INCOMPLETE`
  warning, and one that cannot be ruled out as another's (the OS refused to examine it) with a
  `PLUGIN_KEPT_SIBLING_UNEXAMINED` warning; this now covers another plugin's directory that links to
  it, and filesystems that report no inode.
- **A plugin installed from a read-only source can be uninstalled.** The cache copy's directories
  are now always owner-writable; previously they kept the source's mode and nothing could remove
  them. One installed read-only by an earlier build is made owner-writable on the way down.

- **`vat agent install` of a read-only bundle can now be removed.** The install root used to
  copy the bundle root's mode exactly. A `0555` bundle, from a read-only checkout or a packaging
  step's `chmod`, became an install that `vat agent uninstall` refused with `RUN_INCOMPLETE`. The
  install root now keeps the owner's read, write and search bits.
- **`vat agent install` reports a bundle it cannot read as `INPUT_UNREADABLE`, as its help says.**
  An unreadable file, an unlistable directory or a dangling link in the bundle used to be
  `RUN_INCOMPLETE`. The previous install is still kept.
- **`vat agent install` and `vat agent build` can no longer hang on a file that becomes a named
  pipe after the tree is listed.** Each file is opened without blocking, checked with `fstat` on
  that handle, and copied from the handle. The file mode is kept, as before.
- **A `vat skill test run` npm source is found on disk, not through Node's resolution of
  `./package.json`.** A package whose `exports` map hides `./package.json` used to be refused as
  naming no skill source. A subpath that names a directory (`npm:@scope/pkg@1.0.0/skills/x`) could
  never be found, with or without an `exports` pattern. A subpath is now a file or directory inside
  the installed package. If nothing is at that path, it is tried as an `exports` subpath. A subpath
  that climbs out of the package is refused as an invalid spec.
- **`vat doctor` lists a schema behind a package Node cannot read as `Unreadable:`.** It used to
  list it under `Missing:`, with advice to create the file. A collection `frontmatterSchema` of
  that kind is still a `FRONTMATTER_SCHEMA_ERROR` finding, and its message now says the package is
  unreadable. `--frontmatter-schema` or `--evals` naming a file in such a package is
  `INPUT_UNREADABLE`, not "names nothing".
- **`packages/cli/docs/skill-test.md` no longer says every required source that names nothing is
  refused as `USAGE_INVALID`/`CONFIG_INVALID`.** That holds for npm sources and for a scoped
  specifier given as a path. A `path:` source naming a missing directory is `INPUT_UNREADABLE`
  when it is staged.

- **`vat skills package`, `vat skills install`, `vat skills build`, `vat claude plugin build` and
  `vat build` no longer end `INTERNAL_ERROR` on a file the OS refuses** while validating the skill,
  reading back the package for its ZIP or link check, or probing the marketplace manifest; and a
  project that vanishes under a packaging verb now refuses `RUN_INCOMPLETE`.

- **`vat claude plugin install` (every lane), `vat claude plugin build`, `vat claude marketplace
  publish`, `vat rag clear` and `vat agent install --dev` no longer end `INTERNAL_ERROR` on a file
  the OS refuses** while listing the package, copying into `~/.claude`, staging the publish tree,
  listing `dist/skills`, examining the database to clear, or linking the agent.

- **A temporary directory the OS refuses to resolve is refused `RUN_INCOMPLETE`, not `INTERNAL_ERROR`.**
  `normalizedTmpdir()` (`@vibe-agent-toolkit/utils`) raises the refusal as an `FsFaultError` on side
  `environment`; every verb that keeps scratch, staging or a cache under `$TMPDIR` reported it as a defect.
- **`vat agent build` refuses a `scripts/` link that points outside `scripts/` before writing any
  output**, rather than after writing part of it. `vat claude plugin install` and the skill test
  harness refuse a named pipe, socket or device in a plugin, skill or `.claude-plugin/` tree as
  `INPUT_UNREADABLE` instead of passing it to a copy that could block on it.

- **A plugin install, its registry and its `vat.replaces` are one transaction.** The marketplace copy (with
  VAT's `.vat-marketplace` marker written in the copy itself), each plugin's cache, the removal of each
  replaced plugin and legacy flat skill, and the three registry files change together: a failure anywhere
  before the registry is written puts every tree and file back, the parent directories a first install made
  included. The marketplace copy used to be committed before registration, and `vat.replaces` ran as a second
  transaction after it, so a failure between them left a half-installed state the report called "nothing
  finished". A plugin or flat skill `vat.replaces` removed that the OS will not delete once the registry is
  written refuses `RUN_INCOMPLETE` naming it, and lists what was installed (a previous copy of the plugin
  being installed is the `TREE_CLEANUP_INCOMPLETE` warning instead).
- **`vat claude plugin install --dev` no longer deletes the installed marketplace before rebuilding it.** The
  dev marketplace (its content copied, each skill linked to its build) is staged whole and swapped in; a link
  the OS refuses leaves the installed one untouched, and is `RUN_INCOMPLETE`, not `INTERNAL_ERROR`.
- **A replaced plugin that is the one being installed on disk (`Old` → `old` on a case-insensitive
  filesystem) keeps its directory** — the new plugin is installed into it and only `Old`'s registry entry goes.
- **`vat claude plugin install <zip> --dry-run` refuses a zip the real run refuses**: the dry run extracts
  into its `$TMPDIR` staging too.
- **A plugin install and an uninstall are one transaction with Claude Code's registry.** The trees are
  staged and swapped, then `known_marketplaces.json`, `installed_plugins.json` and `settings.json` are each
  replaced whole (never truncated in place); a failure anywhere puts every tree and every registry file
  back, so the registry never names a directory that is not there. A registry file that cannot be put
  back is `TREE_ROLLBACK_INCOMPLETE` (`RUN_INCOMPLETE`), naming it.
- **`vat claude plugin uninstall --all` uninstalls every plugin or none.** It used to stop partway,
  leaving earlier plugins removed and the registry between states.
- **Uninstalling the last plugin of a marketplace VAT made removes the marketplace's directory with its
  `known_marketplaces.json` entry**, instead of leaving a directory nothing names. VAT now writes a
  `.vat-marketplace` marker into every marketplace directory it installs a plugin into, in the install's own
  transaction, and removes only a marked one: Claude Code registers marketplaces of every source (npm
  included), so the source proves nothing. An unmarked marketplace — Claude Code's, or one installed by an
  earlier VAT — is kept, directory and entry, with the reason; so is one that holds a directory another
  plugin still uses.
- **`vat claude plugin uninstall` no longer reports "nothing finished" after it has uninstalled.** A
  moved-aside directory the OS will not delete once the registry is rewritten is `RUN_INCOMPLETE` naming it,
  with every key listed as finished. `--dry-run` prints the plan, one line per directory.
- **A plugin installed read-only (0555) by an older build is uninstalled and re-installed whole**,
  rather than failing `EACCES` partway.
- **Relative links in a plugin are installed verbatim**, not rewritten to absolute links into the
  source tree.
- **A registry file, or a directory to be replaced or removed, whose probe answers `ENOENT` while it is
  there is refused**, never read as empty or free (which dropped every other installed plugin from the
  registry, or left a directory the uninstall said it removed).
- **A removal never takes a kept directory with it**: a `remove` that holds a directory the plan keeps
  is kept too.
- **`replaceFile` (`@vibe-agent-toolkit/utils`) refuses a file a write in place would be refused on** (a
  read-only `settings.json`), before writing anything, instead of renaming a new file over it. A
  registry file the user locked is refused `RUN_INCOMPLETE`, as it was before writes became atomic.
- **Removing a read-only tree no longer fails on an entry the first removal pass had just taken**
  (`ENOENT` from the pass that grants the owner write access), which left the replaced tree behind.
- **A tree-change removal checks the entry is gone.** Node's `rm` reads an `ENOENT` from its own listing as
  "already gone" and can resolve with the directory still there; the uninstall then exited 0 with a parked
  tree left and nothing naming it. The removal now runs again, and refuses if the entry survives; an
  `lstat` answering `ENOENT`/`ENOTDIR` for an entry its parent still lists is a fault, not "already gone".
- **A plan examines each entry once.** Its decisions (what to keep, what overlaps) asked the filesystem
  again and again, so a refusal seen by one and not the next made the planner refuse its own plan
  (`TREE_DESTS_OVERLAP`). A removal whose own target cannot be examined now refuses, instead of being
  kept, and an entry identity's "absent" is believed only when the parent's listing agrees.

- **`vat skills build` and `vat claude plugin build` no longer call a refused listing of their own output
  `INPUT_UNREADABLE`.** The project crawl also walks `dist/`; a directory there the OS will not list that
  holds or lies in what the run writes (`dist/skills`, its staging, the marketplaces) is `RUN_INCOMPLETE`.
- **Packaging no longer blames a source file the OS will not resolve on the output** (`vat skills
  package`, `vat skills build`, `vat agent build`): the check whether the output holds the source refuses
  that read as the source's, `INPUT_UNREADABLE`, naming the file.

- **`vat skills build` no longer ends in `INTERNAL_ERROR` when the OS refuses a read of the bundle it
  just built** (the post-build checks re-read it): the staged tree is the build's output, so the
  refusal is `RUN_INCOMPLETE`, and nothing staged is left in `dist/`.
- **`vat skills install --force` no longer deletes the installed skill before copying its
  replacement**: a copy the disk refuses leaves the previous install exactly as it was.
- **`vat skills install` of a `.zip` names a `$TMPDIR` staging directory it could not remove once the
  install was complete** as a `TREE_CLEANUP_INCOMPLETE` warning (exit 0), where it was a log line only.
- **A tree-change `write` fill lands with the mode any new directory gets, not a temporary
  directory's 0700** (`@vibe-agent-toolkit/utils` `applyTreePlan`): a marketplace that
  `vat claude plugin install` builds in staging is no longer owner-only.

- A failed `vat claude plugin build` no longer destroys the previous marketplace tree (registered
  defect).
- A `vat skills package` whose SKILL.md the project crawl could not read is refused naming it
  (`SKILL_PACKAGING_FAILED`), instead of packaging the SKILL.md alone with every link dropped
  (exit 0).
- A refused listing of a previous package or agent build beside the run's staged tree, or of the
  marketplaces a `vat build` writes, is `RUN_INCOMPLETE` (the run's output), not `INPUT_UNREADABLE`.
- `vat claude plugin build` classifies a plugin source the OS will not list or examine during its
  symlink sweep, and a refused close of a plugin file, as the input's (`INPUT_UNREADABLE`), not an
  `INTERNAL_ERROR` or the output's `RUN_INCOMPLETE`.

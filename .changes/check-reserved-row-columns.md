### Breaking

- **A `resources.checks` key equal to a built-in check's name is refused at config load**, naming
  the clash and the fix: rename it. The built-in always runs, so the two shared one name in
  `data.checks`, `--check` and every finding's `check`. A copy of a built-in's SQL twin needs a
  name of its own.
- **A check row's `path` must be text or NULL.** Text is the finding's `location` when it is one —
  a non-empty relative path with `/` separators inside the root (no leading `/`, no drive, no `..`
  that climbs out, and no `\` on Windows, where it is the separator). Text that is no location
  (absolute, climbing, empty — `roots.path`, an outside-root closure reference's
  `realization_conditions.path`) gives a finding with no location at the declared severity, the
  value kept as `evidence.path`. A value that is not text (a number, a BLOB) fails the check as
  `RESOURCE_CHECK_BROKEN` with the structured `reason` (`column: path`). NULL or absent is no
  location and no evidence entry. A published finding's `location` (`ValidationIssueSchema`) now
  refuses an empty or root-climbing value too: one predicate, `isProjectLocation` in
  `@vibe-agent-toolkit/schema`, decides both; it also refuses the root itself (`.`, `docs/..`) and
  a leading `\` or UNC path on every host, and shares its one definition of absolute
  (`isAbsoluteOnAnyHost`) with the relative paths a report states. A location is published in its
  normalised form (`./docs/a.md` is `docs/a.md`, `docs/../a.md` is `a.md`). A published finding's
  `column` requires its `line` (`ValidationIssueSchema`, every report schema, and the committed
  JSON Schemas).
- **A finding whose file lies outside the run's root now has no `location`, its path named in the
  message instead** — where it used to carry a climbing `../…` (or, from `vat resources check`, an
  empty) location. Every verb that publishes findings can emit one: `vat okf validate` (a bundle
  declared at `../shared-docs`), `vat skills validate`, `vat skills build`, `vat skills package`,
  `vat audit` (a user-scope `settings.json` included), `vat resources validate`, `vat claude marketplace validate`, `vat claude plugin
  build`, `vat skill test run`, `vat build`, `vat verify`
  and `vat validate`. A consumer that requires `location` on every finding must accept its absence.
  `createRegistryIssue` and `toFindings` (`@vibe-agent-toolkit/schema`) apply the rule, through the
  new `projectLocationOf` and `anchoredAt`.
- **`ResourceCheckSchema` (`@vibe-agent-toolkit/resources`) is a `ZodEffects`, not a `ZodObject`**,
  since it refuses `allowEmpty` without `examined`: `.shape`, `.extend()`, `.pick()` and the other
  object methods are gone from it. Validate with `.parse()` / `.safeParse()`, or compose from the
  `checks` record of the project config schema.
- **A `resources.checks` statement that defines a CTE named `changed_files`** (`WITH changed_files
  AS (` or `, changed_files AS (`) is `RESOURCE_CHECK_BROKEN` (`reason: {refusal: USAGE_INVALID}`),
  "`changed_files` is a reserved relation name; rename the CTE" — with or without `--base`, since
  the CTE either shadows the relation or trips its refusal. `vat resources query` refuses it as
  `USAGE_INVALID`.
- **A `resources.checks` statement's `finding_severity`, `finding_line` and `finding_column` columns
  now feed the finding** (beside `path`), matched exactly. A value they cannot mean —
  `finding_severity: 'high'`, `finding_line: 0` — fails the check as `RESOURCE_CHECK_BROKEN`. No
  projection relation carries those names, so `SELECT *` never sets one; a table's own `severity`,
  `line` or `column` stays evidence.
- **`vat resources check`'s findings carry `check` and `evidence`, and `vat validate`'s finding
  schema (`orchestrator.json`, shared by `vat build` and `vat verify`) is the check-finding schema.** A strict consumer of either published
  schema must re-read it.

### Added

- **A check's rows can set their own severity, line and column**: `finding_severity` (`error` |
  `warning` | `info`, NULL = the declared one), `finding_line`, and `finding_column` (needs
  `finding_line`). A `resources.validation.severity` override on `CUSTOM:<name>` replaces the
  severity of EVERY row of that check, raising a row's `info` as well as lowering its `error`. A
  column that nearly names a reserved one — equal once case and `_` are removed (`Finding_Line`,
  `findingSeverity`), or the bare `severity`, `line` or `column` — is a stderr warning, and is
  listed as spelled on that check's `data.checks` entry as `nearMisses` (absent when there is none)
  — read from the statement's columns before it runs, so it is listed whatever the row count, on a
  broken check, a check that threw, and a run killed mid-check alike.
- **Every finding one check produced names it: `check: <name>`** — its violations (built-in or
  declared) and the `RESOURCE_CHECK_BROKEN` / `RESOURCE_CHECK_EXAMINED_NOTHING` refusals about it, in
  `vat resources check` and in `vat validate`'s `checks` phase alike. A finding about the whole run
  carries none.
- **A declared check's violation carries `evidence`**: the row's columns other than the reserved
  ones, values as SQLite returned them (a BLOB, or a non-finite number such as `Infinity`, as the
  text the message shows — so the JSON and YAML documents agree); a column aliased `__proto__` is
  kept. The message is unchanged. A refusal's message quotes every text value, a non-finite number
  carried as text included (`finding_line = "Infinity"`).
- **A check whose rows could not be read carries `reason`** on its `RESOURCE_CHECK_BROKEN` finding:
  `{column, value, row, allowed}` — the reserved column, the value as `evidence` renders it, the
  1-based row (the FIRST bad one), and what the column may hold (`one of error | warning | info`,
  `a positive integer`, `NULL without a finding_line`). The message states the same `allowed`. A
  check whose `examined` statement returned no count carries the other shape,
  `{statement: 'examined', rows, columns?, value?, allowed}`. A check whose statement could not run
  because a derived relation it reads refused carries `{refusal: <code>}`, the code
  `vat resources query` exits with for it.
- **A killed run's report keeps every check that had already completed broken**: its entry and its
  `RESOURCE_CHECK_BROKEN` finding (message, `check`, `reason`) are the ones the completed run
  publishes, in the order a completed run publishes them — before the in-flight check's.
- **`column` is a field of `ValidationIssue`** (and `createRegistryIssue`'s extras); the published
  finding inherits it.

### Changed

- **A check whose rows it could not read is published with `broken: true` AND `rows`**: `rows` is
  present exactly when the statement completed.
- **A finding with a `line` but no file prints the coordinates after the message** —
  `error: <message> [<code>] (line 3, column 5)` — instead of a bare `3:5:` prefix.
- **A budget kill while a check's rows were being turned into findings names that state**, and
  records that check as broken with its `rows` — and its `examined` and `allowEmpty`, exactly the
  entry a completed run whose conversion failed publishes — instead of blaming a statement that
  would not finish.

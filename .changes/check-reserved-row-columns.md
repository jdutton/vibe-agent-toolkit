### Breaking

- **A `resources.checks` key equal to a built-in check's name is refused at config load**, naming
  the clash and the fix: rename it. The built-in always runs, so the two shared one name in
  `data.checks`, `--check` and every finding's `check`. A copy of a built-in's SQL twin needs a
  name of its own.
- **A check row's `path` must be a relative POSIX path inside the root, or NULL.** Any other value
  — not text, absolute, a drive path, a backslash, or a `..` that climbs out of the root — fails the
  check as `RESOURCE_CHECK_BROKEN` with the structured `reason` (`column: path`), on every platform
  alike. NULL or absent is no location. `path` is never evidence. A built-in's finding over a file
  whose name holds a backslash now carries no location.
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
  `finding_line`). An override on `CUSTOM:<name>` still wins. A column that differs from a reserved
  name only in case is a stderr warning, and is listed as spelled on that check's `data.checks`
  entry as `nearMisses` (absent when there is none) — read from the statement's columns, so it is
  listed whatever the row count, on a broken check and on a run killed mid-check alike.
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

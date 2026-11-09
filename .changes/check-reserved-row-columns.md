### Breaking

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
  name only in case is a stderr warning.
- **Every finding one check produced names it: `check: <name>`** — its violations (built-in or
  declared) and the `RESOURCE_CHECK_BROKEN` / `RESOURCE_CHECK_EXAMINED_NOTHING` refusals about it, in
  `vat resources check` and in `vat validate`'s `checks` phase alike. A finding about the whole run
  carries none.
- **A declared check's violation carries `evidence`**: the row's columns other than the reserved
  ones, values as SQLite returned them (a BLOB, or an integer beyond JSON's range, as the text the
  message shows). The message is unchanged.
- **`column` is a field of `ValidationIssue`** (and `createRegistryIssue`'s extras); the published
  finding inherits it.

### Changed

- **A check whose rows it could not read is published with `broken: true` AND `rows`**: `rows` is
  present exactly when the statement completed.
- **A finding with a `line` but no file prints the coordinates after the message** —
  `error: <message> [<code>] (line 3, column 5)` — instead of a bare `3:5:` prefix.
- **A budget kill while a check's rows were being turned into findings names that state**, and
  records that check as broken with its `rows`, instead of blaming a statement that would not finish.

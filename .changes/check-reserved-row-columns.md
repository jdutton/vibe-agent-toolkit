### Breaking

- **A `resources.checks` statement's `severity`, `line` and `column` columns now feed the finding**
  (beside `path`), matched exactly. A value they cannot mean — `severity: 'high'`, `line: 0` — fails
  the check as `RESOURCE_CHECK_BROKEN`. `SELECT *` or a join over `blob_conditions`,
  `realization_conditions`, `harness_blob_imports` or `blob_references` now picks up those tables'
  own columns: alias them (`b.line AS refLine`) to keep them as evidence.

### Added

- **A check's rows can set their own severity, line and column**: `severity` (`error` | `warning` |
  `info`, NULL = the declared one), `line`, and `column` (needs `line`). An override on
  `CUSTOM:<name>` still wins. A column that differs from a reserved name only in case is a stderr
  warning.
- **`column` is a field of `ValidationIssue`** (and `createRegistryIssue`'s extras); the published
  finding inherits it.

### Changed

- **A check whose rows it could not read is published with `broken: true` AND `rows`**: `rows` is
  present exactly when the statement completed.
- **A finding with a `line` but no file prints the coordinates after the message** —
  `error: <message> [<code>] (line 3, column 5)` — instead of a bare `3:5:` prefix.
- **A budget kill while a check's rows were being turned into findings names that state**, and
  records that check as broken with its `rows`, instead of blaming a statement that would not finish.

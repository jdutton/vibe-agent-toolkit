### Fixed

- **A missing table or column in a `vat resources query` statement or `vat resources check` rule
  read as a read-only violation.** The refusal now opens with SQLite's own error (`no such table:
  <name>`, `no such column: <name>`). No action needed.

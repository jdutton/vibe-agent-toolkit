### Added

- **A `resources.checks` entry can declare what it examined**: `examined: <SQL>`, a second statement
  whose row count is what the check ranged over. Its count is published on the check's
  `data.checks` entry as `examined` (absent when undeclared or when the statement did not complete).
  A count of 0 fails the run as the new refusal code `RESOURCE_CHECK_EXAMINED_NOTHING` (error, not
  overridable), naming the check; its own violations are still reported. `allowEmpty: true` declares
  zero legitimate and is published beside `examined: 0`; `allowEmpty` without `examined` is refused
  at config load. A failing examined statement is `RESOURCE_CHECK_BROKEN`. The same holds in
  `vat validate`'s `checks` phase. A check entry carries `examinedNothing: true` exactly when that
  check produced `RESOURCE_CHECK_EXAMINED_NOTHING`.
- **A budget kill or death during a check's examined statement names that statement**, and records
  the check as broken with its `rows` (and `allowEmpty`), the entry a completed run whose examined
  statement failed publishes, instead of blaming the violations statement.

### Changed

- **A check's `durationSecs` covers its examined statement too**, when it declares one.

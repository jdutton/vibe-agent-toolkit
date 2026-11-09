### Added

- **A `resources.checks` entry can declare what it examined**: `examined: <SQL>`, a second statement
  returning ONE count of what the check ranged over (`SELECT COUNT(*) FROM … WHERE …`). Its count is
  published on the check's `data.checks` entry as `examined` (absent when undeclared or when the
  statement did not complete). A count of 0 fails the run as the new refusal code
  `RESOURCE_CHECK_EXAMINED_NOTHING` (error, not overridable), whose message names the check and says
  its examined statement counted 0; its own violations are still reported. `allowEmpty: true`
  declares zero legitimate and is published on every entry of that check, whatever it counted;
  `allowEmpty` without `examined` is refused at config load. An examined statement that fails, or
  returns anything but exactly one row with one column holding a non-negative integer (as
  `SELECT COUNT(*)` returns), is `RESOURCE_CHECK_BROKEN`; for the latter the finding's `reason` is
  `{statement: 'examined', rows, columns?, value?, allowed}`. The same holds in `vat validate`'s
  `checks` phase. A check entry carries `examinedNothing: true` exactly when that check produced
  `RESOURCE_CHECK_EXAMINED_NOTHING`.
- **A budget kill or death during a check's examined statement names that statement**, and records
  the check as broken with its `rows` (and `allowEmpty`), instead of blaming the violations
  statement. Its `durationSecs` covers only the violations statement — the examined statement never
  finished, so it cannot be charged — so it is not byte-identical to the entry of a completed run
  whose examined statement failed.

### Changed

- **A check's `durationSecs` covers its examined statement too**, when it declares one and the
  statement completed.

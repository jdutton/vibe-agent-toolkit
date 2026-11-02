### Changed

- **`vat validate`, `vat verify` and `vat resources validate` now print resources and checks findings
  on stderr**, as their help always said: every error, errors first, plus warnings and info with
  `--verbose`. The stdout document is unchanged; read stderr and redirect stdout to a file.
- **`vat resources check` reports its findings on stderr the same way**, and gains `-v, --verbose`
  to include the warning and info ones.
- **Every human finding line is now `location:line: severity: message [CODE]`**, the same line
  `--format text` prints, in place of `[SEVERITY] [CODE] message` plus a `Location:` line. A log
  filter matching the old `[ERROR]` prefix must match `: error: ` instead.

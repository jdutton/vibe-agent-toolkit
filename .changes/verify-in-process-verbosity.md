### Fixed

- **`vat verify`'s `consistency` and `packaged-content` phases print warning and info findings on
  stderr only with `-v`/`--verbose`**, like every other phase; without it they print errors and a
  "not shown" line. The stdout document and the exit code are unchanged.

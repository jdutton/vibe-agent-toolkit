### Changed

- **`vat verify`'s `consistency` and `packaged-content` phases print warning and info findings on
  stderr only with `-v`/`--verbose`**, like every other phase; without it they print errors and a
  "not shown" line. `-v` changes neither the stdout document nor the exit code.

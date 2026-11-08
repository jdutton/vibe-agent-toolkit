### Breaking

- **`vat verify`'s `consistency` and `packaged-content` phases print warning and info findings on
  stderr only with `-v`/`--verbose`**, like every other phase; without it they print errors and a
  "not shown" line. A CI step grepping stderr for one of their warning codes must pass `-v` or read
  the stdout document, which still lists every finding.

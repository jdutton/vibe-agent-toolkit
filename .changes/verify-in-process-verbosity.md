### Fixed

- **`vat verify` no longer prints every warning and info finding of its in-process phases on stderr
  without `--verbose`.** The `consistency`, `packaged-content` and `files-config-dests` phases printed
  each finding at every severity (a project with many `publish: false` skills got one
  `info: … [SKILL_UNPUBLISHED]` line and its `Fix:` line per skill). They now follow the rule every
  other phase follows: every error always, warning and info findings only with `-v`/`--verbose`, and
  otherwise a `N warning/info finding(s) not shown — re-run with --verbose` line under the phase's
  banner. The stdout document still lists every finding, and the exit code is unchanged.

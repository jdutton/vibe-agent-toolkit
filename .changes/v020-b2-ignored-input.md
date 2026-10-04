### Breaking

- **`vat audit --settings` without `--compat` is refused (`USAGE_INVALID`, exit 2)** instead of
  printing a warning and auditing without the settings check. Add `--compat`, or drop `--settings`.
  `--settings` under `--user`, which was silently ignored, is refused the same way.
- **`vat audit --compat --settings <file>` refuses a file it cannot use.** A path that does not
  exist is `USAGE_INVALID`; a directory, an unreadable file, or one that does not parse or fails the
  settings schema is `INPUT_UNREADABLE` (exit 2 either way). It used to read a missing file as "no
  settings" and publish `findings: []` at exit 0, and to downgrade a malformed one to a stderr
  warning. An auto-discovered settings layer (`--settings` with no file) that does not parse is
  refused the same way.

### Fixed

- **`vat resources validate --format` and `--validation-mode` refuse a value they do not offer**
  (exit 2, naming the accepted values). `--format bogus` used to write YAML and
  `--validation-mode bogus` ran strict, both at exit 0.
- **`vat mcp serve <package> --print-config` resolves the package first.** A package that does not
  load now fails as it does without the flag (exit 2, nothing on stdout); it used to print a
  paste-ready config for a server that could not start, at exit 0.

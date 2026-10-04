### Breaking

- **`vat rag stats`, `vat rag query` and `vat rag clear` refuse a database that is not there**, exit
  2, and no longer create it: `USAGE_INVALID` for a `--db` that names nothing (or names a file),
  `INPUT_UNREADABLE` when the project has no database yet or the directory cannot be read (was:
  `stats` reported zeros and `clear` reported `cleared: true`, exit 0). Run `vat rag index` first.
- **Every `vat` verb refuses a positional argument it does not declare**, exit 2 (`too many
  arguments`); it was silently discarded and the run reported success (`vat audit a b` audited
  only `a`). Drop the extra argument, or run the verb once per path.

### Changed

- **A skill build whose output cannot be written ends `RUN_INCOMPLETE`, exit 2** — a full disk, or
  a read-only or unwritable output directory — in `vat skills build`, `vat skills package`,
  `vat build`, `vat claude plugin build`, `vat agent build` and `vat skill test run`. It is never a
  `SKILL_PACKAGING_FAILED` finding: that is reserved for the skill's own content.
- **`installPlugin` (`@vibe-agent-toolkit/claude-marketplace`, library-only) refuses a `pluginDir`
  it cannot list** with a `VatError` coded `PLUGIN_SOURCE_UNREADABLE`, before creating anything.

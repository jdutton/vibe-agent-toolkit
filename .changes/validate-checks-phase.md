### Breaking

- **`vat validate` now runs `vat resources check` as a `checks` phase whenever `resources:` is
  configured** (phases: `resources`, `checks`, `skills`). A declared check's `error` row fails the
  run (exit 1); no built-in check defaults to `error`.
- **A declared check whose SQL no longer runs now fails `vat validate`** (`RESOURCE_CHECK_BROKEN`,
  exit 1). Run `vat resources check` to see which, and fix or remove it.
- **A cold `vat validate` now populates the resource projection twice** (the `resources` phase and
  the checks phase each build it), so a run with a cold cache takes correspondingly longer.
- **A checks phase that does not finish fails `vat validate`:** `RESOURCE_CHECK_BROKEN` (exit 1) once
  its population is in, `RUN_INCOMPLETE` (exit 2) before. It is killed after 300 s without progress
  (a total bound on the population), and this release has no way to give `vat validate` more time:
  `vat resources check --budget <seconds>` can let the checks pass on their own, not `vat validate`.
- **`vat validate`'s `examined` now includes the checks phase's count** of resources in the projection.

### Added

- **Stopping `vat validate` or `vat resources check` by signalling its pid alone** (SIGTERM, SIGHUP,
  SIGINT) also stops its checks child. Not on Windows, where such a stop runs no handler. Under
  `nohup`, a SIGHUP that arrives while the checks run still ends the run.

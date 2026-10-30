### Breaking

- **`vat validate` now runs `vat resources check` as a `checks` phase whenever `resources:` is
  configured** (phases: `resources`, `checks`, `skills`). A declared check's `error` row fails the
  run (exit 1); no built-in check defaults to `error`.
- **A checks phase that does not finish fails `vat validate`:** `RESOURCE_CHECK_BROKEN` (exit 1) once
  its population is in, `RUN_INCOMPLETE` (exit 2) before. `vat validate` takes no `--budget`; give a
  slow check more time with `vat resources check --budget <seconds>`.
- **`vat validate`'s `examined` now includes the checks phase's count** of resources in the projection.

### Added

- **Stopping `vat validate` or `vat resources check` by signalling its pid alone** (SIGTERM, SIGHUP,
  SIGINT) also stops its checks child. Not on Windows, where such a stop runs no handler.

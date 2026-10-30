### Breaking

- **`vat validate` now runs the project's checks whenever `resources:` is configured.** The phases
  are `resources`, `checks`, `skills`: the new `checks` phase is exactly `vat resources check` over
  the whole project (VAT's built-in checks plus every `resources.checks` statement), run under that
  command's default bound, and its entry under `data.phases` is that command's own report. A check
  that selects a row at `error` now fails `vat validate` (exit 1); a check killed while it ran is
  `RESOURCE_CHECK_BROKEN` (exit 1); a checks run that could not populate is `RUN_INCOMPLETE` (exit
  2). A project that relied on `vat resources validate && vat skills validate` gains the checks it
  was not running. To give a slow check more time, run `vat resources check --budget <seconds>`
  on its own; `vat validate` accepts no `--budget`.
- **`vat validate`'s `examined` grows by the checks phase's count** — the resources in the
  projection the checks ran over — because `examined` is the sum over every phase.

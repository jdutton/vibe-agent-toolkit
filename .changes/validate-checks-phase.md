### Breaking

- **`vat validate` now runs the project's checks whenever `resources:` is configured.** The phases
  are `resources`, `checks`, `skills`: the new `checks` phase is exactly `vat resources check` over
  the whole project (VAT's built-in checks plus every `resources.checks` statement), run under that
  command's default bound, and its entry under `data.phases` is that command's own report. A check
  that selects a row at `error` now fails `vat validate` (exit 1); a check killed while it ran is
  `RESOURCE_CHECK_BROKEN` (exit 1); a checks run that could not populate is `RUN_INCOMPLETE` (exit
  2). A project that relied on `vat resources validate && vat skills validate` gains the checks it
  was not running. To give a slow check more time, run `vat resources check --budget <seconds>`
  on its own; `vat validate` accepts no `--budget`. **No built-in check defaults to `error`**:
  `CLAUDE_RULE_GLOB_INERT` is `info`, `CLAUDE_RULE_FRONTMATTER_INVALID` and
  `CLAUDE_RULE_LINK_UNCHECKED` are `warning` — so `vat validate`'s exit code changes only through
  the project's own declared checks (or a `resources.validation.severity` that raises a built-in),
  plus `RESOURCE_CHECK_BROKEN` when a check cannot run at all.
- **`vat validate`'s `examined` grows by the checks phase's count** — the resources in the
  projection the checks ran over — because `examined` is the sum over every phase.

### Fixed

- **`vat resources check` no longer prints its config and store notices twice.** Its supervised child
  read the same config and keyed the same store as the process you ran, and its stderr is inherited,
  so an unknown config key was warned twice per run (and, under `vat validate`, the "not inside a
  readable git repository" store notice too). A supervised child now prints no such notices; the
  process you invoked prints each once.
- **Terminating `vat resources check` (or `vat validate`) with a pid-only `SIGTERM` or `SIGHUP` no
  longer orphans the checks child.** The bound lived in the parent's timer, so a `kill <pid>`,
  `timeout(1)` or CI step stop left the child running with nothing to stop it. While it supervises,
  the parent now SIGKILLs the child and then dies of the same signal. Ctrl-C is unchanged — it
  reaches the whole process group.
- **A checks child that exits against its own report no longer passes.** The parent forwarded the
  document's exit code and never compared it with the child's, so a complete `ok` report followed by
  a non-zero exit was published as a clean pass. It is now `RESOURCE_CHECK_BROKEN` (exit 1), naming
  both codes.

### Breaking

- **`vat validate` gains a `checks` phase whenever `resources:` is configured** (a `checks` phase
  entry in `data.phases`): VAT's built-in checks plus your `resources.checks`, over the whole tracked
  tree — `resources.include`/`exclude` do not scope it. It builds its own projection, so runs take
  longer. **Action:** drop a separate `vat resources check` CI step beside `vat validate` — it runs
  the same checks twice — unless you need its `--check` or `--budget`.
- **The `checks` phase can fail `vat validate`:** a check row at `error`, or `RESOURCE_CHECK_BROKEN`
  — including a phase killed or dead during a check — is exit 1; exit 2 (`RUN_INCOMPLETE`) only when
  the phase stops before its population completes. It is killed after 300 s without progress (the
  whole population is one unit); `vat validate` cannot raise that bound.
- **`vat mcp serve` and `vat-compile-resources watch` now die of a terminating signal** (status
  128+n on POSIX) instead of exiting 0, and every signal-handling command also handles SIGBREAK on
  Windows. Interrupting a supervised checks run: `vat resources check --help`.

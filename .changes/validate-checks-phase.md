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
- **`vat` (every command) now waits for the CLI it starts and ends as it did:** `kill`/`timeout` on
  the `vat` pid stops the CLI too (it used to run on), and a CLI killed by a signal makes `vat` die of
  it (status 128+n on POSIX) instead of exiting 1. Windows Ctrl-C/Ctrl-Break exits 2.
- **A second terminating signal more than ~0.5 s after the first ends `vat` at once**, CLI included,
  even mid-cleanup; one within 0.5 s is treated as the same interruption.
- **`vat skill test run` interrupted** now dies of the signal on POSIX (exits 2 on Windows) instead
  of exiting 128+n, and **`vat audit <git-url>`** also removes its clone on SIGTERM, SIGHUP, SIGQUIT and
  SIGBREAK, not just SIGINT.

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
- **`vat mcp serve` and `vat-compile-resources watch` now die of SIGINT** (status 130 on POSIX)
  instead of exiting 0; SIGTERM still kills them, as before. Every signal-handling command also
  handles SIGBREAK on Windows. Interrupting a supervised checks run: `vat resources check --help`.
- **`vat` (every command) now waits for the CLI it starts and ends as it did:** on POSIX,
  `kill`/`timeout` on the `vat` pid stops the CLI too (it used to run on; on Windows an outside kill
  of `vat` already ended the CLI with it, as before),
  and a CLI killed by SIGTERM/SIGINT/SIGHUP/SIGQUIT makes `vat` die of it instead of exiting 1.
- **Any other abnormal CLI end now makes `vat` exit 2:** a CLI killed by SIGKILL (an OOM killer, say),
  SIGSEGV or SIGABRT, or exiting with a code other than 0/1/2 — it used to exit 1 for a signal death
  and pass any other code through. Windows Ctrl-C/Ctrl-Break exits 2.
- **A second terminating signal more than ~0.5 s after the first ends `vat` at once**, CLI included,
  even mid-cleanup; one within 0.5 s is treated as the same interruption.
- **`vat skill test run` interrupted** now dies of the signal on POSIX (exits 2 on Windows) instead
  of exiting 128+n, and releases its lock on SIGHUP, SIGQUIT and SIGBREAK too, not just SIGINT/SIGTERM.
- **`vat audit <git-url>`** also removes its clone on SIGTERM, SIGHUP, SIGQUIT and SIGBREAK, not just SIGINT.

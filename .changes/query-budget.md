### Added

- **`vat resources query --budget <seconds>` bounds a statement that might run away.** The statement
  runs in a child process under `vat resources check`'s supervisor, killed after that many seconds
  without progress; a run killed, or dead of anything else, before it finished is refused as
  `RUN_INCOMPLETE` (exit 2), never published as a partial answer. The bound is opt-in: without
  `--budget`, or with `--budget 0`, `query` runs in one process exactly as before. A value
  `vat resources check` refuses (blank, negative, not a number, a zero not written `0`) is refused
  here too.

### Breaking

- None for `query`. `check` and `vat validate`'s checks phase: a synchronous spawn failure is now
  `spawn-failed` (`RUN_INCOMPLETE`, exit 2), no longer whatever refusal the escaped throw became.

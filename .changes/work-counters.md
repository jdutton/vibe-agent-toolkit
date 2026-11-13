### Added

- **`VAT_WORK_COUNTERS=<dir>` dumps a run's work counters.** Each `vat` process writes
  `work-counters-<pid>.json` there: rows decoded, store reads and writes, extents derived and
  served, parse cache hits, dispatches and refusals, bytes hashed, and git calls. Counts are
  deterministic for a given tree and store; nothing is gated on them yet.
- **`@vibe-agent-toolkit/utils`: `countWork`, `readWorkCounters`, `forbidWorkCounting`,
  `installWorkCounterDump`, `WORK_COUNTER_NAMES`, `WORK_COUNTERS_ENV`** and their types, for code
  that counts or reads the same counters.

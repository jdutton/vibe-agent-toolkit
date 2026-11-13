### Added

- **`VAT_WORK_COUNTERS=<dir>` dumps a run's work counters.** Each `vat` process writes
  `work-counters-<pid>.json` there: rows decoded and written, store reads and writes, extents
  derived and served, store-miss refused pairs, parse cache hits, dispatches and refusals, bytes
  hashed, and git calls. Counts are deterministic for a given tree and store, except
  `parse.refused.load` (machine load) and, on a cold cache, `parse.dispatched` and
  `parse.cache.hit`. Nothing is gated on them yet.
- **`@vibe-agent-toolkit/utils`: `countWork`, `readWorkCounters`, `forbidWorkCounting`,
  `onWorkCountersReset`, `installWorkCounterDump`, `WORK_COUNTER_NAMES`, `WORK_COUNTER_ROLES`,
  `WORK_COUNTERS_ENV`** and their types, for code that counts or reads the same counters.

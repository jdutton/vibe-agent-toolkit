### Added

- **`VAT_WORK_COUNTERS=<dir>` dumps a run's work counters.** Each `vat` process writes
  `work-counters-<pid>.json` there: rows decoded and written, store reads and writes, extents
  derived and served, store-miss refused pairs, parse cache hits, dispatches, re-dispatches and
  refusals, bytes hashed, and git calls. Nothing is gated on them yet.
  - Counts are deterministic for a given tree and store, with three exceptions.
  - A parse refused under machine load (`parse.refused.load`) is not a property of the code. It
    also moves `parse.dispatched`, `extent.derived`, the store's row counts,
    `store.miss.refusedPairs` and `parse.refused.keyDetermined`, so a run with one is not
    comparable count for count.
  - `parse.redispatched` counts a second dispatch made only when a cache entry a worker filed is
    gone at the read-back, such as after a concurrent cache clear.
  - On a cold cache, `parse.dispatched` and `parse.cache.hit` depend on timing: two files with one
    content key can be in flight at once, and both miss.
- **`@vibe-agent-toolkit/utils`: `countWork`, `readWorkCounters`, `forbidWorkCounting`,
  `forbiddenWorkCountPolicy`, `installWorkCounterDump`, `WORK_COUNTER_NAMES`,
  `WORK_COUNTER_ROLES`, `WORK_COUNTERS_ENV`** and their types, for code that counts or reads the
  same counters. On `@vibe-agent-toolkit/utils/testing`: `__resetWorkCountersForTest`,
  `__readWorkCounterDumpForTest` and `__throwOnForbiddenWorkCountForTest`.

### Fixed

- **A `VAT_PARSE_TIMING` or `VAT_CRAWL_TIMING` directory that cannot be made is reported once.**
  The seam turns itself off instead of failing again at exit.

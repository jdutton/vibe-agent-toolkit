### Breaking

- **`VAT_PARSE_POOL` is removed, and every document parse now runs in a bounded worker thread.**
  There is no in-process parse left to switch back to: a parse on the run's own thread cannot be
  stopped, so one pathological document could hang or crash the whole run. Setting the variable now
  does nothing; delete it from CI and scripts. A small run that used to parse on the main thread
  now starts one worker, which costs a cold small corpus a measured fraction of a second (numbers in
  `docs/architecture/fact-extractors-limits.md`). `VAT_PARSE_POOL_SIZE` and
  `VAT_PARSE_POOL_MIN_MISSES` still size the pool.
- **`ParsePoolPolicy.enabled` is removed** from `@vibe-agent-toolkit/resources`. A policy now
  takes `limits` (a partial `ParseLimits`) instead; pass nothing to get the defaults.

### Added

- **Every parse has limits: wall clock, heap, stack depth, output rows, output bytes and input
  size.** A breach kills the worker (the pool replaces it) and refuses that one file, naming it
  and the limit; every other file keeps its rows, and the run completes. Nothing about a breach is
  stored, so the next run parses the file again. The projection reports it as
  `BLOB_PARSE_LIMIT_EXCEEDED` ("over a parse limit" in the refusal summary), and `vat resources
  validate` as the new error finding `RESOURCE_PARSE_LIMIT_EXCEEDED`.

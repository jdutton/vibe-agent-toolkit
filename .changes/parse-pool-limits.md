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
- **A document over a parse limit now fails `vat resources validate`.** It is reported as
  `RESOURCE_PARSE_LIMIT_EXCEEDED` at error severity, so the run exits 1. A document whose parse
  worker dies is reported the same way, as `RESOURCE_PARSE_WORKER_DIED`. Set
  `severity.RESOURCE_PARSE_LIMIT_EXCEEDED` to `warning` to keep a known-pathological file from
  failing CI while you fix or exclude it.
- **`ResourceRegistry.addResource` throws `ParseLimitError` when one document's parse breaches a
  limit**, and `ParseWorkerDiedError` when the worker holding it dies; `addResources` records both
  as findings instead. Both are exported from `@vibe-agent-toolkit/resources`, with
  `isParseLimitError`, `isParseWorkerDiedError` and the `ParseLimits` type.
- **`vat rag index` no longer parses.** It chunks each resource by the facts the registry already
  derived (an HTML resource by its HTML facts, not a markdown re-parse) and reads only its text, so
  a document deep enough to overflow a parse on the indexing thread indexes like any other.

### Added

- **Every parse has limits: wall clock, heap, stack depth, output rows, output bytes and input
  size.** Time and heap breaches kill and replace the worker; stack and output breaches are
  reported by it; input size is refused before dispatch. Each breach refuses that one file, naming
  it and the limit; every other file keeps its rows, and the run completes. Nothing about a breach
  is stored, so the next run parses the file again. The projection reports it as
  `BLOB_PARSE_LIMIT_EXCEEDED` ("over a parse limit" in the refusal summary), and `vat resources
  validate` as the new error finding `RESOURCE_PARSE_LIMIT_EXCEEDED`. A worker that dies holding a
  job is the same kind of per-run outcome: `BLOB_PARSE_WORKER_DIED` ("parse worker died") and
  `RESOURCE_PARSE_WORKER_DIED`, never stored, never a parse failure of the file.
- **Frontmatter YAML is decoded only in the parse worker,** under its limits. A block nested deep
  enough to overflow the worker's stack is a `stackMb` breach, never a `frontmatterError`. A
  1,000-level nested block that used to overflow the main thread on a parse-cache hit now parses
  on every run.

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
- **`vat resources scan` and `vat rag index` now exit 1 for a file the crawl could not parse.**
  Each such file is an error finding under its refusal code (`RESOURCE_PARSE_LIMIT_EXCEEDED` or
  `RESOURCE_PARSE_WORKER_DIED`) and counts in `examined`; before, it was silently left out and the
  run exited 0. `vat resources scan` also reports a file it could not read as `RESOURCE_UNREADABLE`.
  Fix or exclude the file, or set its severity to `warning`.
- **`vat rag index` refuses a document that changed after the crawl.** It is a
  `RAG_DOCUMENT_INDEX_FAILED` error and is not indexed; re-run to index the current content.
- **Skill validation, packaging and `vat audit` report a document they cannot parse.** A SKILL.md
  or linked document nested too deeply for an in-process parse is a `RESOURCE_PARSE_LIMIT_EXCEEDED`
  error at that file; before, it was a link-integrity warning, `SKILL_MISSING_FRONTMATTER`, or a
  crash. A linked document the crawl refused to parse is an error too, and `vat skills build` /
  `vat skills package` refuse the skill.
- **API:** `ResourceRegistry.getParseRefusedResources()` lists every file the crawl refused to
  parse (`ParseRefusedResource`); `calculateChecksumFromContent` and `isStackOverflow` are exported
  from `@vibe-agent-toolkit/resources`. `FrontmatterError.cause` is now required, the inventory
  `ParseError` gains `parseRefused`, and `@vibe-agent-toolkit/agent-skills` exports `refusedAmong`
  and `parseRefusedMessage`.
- **A `ParseResult` you build yourself must set `frontmatterNotAMapping`.** A frontmatter block
  that is valid YAML but decodes to a sequence or a scalar no longer yields `frontmatter`; the parse
  sets `frontmatterNotAMapping: true` instead, and the projection's `blob_conditions` and the OKF
  judges read only that flag (they no longer decode `frontmatterSource` themselves). A caller that
  hands VAT a `ParseResult` it assembled must set the flag for such a block, or it is read as a
  block that declares nothing.

### Changed

- **`vat rag index` no longer parses a document of its own.** It reads each resource's text and
  chunks it by the facts the registry already derived; an HTML resource is still chunked as before,
  so the chunks it writes are unchanged. A document deep enough to overflow a parse on the indexing
  thread now indexes like any other.
- **The first run after upgrading is fully cold.** The stored parse facts changed shape, so the
  parse cache's namespace (a digest of that shape) moved and every document is parsed once again.
- **A pathological frontmatter shape is bounded too.** YAML aliases count against `outputRows` and
  `outputBytes` at their expanded size, so an anchor aliased many times is refused like the
  expanded document would be, and nothing is stored.
- **A broken install is loud.** A parse worker that dies before it is ready, or three in a row that
  die without answering, fail the run with a parser-unavailable error naming the worker entry,
  instead of reporting every file as a worker death.
- **A parse-cache entry whose stored frontmatter is corrupt is a cache miss,** parsed again in a
  worker, never an error; a failure rebuilding a fresh worker answer is a VAT defect thrown as
  `PARSE_DECODE_DEFECT`, never a finding about the file.
- **A refusal no longer depends on what ran before.** An in-process parse (skill validation,
  packaging) of a document over the input or output limits still answers, but files nothing in
  the parse cache, so a later `vat resources` or `vat rag index` crawl refuses that document as a
  cold run would.
- **The pool keeps its width across limit breaches:** a worker being killed for a breach counts
  against the pool size until it has exited, so a run never holds more live parse threads than
  `VAT_PARSE_POOL_SIZE`.

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

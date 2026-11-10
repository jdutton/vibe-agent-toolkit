### Breaking

- **`VAT_PARSE_POOL` is removed, and every document parse a crawl makes now runs in a bounded
  worker thread** — `vat resources validate | scan | check | query`, `vat rag index`, the
  inventory's projection lane, and `ResourceRegistry.addResource` / `addResources`. There is no
  in-process route for them to switch back to: a parse on the run's own thread cannot be stopped,
  so one pathological document could hang or crash the whole run. Still in-process, bounded only
  by the files a skill's link graph reaches: `parseFileCached` (skill validation and packaging,
  post-build checks, the CLI's skill discovery), direct `parseMarkdown` calls, and the skill lane's
  frontmatter decode. A stack overflow in `parseFileCached` now falls back to one bounded parse
  through the pool, so its answer is the worker's, cold or warm. Setting the variable now
  does nothing; delete it from CI and scripts. A small run that used to parse on the main thread
  now starts one worker, which costs a cold small corpus a measured fraction of a second (numbers in
  `docs/architecture/fact-extractors-limits.md`). `VAT_PARSE_POOL_SIZE` and
  `VAT_PARSE_POOL_MIN_MISSES` still size the pool.
- **`ParsePoolPolicy.enabled` is removed** from `@vibe-agent-toolkit/resources`. A policy now
  takes `limits` (a partial `ParseLimits`) instead; pass nothing to get the defaults.
- **A document over a parse limit now fails `vat resources validate`.** It is reported as
  `RESOURCE_PARSE_LIMIT_EXCEEDED` at error severity, so the run exits 1. A document whose parse
  worker dies is reported the same way, as `RESOURCE_PARSE_WORKER_DIED`. Set
  `severity.RESOURCE_PARSE_LIMIT_EXCEEDED` to `warning` (or `allow` the one file) to keep a
  known-pathological file from failing the validating and reporting verbs while you fix or exclude
  it. That advice does not reach packaging: `vat skills build` / `vat skills package` refuse a
  skill that reaches a refused file whatever its severity, because a package never ships a document
  VAT could not read.
- **`ResourceRegistry.addResource` throws `ParseLimitError` when one document's parse breaches a
  limit**, and `ParseWorkerDiedError` when the worker holding it dies; `addResources` records both
  as findings instead. Both are exported from `@vibe-agent-toolkit/resources`, with
  `isParseLimitError`, `isParseWorkerDiedError` and the `ParseLimits` type.
- **`vat resources scan` and `vat rag index` now exit 1 for a file the crawl could not parse.**
  Each such file is an error finding under its refusal code (`RESOURCE_PARSE_LIMIT_EXCEEDED` or
  `RESOURCE_PARSE_WORKER_DIED`) and counts in `examined`; before, it was silently left out and the
  run exited 0. `vat resources scan` also reports a file it could not read as `RESOURCE_UNREADABLE`.
  Fix or exclude the file, or set its severity to `warning` or `allow` it (packaging still
  refuses it — see above).
- **One contract for a file a crawl enumerated and did not admit, in every crawling verb.**
  `vat resources validate`, `vat resources scan` and `vat rag index` now report an unreadable or
  parse-refused file with the same code and sentence, at the severity `resources.validation` gives
  it (`scan` and `rag index` ignored it before), and count it in `examined` (`validate` did not).
  Under `--collection`, `validate` and `scan` count and report it only when that collection's own
  patterns match it; `scan` reported every one before. `vat rag index` reports an unreadable file as
  `RESOURCE_UNREADABLE`, no longer as `RAG_DOCUMENT_INDEX_FAILED`, which now means only that the
  provider could not chunk or embed an admitted document.
- **`vat resources check` fails on a file whose parse it refused.** No check can see that file's
  rows, so each one is a finding at it under its refusal code, an error by default (exit 1),
  resolved through the whole `resources.validation` like every other verb: an `allow` entry naming
  the file clears it, and `severity` sets its level. Every `vat resources check` finding with a
  registry code now carries its `reference`, as other verbs' findings do — a killed run's rebuilt
  findings included. `vat resources query` still answers over the rows it
  has and names the refusal on stderr.
- **`parseMarkdown` and `parseHtml` throw on a stack overflow** — a document nested too deeply for
  the calling thread — instead of returning a partial result or a frontmatter error. Classify it
  with `isStackOverflow` from `@vibe-agent-toolkit/resources`; the bounded crawl never throws it, it
  refuses the file (`stackMb`). `parseFileCached` never throws it either: it re-parses the document
  once through a one-thread bounded pool and returns that answer, or throws the pool's
  `ParseLimitError` / `ParseWorkerDiedError`; it is now exported from the dispatcher module, still
  through the `@vibe-agent-toolkit/resources` barrel.
- **`BlobPopulationResult` has two new required counters,** `blobsParseLimited` and
  `blobsParseWorkerDied`. A caller that builds one must set them.
- **`@vibe-agent-toolkit/rag-lancedb` `indexResources` parses nothing.** It trusts each resource's
  facts as the registry derived them and reads only its text, so a resource's `checksum` must be
  `calculateChecksumFromContent` of that text (a mismatch is the resource's error and nothing is
  written for it). It no longer throws `ParserUnavailableError`.
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
  and `SKILL_REACHED_REFUSAL_CONSEQUENCE`. The not-admitted contract is exported from
  `@vibe-agent-toolkit/resources` (`ResourceRegistry.getNotAdmitted()`, `notAdmittedIssues`,
  `notAdmittedFindings`, `notAdmittedInScope`, `notAdmittedCount`, `parseRefusedEntry`,
  `parseRefusedMessage(entry, location, consequence)`, `inProcessRefusalEntry`), with
  `isPerRunParseRefusal`, `isPlainMapping` (the one rule for what a frontmatter root may be) and
  `parseRefusedRealizations` (a population's refused files, as `ParseRefusedResource` entries; the
  `RefusedRealization` type is gone). `ParseRefusedResource` carries `code` and `reason` and no
  longer `error`. `@vibe-agent-toolkit/schema` exports `resolveFindings` (the allow filter and
  severity, for findings reported beside no framework run) — the one finding resolver; the CLI's
  private `resolveIssueSeverity` is deleted. `@vibe-agent-toolkit/agent-skills`'s
  `stackOverflowIssue` is replaced by `inProcessRefusalIssue`. The inventory's
  `InventoryPopulation` gains a required `parseRefusedAmong`.
- **A `ParseResult` you build yourself must set `frontmatterNotAMapping`.** A frontmatter block
  that is valid YAML but decodes to a sequence, a scalar or a typed value (`!!set`, `!!omap`,
  `!!timestamp`, `!!binary`) no longer yields `frontmatter`; the parse
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
- **A pathological frontmatter shape is bounded too.** Frontmatter counts against `outputRows` and
  `outputBytes` as exactly the JSON the store writes for it: every array element and every mapping
  entry is a row, YAML aliases count at their expanded size, and a `!!binary` counts as its stored
  JSON (one row per byte), never its base64. So an anchor aliased many times, or a multi-megabyte
  binary, is refused like the stored document would be, and nothing is stored.
- **The skill lane reads one frontmatter shape rule with the crawl.** A `!!set`, `!!omap`,
  `!!timestamp` or `!!binary` frontmatter root is "not a YAML mapping" in skill validation too
  (`SKILL_MISSING_FRONTMATTER`), where it used to pass as an empty mapping; an empty block is
  refused as empty, never as "not a mapping".
- **A link anchor into a file whose parse was refused is `LINK_TARGET_UNREADABLE`,** naming the
  refusal, as for an unreadable file — never a silent skip and never a broken anchor.
- **One sentence for a refused file in every lane.** `vat resources check`, both inventory lanes and
  skill validation name a refused file by its project-relative path in the sentence `vat resources
  validate` uses, and two files with identical bytes each name their own path.
- **Bundled assets share one parse dispatcher,** so a broken install fails `vat skills build` as
  parser-unavailable instead of refusing the first asset as a worker death.
- **A broken install is loud.** A parse worker that dies before it is ready, or three in a row that
  die without answering, fail the run with a parser-unavailable error naming the worker entry,
  instead of reporting every file as a worker death.
- **A parse-cache entry whose stored frontmatter is corrupt is a cache miss,** parsed again in a
  worker, never an error; a failure rebuilding a fresh worker answer is a VAT defect thrown as
  `PARSE_DECODE_DEFECT`, never a finding about the file.
- **A refusal no longer depends on what ran before.** No parse files a parse-cache entry a
  default run would refuse — an in-process parse (skill validation, packaging), or a pool run under
  looser limits — so a later `vat resources` or `vat rag index` crawl refuses that document as a
  cold run would.
- **A heap refusal names the ceiling that stopped it.** When V8 stops a worker at its own ceiling
  before the pool's sampler does, the refusal names that ceiling — twice the bound the sampler
  enforces — or says it is unknown when no sample landed; it never names the sampler's bound, or the
  configured `heapMb`, as the one that applied.
- **A worker stopped at `timeMs` before its parser loaded counts toward the broken-install
  breaker,** like a worker that died without answering.
- **The pool keeps its width across limit breaches:** a worker being killed for a breach counts
  against the pool size until it has exited, so a run never holds more live parse threads than
  `VAT_PARSE_POOL_SIZE`.

### Added

- **Every parse a crawl or `addResource` makes has limits: wall clock, heap, stack depth, output
  depth, output rows, output bytes and input size** (the in-process lanes named under Breaking
  above are bounded only by a skill's link graph, plus the overflow fallback). `outputDepth` (default 1,000, and never above it: SQLite's `json_extract` reads
  no deeper) refuses frontmatter nested past what the projection can query, and a cyclic anchor. Time and heap breaches kill and replace the worker; stack and output breaches are
  reported by it; input size is refused before dispatch. Each breach refuses that one file, naming
  it and the limit; every other file keeps its rows, and the run completes. Nothing about a breach
  is stored, so the next run parses the file again. The projection reports it as
  `BLOB_PARSE_LIMIT_EXCEEDED` ("over a parse limit" in the refusal summary), and `vat resources
  validate` as the new error finding `RESOURCE_PARSE_LIMIT_EXCEEDED`. A worker that dies holding a
  job is the same kind of per-run outcome: `BLOB_PARSE_WORKER_DIED` ("parse worker died") and
  `RESOURCE_PARSE_WORKER_DIED`, never stored, never a parse failure of the file. `heapMb` bounds
  a worker's whole used heap and is enforced by the pool, never by V8's own ceiling: a worker that
  reaches V8's ceiling can take the whole process down with it, so that ceiling sits at twice
  `heapMb`, and under a process-wide `--max-old-space-size` lower than that the job is stopped at
  half the flag's value, which the refusal names.
- **Frontmatter YAML is decoded only in the parse worker,** under its limits. A block nested deep
  enough to overflow the worker's stack is a `stackMb` breach, never a `frontmatterError`. A
  1,000-level nested block that used to overflow the main thread on a parse-cache hit now parses
  on every run.

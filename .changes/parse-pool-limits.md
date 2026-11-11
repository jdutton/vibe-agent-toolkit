### Breaking

- **`VAT_PARSE_POOL` is removed, and every markdown and HTML parse VAT makes now runs in a
  bounded worker thread** — every crawl (`vat resources validate | scan | check | query`, `vat rag
  index`, the inventory's projection lane, `ResourceRegistry.addResource` / `addResources`), skill
  validation, packaging and post-build checks, the CLI's skill discovery, `vat audit`, and the skill
  lane's frontmatter decode. There is no in-process route left to switch back to: a parse on the
  run's own thread cannot be stopped, so one pathological document could hang or crash the whole
  run. Setting the variable now does nothing; delete it from CI and scripts. A small run that used to parse on the main thread
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
- **`vat resources check` fails on every file the population enumerated and did not admit** — one
  whose parse it refused, and one it could not read, that was over the input size, that changed under
  the run or whose parse failed (`RESOURCE_UNREADABLE`, as `vat resources validate` and `scan` report
  an unreadable file). No check can see that file's rows, so each one is a finding at it under the
  not-admitted contract's code, an error by default (exit 1), computed before the checks run so a
  killed run's report carries it too,
  resolved through the whole `resources.validation` like every other verb: an `allow` entry naming
  the file clears it, and `severity` sets its level. Every `vat resources check` finding with a
  registry code now carries its `reference`, as other verbs' findings do — a killed run's rebuilt
  findings included. `vat resources query` still answers over the rows it
  has and names the refusal on stderr.
- **Every public parse function is asynchronous and bounded, and the in-process ones are gone.**
  `parseMarkdown` and `parseHtml` are deleted: use `parseFileCached(path, kind, route?)`, or
  `parseContentCached(content, kind, route?)` for text you hold. Both read the parse cache and, on a
  miss, parse in a worker under the default limits: through the `ParseDispatcher` you pass as
  `route.dispatcher` (build one with `withParseDispatcher(work)`, which shuts it down) when you
  parse many documents, or a one-thread pool started and shut down for that call. A document over a
  limit throws `ParseLimitError` / `ParseWorkerDiedError`; nothing throws a stack overflow any more.
  `parseKeyed`, `loadParser`, `LoadedParser`, `importParserModule` and `isStackOverflow` are no
  longer exported, and the `./link-parser`, `./remark-parser` and `./markdown-processor` package
  subpaths are deleted (`./parse-conformance` remains, for testing a parser implementation).
  `@vibe-agent-toolkit/agent-skills`: `parseFrontmatter(content, route?)`, `readDeclaredSkillName`,
  `declaredSkillNameIn`, `runCompatDetectors` (whose route is now required),
  `allowedToolsDeclarations` and `collectLocalShellEvidence` return promises, and
  `bundledPathCandidates(path, route)` takes a route; `ValidateOptions` and
  `SkillValidationSharedContext` take an optional `dispatcher`. `@vibe-agent-toolkit/claude-marketplace`:
  `scanFrontmatter` and `scanCodeBlocks` return promises, `ClaudeSkillInventoryOptions` takes a
  `dispatcher`, and `readPluginLocalSkillName(skillSourceDir, dispatcher?)` drops its
  `skillDirPath` parameter. `parseFrontmatter` now takes its value from the worker's decode, so a
  cyclic anchor or a block nested past `outputDepth` is refused there exactly as the crawl refuses
  it, and its "not a YAML mapping" message no longer names the decoded type.
- **`BlobPopulationResult` has two new required counters,** `blobsParseLimited` and
  `blobsParseWorkerDied`. A caller that builds one must set them.
- **`@vibe-agent-toolkit/rag-lancedb` `indexResources` parses nothing.** It trusts each resource's
  facts as the registry derived them and reads only its text, so a resource's `checksum` must be
  `calculateChecksumFromContent` of that text (a mismatch is the resource's error and nothing is
  written for it). It no longer throws `ParserUnavailableError`.
- **`vat rag index` refuses a document that changed after the crawl.** It is a
  `RAG_DOCUMENT_INDEX_FAILED` error and is not indexed; re-run to index the current content.
- **Skill validation, packaging and `vat audit` report a document they cannot parse.** A SKILL.md
  or linked document over a parse limit is a `RESOURCE_PARSE_LIMIT_EXCEEDED` error at that file; before, it was a link-integrity warning, `SKILL_MISSING_FRONTMATTER`, or a
  crash. A linked document the crawl refused to parse is an error too, and `vat skills build` /
  `vat skills package` refuse the skill.
- **API:** `ResourceRegistry.getParseRefusedResources()` lists every file the crawl refused to
  parse (`ParseRefusedResource`); `calculateChecksumFromContent` is exported
  from `@vibe-agent-toolkit/resources`. `FrontmatterError.cause` is now required, the inventory
  `ParseError` gains `parseRefused`, and `@vibe-agent-toolkit/agent-skills` exports `refusedAmong`
  and `SKILL_REACHED_REFUSAL_CONSEQUENCE`. The not-admitted contract is exported from
  `@vibe-agent-toolkit/resources` (`ResourceRegistry.getNotAdmitted()`, `notAdmittedIssues`,
  `notAdmittedFindings`, `notAdmittedInScope`, `notAdmittedCount`, `parseRefusedEntry`,
  `parseRefusedMessage(entry, location, consequence)`, `parseRefusedEntryFor`, `parseRefusal`), with
  `isPerRunParseRefusal`, `classifyParseFailure` (the one answer to whose fault a per-file parse
  failure is: an allowlist that rethrows every VAT defect), `isPlainMapping` (the one rule for what
  a frontmatter root may be),
  `notAdmittedRealizations(rows, root)` (every file a population did not admit, as a `NotAdmittedLog`
  of unreadable and parse-refused entries; it replaces `parseRefusedRealizations`, and the
  `RefusedRealization` type is gone) and `resolveNotAdmittedAmong`. `ParseRefusedResource` carries `code` and `reason` and no
  longer `error`. `@vibe-agent-toolkit/schema` exports `resolveFindings` (the allow filter and
  severity, for findings reported beside no framework run) — the one finding resolver; the CLI's
  private `resolveIssueSeverity` is deleted. `@vibe-agent-toolkit/agent-skills`'s
  `stackOverflowIssue` is replaced by `parseRefusalIssue`. The inventory's
  `InventoryPopulation` gains a required `parseRefusedAmong`, and an inventory `ParseError` for a
  refused file carries its reason in `message` and its code in `parseRefused`, never a finished
  sentence: `vat audit` builds the sentence at its own boundary.
- **A `ParseResult` you build yourself must set `frontmatterNotAMapping`.** A frontmatter block
  that is valid YAML but decodes to a sequence, a scalar or a typed value (`!!set`, `!!omap`,
  `!!timestamp`, `!!binary`) no longer yields `frontmatter`; the parse
  sets `frontmatterNotAMapping: true` instead, and the projection's `blob_conditions` and the OKF
  judges read only that flag (they no longer decode `frontmatterSource` themselves). A caller that
  hands VAT a `ParseResult` it assembled must set the flag for such a block, or it is read as a
  block that declares nothing.

- **`vat claude context` reads memory files in the parse worker.** Claude Code's memory-file facts
  (the `marked` lexer and frontmatter split behind `harness_blob_facts`) run under the pool's limits;
  a file over a limit is refused for the run (`BLOB_PARSE_LIMIT_EXCEEDED` / `BLOB_PARSE_WORKER_DIED`,
  named in the refusal summary), its imports are not followed, and every other file keeps its facts.
  API: `HarnessProfile.factsOf` is removed; `runHarnessPass` takes a required `deriveFacts` and its
  result has a `refused` count; `afterClosurePromotion` takes a required `dispatcher`;
  `PopulateOptions` has no `parsePool` option.
- **The projection's query surface changed for frontmatter and refusals** (`vat resources query` /
  `check` statements read these directly). `blob_conditions` has two new codes,
  `BLOB_PARSE_LIMIT_EXCEEDED` and `BLOB_PARSE_WORKER_DIED`, for a per-run refusal. A frontmatter block
  that is valid YAML but not a plain mapping (a sequence, a scalar, or a `!!set`, `!!omap`,
  `!!timestamp` or `!!binary` root) now leaves `blobs.frontmatter` NULL, where a typed root used to be
  stored as a value, and sets `blobs.frontmatterError` to the sentence "the frontmatter block is valid
  YAML but not a YAML mapping — it decodes to a sequence, a scalar or a typed value (!!set, !!omap,
  !!timestamp, !!binary), so it declares no keys at all". No column or table was renamed, so there is
  no rename map (ADR P4's rename map covers renames, and none applies); a statement that read a typed
  root out of `blobs.frontmatter`, or matched an old `frontmatterError` text, must be updated.

- **`checkSettingsCompatibility` takes a required `dispatcher`** (`@vibe-agent-toolkit/claude-marketplace`):
  the run's parse dispatcher, held across every plugin it checks, so a run starts one worker pool
  rather than one per plugin. Open one with `withParseDispatcher` from
  `@vibe-agent-toolkit/resources` around the run and pass it to each call.
- **`analyzeCompatibility` takes a required `dispatcher`** (`@vibe-agent-toolkit/claude-marketplace`),
  `analyzeCompatibility(pluginDir, locationRoot, dispatcher, options?)`: it no longer opens a worker
  pool of its own per plugin. Open one with `withParseDispatcher` around the run, as for
  `checkSettingsCompatibility`. Its per-file catch, and any caller's catch around either entry,
  classifies through the new `classifyCompatibilityFailure` export (a plugin's malformed manifest,
  a per-run refusal, the parser's throw over the bytes or a read the OS refused is the plugin's;
  every VAT defect is rethrown). A manifest with no `name` is now a `SyntaxError`.
- **`vat audit` resolves a refused document through the audited project's `resources.validation`.**
  A `RESOURCE_PARSE_LIMIT_EXCEEDED`, `RESOURCE_PARSE_WORKER_DIED` or `RESOURCE_UNREADABLE` finding is
  cleared by an `allow` entry naming the file (matched at its project-relative path) and set by
  `severity`, and is located from the one root the audit reports from.
- **`validation.allow` now applies in `vat claude marketplace validate`, the packaged-content phase
  of `vat verify`, and every `vat resources check` finding.** `verify` reads each skill's packaging
  validation (`skills.defaults` / `skills.config.<name>`, paths relative to the working directory);
  `claude marketplace validate` reads `skills.defaults.validation` (paths relative to the marketplace
  directory; skills inside a marketplace still get `severity` only); `resources check` reads
  `resources.validation` (paths relative to the project root). These verbs keep no allow ledger, so an
  entry used only by them is never reported as `ALLOW_UNUSED` or `ALLOW_EXPIRED`, and an expired
  entry that matches still clears its finding there.

### Changed

- **`vat rag index` no longer parses a document of its own.** It reads each resource's text and
  chunks it by the facts the registry already derived; an HTML resource is still chunked as before,
  so the chunks it writes are unchanged. A document deep enough to overflow a parse on the indexing
  thread now indexes like any other.
- **The first run after upgrading is fully cold.** The stored parse facts changed shape, so the
  parse cache's namespace (a digest of that shape) moved and every document is parsed once again.
- **A pathological frontmatter shape is bounded too.** Frontmatter counts against `outputRows`,
  `outputBytes` and `outputDepth` as exactly what crosses the wire and the store writes for it: every
  array element and every mapping entry is a row, YAML aliases count at their expanded size, a
  `!!binary` counts as its stored JSON (one row per byte), never its base64, and a `!!set` / `!!omap`
  counts every member and entry it carries (a million-member set, a set nested 3,000 deep and a set
  that contains itself are refused). So an anchor aliased many times, or a multi-megabyte
  binary, is refused like the stored document would be, and nothing is stored.
- **The skill lane reads one frontmatter shape rule with the crawl.** A `!!set`, `!!omap`,
  `!!timestamp` or `!!binary` frontmatter root is "not a YAML mapping" in skill validation too
  (`SKILL_MISSING_FRONTMATTER`), where it used to pass as an empty mapping; an empty block is
  refused as empty, never as "not a mapping".
- **A skill whose `SKILL.md` parse was refused has no name — never its directory's, never a
  fallback.** `vat skills validate` and `vat skills list` report it as a
  `RESOURCE_PARSE_LIMIT_EXCEEDED` / `RESOURCE_PARSE_WORKER_DIED` finding; `vat skills build`,
  `vat claude plugin build`, `vat verify`, `vat ard emit`, `vat skill test configure`,
  `vat claude plugin install` and `vat claude org skills` uploads refuse the run (exit 2) naming
  the file and the limit; `vat audit` validates it config-free and reports the refusal on the file.
  Reading `name` or `allowed-tools` from a refused block throws the refusal instead of answering
  "declares nothing".
- **`vat okf validate` names an unreadable document's real errno** (`EACCES`), not `FS_FAULT`.
- **A link anchor into a file whose parse was refused is `LINK_TARGET_UNREADABLE`,** naming the
  refusal, as for an unreadable file — never a silent skip and never a broken anchor.
- **One sentence for a refused file in every lane.** `vat resources check`, both inventory lanes and
  skill validation name a refused file by its project-relative path in the sentence `vat resources
  validate` uses, and two files with identical bytes each name their own path.
- **Bundled assets share one parse dispatcher,** so a broken install fails `vat skills build` as
  parser-unavailable instead of refusing the first asset as a worker death.
- **A broken install is loud.** A parse worker that dies before it is ready, or three in a row that
  die without answering, fail the run with a parser-unavailable error naming the worker entry,
  instead of reporting every file as a worker death. Every per-file parse catch — skill validation,
  both inventory catches, `vat okf validate`, plugin compatibility analysis, `vat audit`'s two
  compat lanes (compatibility and `--settings`) and the parse-fact oracle — classifies what it
  caught through one allowlist, so a broken install or any other VAT defect fails the run:
  `vat audit` and `vat inventory` no longer file it as a `link walk failed` row on `SKILL.md`, or a
  plugin "that could not be analyzed", and exit 0.
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
- **Heap is judged on what a job holds, not on garbage.** A used heap past `heapMb` is a breach
  only once an old-generation collection shows it is held, or once it passes a stop halfway to V8's
  ceiling with no collection; a document whose live heap is far under the bound (a 10,000-level
  blockquote, about 420 MiB) is no longer refused on a loaded machine. Under a small
  `--max-old-space-size` the applied bound is floored at 96 MiB while V8's ceiling leaves room, so an
  ordinary document is admitted under a 128 MiB flag.
- **A parse that answered just as its time ran out is admitted.** The wall-clock limit decides only
  after the worker's queued messages are read, and a stop the busy parent itself made late never
  counts toward the broken-install breaker.
- **The pool keeps its width across limit breaches:** a worker being killed for a breach counts
  against the pool size until it has exited, so a run never holds more live parse threads than
  `VAT_PARSE_POOL_SIZE`.

### Added

- **Every parse a crawl or `addResource` makes has limits: wall clock, heap, stack depth, output
  depth, output rows, output bytes and input size** (every parse VAT makes, per the first Breaking
  entry above). `outputDepth` (default 1,000, and never above it: SQLite's `json_extract` reads
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

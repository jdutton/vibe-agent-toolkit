### Breaking

- **A document over a parse limit now fails `vat resources validate`.** It is reported as
  `RESOURCE_PARSE_LIMIT_EXCEEDED` at error severity, so the run exits 1; a document whose parse
  worker dies is reported the same way, as `RESOURCE_PARSE_WORKER_DIED`. Set
  `severity.RESOURCE_PARSE_LIMIT_EXCEEDED` to `warning` (or `allow` the one file) under
  `resources.validation` to keep a known-pathological file from failing the validating and
  reporting verbs while you fix or exclude it. That does not reach packaging: `vat skills build` /
  `vat skills package` refuse a skill that reaches a refused file whatever its severity, because a
  package never ships a document VAT could not read.
- **`vat resources scan` and `vat rag index` now exit 1 for a file the crawl enumerated and did not
  admit** — one it could not read (`RESOURCE_UNREADABLE`) or whose parse it refused
  (`RESOURCE_PARSE_LIMIT_EXCEEDED`, `RESOURCE_PARSE_WORKER_DIED`). Each is an error finding counted
  in `examined`, under the same code and sentence `vat resources validate` reports it with. Fix or
  exclude the file, or set its severity to `warning` or `allow` it (packaging still refuses it).
- **`vat rag index` refuses a document that changed after the crawl.** It is an error finding
  (`RAG_DOCUMENT_INDEX_FAILED`) and is not indexed; re-run to index the current content.
- **Skill validation, packaging and `vat audit` report a document they cannot parse, and refuse
  to ship it.** A `SKILL.md` or linked document over a parse limit is a
  `RESOURCE_PARSE_LIMIT_EXCEEDED` error at that file, where it used to be a link-integrity warning,
  `SKILL_MISSING_FRONTMATTER`, or a crash. In every skill lane that reports (`vat skills
  validate`/`build`/`list`, `vat skill review`, `vat audit`, `vat claude marketplace validate`)
  these codes are resolved through the project's `resources.validation` alone — a skill's own
  `validation` does not move them, and an `allow` entry there naming the file clears the finding.
  `allow` governs reporting only: the packager refuses every refused file a skill reaches,
  `SKILL.md` included, before anything is written, so `vat skills validate` can exit 0 under an
  `allow` entry while `vat skills build` (and `vat claude plugin build`, `vat agent build`, `vat
  skill test`, `vat skills package`) refuses the skill. `vat skills package` and `vat skills
  install` read no project config.
- **A `!!set`, `!!omap`, `!!timestamp` or `!!binary` frontmatter root fails skill validation.** It
  is "not a YAML mapping" (`SKILL_MISSING_FRONTMATTER`), where it used to pass as an empty mapping;
  an empty block is refused as empty.
- **`parseMarkdown` and `parseHtml` are deleted from `@vibe-agent-toolkit/resources`; every parse
  is asynchronous and runs in a bounded worker.** Use `parseFileCached(path, kind, route)`, or
  `parseContentCached(content, kind, route)` for text you hold, the route required —
  `{ dispatcher: undefined }` for the default route: each reads the parse cache and, on
  a miss, parses in a worker under the default limits — through the `ParseDispatcher` you pass as
  `route.dispatcher` (open one with `withParseDispatcher(work)`, which shuts it down) when you
  parse many documents, or a one-thread pool started and shut down for that call. A document over a
  limit throws `ParseLimitError` / `ParseWorkerDiedError`; nothing throws a stack overflow.
- **`ResourceRegistry.addResource` throws `ParseLimitError` when one document's parse breaches a
  limit**, and `ParseWorkerDiedError` when the worker holding it dies; `addResources` records both
  as findings instead (`getParseRefusedResources()`, `getNotAdmitted()`).
- **A `ParseResult` you build yourself must set `frontmatterNotAMapping`.** A frontmatter block that
  is valid YAML but decodes to a sequence, a scalar or a typed value (`!!set`, `!!omap`,
  `!!timestamp`, `!!binary`) no longer yields `frontmatter`; the parse sets
  `frontmatterNotAMapping: true` instead, and a `ParseResult` assembled without the flag is read as
  a block that declares nothing.
- **`@vibe-agent-toolkit/agent-skills` frontmatter readers are asynchronous and take a route,
  required.** `parseFrontmatter(input, route)` and `readDeclaredSkillName(path, route)` return
  promises; pass `{ dispatcher }` inside a run, `{ dispatcher: undefined }` for one read. `parseFrontmatter` takes the
  content with the size of the bytes it came from: pass `readContentForParse`'s result for a file,
  `inMemoryContent(text)` for text you hold.
  `parseFrontmatter` takes its value from the worker's decode, so a cyclic anchor or a block nested
  past `outputDepth` is refused there exactly as the crawl refuses it, and its "not a YAML mapping"
  message no longer names the decoded type. `readDeclaredSkillName` throws the refusal for a
  `SKILL.md` whose parse was refused, or one past the input cap, rather than answering "declares no
  name". `FrontmatterError.cause` is required.
  `runCompatDetectors(content, filePath, locationRoot, frontmatter)` takes the frontmatter the
  caller parsed once (from the new `detectorFrontmatter(input, route)`) and stays synchronous.
- **Every skill validation lane takes the project's `resources.validation` from its caller, as a
  required field** (`{}` where no project config governs the run): `validateSkillForPackaging(
  skillPath, resourcesValidation, packagingConfig?, context?, shared?)` takes it as its new second
  argument, and `ValidateOptions.resourcesValidation` (`validateSkill`) is required. The packager
  takes no such field: it refuses a refused file whatever the config.
- **`@vibe-agent-toolkit/agent-skills` skill validation takes the run's parse dispatcher, as a
  required field.** Set `dispatcher` on `ValidateOptions` (`validateSkill`) and on
  `SkillValidationSharedContext`: the run's `ParseDispatcher`, or `undefined` for the validation to
  open one of its own.
- **`@vibe-agent-toolkit/claude-marketplace` compatibility checks take the run's parse
  dispatcher, required.** `analyzeCompatibility(pluginDir, locationRoot, dispatcher, options?)` and
  `checkSettingsCompatibility(pluginDir, effectiveSettings, dispatcher)` no longer open a worker
  pool per plugin: open one with `withParseDispatcher` around the run and pass it to each call. A
  plugin manifest with no `name` is a `SyntaxError`. A markdown file past the parse input cap is
  listed under `unchecked` (in `vat audit --compat` too), naming the limit.
- **`@vibe-agent-toolkit/rag-lancedb` `indexResources` parses nothing.** It trusts each resource's
  facts as the registry derived them and reads only its text, so a resource's `checksum` must be
  `calculateChecksumFromContent` of that text (a mismatch is the resource's error and nothing is
  written for it).

### Changed

- **Every markdown, HTML and `text/plain` parse runs in a worker thread**, where it used to run on
  the command's own thread — every crawl (`vat resources validate | scan`, `vat rag index`,
  `ResourceRegistry.addResource` / `addResources`), skill validation, packaging and post-build
  checks, the CLI's skill discovery, `vat audit`, and the skill lane's frontmatter decode. A small
  run starts a worker for each parse pool it holds open at once (two for a cold `vat build`; an
  idle worker is handed from one pool to the next rather than closed), which costs a cold small
  corpus a measured fraction of a second (numbers in `docs/architecture/fact-extractors-limits.md`).
  `VAT_PARSE_POOL_SIZE` caps the live parse threads, `VAT_PARSE_POOL_MIN_MISSES` sets how many cache
  misses start more than one, and `VAT_PARSE_LOOK_AHEAD` how far reading runs ahead of parsing.
- **`vat rag index` no longer parses a document of its own.** It reads each resource's text and
  chunks it by the facts the registry derived; an HTML resource is chunked as before, so the chunks
  it writes are unchanged, and a document deep enough to overflow a parse on the indexing thread
  indexes like any other.
- **`validation.allow` now applies in `vat claude marketplace validate` and the packaged-content
  phase of `vat verify`.** `verify` reads each skill's packaging validation (`skills.defaults` /
  `skills.config.<name>`, paths relative to the working directory); `claude marketplace validate`
  reads `skills.defaults.validation` (paths relative to the marketplace directory; skills inside a
  marketplace still get `severity` only). Neither keeps an allow ledger, so an entry used only by
  them is never reported as `ALLOW_UNUSED` or `ALLOW_EXPIRED`, and an expired entry that matches
  still clears its finding there.

### Added

- **Every parse has limits: wall clock, heap, stack depth, output depth, output rows, output bytes
  and input size** (`ParseLimits`; `ParsePoolPolicy.limits` takes a partial set, nothing for the
  defaults). Time and heap breaches kill and replace the worker; stack and output breaches are
  reported by it. Each breach refuses that one file, naming it and the limit; every other file keeps
  its rows, and the run completes. Nothing about a breach is stored, so the next run parses the
  file again, and no parse files a cache entry a default run would refuse, so a refusal never
  depends on what ran before. `vat resources validate` reports a breach as
  `RESOURCE_PARSE_LIMIT_EXCEEDED`, a worker that died holding the job as
  `RESOURCE_PARSE_WORKER_DIED`; the projection as `BLOB_PARSE_LIMIT_EXCEEDED` / `BLOB_PARSE_WORKER_DIED`
  ("over a parse limit" / "parse worker died" in the refusal summary).
  - **Input size.** A file a parser reads — markdown, HTML, or `text/plain` prose, which routes to
    the markdown parser — over `inputBytes` is refused by its size before it is read, on every lane
    that reads one to parse it: every crawl, `parseFileCached`, and every lane that reads a
    `SKILL.md` for its frontmatter (`readContentForParse`, under the run's dispatcher's cap). The
    refusal names the cap and no size. Content handed over already in memory is refused whole by its
    UTF-8 byte length at the same cap — a frontmatter read included, never cut down to a block that
    fits — and a ZIP entry's `SKILL.md` (`vat claude org skills install`) by its own bytes: its
    declared size, before it is inflated. Re-reads that hand nothing to a parser are not held to the
    cap: the skill validator's compat-detector re-read of a linked file it already parsed and its
    implicit-reference scan, the packager's link read-back of packaged markdown, and the
    compatibility analyzer's Python import scan. On the projection lane it is a realization with `contentState: 'oversize'` and no blob, and
    every verb reports it as `RESOURCE_PARSE_LIMIT_EXCEEDED`.
  - **Time.** `timeMs` counts only a document's own parse; a slow thread start or parser load never
    refuses the document. A document ends within about four `timeMs`.
  - **A broken install fails the run.** Three load-clock stops in a row for one parser kind, with
    that parser loaded nowhere between them, fail the run as parser-unavailable
    (`ParserUnavailableError`, naming the worker entry); a document stopped at its load clock on
    three threads ends as parser-unavailable itself. So do a worker that dies before it is ready and
    three in a row that die without answering. A thread that dies before the document's parser has
    loaded is never that document's death: the document runs again on another thread, and ends as
    parser-unavailable if that happens on three. Every per-file parse catch classifies what it caught
    through one allowlist (`classifyParseFailure`), so a broken install or any other VAT defect
    fails the run rather than filing a finding about the file.
  - **Heap.** `heapMb` bounds a worker's whole used heap; a document past it is refused, before
    V8's own ceiling (twice `heapMb`) is reached. A `heapMb` below 64 MiB, under which a thread
    can reach V8's own ceiling and abort the process, is refused as a configuration error. A
    thread reused for another document starts it holding at most what a fresh thread does plus an
    eighth of the bound, or is replaced. A process-wide
    `--max-old-space-size`, `--max-semi-space-size` or `--max-heap-size` that lowers V8's ceiling
    lowers the bound with it (96 MiB under a 128 MiB old space on Node 26), and the refusal names
    the bound that applied. Parse threads that got no full collection (V8's `--expose-gc` was
    refused or cleared while a thread set it up) are warned once per loaded copy of VAT
    (`VAT_PARSE_NO_COLLECTOR`); a reused thread past its bound is then replaced, not collected.
  - **Frontmatter** counts against `outputRows`, `outputBytes` and `outputDepth` as what the store
    writes for it. `outputDepth` (default 1,000, and never above it) refuses frontmatter nested
    deeper than the projection can query, and a cyclic anchor.
  - **A parse pool's `shutdown()` parks a healthy idle thread**, `unref`'d, for up to 5 s for the
    next pool of the same shape in the process, then it closes itself; a command still exits on its
    own, and a long-lived host has nothing to call.
- **One contract for a file a crawl enumerated and did not admit, in every crawling verb.**
  `vat resources validate`, `vat resources scan`, `vat rag index`, skill packaging and its
  validators, the inventory and `vat audit` report an unreadable or parse-refused file with the same
  code and sentence, naming it by its project-relative path, at the severity `resources.validation`
  gives it, counted in `examined`; under `--collection`, only when that collection's own patterns
  match it. `vat audit` resolves it through the audited project's `resources.validation` (`allow`
  matched at the project-relative path, then `severity`), from the one root it reports from. A link
  anchor into a refused file is `LINK_TARGET_UNREADABLE`, naming the refusal. Bundled assets share
  one parse dispatcher, so a broken install fails `vat skills build` as parser-unavailable rather
  than refusing the first asset.
- **A skill whose `SKILL.md` parse was refused has no name** — never its directory's. `vat skills
  validate` and `vat skills list` report it as a finding, counted in `examined` (`--skill <name>`
  selects it by its directory's name; with `--skill`, another skill's refused `SKILL.md` is not
  examined); `vat skills build`, `vat claude plugin build`, `vat verify`, `vat ard emit`, `vat skill
  test configure`, `vat claude plugin install` and `vat claude org skills` uploads refuse the run
  (exit 2) naming the file and the limit; `vat audit` validates it config-free and reports the
  refusal on the file. A skill's `validation` naming `RESOURCE_UNREADABLE`,
  `RESOURCE_PARSE_LIMIT_EXCEEDED` or `RESOURCE_PARSE_WORKER_DIED` is `CONFIG_INVALID` (exit 2),
  naming `resources.validation` as where the entry belongs.
- **`vat resources check` fails on every file the population enumerated and did not admit**, each a
  finding at it under the code `vat resources validate` reports for that file, an error by default,
  computed before the checks run so a killed run's report carries it too, and resolved through the
  whole `resources.validation` (`allow`, then `severity`). Every `vat resources check` finding with a
  registry code carries its `reference`. `vat resources query` answers over the rows it has and
  names the refusal on stderr. The projection's `blob_conditions` carries
  `BLOB_PARSE_LIMIT_EXCEEDED` and `BLOB_PARSE_WORKER_DIED`; a frontmatter block that is valid YAML
  but not a plain mapping leaves `blobs.frontmatter` NULL and sets `blobs.frontmatterError`.
- **`vat claude context` reads memory files in the parse worker**, under the pool's limits: a file
  over a limit is refused for the run and named in the refusal summary, its imports are not
  followed, and every other file keeps its facts. Its refused-file findings are resolved before
  anything is written, so the run writes one document.
- **API.** `@vibe-agent-toolkit/resources`: `ParseLimitError`, `ParseWorkerDiedError`,
  `isParseLimitError`, `isParseWorkerDiedError`, `ParseLimits`, `ParserUnavailableError`,
  `parseFileCached`, `parseContentCached` (each taking a required route), `readContentForParse`,
  `parseInputRefusal`, `MeasuredContent` / `inMemoryContent`,
  `ParseDispatcher` (its `inputBytes` the cap it runs under), `withParseDispatcher`,
  `readContentWithKey`, `readKeyedContent`, `RunContentCache` (taking no options: its reads are held to the population's
  own input cap), `calculateChecksumFromContent`, `ResourceRegistry.getParseRefusedResources()`
  (`ParseRefusedResource`, carrying `code` and `reason`) and the not-admitted contract
  (`ResourceRegistry.getNotAdmitted()`, `notAdmittedIssues`, `notAdmittedFindings`,
  `notAdmittedInScope`, `notAdmittedCount`, `notAdmittedRealizations`, `resolveNotAdmittedAmong`,
  `partitionNotAdmitted` / `NotAdmittedRoots`, `parseRefusedEntry`, `parseRefusedEntryFor`,
  `parseRefusedMessage`, `parseRefusal`, `isPerRunParseRefusal`, `classifyParseFailure`,
  `isPlainMapping`), and the `./parse-conformance` subpath for testing a parser implementation.
  `@vibe-agent-toolkit/schema`: `resolveFindings`, the one finding resolver.
  `@vibe-agent-toolkit/agent-skills`: `declaredSkillNameIn`, `detectorFrontmatter`,
  `parseRefusalIssue`, `refusedAmong`, `SKILL_REACHED_REFUSAL_CONSEQUENCE`.
  `@vibe-agent-toolkit/claude-marketplace`: `classifyCompatibilityFailure`, and a required
  `dispatcher` on `ClaudeSkillInventoryOptions` (`undefined` for one of its own); an inventory `ParseError` for a refused file carries its reason in
  `message` and its code in `parseRefused`.

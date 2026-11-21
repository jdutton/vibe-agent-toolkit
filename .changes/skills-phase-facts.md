### Breaking

- **The projection has two new blob tables, `skill_text_facts` and `skill_text_matches`**: what the
  skill validators matched in each markdown file. `vat resources query` and `check` can name them,
  and the exported projection (`exportProjection`) and its JSON Schemas carry them. A consumer that
  reads every table of an exported projection handles the two new keys. A record past 16,384
  matches or 4 MiB is not held (`skill_text_facts.held` false, no match rows), and that file is
  scanned from its text on every run, with findings unchanged; `skill_text_matches.loneSurrogates`
  records the lone surrogates a match held, as `matchText` is stored well-formed.
- **(library) `runCompatDetectors`, `collectUnqualifiedMcpToolIssues`,
  `collectNonPortableAssetReferenceIssues` and `collectNonPortableCommandIssues`
  (`@vibe-agent-toolkit/agent-skills`) take a file's skill-text record, not its text**;
  `runCompatDetectors` also takes the file's parsed frontmatter. Compute the record with `skillTextFactsOf(text, SKILL_TEXT_DECLARATION)` from `@vibe-agent-toolkit/resources`.
- **(library) `ValidateOptions.run` (`validateSkill`) is required and replaces `dispatcher`**: the
  run whose store and dispatcher the validation reads through (a `RunPopulation` or
  `RunSkillRegistries`), or `undefined` to validate with a dispatcher of its own and no store.
- **(library) `ResourcePopulationSource` has a required `storedDocument(absolutePath, parserKind)`**;
  a custom source with no store returns `undefined`. **`RunPopulationOptions.outputs` is required**:
  the trees the run writes, `[]` for a run that writes none.
- **(library) `RunPopulationOptions.questionCacheOf` is required**: the store as the run's
  stored-document questions open it, or `undefined` with no store. A caller with no store passes
  `() => Promise.resolve(undefined)`; one with a store passes a connection that does not wait on a
  lock, as the CLI's `openQuestionCache` does.
- **(library) `ParseResult.skillText` is required** (the record for markdown, `null` otherwise); a
  value you construct adds it.
- **`skill_text_facts` gains a `frontmatterFence` column (`none`, `unclosed`, `closed`)**, and the
  skill-text record (`SkillTextFacts`, `ParseResult.skillText`) gains the same `frontmatterFence`
  field: where the skill frontmatter fence rule finds a document's fences. A store or parse cache
  written before it is cold once (the shape digest moves; no version constant).
- **(library) `BlobResourceFacts` (and so `StoredDocumentFacts.facts`) carries
  `frontmatterNotAMapping`**: the parse's not-a-mapping verdict on the frontmatter block.

### Added

- **Skill discovery and skill validation read stored facts on a warm run**: with the projection
  store on, `vat validate`, `vat verify`, `vat resources validate` and `vat skills validate`
  take each `SKILL.md`'s name, frontmatter and links, and
  every skill finding's input, from the store instead of reading and parsing the file. Findings are
  unchanged. No action needed.
- **`VAT_WORK_COUNTERS` dumps `skillText.storeMiss`**: each file per run that the skills lane scanned
  from its text because the store did not serve it. On a cold or store-off run it equals the files
  scanned.
- **`VAT_WORK_COUNTERS` dumps `skillText.storeUnopened`**: once per run, when the skills lane's
  optional stored-document question was what opened the projection store or built the home
  population, and that failed (a read-only `VAT_CACHE_DIR`, say). That question now answers nothing
  and the lane reads each file itself, so a verb that never enumerates its home, such as
  `vat verify` on a project whose skills are all plugin-local, no longer refuses with exit 2. A verb
  that enumerates its home still refuses as before.
- **`VAT_WORK_COUNTERS` dumps `skillText.outsideRoot`**: each file per run the skills lane asked the
  store about that lies outside the run's root, answered without opening the store.
- **(library) The skill-text core on `@vibe-agent-toolkit/resources`**: `skillTextFactsOf`,
  `SKILL_TEXT_DECLARATION`, `skillTextDeclarationDigest`, `SkillTextFactsSchema`,
  `SKILL_TEXT_FAMILY_PATTERNS`, `EXTERNAL_CLI_BINARIES`, `frontmatterFencesOf`, the
  `StoredDocumentFacts`, `SkillTextFactsRow` and `SkillTextMatchRow` types and the record types,
  `SKILL_TEXT_HELD_LIMITS` and `DEFAULT_PARSE_LIMITS` (the default parse caps, frozen); on
  `@vibe-agent-toolkit/agent-skills`, `readSkillDocument`, `skillNameOf`, `withSkillTextRun` and
  `SkillTextRun`; on `@vibe-agent-toolkit/utils/testing`, `seededRandom`.

### Changed

- **The skills lane's store lookups never wait on another process**: when another `vat` holds the
  projection store's lock, the lookup answers nothing at once and the file is read instead, where it
  used to wait up to the store's busy timeout. A skill outside the project the command runs in (a
  `vat skill review` of a directory elsewhere) is read directly, without crawling that project.
  Findings are unchanged.
- **A frontmatter block whose lines end in a lone CR or CRLF decodes as the same block with LF
  endings in every lane** (`parseFrontmatterSource`). The whole-document parse used to call a
  lone-CR block invalid YAML, while `validateSkill` read the same file as valid. So discovery named
  such a skill from its H1, and packaging reported SKILL_MISSING_FRONTMATTER, where `validateSkill`
  accepted it. All three now agree with `validateSkill`.
- **`validateSkill` reads its SKILL.md once per validation**, through the same document mapping
  that discovery and the packaging lane use. On a store-served SKILL.md it words every frontmatter
  refusal (no opening fence, no closing fence, empty, invalid YAML, not a mapping) from stored
  facts, with no read of the file. `vat verify` no longer reads and keys each built SKILL.md twice.
- **When the parse of a SKILL.md is refused (a limit, a dead worker), `validateSkill` reports that
  refusal as its only issue**, as the packaging lane does. Before, it read the frontmatter block
  alone and then reported the refusal from the link walk, beside findings made from the frontmatter.
- **The parse cache and the projection store start cold once after upgrading**: both hold the new
  skill-text facts. No action needed.
- **Some runs still scan skill text themselves (time only; findings are unchanged)**: `vat audit`,
  the marketplace compatibility analyzer and `vat claude org` open no store and scan every file they
  check, and `vat audit`'s packaging lane rebuilds each bundled markdown file's skill-text record on
  the main thread though the crawl's parse already computed one in the worker (the SKILL.md is no
  longer computed twice); on a cold run with the store on, the skills lane scans each bundled markdown file though its
  parse already computed the same facts; a warm run reads and scans a linked file that is not
  plain UTF-8 (a BOM, UTF-16) itself, as its findings come from the raw reading; a warm
  `vat claude plugin build` still reads and scans some of the skills it packages; and
  `vat skills package` and `vat skill test run` can enumerate the project a second time.

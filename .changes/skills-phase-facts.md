### Breaking

- **The projection has two new blob tables, `skill_text_facts` and `skill_text_matches`**: what the
  skill validators matched in each markdown file. `vat resources query` and `check` can name them,
  and the exported projection (`exportProjection`) and its JSON Schemas carry them. A consumer that
  reads every table of an exported projection handles the two new keys. A record past 16,384
  matches or 4 MiB is not held (`skill_text_facts.held` false, no match rows), and that file is
  scanned from its text on every run, with findings unchanged; `skill_text_matches.loneSurrogates`
  records the lone surrogates a match held, as `matchText` is stored well-formed.
- **(library) `runCompatDetectors`, `collectNonPortableAssetReferenceIssues` and
  `collectNonPortableCommandIssues` (`@vibe-agent-toolkit/agent-skills`) take a file's skill-text
  record, not its text**; `runCompatDetectors` also takes the file's parsed frontmatter. Compute the
  record with `skillTextFactsOf(text, SKILL_TEXT_DECLARATION)` from `@vibe-agent-toolkit/resources`.
- **(library) `ValidateOptions.run` (`validateSkill`) is required and replaces `dispatcher`**: the
  run whose store and dispatcher the validation reads through (a `RunPopulation` or
  `RunSkillRegistries`), or `undefined` to validate with a dispatcher of its own and no store.
- **(library) `ResourcePopulationSource` has a required `storedDocument(absolutePath, parserKind)`**;
  a custom source with no store returns `undefined`. **`RunPopulationOptions.outputs` is required**:
  the trees the run writes, `[]` for a run that writes none.
- **(library) `ParseResult.skillText` is required** (the record for markdown, `null` otherwise); a
  value you construct adds it.

### Added

- **Skill discovery and skill validation read stored facts on a warm run**: with the projection
  store on, `vat validate`, `vat verify`, `vat resources validate`, `vat skills validate`,
  and `vat claude plugin build` take each `SKILL.md`'s name, frontmatter and links, and
  every skill finding's input, from the store instead of reading and parsing the file. Findings are
  unchanged. No action needed.
- **`VAT_WORK_COUNTERS` dumps `skillText.storeMiss`**: each file per run that the skills lane scanned
  from its text because the store did not serve it. On a cold or store-off run it equals the files
  scanned.
- **(library) The skill-text core on `@vibe-agent-toolkit/resources`**: `skillTextFactsOf`,
  `SKILL_TEXT_DECLARATION`, `skillTextDeclarationDigest`, `SkillTextFactsSchema`,
  `SKILL_TEXT_FAMILY_PATTERNS`, `EXTERNAL_CLI_BINARIES`, `frontmatterFencesOf`, the
  `StoredDocumentFacts`, `SkillTextFactsRow` and `SkillTextMatchRow` types and the record types,
  `SKILL_TEXT_HELD_LIMITS` and `DEFAULT_PARSE_LIMITS` (the default parse caps, frozen); on
  `@vibe-agent-toolkit/agent-skills`, `readSkillDocument`, `skillNameOf`, `withSkillTextRun` and
  `SkillTextRun`; on `@vibe-agent-toolkit/utils/testing`, `seededRandom`.

### Changed

- **The parse cache and the projection store start cold once after upgrading**: both hold the new
  skill-text facts. No action needed.
- **Some runs still scan skill text themselves (time only; findings are unchanged)**: `vat audit`,
  the marketplace compatibility analyzer and `vat claude org` open no store and scan every file they
  check; on a cold run with the store on, the skills lane scans each bundled markdown file though its
  parse already computed the same facts; a warm run reads and scans a linked file that is not
  plain UTF-8 (a BOM, UTF-16) itself, as its findings come from the raw reading; and `vat skills package` and `vat skill test run` can
  enumerate the project a second time.

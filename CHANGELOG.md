# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This release was driven by extensive adopter testing and QA. Every bug below was fixed test-first,
with a regression test.

### Breaking

#### CLI

- **VAT now requires Node >= 22.13.0**, raised from >= 22.0.0 across every package. `vat resources
  query` and `vat resources check` build their projection through `node:sqlite`, which loads
  unflagged only from 22.13.0. If you are on Node 22.0–22.12, upgrade. `vat doctor` compared the
  major version only, against `20`, and so green-lit environments VAT cannot run in; it now reads
  `engines.node` and checks the interpreter actually running VAT rather than a spawned `node` from
  `PATH`.

- **An unrecognized key in `vibe-agent-toolkit.config.yaml` is now a warning on stderr, not
  `exit 2`.** The downgrade is path-agnostic — it applies at the top level and under every section
  (`skills:`, `claude:`, `resources:`, `extents:`, `test:`, `okf:`, `ard:`), at any depth. A stray
  key under a strict section used to fail every `vat` command; it is now named, ignored and
  reported. **A script relying on `exit 2` for a stray key must read stderr instead.** Every other
  validation failure — a wrong type, a missing required field, a bad enum — still refuses.

- **`vat audit` on a directory no longer exits 2 because one nested config cannot be loaded.** One
  bad `vibe-agent-toolkit.config.yaml` anywhere under the scanned tree aborted the whole audit —
  zero skills validated, no findings — while `vat audit <a SKILL.md under it>` exited 0 and
  reported that skill as passing. The scan now warns once per config, names the file and the
  reason, and validates the skills it governs config-free. **Scripts that read `vat audit`'s exit 2
  as "config is broken" must now read stderr.**

- **`vat claude org skills install` now exits non-zero when an upload fails.** A `--from-npm` run
  in which **any** skill was rejected — a partial success included — reported `status: success` and
  exit `0`; it now reports `status: error` and exits `1`, with the per-skill results still in the
  document. Usage mistakes
  (no `<source>`, or `<source>` together with `--from-npm`) exit `2` with a YAML document instead
  of `1` with a raw Node stack trace. Update CI wrappers that branch on the old codes.

- **The RAG backends are no longer installed for you.** They were declared as
  `optionalDependencies`, which npm and pnpm install by default, so every adopter downloaded
  `onnxruntime-web`, a LanceDB platform binary and `apache-arrow` whether or not they ever ran a
  `rag` command — **~287 MB unpacked** (onnxruntime-web 137.5 MB, the LanceDB platform binary
  97.8 MB, gpt-tokenizer 42.2 MB, apache-arrow 5.3 MB, protobufjs 3.0 MB), measured on
  `darwin-arm64` against this release's pins; the platform binary is larger on `win32-x64`. They
  are now optional *peer* dependencies. **If you use `vat rag`, install the backend explicitly:**
  `npm install @vibe-agent-toolkit/rag-lancedb`. The projection store is unaffected and needs no
  install.

- **`@vibe-agent-toolkit/runtime-langchain` now requires `@langchain/core` 1.x, not 0.3.x.** Upgrade
  `@langchain/core` to `^1.2.9` and `@langchain/openai` to `^1.5.11`. Done for a security reason:
  core 0.3.x declared a `langsmith` range that excluded every published fix, holding five advisories
  open that no override or dedupe could reach.

- **VAT routes files to a parser by MIME type, and only `text/markdown`, `text/plain` and
  `text/html` reach one.** Every file that was not `.html` used to be parsed as Markdown. Three
  things change: **every content key changes** for a file that stopped being Markdown, so stale
  parse and projection entries become unreachable; **`resource_realizations` gains a `mime` column
  at index 8**, so anything reading that table positionally must be updated; and **a data file
  reachable only from inside a bundled script is now in no skill's closure and will not be
  packaged**.

- **Resource scanning now uses the projection lane with the git enumerator by default.** Set
  `VAT_RESOURCES_CRAWL=walk` for the old link walk, or `VAT_EXTENT_SOURCE=filesystem` to keep the
  projection and enumerate without git. ⚠️ A broken symlink is no longer reported as
  `LINK_BROKEN_FILE` — use `walk` if you rely on it.

- **Every resource crawl now sees uncommitted files.** The population is `tracked ∪ (untracked ∧
  ¬ignored)`; gitignored files stay out. **Expect new findings on trees with uncommitted work** —
  that is the fix, not a regression.

- **`vat rag index` now exits 1 and reports `status: partial` when a resource fails to index**,
  instead of hardcoding `status: success` and exit 0. **A pipeline can now fail where it previously
  passed, and that failure is real:** the named resources are absent from the index and
  unsearchable. Exit 2 remains the system-error code.

- **`vat rag index` chunks are now sized from the provider's real token limit — clear and re-index:
  `vat rag clear && vat rag index`.** The budget was a hardcoded 8191-token OpenAI figure applied to
  every provider, including the default local model, which reads **256**; everything past the real
  limit was cut at inference time with nothing said. `vat rag index` alone is not enough — change
  detection is a content hash, so unchanged files keep their stale, truncated vectors.

- **Every hand-maintained version constant and version label is gone**, including
  `INVENTORY_SCHEMA_VERSION`, `CONTENT_KEY_SCHEMA_VERSION` and `PARSE_CACHE_SCHEMA_VERSION`.
  **Scripts reading `schema == "vat.inventory/v1alpha"` must drop the check and switch on `kind`
  instead.** A strict schema now decides whether a stored artifact is readable. ⚠️ Stored QA
  snapshots are invalidated and must be re-captured.

- **`vat skill test`: five changes, four of which need action.** Per-eval workspaces moved out of
  the harness root to a random OS-tmp directory, reported as `workspacesPath`, and **`--keep` is now
  the only flag that retains them** — `--out` and `--workdir` no longer do. Runs now spawn with
  `--no-session-persistence` and preflight refuses to run without it, so a `claude` too old for the
  flag exits 2; **delete any transcripts under `$CLAUDE_CONFIG_DIR/projects/` for a skill you do not
  trust**, because earlier runs left the grading nonce and the eval's answer key there.
  **Re-run any `--baseline` numbers taken before this release** — the control arm used to reach the
  skill through the prompt, the environment and its own working directory, so a zero may have been a
  contaminated control rather than a skill with no effect. `--out` and `--workdir` are now mutually
  exclusive (exit 2); passing both silently discarded `--workdir`.

- **`HarnessLockBusyError` and `UnresolvableEnvTokenError` now exit 2, not 1.** Both are
  user-correctable, and CI recipes reading 1 as "the harness broke" used to fire on them.

- **A duplicate expectation string within one eval is now rejected at parse time** (exit 2) instead
  of throwing mid-run and destroying a fully-billed run over a suite typo. Two *different* evals may
  still share expectation text.

- **`vat skills validate` and `vat skills build` now write their stdout summary after their stderr
  findings**, which is what every other command already did.

#### RAG (library)

- **A RAG filter no provider implements now throws instead of being silently ignored.** Ignoring one
  *widened* your search: a query filtered only by an unimplemented field ran unfiltered over the
  whole index. Move `filters.tags` / `type` / `headingPath` under `filters.metadata` — which works
  only where your metadata schema **declares** those fields. The default metadata schema does; a
  custom one that does not gets `Unknown metadata filter field`, by design, because an undeclared
  field would contribute no condition. Replace `filters.dateRange` with a date field on your own
  metadata schema. Omit `hybridSearch` entirely: `keywordWeight` is refused independently of
  `enabled`, so `{enabled: false, keywordWeight: 0.3}` still throws — `{enabled: false}` on its own
  is accepted. Any unrecognised filter key throws for the same reason.

- **`RAGQuerySchema.safeParse` now rejects an unknown key instead of stripping it.** A misspelled
  filter (`resourceID`) parsed clean and was deleted, and a deleted filter widens the search rather
  than narrowing it — the same failure the refusal above exists to close, reached through VAT's own
  validation path. `filters.metadata` stays open, because it is your schema. The published
  `RAGQueryJsonSchema` already declared `additionalProperties: false`, so this closes a
  disagreement between the two halves of one contract rather than tightening the JSON half — but
  the emitted schema does move, because `filters.metadata` is a new property and the filter
  descriptions are rewritten.

- **RAG providers should call the new `assertQuerySupported(query, support)` and declare their own
  `QuerySupport`.** Without it a provider inherits the declared query fields and none of the
  refusals.

- **`EmbeddingProvider` implementations must expose `maxInputTokens`** — the model's real
  input-token limit, which chunk budgets and the over-length guard now read instead of a hardcoded
  constant.

#### Library

- **The published `edges` and `edge_resolutions` row schemas changed shape.** Both are npm-published
  JSON Schemas (`@vibe-agent-toolkit/resources/schemas/projection-edges.json` and
  `projection-edge-resolutions.json`), so this lands a diff a consumer can read. It was taken now
  because these two tables have **zero producers** — nothing populates them — and a correction after
  a producer exists rewrites the meaning of every row already written. That window is now shut: the
  next edge-schema correction costs a migration.

  - **`edges.resolution` is REMOVED.** One open string was carrying two different vocabularies. The
    *reachability tier* (`same-plugin`, `auth-required`, `nonexistent`) grades a **candidate**, not
    an edge — an edge with one co-bundled and one uninstalled candidate has no single tier — so it
    moved to `edge_resolutions.tier`. The *edge verdict* (`resolved` / `ambiguous` / `nonexistent`)
    was not moved anywhere, because it is derived: it is a `GROUP BY (src, refOrdinal, contextId)`
    over the candidate rows, and a stored copy is a second source of truth nothing keeps in step.
  - **`edge_resolutions` gains `tier`** — the reachability tier, open vocabulary, and **nullable**.
    Null means the lens has no reachability model, so that "has a tier" keeps meaning "reachability
    was assessed" — the same argument `score` already makes about a fabricated `1.0`.
  - **`edge_resolutions` gains `dstKind` + `dstKey`.** External URLs, out-of-corpus targets and
    declared-but-unwritten targets all used to collapse into `dstResource: null`, which reads as
    "resolves to nothing" — so a dangling-link count could not separate *dead* from *outside the
    corpus*, and an external destination had no key to `GROUP BY` at all. `dstKind` is a **closed**
    enum (`resource` | `external` | `out-of-corpus`); `dstKey` is the canonical key within that
    class. ⚠️ **Group by the PAIR, never `dstKey` alone** — three namespaces share the column.
    Two invariants are enforced by the schema rather than left to producers: `dstResource` is
    non-null **iff** `dstKind` is `resource`, and in that class `dstKey` must equal `dstResource`.
  - **`dstAnchor`'s documented meaning is widened** (same name, same type). For `dstKind`
    `resource` it still joins `blob_sections.slug`; for the other two classes it now carries the raw
    fragment, which nothing in the projection can resolve.
  - ⚠️ **`dstKey` is deliberately NOT stable across extent widening.** Widening moves a destination
    from `out-of-corpus` (a path) into `resource` (a hash) — the key changes *class*, not just
    value. Anything comparing destinations across runs must key on `(dstKind, dstKey)` and treat a
    class change as a change.
  - ⛔ **No existence verdict was added.** `out-of-corpus` is a class, not "dead": nothing in the
    projection stats a path outside the population. Separating dead from out-of-corpus still needs a
    verdict column fed by something that actually looked, and that decision is still open.

  **`resolveEdges(projection, lens)` evaluates the edge relation** and is exported from
  `@vibe-agent-toolkit/resources`. It returns `{ edges, edgeResolutions }` and **adds no projection
  table**: `projection.ts` places `edges`/`edge_resolutions` in the derived-per-lens column, so they
  are computed per lens and held by the caller, the same shape `whatLoadsAt` already ships. An
  `EdgeLens` declares its own policy — `AUTHORED_EDGE_FORMS` (`markdown-link`,
  `markdown-link-reference`, `html-link`) is the conservative floor, because admitting every
  lexer-derived token is a ten-fold larger relation and that is a decision, not a default.
  `markdown-definition` is deliberately excluded: the edge belongs to the *use*, and counting the
  definition too double-counts every inbound reference-style link.

  An edge with **zero** candidate rows is a real state — the lens looked and the token named no file
  at all — and is distinct from an edge whose candidate lies outside the corpus. One scalar
  destination column could not tell those apart, which is why the two relations are separate.

  **`resolveReferencePath` is exported alongside it**, and `closure-extent.ts` now calls it rather
  than carrying its own copy. "Where does this reference point" has one answer whoever asks; the
  caller still does its own realization lookup, which is the part that genuinely differs.

  Three builders ship alongside it — `resourceDestination`, `outOfCorpusDestination` and
  `externalDestination`, exported from `@vibe-agent-toolkit/resources` — each returning the four
  destination columns. They exist so the two invariants above become *unconstructible* rather than
  merely validated: a `superRefine` catches a bad row at the boundary, a builder means a producer
  cannot express the mistake. They are pure, take an already-resolved outcome, and do no I/O — path
  resolution stays in `closure-extent.ts` so the corpus keeps one answer to that question.

- **`matchesPermissionRule` and `matchesBashRule` now require a `lane` argument** (`'allow' | 'deny'
  | 'ask'`), with no default — a default would have left every existing caller on the old behaviour.
  Pass `'allow'` to keep today's semantics, or use the new `matchesAllowRule` / `matchesDenyRule`
  wrappers. `PermissionLane` is exported alongside them.

- **Deny and ask rules now match the way Claude Code publishes them, which is not how allow rules
  match.** A deny rule applies when **any** subcommand matches (allow needs every one), reaches
  commands nested in a subshell or command substitution, and matches past any leading environment
  assignment, a `case` arm, or a function body. On a command it cannot parse it now reaches a denied
  program anywhere in the string, not only at the front. A command nested inside another — a
  subshell, a command substitution, a backtick — is now matched against **the text the command
  actually has**, where an earlier build substituted a placeholder for the nested part and so missed
  any rule whose literal spanned it: `Bash(rm -rf $(pwd))` did not match `(rm -rf $(pwd))`. Across a
  200-shape probe that restores **178** deny/ask matches and removes **11** conflicts the placeholder
  had manufactured (it was read as a `case` arm pattern the command never had). **Re-run any saved
  permission-conflict report** — it will flag things it previously missed, and drop a few it should
  never have raised.

  Allow-lane answers are unchanged **against the previous release** apart from `NODE_ENV=` now being
  stripped — measured over 2,501,040 rule/command pairs, zero divergences. That is not the same
  claim as agreeing with Claude Code's published table: VAT's allow lane has 40 known widenings
  against that table, all pre-dating this release, and all reachable only in a shape where no
  command runs (confirmed by exhaustively enumerating 597,870 token lists). `vat audit` is the tool
  that reports where your settings and Claude Code disagree; this note is about what changed in VAT.

- **`ParsedBashRule.regex?: RegExp` is now `pattern?: WildcardPattern`.** Wildcard rules no longer
  compile to a regular expression at all (see Security), so anything reading `.regex` must read
  `.pattern`. `WildcardPattern` is exported alongside it.

- **⚠️ `vat resources validate` now checks the case and Unicode normalization of EVERY path
  component, not just the filename — which can turn a green repo red on a Mac or Windows box.** A
  link written `Docs/readme.md` against a directory named `docs` resolved silently on a
  case-insensitive filesystem and was reported as valid; it 404s on case-sensitive Linux. Those links
  were **already broken in CI** — this reports them where you can fix them. The finding codes are
  unchanged (`LINK_BROKEN_FILE` for case, `LINK_NORMALIZATION_MISMATCH` for normalization), and the
  suggestion now names the whole corrected path (`Use "docs/readme.md" instead of "Docs/Readme.md"`)
  rather than only its last segment, which was a remedy that still 404d when followed. Text is
  byte-identical to before when only the basename is wrong.

  It is also **~105× faster on a wide directory**: the judge used to scan a whole directory listing
  up to three times per link, so cost scaled with directory width. Measured on 4,000 documents ×
  10 links in one directory, identical findings both arms: **23.16 s → 0.22 s**.

- **`@vibe-agent-toolkit/agent-schema` is now `@vibe-agent-toolkit/schema`.** Rename the dependency
  and every import specifier; nothing else about the package changed.

- **`@vibe-agent-toolkit/resource-compiler`'s `parseMarkdown` is now `toMarkdownResource`.**
  `@vibe-agent-toolkit/resources`' own `parseMarkdown`, which takes a path rather than content,
  keeps its name.

- **`safeExecSync()` and `safeExecResult()` throw when asked to run `git`.** Use `runGit()` /
  `runGitOrThrow()` from `@vibe-agent-toolkit/utils`, which pin the repository explicitly instead of
  inheriting whichever one the ambient environment names.

- **The four inventory extractors take an options object with a REQUIRED `gitTrackerSource`**; the
  install root moves into it, and `NO_GIT_TRACKER` restores the old tracker-less walk. Gitignore
  questions are now answered from a tracker's active set, so a skill's `files.linked` can change
  under a symlinked ancestor, in a submodule, or `.git/`.

- **`@vibe-agent-toolkit/utils` no longer exports `verifyCaseSensitiveFilename`.** Use
  `fillPathSpellings(requests, fsCache)` to build a table once, then
  `pathSpellingFrom(table, referrer, target)` to judge. The removed function judged only the
  **basename**, which left every directory component of a path to the host filesystem's own
  case-folding — the defect the whole-path judge exists to close, so it is deleted rather than
  deprecated. (`fillSiblingNames`, `classifyFilenameCaseFrom`, `SiblingNamesTable` and
  `FilenameCaseVerdict` went with it; they were introduced and removed inside this release series
  and never appeared in a stable one, so there is nothing to migrate.)

- **`assertGraderPromptInvariants`'s second parameter is now the run nonce, not the transcript, and
  it is required.** Pass the same nonce you passed to `buildGraderPrompt`.

- **`ParsedTranscript.raw` is removed and `malformedLineCount: number` is added (required).** `raw`
  had no reader and pinned the whole source string alive — 29 MB of retained heap on a 27 MB
  transcript. `mergeFragmentsToGrading` also no longer carries `runNonce` onto the merged report.

### Added

- **`ruleConstrainsTool(toolName, rule, lane)`** is exported from
  `@vibe-agent-toolkit/claude-marketplace`'s settings module. It answers "does this rule restrict
  this tool at all?" off the same content-lane taxonomy `matchesPermissionRule` dispatches on, so a
  caller summarising rules and a caller matching a concrete input cannot give different answers.

- **The path-spelling result now says WHY a component is absent.** `PathSpelling` and
  `ComponentMatch` carry `because: 'no_such_entry' | 'directory_unreadable'` on their absent arm,
  and `FsLookupCache.readdir` returns a `DirectoryListing` union (`listed` / `absent` /
  `unreadable`) rather than `string[] | null`. A single `null` previously meant both "no such
  directory" and "I was refused", and only the first may read as absence.

- **`vat claude org skills versions add <skill-id> <source>` — publishing a change to an
  already-published skill is now possible at all.** `install` only ever POSTs a create, and the API
  rejects a reused `display_title`, so the first publish of a skill worked and every later one
  failed — which is the normal case, since you publish because something changed. The new command
  POSTs to `/v1/skills/{id}/versions`; the server assigns the version identifier and promotes it to
  `latest_version`, so nothing is numbered locally. It takes a built skill **directory** (a ZIP is
  `install`-only), and it fails loudly if the response does not carry the id, title, version and
  timestamp it prints — rather than reporting `status: success` beside `version: null`, which is
  the value `versions delete` later takes.

  **It takes the skill id rather than resolving one, and `install` still only creates.** Neither
  command inspects the workspace to decide which operation it "should" perform. A `display_title` is
  *not* unique: the API enforces uniqueness only when the field is sent explicitly, and derives a
  title from SKILL.md frontmatter otherwise — two skills with one title are reachable and were
  observed. A title→id lookup therefore matches none, one, or several, and a wrong match appends
  your version to somebody else's skill. Packaging is shared between the two commands (identical
  exclusions and size ceiling); only the endpoint differs, and which endpoint is the command you
  typed.

- **`PACKAGED_SIZE_EXCEEDS_API_LIMIT` (warning, built phase) — the first byte measurement in VAT's
  validators.** The two checks whose names suggest they already covered this could not:
  `SKILL_TOTAL_SIZE_LARGE` counts *lines* of bundled markdown and `SKILL_TOO_MANY_FILES` counts
  *files*, so the shape that actually blocks a publish — one large binary, which has no lines and is
  one file — was invisible to both by construction. The reported instance is a 35.7 MB `.wasm`
  runtime bundled by three skills in one adopter marketplace, over the ceiling on its own before a
  byte of markdown counts. Unlike those two thresholds, which are VAT maintainability opinions the
  vendor counter-signals, this one is the Skills API's own refusal, verified against the live API:
  an over-ceiling upload returns `413 Request exceeds the maximum size`. So it catches a real
  external gate at build time instead of at the end of an upload. The ceiling is **30 MiB
  (31,457,280 bytes)**, established by measurement rather than by reading "30 MB" — a
  30,700,000-byte bundle was accepted (refuting the decimal reading) while 31,500,000 was refused. The message names the largest files, which is usually the whole diagnosis.
  `warning`, not `error`, because the ceiling is target-specific: a bundle over it still installs
  fine as a Claude Code plugin, and VAT has no API publish target to condition on yet. The finding
  carries the largest file as its `link`, so one skill that legitimately bundles a big runtime is
  waivable with `validation.allow` instead of turning the check off project-wide. Any entry the
  walk cannot weigh — an unreadable directory, a `stat` that threw, a symlink to a directory —
  emits `SCAN_PATH_UNREADABLE` (warning) rather than counting as zero bytes, so a clean size result
  is never built on a silent under-count.

- **`MCP_TOOL_NAME_UNQUALIFIED` (warning) — promoted from a manual `vat skill review` checklist
  line.** Anthropic's guidance is that a bare MCP tool name "may fail to locate the tool, especially
  when multiple MCP servers are available", but VAT had held the rule back as a human checklist item
  with the note that "a bare identifier in prose is only a defect when the skill actually drives
  MCP". That reservation is now dissolved rather than argued with: the detector reports a bare tool
  name **only when the same document also spells that tool fully-qualified** — as `mcp__server__tool`
  or `ServerName:tool_name` — so a document that does not drive MCP has an empty vocabulary and
  cannot produce a finding. Frontmatter is stripped first, so an `allowed-tools:` list is a manifest
  and not the document contradicting itself, and a line that already spells the tool qualified is
  exempt — a bare-to-qualified mapping table needs no waiver. Hyphens count on both halves, so
  `mcp__claude-in-chrome__browser_batch` and `…__query-docs` are read correctly. Measured over 883
  documents in two corpora: 7 firing, 11 occurrences, **0 false positives**, and the authoring
  project itself fires 0. Each finding carries the bare tool name as its `link`, so one identifier
  can be waived with `validation.allow` while a different bare tool name in the same document still
  fires.

- **Two skill-portability checks for hosts that are not Claude Code.** `NON_PORTABLE_ASSET_REFERENCE`
  gained a `claude-skill-dir` variant (`${CLAUDE_SKILL_DIR}`, `$CLAUDE_SKILL_DIR`,
  `$env:CLAUDE_SKILL_DIR`) and an `api-skill-mount` variant (a hardcoded `/skills/<name>/` path).
  Both are host literals wearing portability's clothes: the variable is load-bearing in Claude Code
  and expands to *empty* in the Anthropic API code-execution container, which mounts the skill at a
  literal `/skills/<name>/` with cwd `/` and sets no equivalent variable; the mount path is the
  mirror-image mistake and resolves nowhere else. The portable form is a bare relative path, which
  every host resolves because the *model* resolves it against the skill directory — and when a
  process genuinely needs an absolute path, the remedy text now says to `cd` into the skill
  directory first, which is the fix authors do not guess. Reported by an adopter publishing 61
  skills to the Messages API, where `vat skill review` had been silent on a skill whose every
  command was `${CLAUDE_SKILL_DIR}`-anchored. The `$env:` form is newly matched for
  `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` too, which previously flagged a skill's bash line
  and waved through the PowerShell line beneath it.

- **`PACKAGED_REFERENCED_PATH_MISSING`** (warning) — the inverse of `PACKAGED_UNREFERENCED_FILE`.
  That code asks whether every shipped file is mentioned; this one asks whether every mentioned
  path is shipped, and it is the only check that can see a **build drop**: a reference that is
  correct in the source repository whose target did not survive into the bundle. The source looks
  right, so neither review nor an agent reading the source catches it. Runs at the built phase only
  (a `files:` dest exists in the output and not in the source tree) and covers only the bare path
  tokens the markdown parser did not claim — a path inside a code block, a code span, or prose —
  since `PACKAGED_BROKEN_LINK` already reports a markdown link with a missing target, at `error`.
  Warning rather than error on measured evidence: **2 misfires in 52 built skills (3.8%)** on a
  live marketplace, the residual class being skills whose subject *is* skill authoring and which
  cite example paths they do not ship. Each finding carries the missing path as its `link`, so one
  illustrative path is waivable via `validation.allow` without silencing the document. See
  [`docs/validation-codes.md`](docs/validation-codes.md#packaged_referenced_path_missing) for the
  two filters and what each is worth.
- **The resource projection** — a populated, queryable model of a project's documents, blobs, links
  and membership, replacing ad-hoc crawling as the substrate for the resource commands.
  `vat resources scan` gains `--format json` and two new fields, `lane` and `extentSource`. Optional
  SQLite persistence comes from the new `@vibe-agent-toolkit/projection-sqlite` package, enabled
  with `VAT_PROJECTION_STORE=sqlite`; `VAT_PROJECTION_STORE_DIR` sets where that database lives —
  set it per CI job, or concurrent jobs write into one file.

- **`vat resources query <sql> [path]`** — runs one read-only SQL statement against this tree's
  resource projection, so questions no command reports a field for (headings, link targets, what the
  parser refused) get an answer. The statement must begin with `SELECT`, `WITH` or `VALUES`; writes
  and multi-statement text are refused.

- **`vat resources check [path]`** — runs the SQL assertions a project declares under
  `resources.checks` and exits 1 when one is violated. Each check is a `description` plus one `sql`
  statement selecting the rows that VIOLATE it, so zero rows is a pass; findings carry
  `CUSTOM:<name>`, which `resources.validation.severity` can downgrade or ignore. A check that could
  not run is reported as `RESOURCE_CHECK_BROKEN`, which no `severity` entry can silence.
  `--budget <seconds>` (default 300) bounds time without progress, so a runaway statement is killed
  and reported rather than hanging the build; `--budget 0` removes the bound.
  ⚠️ **Checks run over the TRACKED TREE, not over your configured resource set.**
  `resources.include` / `resources.exclude` scope `vat resources scan` and `vat resources validate`;
  they do **not** scope the projection, so a path you excluded in config is still there and a check
  will fire on it. Narrow the check's own SQL with a `WHERE path NOT LIKE …` predicate — it is the
  only scope a check has.

- **A cross-process parse cache, on by default.** Parsing dominated `vat resources validate`;
  results are now reused across runs and across processes. `vat cache clear` removes VAT's on-disk
  caches, and `--no-cache` on the root command disables them for one run.

- **Markdown parsing can optionally run on worker threads during projection population.** Off by
  default; set `VAT_PARSE_POOL=1` to opt in. It starts only after enough parse-cache misses to prove
  the work is real, and output is byte-identical either way. `VAT_PARSE_POOL_SIZE`,
  `VAT_PARSE_POOL_MIN_MISSES` and `VAT_PARSE_LOOK_AHEAD` tune it.

- **`vat claude context [paths...]`** — reports which `CLAUDE.md` files, `.claude/rules` files and
  `@`-imported files load into an agent's context at a path, why each is there, and its estimated
  token cost. `--discoverable` adds what those files link to in one hop that the harness does not
  load; `--all` reports a cost map. `--format json`/`yaml` emit `{ root, answers: [...] }`.

- **`vat claude budget [paths...]` — checks the always-loaded context a working location pays.**
  Reports `ALWAYS_LOADED_CONTEXT_BUDGET` at `info` for any instruction chain over
  `resources.validation.thresholds.alwaysLoadedContextTokens` (default 12,000); set that code to
  `ignore` to silence it, or promote it to `error` to make the command exit 1. The total is a stated
  lower bound — a global `~/.claude/CLAUDE.md` is real cost a tree-only projection cannot see.

- **`vat okf validate` — conformance checking for Open Knowledge Format bundles.** Declare one with
  `okf.bundles.<name>.root`; every non-reserved `.md` beneath it is checked for parseable
  frontmatter with a non-empty `type`, and cross-links are resolved against the bundle root. There
  is no `include`/`exclude` on purpose — the population is the specification's, and a narrower one
  would let VAT report a clean bundle it never fully read. Read a clean report precisely: §11.1 and
  §11.2 in full, §11.3 only in part — and wikilinks are not read at all.
  Cross-links are checked for case (`OKF_LINK_CASE_MISMATCH`) and Unicode normalization
  (`OKF_LINK_NORMALIZATION_MISMATCH`) on **every path component, not just the filename**, so a
  bundle that resolves on the author's Mac is not certified when it 404s on a case-sensitive
  filesystem — a link written `Docs/guide.md` against a directory named `docs` is caught, and the
  remedy names the whole corrected path rather than only its last segment. `OKF_BROKEN_CROSS_LINK`
  now means only "not in the bundle". An unreadable subdirectory
  (`OKF_SUBDIRECTORY_UNREADABLE`) and an unreadable document (`OKF_DOCUMENT_UNREADABLE`) are each
  their own finding naming what could not be read, and the rest of the bundle is still judged — both
  used to abort the whole run and exit 2. A bundle member is a file whose bytes live under the root,
  judged by the same containment rule the link lane uses, so a symlink escaping the bundle is left
  out of the population and reported as `OKF_DOCUMENT_ESCAPES_BUNDLE` instead of being judged as a
  member and refused as a link target. A `/`-anchored link whose target exists at the repo root but
  not under the bundle root gets its own code, `OKF_ROOT_RELATIVE_LINK_UNRESOLVED`, because the
  remedy is to re-anchor rather than to write a missing document. An unreadable bundle root is that
  bundle's own `OKF_BUNDLE_ROOT_UNREADABLE` finding at hard `error` — the per-bundle severity dial
  cannot lower it, since an unreadable root means conformance was never assessed — and the other
  bundles still run.
  `ValidateOkfBundleOptions.rootSpecifier` is required and `OkfBundleReport.root` carries it rather
  than the resolved absolute path, so a report does not embed the developer's home directory in
  every bundle entry and carry it into CI logs.

- **`vat ard emit` — writes a `.well-known/ard.json` discovery manifest.** Set `ard.publisher` and
  `ard.baseUrl`; published skills become entries automatically. Marketplaces, OKF bundles and MCP
  servers are emitted only if you supply `ard.entries.<name>.type`, because the ARD specification
  names no media type for any of them and VAT will not guess one under your domain.
  Overrides are keyed `ard.entries."<kind>:<name>"`; a bare key matching surfaces of more than one
  kind is refused, naming both qualified forms, rather than retyping whichever it reached first. A
  duplicate emitted `identifier`, a `skills.config` key naming a skill that does not exist, a
  `publisher` that is not a real domain, and a `baseUrl` carrying a query, a fragment or a
  non-`http(s)` scheme are all refused too. A qualified key that displaces a bare one now says so on
  stderr, naming both, instead of discarding the loser silently.
  `.` and `..` are refused as a `ard.namespace` or a surface name, and as any segment of a
  library-supplied `urlPath`: URLs are joined with `new URL`, which **collapses dot segments**, so
  such a name silently relocated the entry — a namespace of `..` moved every entry above its
  `baseUrl` and still exited 0. A segment that merely contains dots (`v1.2`) is unaffected.
  `findArdEntryOverride`, `findShadowedArdOverrideKeys`, `isArdNameSegment` and `isArdUrlPath` are
  exported for callers building entries directly.
  `--format json` publishes a machine-readable report — `status` (`written` | `empty`),
  `outputPath`, `entryCount`, `skippedCount`, `shadowedCount` and the full skipped/shadowed lists —
  so a pipeline can gate on a number instead of parsing stderr, and `--strict` turns "the manifest
  advertises nothing" or "a configured surface was skipped" into exit 1. The DEFAULT exit code is
  unchanged: an empty manifest is a legal artifact, so a plain run still exits 0 and says why on
  stderr. **Every non-zero exit publishes a document too** — `{status: 'error', error, duration}`,
  in whichever format was asked for — so a wrapper reading stdout never has to fall back to parsing
  stderr, including on the exit-1 case every repository that has not opted into ARD hits first.
  `trustManifest.identity` must carry an authority VAT can bind to `ard.publisher` — an HTTPS FQDN
  URI or a SPIFFE ID, with a DID the one exempt form because DID methods encode their authority
  per-method. A bare domain is none of the three, and it previously skipped publisher-authority
  binding — the one check ARD mandates — in silence, at exit 0: the DID exemption was written as
  "no `://`, no authority to parse", and `attacker.com` has no `://` either. The refusal is enforced
  at CONFIG LOAD as well as at emission, sharing one predicate, so it fails every command that reads
  the config rather than only this one.
  The exit codes distinguish the project from the invocation: **exit 1** means VAT read this project
  and produced no manifest by its own rules — it declares no `ard:` block, or a surface could not be
  derived into a conformant entry — while **exit 2** means VAT never got that far (no project root,
  no config file, a config it cannot parse, an unexpected internal failure). A CI job that tolerates
  repositories which never opted into ARD depends on exactly that split, so branch on it rather than
  on "non-zero".

- **A collection can declare the MIME type of the files it matches, and that declaration reaches the
  parser.** `resources.collections.<name>.mimeType` overrides the built-in extension tables, so a
  project whose `.ts` files really are prose can say so. Two collections declaring **different**
  types for one file is reported as `COLLECTION_MIME_CONFLICT` naming both, and the run completes
  with the built-in table's answer rather than dying mid-way.

- **`vat inventory` answers skill membership from the projection** for a plugin-directory subject,
  instead of the markdown link walk. The walk remains reachable as `VAT_INVENTORY_CRAWL=walker`.

- **Four new `@vibe-agent-toolkit/resources` subpaths: `./parse-conformance`, `./link-parser`,
  `./remark-parser` and `./markdown-processor`.** All four reach the markdown parser, so they are
  deliberately absent from the `.` barrel — import them directly. `./parse-conformance` diffs any
  two parser implementations field by field over `ParseFacts`.

- **`vat skill test` now reports the delta `--baseline` always claimed.** `--no-baseline` on
  `configure` and `run` (a committed `test.baseline: true` silently doubled spend, because
  `--max-budget-usd` is a *per-spawn* cap); `baselineDelta` run-level and per eval;
  `baselineIntegrity` plus a warning when a control arm reached the skill anyway — read `signals`,
  `degraded`, `comparable` and `contaminated`, because a clean verdict and a blind one are different
  things. `results/` is now kept after a default run and its path returned as `resultsPath`.

- **The Node floor is enforced across every manifest and executed in CI.** A repo-structure rule
  derives the floor from the root `package.json` and fails when any package disagrees. Nothing to do
  unless you add a package — give it `engines.node` matching the root, or mark it `private`.

- **`externalSource` on a marketplace plugin entry** — reference a plugin published elsewhere rather
  than vendoring it.

- **Five new rules in the published ESLint pack** — `@vibe-agent-toolkit/no-raw-text-decode`,
  `no-self-package-import`, `no-bare-symlink-in-tests`, `no-process-exit-in-phase` and
  `no-fragile-entrypoint-guard`. **None of the five is in `configs.recommended`**: each keys on
  something that is VAT's rather than portable — a naming convention, a required option, a seam a
  consumer may not have, or a claim about the consumer's own Node floor. All five ship in `rules`,
  and this repo enables each one explicitly, scoped to where it holds.

- **New validation code `LINK_FROM_NON_ROUTABLE_FILE` (warning)** — a link out of a bundled HTML
  page that VAT did not follow.

- **(library) `decodeTextContent()` on the new `@vibe-agent-toolkit/utils/text` subpath**, plus
  `runGit()`, `runGitOrThrow()`, `isFilesystemAccessError(err)`, `removeScratchDir()`,
  `vatCacheNamespace()` and `vatCacheNamespaceRoot()` on the barrel.

- **(library) Claude `@`-import closures are now projected.** `ClaudeImportExtentContributor`
  registers one closure extent per `CLAUDE.md` / `CLAUDE.local.md` / `.claude/rules` file to the
  vendor's four-hop bound. Dangling `@` imports surface as `CLOSURE_REFERENCE_UNRESOLVED`, escaping
  `@~/…` as `CLOSURE_REFERENCE_OUTSIDE_ROOT`.

- **(library) `resource_tags` is now populated**, tagging each resource with the harness convention
  its path carries (`claude-md`, `skill-md`, `subagent`, …) plus a `loading` row valued `always` or
  `selected`. `vat claude budget` reads them, so the tag vocabulary and the budget share one
  definition.

- **(library) HTML files now contribute `blob_references` rows.** `<a href>` and `<img src>` are
  projected under an `html-link` syntactic form of their own. `html-link` is in no closure's
  `follow` default, so HTML references are reported but never traversed.

- **New concept guide: [Knowledge interop formats](docs/concepts/knowledge-interop-formats.md)** —
  what the Open Knowledge Format and Agentic Resource Discovery each are, how they differ, and VAT's
  producer-side stance toward both.

- **(library) The Skills API upload ceiling and its message builder are public.**
  `@vibe-agent-toolkit/agent-skills` exports `API_SKILL_MAX_UPLOAD_BYTES` (31,457,280),
  `describeOversizeBundle()`, `formatBytes()` and the `SizedFile` type, so your own uploader can
  refuse an over-ceiling bundle in the same words `PACKAGED_SIZE_EXCEEDS_API_LIMIT` uses at build
  time. The same package also exports `declaredSkillNameIn()`,
  `collectNonPortableAssetReferenceIssues()`, `collectNonPortableCommandIssues()` and
  `collectUnqualifiedMcpToolIssues()`, so an uploader can run the portability checks itself.

- **(library) `RAGQuerySchema` gained a `filters.metadata` key.** Without it a schema-validated
  `filters.metadata` was stripped — the one filter path that works could not be expressed. The
  generated `RAGQueryJsonSchema` moves with it.

- **(library) `codeContextRangesFrom(spans)` in `@vibe-agent-toolkit/resources`**, replacing
  `collectCodeContextRanges(tree)`: it takes the flat `SourceSpan[]` a parse reports rather than an
  mdast `Root`. Get one from the new `./remark-parser` subpath. `parseMarkdownContent` additionally
  accepts an optional third `parser` argument; the default is unchanged. CLI users are unaffected.

- **(library) A closure extent declaration carries `referenceDialect`**, defaulting to `'href'` so
  every existing declaration behaves as before. Code that compares a parsed `ExtentDeclaration`
  structurally must account for it.

- **(library) `isEntrypoint(importMetaUrl, entryPath?)` on
  `@vibe-agent-toolkit/utils/process`** — one answer to "am I the script Node was asked to run?".
  `import.meta.main` is `undefined` below Node 22.18 and 24.2, and a raw compare against
  `pathToFileURL(process.argv[1]).href` is false through a `node_modules/.bin` symlink; both
  spellings silently guard nothing. The new `no-fragile-entrypoint-guard` ESLint rule keeps them
  from coming back.

- **(library) `assertFiltersProducedConditions` is exported from `@vibe-agent-toolkit/rag`, and
  `LANCEDB_QUERY_SUPPORT` from `@vibe-agent-toolkit/rag-lancedb`** — the backstop that refuses a
  filter set which produced no condition, and the shipped provider's declared `QuerySupport`.

- **(library) The path-spelling surface is exported from `@vibe-agent-toolkit/utils`** —
  `DirectorySpellingIndex` and `spellingWalkRoot`, plus the `PathSpelling`, `PathSpellingRequest`,
  `PathSpellingTable` and `ComponentMatch` types, alongside `fillPathSpellings` /
  `pathSpellingFrom`.

### Changed

- **A stray key under `resources:` is now named on stderr instead of being silently discarded.**
  The section declares its keys — `include`, `exclude`, `collections`, `validation`, `linkAuth` and
  `checks` — and anything else is reported and ignored, exactly like an unknown key anywhere else in
  the config (see Breaking). **Nothing fails to load**: a config carrying `resources.metadata`,
  removed from the schema several releases ago and silently thrown away ever since, keeps working
  and now says so once per run.
  🪤 `resources.collections.<name>` is still permissive, so a misspelled key inside a collection is
  accepted and stripped with nothing said.

- **The CLI suppresses the one `ExperimentalWarning` `node:sqlite` emits at load.**
  `vat resources query` builds its ephemeral store through `node:sqlite`, which Node loads unflagged
  from 22.13.0 but still announces once per process — on an ordinary run, with no way to silence it
  short of silencing everything. A process-wide filter matches that warning by **both** its
  `ExperimentalWarning` type and SQLite's own message text, and passes every other warning through;
  `@vibe-agent-toolkit/projection-sqlite` deliberately does not suppress it itself, leaving the
  filtering to whichever caller turns the backend on by default.

- **(internal) Link-fact table renames in `@vibe-agent-toolkit/resources`.** `linkTargetPaths` is
  now `linkTargets` and returns `{referrer, target}[]` (the judge needs the referrer to bound its
  walk); `LinkFactTables.siblingNames` is now `spellings`; `FileVerification.actualName` is now
  `correction: {asked, actual}`. Not a breaking change: the barrel states that link-validator
  internals are not exported, and the package's `exports` map declares no `./link-validator`
  subpath, so no consumer could import any of them.

- **`vat skill review` files five codes under named sections instead of `Other automated
  findings`** — `SKILL_FRONTMATTER_EXTRA_FIELDS`, `SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE`,
  `SKILL_CROSS_SKILL_AUTH_UNDECLARED`, `NON_PORTABLE_ASSET_REFERENCE` and `NON_PORTABLE_COMMAND`.

- **`vat claude org skills install` now refuses an over-ceiling bundle before uploading it, and
  reports sizes in the units it labels.** The Skills API's `413` is correct but arrives only after
  the whole body has crossed the wire — 11 s for a 30 MB bundle, measured — and names no file, so
  an author learns they have a problem and not where it is. The command now raises the same finding
  `PACKAGED_SIZE_EXCEEDS_API_LIMIT` gives at build time, in the same words (one shared builder, so
  the two cannot drift), naming the largest files, in 212–221 ms across three runs on a 29-file,
  51.7 MB bundle. It measures the collected upload set,
  so the exclusions it just reported (evals, `node_modules`, `.git`) are already accounted for, and
  it applies to a `.zip` source as well as a directory — the one input that is by construction a
  single large binary. A `.zip` faces a second, separate refusal: **the API weighs an archive
  UNCOMPRESSED**, so VAT reads its central directory and refuses locally when the expanded total is
  over the ceiling, however small the archive is on the wire. Separately, the progress line divided by 1024 and labelled the result "KB",
  so a 35,900,338-byte bundle printed as `35058.9KB`; it now prints `34.2 MiB` — binary units,
  because the ceiling it is read against is binary, and the label matches the divisor. Where a
  size is compared to the ceiling the exact byte count is printed beside it, so a bundle one byte
  over no longer reads `30.0 MiB … over the 30.0 MiB ceiling`.
- **`vat validate`, `vat verify` and `vat build` no longer spawn a child process per phase.** Their
  phases run in the orchestrator's own process, so each no longer pays a full Node startup, a second
  copy of the module graph and a cold parse cache. `MAX_PHASE_STDOUT_BYTES` went with the process
  boundary.

- **A `vat` invocation no longer imports every command before running one.** On a 4-CPU Windows box
  `vat --version` goes from **2,477 ms to 370 ms**. Help, a bare `vat`, an unknown command and any
  unrecognised option still load the whole tree, because they have to render or search it.

- **`vat audit` and `vat inventory` no longer spawn a `git check-ignore` process per link target.**
  On a 1,484-document monorepo the whole command goes from **12.5 s to 2.5 s**. Reports are
  unchanged.

- **`vat resources validate` no longer re-asks the filesystem the same question once per skill, per
  skill.** Measured on a 103-skill project: **21,648 → 10,936 filesystem calls**. `vat skills build`
  and `vat claude plugin build` share the helper and get the same fix.

- **A warm resource scan no longer loads the markdown parser or the external-link validator it never
  calls** — **4,000 ms → 2,969 ms** over 184 documents. Cold scans are parse-bound and unchanged.

- **Markdown parsing walks the syntax tree twice per document instead of fifteen times**, and
  scanning a tree with large ignored directories does one filesystem probe per ignored path instead
  of one per contained file. No output change.

- **A markdown link whose target exists but cannot be read is now reported instead of silently
  dropped** — new `LINK_TARGET_UNREADABLE` (error), configurable like any other code.

- **A frontmatter link-validation failure is no longer reported as a frontmatter *schema* error.**
  It used to surface as `FRONTMATTER_SCHEMA_ERROR` once per resource, against a schema that had
  loaded fine.

- **`vat inventory` lists a skill's linked files in sorted order** rather than discovery order.

- **`vat skill test` preflight's `flag <name>` checks now verify something.** All six passed
  unconditionally before, because `claude --help` exits 0 for a flag that does not exist. Preflight
  can now fail (exit 2) on a `claude` that used to pass it — which means the spawn would have failed
  later anyway. `--max-turns` is reported as unverifiable rather than confirmed.

- **`eslint-plugin-sonarjs` upgraded 3.0.7 → 4.2.0**, taken for a security reason (see below). Patch
  bumps folded in from Dependabot: `vitest` 3.2.6 → 3.2.7, `turbo` 2.10.11 → 2.10.12, `apache-arrow`
  15.0.0 → 15.0.2.

### Security

- **The settings checker reported an unparseable Bash command as permitted.** An odd quote or an
  unclosed `(` switched off separator detection for the rest of the command, so `Bash(echo *)`
  approved `echo hi # don't` + newline + `rm -rf /`. **Re-run any saved permission report** —
  verdicts can flip from permitted to refused.

- **`vat claude org skills install <file>.zip` published your eval suite — answer keys included.**
  The directory shape withholds `evals/`, `node_modules/` and `.git/` and reports the exclusion; the
  ZIP shape never called that collector, so `zip -r my-skill.zip my-skill/` uploaded the whole tree
  to a shared org workspace with no warning. VAT now reads the archive's entry names and **refuses**,
  naming the offending entries. ⚠️ This lane sees only the conventional directory names — a suite at
  a location declared in `skills.config.<name>.test.evals` is not visible inside an archive. **Check
  what you already published with `vat claude org skills list`.**

- **`vat claude org skills install` read symbolic links through to their targets and published the
  result to a shared org workspace.** The collector refused only a link resolving to a *directory*;
  a link to a *file* fell through both branches and `readFileSync` returned the target's bytes, so a
  skill directory containing `notes.md -> /etc/passwd` uploaded 9,344 bytes of that file under the
  in-bundle name `notes.md`, visible to every member of the workspace. Nothing in the run said a
  link had been followed — the collector's "every withholding is reported" guarantee covers
  exclusions, not dereferences. **Any symbolic link is now refused, whatever it resolves to**, and
  the refusal names the path. A registry tarball could not plant one (node-tar 7 de-roots an
  absolute linkpath, measured); the vector is a directory extracted with system `tar`, which does
  recreate it, or cloned from an untrusted repo and handed to `install <dir>`. The build-time size
  walk changed with it: it no longer weighs a linked file *through* the link, which its comment used
  to defend as deliberate — "which matches the uploader". The two lanes did agree and both were
  wrong. A link is now reported as an unweighed entry instead.

- **A wrapper flag's value was treated as the wrapped command**, so `Bash(ls *)` reported
  `timeout -s ls 30 rm -rf /` as permitted. A wrapper carrying a flag with a non-numeric value is
  now left unstripped and reported as not matching.

- **A backslash in a permission rule compiled as a regex escape instead of as itself.**
  `Bash(a\b *)` reported `a b` as permitted, and any rule holding a Windows path matched something
  other than what it said. **Re-check any rule containing a backslash.**

- **`Bash(x:*)` and `Bash(x *)` gave different answers** despite being documented as equivalent, and
  `:*` granted a bare-command permit the ` *` spelling refuses. **Re-check reports for rules using
  the `:*` spelling.**

- **The settings auditor advised deleting rules that were not redundant.** A rule appearing at two
  settings levels had BOTH copies reported redundant, and `Bash(npm test *)` was reported redundant
  under `Bash(npm * *)`. **Re-read any rule you deleted on that advice** — deleting either revokes a
  permission. Relatedly, `isSubsumedBy` contradicted `matchesBashRule`: a `:*` broad rule subsumed
  **nothing**, and `settings-conflict-analyzer` is built entirely on that function, so it silently
  under-reported.

- **Path deny rules were checked for six tools and matched none of them in practice.** Claude Code
  consults `Read(path)` and `Edit(path)` only, so `Write(…)`, `Glob(…)` and the Notebook rules now
  report as blocking nothing; separately, relative paths resolved against the process's own
  directory rather than the plugin's, so the path lane never matched.

- **The Bash permission matcher now follows Claude Code's published behavior table.** A trailing
  ` *` matches the bare command when it is the rule's only wildcard; compound commands split on
  `&&`, `||`, `;`, `|`, `|&`, `&` and newlines with an allow rule required to match **every**
  subcommand, so `Bash(safe-cmd *)` no longer reports `safe-cmd && other-cmd` as permitted; a
  dangling `&&` is treated as unparseable and approves nothing; and the documented wrappers
  (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, bare `xargs`) are
  stripped before matching. Seven of the eight divergences found against that table are now fixed
  and pinned — including per-lane environment-assignment stripping, `PATH_TOOLS` narrowed to `Read`
  and `Edit`, and MCP tool-name globs. The one still open is not a divergence but a hole **in** the
  table: whether the ALLOW lane descends into `$(…)`, backticks and control-flow bodies is
  undetermined, so only the documented deny/ask nesting is implemented and the allow half is left
  where it was rather than guessed at in either direction.

- **A permission rule with wildcards separated by literals could hang the process, and `vat audit`
  on an untrusted plugin was the way in.** Every `*` became `.*` in a compiled regular expression, so
  `Bash(ab*b*b*b*b*b*b*b*z)` — a 24-character rule — took **26 seconds** against a 61-character
  command, growing ~9x per added `b*`; an ordinary-looking
  `Bash(npm * --registry * --registry * --registry * publish)` took 10 s on a 4 KB command. A
  plugin's `SKILL.md` `allowed-tools:` and an adopter's `settings.json` are both attacker-reachable
  inputs to that path. Wildcard rules are no longer compiled to a regular expression: matching is now
  a linear two-pointer scan. **26,273 ms → 0.3 ms**, same answers. The tool-name and
  `WebFetch(domain:…)` lanes shared the compiler and are fixed with it.

- **Nine regexes in production code could be driven into quadratic backtracking, and are now
  linear.** Measured on hostile input, the inline-link scanner took **2,632 ms on 40k unclosed
  brackets** and is now ≤1.1 ms, with identical output on every case tested. They had been triaged
  behind `sonarjs/slow-regex` disable comments whose stated reasoning was wrong.

- **The OSV accepted-risk register is down from ten entries to one** — a CVSS 2.5 `esbuild`
  dev-server advisory in build-time-only tooling. `fast-uri` (four advisories, CVSS 7.5) and `qs`
  (two, CVSS 6.3) went stale at their pinned versions and are re-pinned forward to 3.1.6 and 6.16.0;
  `@hono/node-server` moved to 1.19.17, whose fix was backported inside
  `@modelcontextprotocol/sdk`'s declared range; three `minimatch` advisories (one **CVSS 8.7**) were
  held by an exact pin inside `eslint-plugin-sonarjs@3.0.7`, which 4.2.0 widens; and five
  `langsmith` advisories are resolved by the `@langchain/core` 1.x move above. Nothing in VAT's own
  code changed.

- **An eval suite could inject instructions into the grader prompt on the arm that decides the
  primary verdict.** `toolExpectations.mustRun` / `mustNotRun` / `mustSucceed` / `sequence` went raw
  into the grader's instruction region, and also defeated `assertGraderPromptInvariants`. It is now
  nonce-fenced.

- **A grader's tool verdict must now name the checks the eval actually declared.** Omitting one made
  that expectation vacuously pass; inventing one added a check the eval never declared.

- **Untrusted text can no longer write its own lines on your terminal.** Grader
  `friction[].message`, the contamination scan's degradation detail and `parseGradingJson`'s error
  message all echoed attacker-influenced bytes, so a grader could print a green line in vat's own
  voice.

- **The run nonce no longer reaches the run's artifacts**, and **`baseline.json` evidence no longer
  leaks your login name** or bypasses its excerpt bound for any tool input containing a newline,
  quote or backslash. A grader still writes its nonce-bearing fragment to a file, but under an owner-only
  (`0700`) directory, and it is consumed and unlinked on read.

- **`vat skill test` no longer copies your eval suite — `expected_output` answer keys included —
  into the OS temp dir when it does not need to.** The copy is now made only when the suite exists
  nowhere else.

- **VAT's on-disk cache directory is now created owner-only (`0700`) on POSIX.** It sits in a
  world-readable location shared by every user on the host and holds the set of external URLs a
  project links to, including private hostnames. On Windows the mode bits reduce to the read-only
  flag.

- **`@vibe-agent-toolkit/utils` now depends on `@vibe-validate/git` (0.20.1)**, replacing this
  package's own copy of the git-environment scrub and tree-snapshot machinery; it adds
  `@vibe-validate/utils` and `yaml` to the installed tree.

### Fixed

- **Skill packaging no longer ships a wrong link when an image sits inside a link.** On
  `[![alt](img.png)](url)` — an ordinary badge — the rewriter silently did nothing at all, so a link
  the registry had *fully resolved* went out of the bundle still pointing at its source location.
  The cause was a grammar disagreement being papered over by a value both grammars disagree about:
  `transformContent` replayed a raw regex, which matches the INNER image href, then looked that href
  up in a map built from the PARSED links, which holds only the OUTER one — a miss, and a miss took
  the "leave untouched" branch. It now splices each parsed link at its own
  `[startOffset, endOffset)` span instead of correlating on href, so the construct it rewrites is
  the construct the parser identified.

  Three consequences beyond the reported defect:

  - **Link text containing balanced brackets is now rewritten.** `[a [b] c](x.md)` was never matched
    by the regex (which excludes `[` from link text, deliberately) and so was never repointed.
  - **A code-span or fenced EXAMPLE is now structurally safe**, not merely masked. It used to be
    spared only because code ranges were masked before replacement; mdast yields no link node inside
    code, so an example is no longer a rewrite target even when a real link shares its href.
  - **Reference-style uses, autolinks and `<a href>` are explicitly declined** and fall back to the
    previous behaviour, so nothing silently changes a document's link *form*.

  Links the parser cannot locate — `startOffset`/`endOffset` are optional, and the HTML producer does
  emit a link with a line and no offsets — still go through the old regex replay, over the gaps
  between spliced links only. `rewriteBodyLinks` is **unchanged and still diverges**: it takes no
  parsed links, so it cannot be span-driven without an API change, and which grammar is right there
  is a product question. Both answers stay pinned in
  `packages/resources/test/link-grammar-divergence.test.ts`.

- **A reference definition inside a code block could be mis-skipped after a link rewrite.** The
  definition pass tested its offsets against code ranges measured on the *pre-rewrite* string, so any
  length change in pass 1 shifted every range out from under it. Ranges are now recomputed against
  the rewritten text.

- **`vat audit` no longer dies with an uncaught `TypeError` on a bare `Read`/`Edit` declaration.**
  The settings checker asked the path matcher whether a deny rule blocked a tool whose input was the
  empty string, and the underlying ignore matcher throws on an empty path (`path must not be empty`).
  Any plugin whose `SKILL.md` declared a bare `Read` or `Edit` while org settings carried a
  `Read(…)`/`Edit(…)` deny rule crashed the command outright. Fixed on both sides: the checker now
  asks `ruleConstrainsTool`, and `matchesPathRule` answers `false` for an empty relative path rather
  than throwing. Pre-existing — before `PATH_TOOLS` was narrowed it also fired for `Write`, `Glob`
  and `NotebookRead`/`NotebookEdit`.

- **A link through a directory VAT may traverse but not list is no longer reported as a missing
  file.** Judging every path component made every ancestor directory need to be *listable*, not
  merely traversable, so a POSIX `--x` directory (mode `0111`) — whose files open perfectly well —
  turned a valid link into `LINK_BROKEN_FILE`. The listing result now distinguishes "no such
  directory" (`ENOENT`/`ENOTDIR`) from "could not be read", and a link whose spelling could not be
  verified produces no finding at any severity rather than a fabricated one. An unrecognised
  listing failure is treated as unreadable, never as absence.

- **The settings checker and the permission matcher can no longer disagree about the same rule.**
  The checker string-prefixed rule names (`Write(`) while the matcher had just ruled that a
  `Write(…)` path rule constrains nothing, so one deny rule produced opposite answers depending only
  on whether a skill spelled the tool `Write` or `Write(./out/**)`. Both now dispatch on one shared
  content-lane taxonomy. A tool VAT cannot introspect (an MCP tool with non-`*` content, e.g.
  `mcp__srv__tool(foo)`) is no longer reported as conflicting with a bare declaration — matching the
  answer the matcher already gave for every concrete input.

- **A redirection is no longer mistaken for a command separator.** `&` was treated as a top-level
  separator with no redirection awareness, so `2>&1` split into `… 2>` and `1`; the allow lane then
  required a rule for `1` and refused the whole command. `ls -la > /dev/null 2>&1` against
  `Bash(ls:*)` now matches. A genuine `&` — backgrounding or `&&` — still separates.

- **A metadata filter value containing `%` or `_` no longer widens the search it was meant to
  narrow.** Array and string metadata filters interpolate into a SQL `LIKE` pattern, and only quotes
  were escaped, so `tags: ['%']` compiled to `tags LIKE '%%%'` — a clause matching every row, handed
  back to a caller who had asked to be filtered. Wildcards and the escape character are now escaped
  and the pattern carries an explicit `ESCAPE`, emitted only for values that need it so every
  currently-working query is byte-identical.

- **A usage mistake no longer reports itself as a failed check.** An unknown option and an unknown
  command fell through to Commander's default `exit(1)` — which, against the three-way exit contract
  every `--help` publishes, asserts that at least one check was violated. So
  `vat resources check --json` exited **1** having run nothing, and a CI wrapper reading `$?`
  reported findings that were never computed. Usage mistakes now exit **2** across all 69 commands;
  `--help` and `--version` still exit 0.

- **`vat claude org skills install` uploaded without running any of VAT's checks.** Skills that
  reference paths outside their own directory published with a green tick and could not run — under
  the Skills API a skill is its own top-level tree with no siblings. The bundle is now scanned for
  non-portable references, non-portable commands and unqualified MCP tool names before upload, and
  **warns without blocking**; `vat skills build` and `vat audit` remain the gates.

- **`vat claude org skills delete` reported `status: success` and exited 0 when the API said the
  skill was NOT deleted.** `deleted: false` was computed and printed, and nothing branched on it, so
  a CI wrapper spelled `… delete X || fail` reported green while the skill still existed. It now
  ends on the same `orgCommandFailure` path the `--from-npm` batch uses: the document is still
  published, the run exits **1**. `delete --all` also no longer discards its own report — a failure
  part-way through the version loop lists the versions it irreversibly destroyed under
  `deletedVersions` and exits 1, instead of throwing into exit 2 ("the run could not happen") with
  no record of what it deleted. The version-delete lane accepts both `skill_version_deleted` and the
  measured `skill_deleted`, because only the second has ever been seen from the live API and a
  single guessed string would have failed every run.

- **A dropped connection part-way through `delete --all` aborted the loop and left the skill
  half-deleted.** Retrying covered statuses only, while `send`'s docstring claimed it had closed the
  class. Transport failures on idempotent methods are now replayed too. A deadline is never
  replayed (it has already waited its full budget) and a POST is never replayed at all.

- **`vat claude org skills install MySkill.ZIP` was refused as "not a directory or .zip file".**
  `endsWith('.zip')` is case-sensitive, and the refusal gave an operator no way to read it as being
  about capitalisation. Both the match and the title derivation are now case-insensitive.

- **`--title` with `--from-npm`, and `--skill` without it, were accepted and silently ignored.** The
  first can publish a skill under the wrong title, the second publishes every skill in a package
  when the operator named one. Both are now refused with exit 2, like the two illegal combinations
  that already were.

- **A Windows operator's absolute `<source>` path was joined onto the working directory.**
  `source.startsWith('/')` is false for `D:\builds\skill`, so the command reported
  `Source not found: <cwd>/D:/builds/skill`. It now uses `isAbsoluteAnyPlatform`, which answers for
  POSIX roots, drive letters and UNC paths on every host — so a POSIX-only CI can see the
  drive-letter case at all.

- **`vat claude org --help` told every reader that skills commands need two keys.** It said
  `Requires ANTHROPIC_ADMIN_API_KEY` followed by `Skills commands also require ANTHROPIC_API_KEY`,
  so "also" put an admin key in front of the skills family — the exact barrier this release removes.
  Skills commands need only a regular workspace key and the admin key is never sent to those
  endpoints. The help now groups commands under the one key each family actually requires. Two
  neighbouring lines were stale in the same block: the group description named only the Admin API,
  and the exit-code table still described `1` as "not-yet-implemented (stub commands)" while
  `skills install --from-npm` documents `1` as "some skills failed".

- **A skill upload refused for a duplicate title did not say what to do about it.** The API answers
  `400 Skill cannot reuse an existing display_title`, which is precisely the moment the caller needs
  `versions add` — `install` only ever creates. The refusal now appends how to recover: find the id
  with `vat claude org skills list`, then `vat claude org skills versions add <skill-id> <source>`.
  It states plainly that VAT will not turn the title into an id, because `display_title` is not
  unique in general — the API enforces it only when the field is sent — so a title can match none,
  one, or several skills. The remedy is appended, never substituted, and is matched narrowly enough
  that an unrelated `400` keeps the API's own words and gains no misleading advice.

- **`vat claude org skills delete` did not name the command that unblocks it.** The API refuses to
  delete a skill that still has versions; the failure now points at `--all`, which deletes every
  version and then the skill in one command, and at the by-hand `versions list`/`versions delete`
  sequence. Suppressed when the run already used `--all`.

- **`vat claude org skills install <file>.zip` takes its display title from the FILENAME**, not from
  the `SKILL.md` inside the archive, so `my-skill-v2.zip` publishes a separate skill titled
  `my-skill-v2` whose every version declares `name: my-skill`. That was silent; VAT now reads the
  archive's `SKILL.md`, prints both spellings when they diverge, and names the `--title` that
  reconciles them. Pass `--title` to set it explicitly.

- **A `vibe-agent-toolkit.config.yaml` that could not be loaded silently voided every
  `resources.exclude` it declared**, so a package that excludes its deliberately-broken fixtures had
  them audited as production skills. The scan said so only at `--debug`; it now warns, names the
  config, and says the excludes were dropped.

- **`vat skill test configure` still refused a config the rest of VAT accepts, and printed a raw
  Zod JSON dump when it did.** It was a third config reader that neither of the two fixes above
  reached. It now shares them.

- **`vat claude org` read any HTTP status below 400 as success.** A redirect or an informational
  response with an empty body resolved as a completed exchange, so a proxy answering `302` to a
  `DELETE` made the command print `status: success` and exit 0 with the skill still there. A missing
  status did the same. Anything outside `200`–`299` is now a refusal that names the status.

- **`vat claude org` reported the wrong reason for any HTTP failure whose body was not JSON.** A
  `413` from an edge proxy and a `401` both surfaced as `Failed to parse API response`, so neither
  "shrink the bundle" nor "get a key" was legible; a `2xx` with an empty body — a `204` from a
  delete — was rejected as a parse failure. The status is now read first, and failures throw an
  `ApiRequestError` carrying it.

- **`vat claude org` could hang indefinitely on a stalled connection, and died with a raw stack on a
  reset.** Requests now abort after 120 s of socket *inactivity* (a slow-but-progressing 30 MB
  upload is never cut off), and a further 30 s connect deadline covers a DNS blackhole, where there
  was no socket for the inactivity timer to watch. A reset arriving after the response headers is
  now caught instead of becoming an unhandled `error` event. Rate-limit and gateway failures are
  retried honouring `Retry-After`, on idempotent methods only, up to a maximum of three attempts
  (two retries); a `POST` is never replayed — it creates — and the error says so. **When an upload
  gets no status at all, check `vat claude org skills list` before re-running: the skill may
  exist.**

- **Multipart uploads now percent-encode `Content-Disposition` parameters (RFC 7578 §4.2).**
  Filenames and field names reach the wire from a downloaded package's SKILL.md frontmatter on the
  `--from-npm` path, so a value carrying CRLF could open a new header line inside the part. Field
  *values* are deliberately unchanged: a value is a part body and must stay byte-exact.

- **`vat claude org` no longer splices raw ids into URL paths.** User and workspace ids taken from
  argv are percent-encoded, so one containing a `/` addresses the resource you named rather than a
  different endpoint.

- **`vat claude org skills *` demanded an admin key it never sends, locking every non-admin out of
  the Skills API.** `OrgApiClient`'s constructor hard-required `ANTHROPIC_ADMIN_API_KEY`, so all four
  skills commands (`list`, `install`, `delete`, `versions`) refused to start without it — while
  `buildSkillsHeaders()` authenticates with `ANTHROPIC_API_KEY` alone and never reads the admin key
  at all. The command's own `--help` said as much ("Requires ANTHROPIC_API_KEY (regular key, not
  admin key)"), and `/v1/skills` is available to any workspace member, so upload was gated behind a
  credential that neither the endpoint nor the code path uses. Each key is now required at the point
  it is actually sent: a client built with only a regular key reaches the skills endpoints, and
  `buildAdminHeaders()` raises the same clear error as before when an `/v1/organizations/*` call is
  made without an admin key. Verified against the live API — `list` and `install` now succeed with a
  regular workspace key. The existing tests could not have caught this: every one of them constructed
  the client with an admin key, so none exercised the skills-only caller.

- **`--format json` was ignored on every command's failure path**, which emitted YAML — so the one
  document a CI wrapper most needs to read arrived in a format its parser rejects.

- **`vat audit` printed "Audit failed" while exiting 0.** Audit is advisory by design and its exit
  code is deliberately 0, but the stderr line said failure and the document said `status: error`, so
  an adopter wiring it into CI read a failure and got a green step. The line now names the count and
  says it is advisory. **No exit code changed.**

- **Git commands run from inside a git hook could read — or write — the wrong repository.** Worst
  case, `vat claude marketplace publish` switched a branch and landed a commit in the repository you
  were committing from. Also affected `gitLsFiles()`, `isGitIgnored()` and `cloneGitSource()`.

- **VAT could not read a UTF-16 document at all.** A file written by PowerShell's `>` or `Out-File`
  decoded to mojibake and yielded no headings, links or sections. Content is now decoded from its
  byte-order mark, and a UTF-8 BOM no longer stops a config file, JSON schema or `.gitignore` from
  parsing.

- **A tracked file with a non-ASCII filename vanished from every git-aware command**, and a link to
  a file whose name carries an accent was reported broken even though the file was there.

- **`vat doctor` reported "Git is not installed" when git was installed and working.** Also affected
  `getToolVersion('git')` and `isToolAvailable('git')`.

- **`vat` ignored git configuration supplied through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` /
  `GIT_CONFIG_VALUE_*`**, so a clone that CI had pointed at an internal mirror went to the network
  instead.

- **A `linkAuth` token command that invokes `git` was refused.** Commands such as
  `git credential fill` work again.

- **`vat` now runs the version your lockfile pinned when you install with pnpm.**

- **Two `NON_PORTABLE_*` waivers applied when validating and were ignored when building.** An
  `allow` glob matches an issue's `location`, and the two lanes report different locations for the
  same document: `vat skills validate` names the authored source, `vat build` names the packaged
  artifact. If you have a waiver that works under one and not the other, name both spellings.

- **A list filter that nothing can satisfy matched everything instead of nothing.**
  `filters.metadata.tags: []` — the ordinary "filter to the tags I computed, and I computed none"
  case — compiled to `tags LIKE '%%'` and returned the whole index, while the structurally identical
  `filters.resourceId: []` correctly matched nothing. The mechanism is **stringification**, not
  length: `String([])`, `String([''])` and `String('')` are all the empty string, so `tags: ['']` —
  what you get from `tags: [selectedTag]` when the selection is blank — hit the same tautology. Any
  value that stringifies to nothing now emits the same always-false condition.

- **A multi-value list filter required the stored order.** `filters.metadata.tags: ['a','b']`
  compiled to a single `tags LIKE '%a,b%'` against the comma-joined stored value, so a document
  tagged `b,a` did not match and nothing said why. Each element now gets its own condition, ANDed
  together. **A query relying on the old adjacency behaviour will return more rows than before.**

- **`filters.dateRange` could not be expressed on the wire.** The published `RAGQueryJsonSchema`
  declared `start`/`end` as `date-time` strings while the Zod half accepted only a `Date`, so a query
  that validated against the published schema failed to parse. The Zod half now accepts what the
  JSON half always advertised; the emitted JSON Schema is byte-identical.

- **The chunker rejected a whole document rather than splitting its longest line**, so a single wide
  markdown table row or unwrapped bullet produced zero chunks for the entire file. It now never
  throws, and no content is dropped.

- **`splitBySentences` discarded sentence-terminating punctuation.**

- **A protocol-relative URL was classified as a local file**, so `//cdn.example.com/x.js` was
  reported as a broken link. Both the markdown and the HTML parser now share one classifier.

- **A namespaced `xlink:href` lost its source span in the link rewriter, silently dropping the
  rewrite.** Reproduced with `<svg>`, `<math>` and the uppercase `XLINK:HREF` spelling.

- **A markdown document that declares the same reference-definition label twice** resolved every use
  to the wrong target.

- **A merely broken root-absolute link was reported as escaping the project**, and
  **`directFileCount` counted link occurrences rather than files**, so it could exceed the bundle's
  own file count.

- **A corrupt ONNX embedding model could be cached permanently**, surfacing as `protobuf parsing
  failed`. Downloads now publish atomically and a short body is never cached.

- **A corrupted cache entry could report a reachable link as broken, or return a fetched page with
  no status.** Entries written by earlier versions are discarded, so external links are re-checked
  once on the first run after upgrading.

- **Three CLI options were silently doing nothing** — Commander represents `--no-x` as the positive
  key, and three flags read the wrong one. Separately, **`--debug` produced no debug output from any
  command**, and an unexpected failure printed no stack.

- **`vat skills build` no longer dies on a `files:` glob that matches a symlink to a directory** —
  anything a glob matches that cannot be packaged is skipped and reported as
  `FILES_GLOB_SKIPPED_NON_REGULAR_FILE` (a warning), and the rest of the entry ships.

- **A file that cannot be read no longer kills `vat resources scan` / `validate`**, and **`vat
  audit` no longer aborts when its own config cannot be read** or throws away every finding when it
  hits one unreadable file.

- **`crawlDirectory({ followSymlinks: true })` no longer enumerates a file once per symlink level.**

- **`vat agent install --force` could not replace a broken dev-mode symlink**, such as one left
  dangling by a rebuild that removed `dist/`, and **a failed `vat claude plugin install --dev` no
  longer denies the partial state it leaves behind.**

- **`vat inventory` blamed "the projection membership lane" for what was a config parse error**,
  sending the reader to VAT's code instead of to their own YAML.

- **`vat skill test run --dry-run` destroyed the previous run's artifacts.** The free "what would
  this cost?" invocation — and any failure before the run proper — deleted `grading.json`,
  `baseline.json`, `friction.json` and `tool-eval.json` from the expensive real run you were about
  to read. A dry run now writes nothing under `results/`.

- **An exhausted control-arm rate limit annihilated a fully-billed treatment run.** Both treatment
  executors and both treatment graders had run and been paid for.

- **A transcript line could be silently corrupted and then dropped.** Executor stdout was decoded
  per chunk, so any multi-byte character straddling a 64 KiB boundary damaged a line, and the parser
  discarded unparseable lines without reporting it. `malformedLineCount` now counts what is dropped.

- **The shipped exit-code table said the opposite of what the code does**, and the CI recipe built
  on it silently greened runs whose comparison did not exist: a stall, timeout, spawn error or
  missing grader fragment on the *control* arm exits 0 with `PASS`. A `--baseline` gate must instead
  read `baselineDelta.delta`, `controlArmFailures`, `degraded`, `comparable` and `contaminated`.

- **The published `GradingReportJsonSchema` dropped `summary.passed <= summary.total`.**
  `zod-to-json-schema` discards every `.refine()`, so external tooling accepted
  `{"passed": 9, "total": 3}`. It is now stated in the emitted `description` as not
  machine-enforced.

- **`vat skill test run --help` no longer promises cleanup that `--out`/`--workdir` never perform.**
  Under a location you chose, staged untrusted skill bytes are retained whether or not you pass
  `--keep`. Behaviour is unchanged; the documentation was wrong.

- **`Harness:` printed a path cleanup had already removed** on any run returning early, and a
  failure while releasing the harness lock could replace a good run's result with an exit-1 error.

- **The `vat-skill-distribution` skill taught a config key that does not exist**
  (`skills.config.<name>.claudeWebTarget`), which the strict schema refuses — so an agent following
  the published skill produced a config that failed to load on **every** vat command. It also
  claimed `--target claude-web` sorts files into `scripts/` and `assets/`; it flattens everything
  into `references/`.

- **Every `rag:` config block in the RAG usage guide was unparseable.** There is no top-level `rag:`
  key, so copying an example broke every vat command, not just RAG ones. All eight blocks are now
  validated against the shipped schemas, and the RAG docs state the
  `npm install @vibe-agent-toolkit/rag-lancedb` prerequisite the opt-in change above introduces.

- **The `vat-knowledge-resources` skill documented an output field that no longer exists**, and did
  not mention `vat resources check` at all.

- **Two published ESLint autofixers could rewrite or delete code that had nothing to do with the
  rule**, and `prefer-startswith-over-regex` missed some patterns ending in an escaped backslash.

## [0.1.42] - 2026-08-08

### Breaking

- **`@vibe-agent-toolkit/utils/fs` no longer re-exports the pure path-string helpers.** Seven
  symbols moved from `./fs` to the new `./path` entry: `safePath`, `toForwardSlash`,
  `isAbsolutePath`, `isAbsoluteAnyPlatform`, `hasParentTraversalSegment`, `toAbsolutePath`, and
  `getRelativePath`. `./fs` was a published subpath before this release and went from 14 exports to
  7; anything importing one of those seven from `@vibe-agent-toolkit/utils/fs` must change the
  specifier to `@vibe-agent-toolkit/utils/path`. The two entries are disjoint by design — `./fs` now
  holds only the helpers that genuinely touch `node:fs`/`node:os`/`node:url`, which is what lets
  `./path` reach `node:path` and nothing else. **The `.` barrel is unaffected**: it still exports all
  seven, so consumers importing from `@vibe-agent-toolkit/utils` need no edit. Permitted under the
  pre-1.0 policy; called out here because a silently narrowed published subpath is not.

  A new guard test enumerates the `.` barrel's full export set, so a future removal from *it* cannot
  ship unremarked the way this one nearly did.

- **`verifyCaseSensitiveFilename(filePath)` now requires a second argument: `verifyCaseSensitiveFilename(filePath, fsCache)`.**
  Library-only API break — no CLI behaviour changes. Answering the question needs a listing of the
  target's parent directory, and it was doing an uncached `readdir` per call: measured at 9,963
  `readdir` calls validating a 3,437-document tree, and 7,443 on a 1,132-document monorepo, over a
  few hundred distinct directories. The listing now comes from a caller-supplied `FsLookupCache`
  (new, exported from `@vibe-agent-toolkit/utils/fs` and the `.` barrel), which memoizes `readdir`
  and `realpath` and shares in-flight promises so concurrent callers collapse to one syscall.
  **What to do:** construct one `new FsLookupCache()` per validation run and pass it to every call
  in that run. `verifyCaseSensitiveFilename(p, new FsLookupCache())` at each call site reproduces
  the old behaviour exactly if you want a mechanical migration first. The cache is deliberately
  instance-based, never a module singleton — it holds a *snapshot* of directory contents, so a
  watch-mode or server process must let each run have its own and drop it afterwards. The parameter
  is required rather than defaulted for the same reason: a default lets an unmigrated call site keep
  the un-memoized path silently, which is a no-op wearing the shape of a fix.

  `ValidateLinkOptions` in `@vibe-agent-toolkit/resources` gains a matching **required** `fsCache`
  field, so anything constructing that options object must supply the run's cache.

- **The vestigial `zod` peerDependency is gone from `@vibe-agent-toolkit/utils`.** It was a
  *required* peer, so anyone importing only `./path` was still told by their package manager to
  install `zod`. The package imports `zod` nowhere: all six occurrences of `from 'zod'` in the
  shipped `dist` are inside JSDoc `@example` blocks, and the version-introspection helpers
  deliberately duck-type `_def.typeName` rather than importing the library — which is exactly what
  makes them work across v3 and v4. The declared range (`^3.25.0 || ^4.0.0`) would additionally have
  rejected a future major that the duck typing handles by design. `zod` remains a devDependency, so
  the test that exercises the introspection against a real `zod` is unaffected.

  **Listed as breaking, not merely removed**, because of who it breaks: not anyone importing from
  `utils`, but a consumer that was relying on this package to pull `zod` into *their* tree and now
  finds it absent. If you import `zod` yourself, declare it yourself. (Reported twice by an adopter
  who went looking for this under Breaking and did not find it — it was filed under Added, beside
  the subpath work that prompted it.)

### Added

- **A whole-path spelling judge on `@vibe-agent-toolkit/utils`** — `DirectorySpellingIndex`,
  `fillPathSpellings`, `pathSpellingFrom` and `spellingWalkRoot`, with `ComponentMatch`,
  `PathSpelling`, `PathSpellingRequest` and `PathSpellingTable`. It lists each directory once into
  exact / NFC / NFC-lowercased maps and walks a path from a root downwards, descending into the
  **corrected** spelling so a wrong directory cannot hide a wrong filename. `spellingWalkRoot` picks
  that root as the deepest directory a referring file and its target share — everything above it was
  enumerated off disk, so judging it would compare disk against disk and report normalization nobody
  wrote. Both the OKF lane and `vat resources validate` are built on it, so the two cannot drift.

- **`isEntrypoint()` on `@vibe-agent-toolkit/utils/process`, and a
  `local/no-fragile-entrypoint-guard` ESLint rule that makes the two broken spellings unwritable.**
  "Am I being run directly?" had two failing idioms in circulation. `import.meta.main` is `undefined`
  below Node 22.18/24.2, so a guard using it silently never fires on the floor a package declares —
  a gate that does nothing on the one runtime it exists to police. The other,
  `import.meta.url === pathToFileURL(process.argv[1]).href`, is a raw string compare with no
  `realpath`, so it is **false** whenever the script is reached through a `node_modules/.bin`
  symlink — the normal way an installed CLI runs — and the program exits 0 having done nothing.
  `isEntrypoint(import.meta.url)` answers correctly through symlinked scripts and directories, paths
  containing spaces, and `tsx`. The rule is **not** in `configs.recommended`: whether
  `import.meta.main` is safe depends on the consumer's own Node floor, so it is opt-in rather than a
  portable claim.

- **A `@vibe-agent-toolkit/utils/eslint` subpath — 26 ESLint rules that enforce the safety helpers
  in the rest of the package.** The helpers exist because `path.join()`, `os.tmpdir()`,
  `fs.realpathSync()`, `child_process.execSync()` and `await import(absolutePath)` each have a
  platform pothole; until now nothing stopped a call to the raw primitive, so the API shipped
  without its enforcement. The rules were maintained privately in this repo and had never been
  installable. Most auto-fix, and every message names the replacement and the `utils` subpath it
  lives on.

  ```js
  // eslint.config.js
  import vat from '@vibe-agent-toolkit/utils/eslint';
  export default [vat.configs.recommended];
  ```

  `configs.recommended` registers the rules under the `@vibe-agent-toolkit` namespace and enables
  the cross-platform safety core — 18 of the 21 rules, `error` except three at `warn`
  (`no-path-join`, `no-path-resolve`, `no-path-relative`), the ones whose first run on an existing
  codebase produces a migration rather than a bug list — measured at 4,336 findings on a
  4,670-file tree, **all autofixable**. Three rules ship without riding in `recommended`:
  `require-justified-skip` and `no-test-scoped-functions` encode a position on *test style* rather
  than a portability fact, and `no-unsafe-root-join` is held back on correctness — it keys on
  whether an identifier's name ends in `root` rather than on taint, so it fires on all-literal
  calls and stays silent on `safePath.join(base, userInput)`, the shape it exists to catch. All
  three are enabled by naming them.

  **`--fix` writes the import to the narrow subpath that owns the helper**, matching the rule
  table: `path.join()` becomes `safePath.join()` imported from `@vibe-agent-toolkit/utils/path`,
  the `fs` rules point at `./fs`, and `no-child-process-execSync` at `./process`. A file that
  already reaches the helper through the `.` barrel keeps its existing import and only has the
  call rewritten — a second binding of the same name would be `SyntaxError: Identifier 'safePath'
  has already been declared`, so the fixer checks whether the name is bound at all rather than
  whether it was imported from the module the fixer prefers. That check is scope-based, so a
  top-level `const safePath = …` is a conflict too.

  **A per-rule `safeModule` option redirects both the fix and the message at your own re-export
  seam** — `['error', { safeModule: '@acme/dev-tools/paths' }]`. Necessary because in a workspace
  with isolated `node_modules` an import of an undeclared package does not degrade, it fails to
  resolve: an adopter measured that the defaults would write a specifier resolving in **0 of their
  top 25 affected packages** while their own seam resolved in 24 — 620 files across 52 packages
  that declare no dependency on this one. Per-rule rather than a single shared key because a seam
  need not split its symbols the way this package does (theirs carried `normalizedTmpdir()` but not
  `safePath`, so the `fs` and `path` families needed different targets). Every rule that names a
  module accepts it, including the six that only advise and never fix, so configured advice never
  points at a module you don't use.

  Rules take an `exemptFiles`
  option naming the file(s) allowed to call the banned primitive — the one that implements your
  wrapper. There are deliberately **no** built-in exemptions: those paths are a claim about one
  repo's layout, and matching is anchored at a path segment, so declaring `src/paths.ts` never
  exempts `tools/hooks/paths.ts`. An entry with no `/` at all is reported as
  `unanchoredExemptFile` rather than accepted: because ESLint reports absolute filenames, a bare
  `paths.ts` exempts every file of that name anywhere in the tree, including ones added later.
  Requires ESLint 9+ (flat config) and Node >= 22. Full rule table
  in [the subpath's README](https://github.com/jdutton/vibe-agent-toolkit/blob/main/packages/utils/eslint/README.md).

  `--fix` is safe to run across a whole migration: every rule that rewrites a call and edits
  imports fixes all of a file's call sites without leaving a reference to something it just
  un-imported, never deletes a `type`-only, aliased or re-exported specifier, and leaves a
  suppressed call site working. Enforced by a suite that runs `--fix` to its fixpoint per rule and
  checks the result with `no-undef`.

  It also **finishes the job**, which matters in a repo gating at `--max-warnings=0`. Rewriting the
  last `path.*` call in a file leaves `import path from 'node:path'` bound to nothing — not a
  dangling reference, so a `no-undef` check cannot see it, and an adopter measured **536 such errors
  surviving a converged `--fix` across 232 files**. The rules now report that orphaned binding
  themselves, as a separate finding on the import line with its own fix, so it is visible and
  suppressible rather than a rewrite quietly deleting a declaration. Deliberately narrow: a closed
  list of Node builtins (`node:path`, `node:os`, `node:fs`, `node:fs/promises`,
  `node:child_process`, and their bare spellings), only in a file where the safe symbol is already
  bound, only whole declarations with no references left. Bare `import 'node:path'` side-effect
  imports, `type` specifiers and partially-used declarations are left alone. This is not a general
  unused-import rule and will not become one — the ecosystem's rules abstain here for good reason,
  and in any case cannot help: `@typescript-eslint/no-unused-vars` declares `meta.fixable: 'code'`
  yet emits only a *suggestion* for an unused import, which `--fix` never applies.

  The member-call rules (`no-os-tmpdir` and friends) check the receiver rather than the method name,
  and now recognise a namespace bound by `const os = require('node:os')` or
  `const os = await import('node:os')` as well as by a static `import * as os`. An unrelated object
  with a same-named method is still not a finding.

  **There is no separate plugin package to install**, and `eslint` is declared as an *optional* peer
  dependency, so nothing changes for consumers who take `utils` for `safePath.join()` alone: they
  get no unmet-peer warning and no new dependency. An ESLint plugin is data rather than code that
  runs — the rule modules export plain objects and never `require('eslint')` — so this entry
  reaches no Node builtin and no third-party package, and the other twelve subpaths keep resolving
  in a tree with no ESLint anywhere in it. The cost is bytes on disk and nothing else: the packed
  tarball goes 148,953 → 187,753 bytes (+38,800 compressed; 135,381 unpacked across 27 `.cjs`
  files, a README and a type declaration) for code nothing loads unless you lint. Both endpoints
  are measured in the same tree, by packing with and without the `eslint` entry in `files`, so the
  delta is the subpath's cost and not the drift of a `dist/` built months apart. What it buys is
  one install, one version, and no way for a rule to name a helper signature the installed `utils`
  no longer has.

- **`@vibe-agent-toolkit/utils` is now a first-class public package with narrow subpath exports.**
  The `exports` map goes from 3 keys to 15: `./path`, `./fs`, `./process`, `./git`, `./glob`,
  `./zod`, `./yaml`, `./template`, `./testing`, `./asset`, `./crawl`, `./project`, `./eslint`
  (see below), and `./package.json`, plus the `.` barrel. `./project` carries `findProjectRoot`,
  `findConfigFile`, `findNodeWorkspaceRoot` and `resetProjectRootCaches` — functions whose own code
  imports nothing but `node:fs` and `node:path`, so reaching them no longer requires the `.` barrel
  and its five third-party dependencies. They remain VAT-shaped (`findProjectRoot` looks for
  `vibe-agent-toolkit.config.yaml`, then `.git/`), which the README says plainly; the entry exists
  so that finding out costs nothing. Projects
  building skills with VAT write Node code that has to run on Windows, macOS, and Linux, and hit the
  same platform potholes VAT does — `.cmd` shims needing a shell, `tmpdir()` returning 8.3 short
  paths, backslash-vs-forward-slash comparisons, `await import()` of an absolute path failing on
  Windows. Those primitives are now importable without taking the whole toolkit. The `.` barrel's
  export set is unchanged, so consumers importing from it need no edit — consumers of the
  pre-existing `./fs` subpath do; see **Breaking** above.

  The narrow entries are narrow in their *dependency graph*, not merely in name: `./path` and
  `./glob` reach only `node:path`, never `node:fs`, `node:os`, or `node:url`. A guard test walks
  each entry's transitive source graph and asserts both its `node:` builtin set and its third-party
  set, so the README's "resolves with zero deps installed" column is enforced rather than
  documented. It fails loudly when it cannot resolve a module, so it cannot pass vacuously, and a
  fixture with a dangling import exercises that failure.

  This is **not** a bundle-size change: the package has set `"sideEffects": false` since 0.1.40, and
  a tree-shaking bundler already dropped unused code from the barrel. What subpaths control is what
  a build must *resolve* and what a module graph *reaches* — the barrel reaches `yaml`, `handlebars`,
  and `node:fs` regardless of what you destructure, so it cannot be bundled for a browser target and
  requires every dependency installed.

- **`@vibe-agent-toolkit/utils/process` now exports the Windows spawn safety it was missing.**
  `spawnHardened` (async spawn with correct `.cmd`/`.bat` launching), `shouldUseShell`,
  `windowsShellQuote`, and `buildWindowsShellLine` were reachable only through the `.` barrel, so the
  one subpath meant to make command execution safe on Windows covered synchronous exec only.

- **`engines: { node: ">=22.0.0" }` on all 21 published packages.** Exactly one of the 21 declared a
  Node floor before this release, so an adopter installing on an older Node got no install-time
  signal from any of the other 20 — they simply failed later, at a syntax or API error, with nothing
  pointing at the Node version.

- **A `./crawl` subpath**, promoting `crawlDirectory`/`crawlDirectorySync` and the crawl-exclusion
  glob constants. It is deliberately kept out of `./glob`: it is the only subpath that
  reaches `picomatch` (linkAuth's host matching reaches it too, but only from the `.` barrel), and
  folding it in would break `./glob`'s guarantee of reaching nothing but `node:path` and no
  third-party package at all.

  A `./project` subpath (`findProjectRoot`, `findConfigFile`, `findNodeWorkspaceRoot`,
  `resetProjectRootCaches`) was prototyped and **deliberately dropped before release**. Validated
  against the package's primary real-world consumer, its four exports had zero replaceable call
  sites: `findNodeWorkspaceRoot` needs a `package.json` carrying a `"workspaces"` key and returned
  `null` from every directory in that pnpm workspace; `findConfigFile` hardcodes VAT's config
  filename; and `findProjectRoot`'s config-then-`.git` ladder contradicted all six of that repo's
  own marker walk-ups — one of them a published runtime package, where keying on `.git/` would be a
  bug, since it is absent at install time. The two sites that genuinely wanted a `.git` walk-up are
  served by `gitFindRoot` on `./git`. All four functions remain on the `.` barrel, where VAT's own
  internals use them; only the narrow entry is gone.

- **`PLUGIN_TOPLEVEL_BIN_DIR` — surface a top-level `bin/` in a published plugin (`warning`).** `bin/` and `scripts/` mean different things: Anthropic documents `bin/` as *"Executables added to the Bash tool's `PATH`… invokable as bare commands"*, while `scripts/` is the conventional home for helper scripts invoked by path. A plugin whose executables are only ever invoked by explicit path is using `bin/` without using what `bin/` provides — and a claude.ai-hosted marketplace sync has been **observed** to skip a plugin containing one, silently: the publish succeeds and the plugin simply never appears, surfacing only on the org admin console. VAT now names the shape at audit time so it is visible in the publishing repo. **Advisory only** — `bin/` is a supported, documented CLI feature, VAT has a single undocumented observation of the hosted rejection, and per [validation-rule-design.md](docs/validation-rule-design.md) that is not grounds for a build-blocking error. It is deliberately *not* escalated by strict marketplace validation, and a test pins that. Opt out with `severity.PLUGIN_TOPLEVEL_BIN_DIR: ignore` or a scoped `validation.allow` entry.
- **`docs/contributing/plugin-distribution-findings.md` — a running evidence log behind VAT's plugin-shape rules.** [validation-rule-design.md](docs/validation-rule-design.md) requires evidence to justify a rule's severity; this is where that evidence now lives, so a `warning` shipped on one observation stays distinguishable from a `warning` shipped on principle, and can be promoted (or dropped) when evidence changes. Entries carry an explicit **DOCUMENTED / OBSERVED (n=) / INFERRED** label. Also names the *silent hosted-sync divergence* failure class — publish succeeds, plugin never appears — and carries a **"rules NOT to add"** list recording proposals that were investigated and rejected, with reasons, so they are not re-proposed. Adopter-sourced findings are recorded as shapes, never identities.
- **Authoring guidance — where a script shared by several skills should live.** `vat-skill-authoring` gains a section on the per-skill vs. plugin-level `files:` fork. Per-skill duplication keeps each skill self-contained and standalone-mountable at the cost of duplicated bytes; a plugin-level `files:` entry (whose `dest` may not resolve under `skills/`) ships one copy but forces skill bodies onto `${CLAUDE_PLUGIN_ROOT}`, giving up standalone mounting — which `NON_PORTABLE_ASSET_REFERENCE` correctly flags. The section names the deciding question (does this skill ever run outside its plugin?), and shows recording the answer as a scoped `validation.allow` entry with a required `reason` rather than a repo-wide `severity: ignore`.

### Changed

- **`@vibe-agent-toolkit/utils/git` exposes exactly one git-root finder.** The subpath previously
  re-exported whole modules, surfacing both `gitFindRoot` and the deprecated `findGitRoot` — two
  differently-named functions for the same job, which guarantees consumers split between them. The
  subpath is now an explicit, curated export list carrying `gitFindRoot`; see **Removed** for the
  alias itself.

- **Guidance for building the Node scripts a skill ships**, in the `vat-skill-authoring` skill:
  bundling to a self-contained tree-shaken `.mjs`, statically scanning the artifact for surviving
  external imports, and clean-room booting it outside any `node_modules`. It documents a trap VAT
  itself creates: `files:` injects a bundle under a different `dest` basename, so a script guarding
  its entry point on `basename(process.argv[1])` evaluates that guard as false under the shipped
  name and exits 0 having printed nothing — inert, while reading as success to anything watching
  exit codes.

  It also documents that trap's sibling, which an adopter found the hard way across three of their
  own bins: npm writes `node_modules/.bin/<name>` as a **symlink**, so `process.argv[1]` is the link
  path while `import.meta.url` is the realpath target — meaning the obvious remedy
  (`import.meta.url === pathToFileURL(process.argv[1]).href`) fails the same fail-open way on the
  most common invocation path of all. The guidance therefore recommends shipping a guard-free bin
  entry module, and specifies clean-room verification on **three** legs — shipped `dest` name,
  through a symlink, and from a packed tarball installed outside the workspace. A copy-only clean
  room cannot see the symlink case at all: a copy has no symlink, so it certifies fail-open bins as
  healthy.

### Removed

- **`findGitRoot` is gone from `@vibe-agent-toolkit/utils`. Use `gitFindRoot`** — the behavior is
  identical, because `findGitRoot`'s entire body was `return gitFindRoot(startDir)`. It had carried
  an `@deprecated` tag for some time. Curating it off the new `./git` subpath (see **Changed**)
  addressed only the symptom: the alias stayed on the `.` barrel, the entry with the most consumers,
  so both names remained one import away and the coin flip just moved. Under the pre-1.0 policy
  (never maintain two APIs for the same job) the alias is deleted rather than relocated. No
  production code in this repository ever called it.

  This also removes one of the symbols that were reachable **only** from the wide `.` barrel — the
  shape that undercuts "import the one you need" — and it is the one whose narrow home already
  existed.

### Security

- **16 advisories cleared from the dependency tree** via the root `overrides` block: `undici`
  7.28.0 → 7.29.0 (5 advisories), `ip-address` 10.1.1 → 10.3.1 (3), `hono` 4.12.27 → 4.12.34,
  `fast-uri` 3.1.4 → 3.1.5, `js-yaml` 4.3.0 → 4.3.1, and `postcss` 8.5.18 → 8.5.23, plus a new
  `nanoid` 3.3.16 → 3.3.17 pin closing GHSA-2v37-7h3g-55p8 (CVSS 8.2). `nanoid` reaches the tree
  only through `postcss`, whose `^3.3.16` range the patched version satisfies, so no other pin
  moved. All are within-major bumps of transitive packages; no declared dependency changed and no
  consumer-facing API is affected.

  One advisory is **accepted rather than fixed** and recorded in `osv-scanner.toml` with its
  reasoning: `brace-expansion` (GHSA-rgw5-rvv9-x895) resolves to 1.x, 2.x, and 5.x simultaneously
  in this tree, and the fix lands separately in each line (1.1.18 / 2.1.4 / 5.0.9), so no single
  value in a global `overrides` block can patch all three — pinning any one forces the other two
  majors onto an incompatible version. It is a ReDoS against attacker-controlled brace patterns;
  VAT only ever expands patterns it authors. Same shape, and the same deferral, as the existing
  `minimatch` and `picomatch` entries.

### Fixed

- **`isGitIgnored()` spawned a git subprocess per ancestor directory when the path was not in a git
  repository at all — `vat resources validate` on a 3,437-document tree outside any repository went
  from 196 s to 20.6 s, with a byte-identical report.** `git check-ignore` exits 128 for two
  unrelated conditions: "beyond a symbolic link" and "not a git repository". The code treated any
  non-0/non-1 status as the first, whose recovery is to walk up the ancestor directories re-spawning
  git for each one. Outside a repository *every* ancestor also exits 128, so the walk never broke,
  climbed to the filesystem root, and returned `false` after (1 + depth) spawns — per call, and it is
  called per link. It was the right answer by the wrong route, which is why no assertion ever caught
  it; on the tree above, `spawnSync` was 87.6% of a 225.6-second run. "Is there a repository here?"
  is now settled from the filesystem (via `gitFindRoot`) before anything is spawned, so outside a
  repository the answer costs zero subprocesses. In-repository behaviour, including the symlink
  ancestor walk, is unchanged and pinned by tests that assert the spawn count rather than only the
  return value.

- **VAT crawls walked into `.turbo`.** turborepo's per-package directory was on neither
  `NEVER_CRAWL_GLOBS` nor `BUILD_OUTPUT_GLOBS`, so any crawl with `respectGitignore: false` — the
  path those lists exist for — descended into it and reported turbo's task logs, and, where
  `cacheDir` points inside `.turbo`, files out of the hash-keyed cache. That cache holds *copies* of
  package build output, so the crawl reported the same file twice under two paths: the duplicate
  reading `**/.worktrees/**` is on the never-crawl list to prevent. It is now on
  `NEVER_CRAWL_GLOBS` (not `BUILD_OUTPUT_GLOBS` — a lane that spreads only the never-crawl list is
  by definition one that wants to see build output, and is precisely the lane that must not walk a
  cache of copies). Turborepo is common enough for this to matter: every package in this repo has a
  `.turbo/`.

- **`windowsShellQuote` produced command lines that `CommandLineToArgvW` mis-parses, corrupting
  arguments and silently merging them with the argument that follows.** The function knew none of
  Windows' backslash-escaping rules: a backslash run preceding a quote — or preceding the closing
  quote it adds — is escape-processed by the child's parser, so `C:\Program Files\` was emitted as
  `"C:\Program Files\"` whose final `\"` reads as an *escaped quote* rather than a terminator. A path
  with a trailing separator and a space is the everyday case, and the space is exactly what triggers
  quoting, so the two conditions coincide constantly.

  Now implemented as the canonical algorithm: every backslash run preceding a quote or end-of-string
  is doubled, and quotes escape as `\"`. Measured by round-tripping through an implementation of
  `CommandLineToArgvW` over every string up to length 4 across `{a, \, ", space, %}` — the old
  implementation fails **85 of 781** cases, 74 of them swallowing the next argument; the new one
  fails **0**. That harness ships as a test, self-checked against Microsoft's published worked
  examples so it cannot be silently wrong.

  One documented trade: no byte sequence is correct under *both* parsers in the chain, because
  `cmd.exe` counts every quote while the child needs an odd count to represent a literal one. `\"` is
  chosen because it is understood identically by every known implementation, whereas `""` is absent
  from `CommandLineToArgvW`'s documented rules and CRT variants disagree about it. The residual cost
  is bounded and stated in the code: cmd's quote tracking desyncs only for an argument containing
  both a quote *and* a shell metacharacter.

  Two safety claims in the same module were also overstated and are now documented honestly rather
  than changed. `%` and `!` trigger quoting but are **not neutralized** by it — `cmd.exe` still
  expands `%VAR%` inside double quotes, which also corrupts a literal `%` in a filename (legal on
  Windows). And `shouldUseShell`'s JSDoc asserted "arguments passed as array, preventing injection"
  and "never concatenate user input into command strings" while the Windows shell branch does
  exactly that concatenation. Both now name `shell: false` as the escape hatch.

- **`buildWindowsShellLine` silently produced a broken command line when handed a command path it
  could not safely place in the command position — it now throws instead.** Two shapes reached it:
  an unquoted path containing spaces, which `cmd.exe` splits at the first space; and `''`, which
  promoted the caller's *first argument* into the command position, so
  `buildWindowsShellLine('', ['calc', 'b'])` returned `" calc b"` — a line whose command is `calc`.
  It now requires a single shell token and throws with a message naming the offending token.
  Separately, `safeExecSync`/`safeExecResult` now quote a path-like command the way `spawnHardened`
  already did; the sibling paths previously disagreed and only one was correct.

  **What changes for you:** a call that used to return a subtly wrong command line now raises. If
  you pass a command path through these helpers, resolve it first (both of VAT's own call sites go
  through `which.sync`, which is why neither could reach the empty-token case).

- **`@vibe-agent-toolkit/utils/package.json` was not exported**, so
  `require('@vibe-agent-toolkit/utils/package.json')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. Version
  reporting and resolution assertions all reach for it. Now exported.

- **The `@vibe-agent-toolkit/utils` README documented four functions that do not exist**
  (`normalizeFilePath`, `readFileContent`, `getGitRootDir`, `ensureGitRepository`) and named a fifth
  wrongly (`setupTestTempDir`). The reference is rewritten against verified exports and organized by
  subpath. A `../../docs/` link that resolved to nothing on npm is now absolute.

- **`NON_PORTABLE_ASSET_REFERENCE` no longer advises an impossible fix for `CLAUDE_PROJECT_DIR`.** The family emitted one shared remediation — *"reference bundled files by a path relative to the skill directory"* — for every variant. That is right for `CLAUDE_PLUGIN_ROOT` and absolute script paths, and **wrong** for `CLAUDE_PROJECT_DIR`, which denotes the *user's repository* rather than a bundled asset: no skill-relative path can express it, and substituting one silently re-anchors user artifacts onto the plugin install directory. An adopter reported the rule advising them to revert a fix for exactly that bug. The `claude-project-dir` variant now carries its own remediation (take the location as an explicit parameter with `$CLAUDE_PROJECT_DIR` as fallback; make declared `targets` reflect the Claude Code coupling), and the shared headline no longer asserts the skill-relative advice.

- **`NON_PORTABLE_ASSET_REFERENCE` over-captured a closing brace in nested shell expansion.** The variant patterns used `\$\{?NAME\}?`, whose optional trailing `\}?` consumed the closing brace of an **enclosing** expansion — `"${VAR:-$CLAUDE_PROJECT_DIR}"` was reported as `` "$CLAUDE_PROJECT_DIR}" ``. The malformed token reads exactly like the typo `$FOO}`, sending reviewers to source that was in fact valid shell. Matching is now brace-balanced via alternation. *(Adopter-reported; independently reproduced.)*

## [0.1.41] - 2026-08-03

Entries describe change relative to **0.1.40**, the last stable release. Defects introduced and fixed
entirely within the `0.1.41-rc.*` line are deliberately not listed — no released version ever
exhibited them. Every fix below ships with a regression test.

### Security

- **`vat skill test` no longer stages a skill's eval answer key where the skill under test can read
  it.** Every subject-resolution route — a plain path, a plugin tree-copy, an npm/url/vendored
  artifact, a `packageSkill` dist — carried the eval suite (`evals.json` plus its `fixtures/`,
  including `expected_output`/`expectations`) into the tree the executor runs against, so a skill
  could read its own answer key and pass while demonstrating nothing. The suite is now stripped from
  every staged copy before it is copied onward or content-hashed, and relocated to a VAT-only,
  mode-`0700` directory outside the harness root. `workspaces/` and `results/` are likewise created
  `0700` rather than inheriting the umask.
- **`vat claude org skills install` no longer uploads your eval suite to your Anthropic org
  workspace.** It uploaded *every* file it found, with a hardcoded directory-*name* backstop
  (`evals`, `node_modules`, `.git`) — so a project keeping its suite anywhere else
  (`fixtures/qa/evals.json`, a bare `answers.json`) published every `expected_output`, exited 0, and
  printed an empty exclusion list. The uploader now resolves the *declared* suite through the same
  nearest-ancestor config walk-up `vat audit` and `vat skill review` use, and withholds it in
  addition to the name-based exclusions, which remain as the fail-safe when no config is
  discoverable. Every withheld path is reported.
- **Dependency sweep — the tree goes from 32 vulnerable packages / 120 advisories to 0
  un-triaged.** Highlights an adopter inherits directly: `adm-zip` → `0.6.0`, closing a
  path-traversal advisory ([GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85),
  CVSS 7.5) in a package used at runtime to extract archives fetched from skill-source URLs;
  `tar` → `7.5.22`, closing five advisories including
  [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) (CVSS 9.2) in a direct
  CLI dependency; and the **complete elimination of the `protobufjs@6` transitive chain (11
  advisories, including a 9.8-critical) for every consumer, unconditionally** — adopters could not
  previously override it because `onnx-proto` pins `protobufjs@^6`. Remaining transitive advisories
  are pinned via root `overrides`; the two that cannot be fixed (`brace-expansion`, whose fix exists
  in neither coexisting major line, and `@hono/node-server`, whose vulnerable `serve-static` export
  is never imported) are documented in `osv-scanner.toml`. An OSV-Scanner CI gate now runs against
  the committed lockfile.
- **The `vat skill test` grader protocol is hardened against a skill forging its own verdict.** vat
  is the sole writer of `results/`; each grader fragment carries a secret per-run nonce the executor
  never sees (delivered only via the grader's stdin — never on disk, never in argv), fragments are
  unlinked the instant they are read, and the untrusted transcript and a skill's own
  `declaredExecutables` strings reach the grader inside a nonce-bound fence. Same-uid caveat: the
  grader runs as the same OS user as the skill, so this raises the bar substantially but is not full
  isolation — separate-uid/container isolation is tracked in
  [#149](https://github.com/jdutton/vibe-agent-toolkit/issues/149).

### Added

- **`vat skill test` — transcript-grounded evaluation with a separate executor and grader (issue
  [#145](https://github.com/jdutton/vibe-agent-toolkit/issues/145)).** Each eval now runs in two
  roles instead of one self-grading agent: a blind **executor** (the skill under test) performs the
  task and its transcript is captured in memory, then a separate **grader** judges that transcript
  against the rubric. A grader-side internal failure, or a missing/forged nonce, aborts with the
  harness-broke exit **1** and is never laundered into a pass/fail verdict.
  - `graderModel` config and `--grader-model <id>` (default `claude-sonnet-5`) select the grader
    independently of `model`/`--model`, which now select the **executor**. `--concurrency <n>`
    bounds parallel evals, each retrying a rate-limit with backoff.
  - **Declared tool-expectations.** An eval may declare `toolExpectations`
    (`mustRun` / `mustNotRun` / `mustSucceed` / `sequence`), judged from the transcript and written
    to their own `tool-eval.json` channel so tool verdicts never leak into `grading.json`. A skill's
    packaging config accepts a `declaredExecutables` manifest (`{ path, kind, howInvoked }`) so the
    grader recognizes varied launch forms of one tool (`uv run csvsum.py`, `./csvsum`,
    `node dist/csvsum.mjs`).
  - **Composite, fail-closed verdict.** The reported pass/fail ANDs the output grade with every tool
    verdict, and the run fails closed (exit **4**) if any result artifact is missing, unparseable or
    invalid after the merge.
  - **Cost-tiered fail-fast.** Evals may declare a numeric `tier`; tiers run cheapest-first,
    bounded-parallel within a tier, stopping before the expensive ones once a cheaper tier fails.
  - **Two advisory pre-spend warnings** (never change the exit code): an eval whose expectations are
    all presence-only with no negative check, and a `toolExpectations` entry that looks like a typo
    of a declared executable.
  - **Run-wide spend aggregation** — the summary carries `≈$<total> across <N> sessions`.
- **`vat skill test run --evals <path>` — grade a skill against an eval suite stored outside its own
  tree** (issue [#163](https://github.com/jdutton/vibe-agent-toolkit/issues/163)).
- **`exclude:` on a marketplace plugin entry.** Patterns, relative to the plugin source dir, that
  the verbatim tree-copy must skip — for project-specific content the built-in exclusions cannot
  know about. Additive to the defaults (`.claude-plugin/`, gitignored files, produced skill dirs,
  agent-instruction files).

  ```yaml
  plugins:
    - name: my-plugin
      skills: "*"
      exclude: ["scratch/**", "docs/internal"]
  ```

  A pattern may be a glob (`scratch/**`) or a bare directory name with or without a trailing slash;
  all three drop the whole subtree, in or out of a git repository. A pattern matching nothing is a
  `PLUGIN_EXCLUDE_PATTERN_UNUSED` warning in the structured result.
- **Declared test input is auto-excluded from packaged output.** Declaring a path under
  `skills.config.<name>.test.evals` names it as that skill's eval suite; VAT now treats that
  declaration as the instruction not to package it, and reports what it withheld via
  `PACKAGED_TEST_INPUT`. Declarations are assembled once per run across the whole project, so one
  skill's suite cannot leak into another skill's bundle via an ordinary documentation citation.
- **New validation codes**, each overridable with `validation.severity.<CODE>`:
  - **`LINK_UNRESOLVED_REFERENCE` (`warning`)** — a dangling reference-style link: `[text][label]`
    or the collapsed `[label][]` with no matching `[label]: url` definition.
  - **`REGISTRY_SHAPE_DRIFT` (`info`)** — Claude Code's installed-plugins registry parses cleanly
    but carries a field VAT does not model, so drift stays visible without being an error.
  - **`TREE_PROVENANCE_INDETERMINATE` (`warning`)** — `vat audit` could not decide whether a tree is
    a distribution artifact or ordinary repository source because git could not be consulted (`git`
    absent from `PATH`, an unreadable or corrupt `.git`). It claims only that the tool could not
    tell, never anything about the artifact, and fires only when the tree actually contains
    agent-instruction files, so a clean repo in a git-less container stays quiet.
  - **`LINK_TO_AGENT_INSTRUCTION_FILE` (`error`)**, **`PACKAGED_AGENT_INSTRUCTION_FILE` (`warning`)**,
    **`FILES_GLOB_DROPPED_NEVER_PACKAGED` (`warning`)**, **`FILES_GLOB_MATCHED_NOTHING` (`info`)**
    and **`FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED` (`warning`)** — see Changed.
- **User-facing documentation for `vat skill test` and its config surface**
  (`packages/cli/docs/skill-test.md`), covering the per-skill `skills.config.<skill>.test` block and
  the global `test:` node.
- **The `coherence-audit` skill ships in the `vibe-agent-toolkit` plugin** — the audit method this
  release used: the one-contract question, the failure-direction tell, and how to spot a test suite
  that is structurally blind to the defect it covers.

### Changed

- **BREAKING: repo-internal agent-instruction files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
  `GEMINI.md`) are no longer bundled into skills, and linking to one is now an `error`
  (`LINK_TO_AGENT_INSTRUCTION_FILE`).** Bundling them caused silent mis-resolution — under
  `resourceNaming: basename` two packages' `CLAUDE.md` files collapse onto one destination, and an
  adopter verified by checksum that 2 of 3 links in a packaged document pointed at the wrong file —
  and unintended instruction loading: Claude Code loads `CLAUDE.md` files under the working
  directory on demand, so a skill installed project-locally (`.claude/skills/<name>/`) turns a
  bundled `CLAUDE.md` into live agent instructions the moment a reference beside it is opened.

  **What to do**, cheapest first:
  - **Point the link at the file's canonical home as an absolute URL** — it survives packaging
    verbatim and keeps the pointer. On one adopter this cleared 15 of 28 errors with seven one-line
    edits.
  - **Link the specific content the file describes**, or extract the shared part into a document
    meant for distribution — the right answer when the skill tells the agent to *read* the target.
  - **Ship it deliberately**: declare it under `skills.config.<name>.files` with an **explicit**
    (non-glob) `source:`. It is bundled at its declared `dest`, the link is rewritten to point at
    it, and the finding does not fire. A glob that merely catches the file earns none of that.

  `validation.severity.LINK_TO_AGENT_INSTRUCTION_FILE: ignore` silences the finding; unless an
  explicit `files:` entry names the file, it stays out of the bundle either way. The check runs in
  the packaging lanes (`vat build`, `vat validate`, `vat verify`); auditing a skill tree whose
  documents merely *contain* `CLAUDE.md` files is unaffected.
- **New `PACKAGED_AGENT_INSTRUCTION_FILE` (warning) — the presence-side half.** The link check
  cannot see a file that arrives in a bundle without any link. `vat build`, `vat verify` (a new
  in-process `packaged-content` phase crawling every built skill bundle) and `vat audit` now report
  each agent-instruction file found in a distributed tree, whatever route put it there — including a
  **built skill bundle**, which no lane inspected before: a bundle carrying two such files reported
  `filesScanned: 1`, zero issues, `warnings: 0`. `vat audit` decides a tree is distributed by
  PROVENANCE, not path shape and not your config: a `SKILL.md` inside a Claude install root
  (`~/.claude/plugins|skills|marketplaces`) is an installed artifact, and one that is **gitignored or
  outside any git repository** is a built bundle or unpacked third-party tree. Repository source —
  tracked, *or* written and not yet committed — stays silent, whether or not your project has
  adopted VAT. The install-root clause outranks the git one because Claude Code installs
  marketplaces by `git clone`. Measured on one real install: **7 findings across 628 audited
  skills**, one an intentional scaffold template. In `vat build` and `vat verify` an **explicit**
  `files:` entry naming the file suppresses it (a glob match earns nothing); `vat audit <path>`
  still reports it, having no config block to read intent from. Silence an intentional one with
  `validation.severity.PACKAGED_AGENT_INSTRUCTION_FILE: ignore`.
- **BREAKING: a `files:` glob and a plugin's verbatim tree-copy no longer ship files that never
  belong in a bundle.** Two routes reached a published bundle with no link pointing at them and no
  finding: a plugin's `source:` directory was tree-copied verbatim, so a `CLAUDE.md` beside
  `plugin.json` shipped to every consumer; and a `files:` glob (`source: extras/**/*`) shipped
  whatever it caught, including an `extras/README.md`, because `PACKAGED_UNREFERENCED_FILE` exempts
  any declared `files:` dest and the glob inherited an exemption earned by *explicit* declaration.
  Now:
  - **Agent-instruction files** are never packaged by a glob on any surface — skill bundle *and*
    plugin tree-copy, at any depth, **whatever their case**. (The plugin tree-copy has no per-file
    escape at all.) Case-insensitivity is load-bearing: on APFS and NTFS, Claude Code's lookup for a
    project-local `CLAUDE.md` is satisfied by `Claude.md` or `claude.md` just the same.
  - **Navigation files** (`README.md`, `index.md`, `toc.md`, `overview.md` + case variants) are
    never packaged into a **skill bundle**, but are still copied from a plugin source dir: a
    plugin-root `README.md` is the plugin's front page — 57 of 94 plugins installed on one real
    machine ship one, against 6 of 339 skills with a README beside their `SKILL.md`.
  - **The rule is glob-vs-explicit.** `source: extras/README.md` — a file you named — still ships. A
    deliberate scaffold or skill README needs **no new config**.

  **What to do:** if a glob was your way of shipping one of these, name it explicitly; entry order
  does not matter, including alongside an `integrity: true` glob over the same subtree. Every
  dropped file is a `FILES_GLOB_DROPPED_NEVER_PACKAGED` **warning in the structured result** (not
  merely stderr), anchored at the refused **source** file. A glob whose matches are *all*
  never-packaged is a hard build error. A `SKILL.md` link to a dropped file still fails the build as
  `PACKAGED_BROKEN_LINK`, now naming the never-package rule as the cause.
- **The pre-build gates now predict BOTH glob failures that kill the build.** `vat skills build` has
  two distinct hard errors for a `files:` glob — matched nothing ("has your build run?"), or matched
  and every match was refused by the never-package list — and `vat skills validate`, the lane
  adopters run in CI *before* the build, reported `success` on both. Two new codes close that:
  **`FILES_GLOB_MATCHED_NOTHING` (`info`)**, deliberately `info` because matching nothing before the
  artifact exists is expected and must not fail anyone's CI; and
  **`FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED` (`warning`)**, one finding per entry, **not** silenced
  by an explicit entry re-shipping one of the refused files. The three verdicts are mutually
  exclusive per entry.
- **BREAKING: there is now ONE answer to "findings → status", and every validation result carries
  per-severity counts.** Six places independently collapsed findings into a verdict and disagreed.
  Consequences across the CLI: `status` everywhere uses the same three-value vocabulary
  (`success` | `warning` | `failed`) — `vat resources validate` and `vat skill review --yaml`
  previously used two-valued vocabularies that could not express `warning`, and `vat skills
  validate` printed `status: success` and "✅ All validations passed" above active warnings; every
  result publishes `issueCounts`; `activeErrors`/`activeWarnings` are gone in favour of `allErrors`
  as the sole container; `vat audit` names file counts and finding counts apart
  (`summary.success|warnings|errors` become `summary.filesPassed|filesWithWarnings|filesWithErrors`);
  `vat audit settings --file` replaces `valid: true|false` with `status` + `issueCounts` +
  `findings` + `typeConfidence`; `vat doctor` reports four outcomes per check (`pass`, `fail`,
  `undetermined`, `skipped`) rather than a boolean; and `@vibe-agent-toolkit/claude-marketplace`'s
  `SettingsValidateResult` loses `valid`/`errors` for the same shape. **Every field named `error*`
  now counts errors only** — `vat resources validate` had such fields carrying mixed-severity
  totals, so a consumer gating on them blocked on warnings. **Exit code 2 ("System error") is now
  actually reachable** on `vat validate`, `vat verify` and `vat build`: a phase whose child exits 2,
  is killed by a signal, or never spawns is a system error, not a validation failure. Warnings
  remain non-blocking (exit 0).
- **BREAKING: `ValidationIssue.location` is always a project-relative POSIX path, and a link finding
  is anchored to the file that CONTAINS the link, not to the link's target.** One field had been
  carrying six incompatible meanings; for a missing target the old `location` named a path that does
  not exist, so no editor could open it. **If you have `validation.allow` globs for link codes, they
  must be rewritten against the containing file (or the href)** — `allow` entries match an issue's
  `location` or its `link`, both of which changed meaning here.
- **BREAKING: reports state their base once (`root`) and every `path` and `location` is relative to
  it.** Applies to `vat audit`, `vat resources scan --verbose`, `vat skills list`, `vat agent list`,
  `vat rag query` and `vat claude marketplace validate` — the last renames its top-level `path:` to
  `root:` and makes each `plugins[].path` relative to it. Absolute `$HOME` paths no longer appear in
  machine-readable output, so an audit can be shared or archived and still resolve. `vat inventory`
  and `vat audit settings` are deliberately unchanged; human-readable **stderr** keeps absolute
  paths.
- **BREAKING: `vat validate` stdout is a single parseable YAML document.** Child phases ran with
  inherited stdio, so N child documents were concatenated with no separator and `YAML.parse()` threw.
- **BREAKING: `--only` is removed from `vat verify` and `vat validate`.** Measured on a large
  adopter project, `vat verify` takes 31.7s end to end — the flag saved little and multiplied the
  ways a run could be partial. `vat build --only` remains.
- **BREAKING: the validating commands report per ASSET by default; `--verbose` restores full
  detail.** Applies to `vat resources validate`, `vat skills validate` and `vat claude marketplace
  validate`. **Errors always render in full at any verbosity**; warnings and info collapse into a
  count line. Machine-readable output is never filtered.
- **BREAKING: `vat verify` can see warnings.** Phase status was derived from the child's exit code
  alone, and `vat skills validate` exits 0 while reporting `status: warning` — so a warning phase
  reported `passed`. Its consistency phase now reports `warning` when it emits warnings, and
  publishes `issueCounts` plus the findings into the archived report.
- **BREAKING (widens the scan): `.claude/` and every other dot-directory is no longer invisible to
  VAT's file crawler.** picomatch refuses to let `*` or `**` traverse a segment beginning with a
  dot, so `**/*.md` — the default include pattern — could never match inside `.claude/`, `.github/`
  or any dotted directory. One adopter had **68 tracked files silently uncrawled** (`.claude/rules/`
  15, `.claude/skills/` 48, `.claude/commands/` 3, `.claude/agents/` 1). Every pattern now compiles
  with `dot: true`. **What to expect:** tracked markdown under a dot-directory with no narrowing
  `include` allowlist will now be scanned, and may report findings for the first time.
- **BREAKING: a path argument no longer voids the project's `include`/`exclude` globs.** Affects
  `vat resources validate|scan <path>`, `vat rag index <path>` and `vat audit <path>`. These re-based
  the crawl onto the given path, discarding every root-relative glob — so naming a subdirectory
  scanned build output, vendored trees and deliberately-broken fixtures the project had excluded on
  purpose, turning a green project red. On VAT's own tree `vat resources validate
  packages/vat-development-agents` reported 50 files / 7 errors where the configured run reported
  success; it now reports 25 files / 0 errors. The crawl base stays at the project root, the path
  narrows `include` only, and `exclude` always applies. A path outside the project root warns; a
  path that does not exist now fails loudly instead of reporting `filesScanned: 0` as success.
- **BREAKING for `owner/repo` shorthand: `vat audit <path>` never reaches the network for a path
  that exists.** The command asked "is this a git URL?" before "is this a directory?", and bare
  GitHub shorthand is spelled exactly like a two-segment relative path — so `vat audit plugins/arc`
  resolved to `https://github.com/plugins/arc.git`, never audited the local tree, and silently
  contacted github.com with a name derived from your own directory layout. Anyone registering that
  `owner/repo` could have had their tree cloned and reported back as your audit. An argument naming
  an existing file or directory is now always a path; shorthand applies only when nothing of that
  name exists locally.
- **BREAKING: `<skill-root>/evals/evals.json` is a declaration in the packaging lane too.** The
  harness has always defaulted to that path; the packager did not, so the harness protected the eval
  signal while the build **packaged and published the answer key**. The inference is narrow: keyed
  on the suite *file* existing, never a directory's name, and only at exactly `<skill-root>/evals`.
  An explicit `test.evals` still wins. **If you keep a `<skill-root>/evals/evals.json` suite and
  relied on it shipping, declare its contents through `files:` or move it.**
- **BREAKING: `${fixturesDir}` resolves per eval, under that eval's own staged workspace.** Because
  eval-suite isolation removes `<staged>/evals/` from every staged subject, the old target no longer
  exists. **This supersedes the 0.1.39 note** that fixtures under `evals/fixtures/` auto-stage with
  the eval tree — they no longer do; a fixture reaches the executor only by being declared in its
  eval's `files` list. An eval that declares no input `files` has no workspace, so `${fixturesDir}`
  there now fails at preflight (exit **2**) naming the env key, instead of injecting a path to
  nowhere.
- **BREAKING: `vat skill test`'s `--with`/`--with-optional` stage companion skills, and a run tests
  exactly one subject** (issue [#153](https://github.com/jdutton/vibe-agent-toolkit/issues/153)).
  `--with name=<src>` stages a **required** companion the subject can invoke; `--with-optional`
  stages an optional one. This replaces an undocumented behavior where `--with` merely overrode the
  staging source of an already-listed positional skill and **silently no-op'd** any name that wasn't
  positional — so a routing/deferral eval could "pass" against a skill set that never contained the
  companion. The positional argument is now a single `<skill>` (was variadic). A required companion
  that cannot be resolved fails the run (exit **2**); an optional one is skipped with a warning;
  staging the same name twice is an error. `skills.config.<skill>.test.with`/`optional` behave the
  same way — they previously never staged anything. A companion mapping to a declared skill is now
  **built** rather than tree-copied from raw source, so one backed by a bundled executable no longer
  stages non-functional and hangs the executor with no diagnostic.
- **BREAKING: `license: <spdx-id>` in your marketplace config only accepts identifiers VAT can
  render in full.** `vat claude marketplace publish` vouched for eleven SPDX shortcuts but carried
  real license text for one. Nine fell through to a two-line stub, and `apache-2.0` emitted only the
  short-form notice header — written verbatim as the published `LICENSE`, so a `publish` reporting
  success shipped a distribution whose license file grants nothing (GPL-3.0 §4 and Apache-2.0 §4(a)
  both require conveying a complete copy of the License). `mit` renders as before; the other ten now
  fail with an error naming the identifier, linking its canonical text, and telling you to point
  `license` at a file path (`./LICENSE`), which `publish` has always supported.
- **BREAKING: `vat skills install` installs a skill under the name it declares, not the name of the
  directory it arrived in.** Every other lane treats SKILL.md frontmatter as the identity. The
  command now also says which of its seven targets VAT can see back, and `vat skills list` reports
  the declared name alongside the directory name.
- **BREAKING: plugin-local skills are packaged, not copied verbatim.** A skill in a plugin's own
  `skills/` source tree (`vat claude plugin build`) now goes through the same packaging pipeline as
  every other skill — link traversal, reference rewriting, nav stripping and `files:` injection.
- **BREAKING: local RAG embeddings are batteries-included, backed by `onnxruntime-web` (WASM)
  instead of native `onnxruntime-node`.** No native addon to build. This also fixes **`vat rag
  index`/`query` exiting 134 on macOS**: the native backend raced LanceDB's native runtime at
  process teardown and their static destructors could abort with `libc++abi: mutex lock failed`
  (SIGABRT) **after** the command had already produced correct output.
- **BREAKING: a link to a file that does not exist reports `LINK_MISSING_TARGET`, not
  `LINK_TO_GITIGNORED_FILE`.** Three layers composed to name the wrong cause in every real case.
- **BREAKING: `flushStdout` is removed** from `@vibe-agent-toolkit/cli` (library API only). It had
  no production callers and was not a harmless no-op — it waited only above `highWaterMark`. The
  blocking-stdio fix below replaces it.
- **BREAKING: `vat audit --user` plugin groups are named after the plugin.** The name was read at a
  fixed offset from `marketplaces/`, which does not hold in Claude Code's real layout.
- **BREAKING (library API): `validateFrontmatterSchema`, `validateFrontmatterRules`,
  `detectUndeclaredCrossSkillAuth`, `detectBundledResourceWithoutLinks` and the five inventory
  detectors take an extra argument** — the skill location / project root. Required rather than
  optional by design: a defaulted parameter would let existing call sites silently keep the old
  behaviour. Only affects code importing these directly; no CLI surface changes.
- **BREAKING: `vat skills build` no longer stops at the first bad skill, and a failed build no longer
  destroys `dist/skills/`.** It validated skills one at a time and exited on the first failure, after
  clearing the whole output tree up front — so on a 90-skill adopter monorepo, a run carrying 28
  errors across 6 skills reported **3 of them, named 1 of the 6, and left `dist/skills` absent**, not
  merely stale: 27 bundles and 106 files of gitignored, unrecoverable prior output. `vat claude
  plugin install --dev` symlinks each skill *out of* `dist/skills/` and skips what it cannot find, so
  the installed plugin ended up with no skills, and a subsequent `vat build --only claude` reported
  `status: success` with `errors: 0` against input the previous command had deleted. Separately, a
  skill that failed by *throwing* escaped the batch entirely: a single filename collision discarded
  all 89 other results and collapsed the report into one bare `error:` string. **The exit code for
  that case changes 2 → 1** — it is the validation failure it always was, and a collision is now
  reported as a finding naming its skill by declared name rather than thrown as a raw `Error`.

  Now every skill is validated, every failure collected and contained, and the run reports all of
  them in one pass, with pre-build validation failure published as its own population distinct from
  "packaging threw" and "built, then failed validation". Output is written to a staging directory
  beside `dist/skills` and promoted with a same-filesystem rename only when the run earns it; a
  failed run restores the previous bundle byte for byte. The report gains `outputCommitted`,
  `skillsFailedValidation` and `skillsStaged`, and the exit code derives from `outputCommitted`
  rather than being recomputed. `--dry-run` now touches `dist/` not at all. A failed promotion
  publishes a `promotionError` naming the parked path and the exact `mv` to recover it, forces
  `status: error`, and exits **2** *after* writing the document — previously that path threw past
  the reporting layer and emitted no report at all. The report also **names its findings**: each row
  carries a full `issues:` array in the shape `vat audit` and `vat skills validate` already publish,
  where a ~90-skill adopter run previously reported 67 warnings with no `code`, no location and no
  fix string at any verbosity. Per-skill progress lines name their skill, which at 92 skills is the
  difference between a readable log and 86 anonymous `Built N files` lines.
- **BREAKING: `vat skills validate <path>` and `vat skills build <path>` now exit 2 on a path they
  cannot scope to, instead of reporting success.** A path that does not exist, is not a directory,
  or holds no `vibe-agent-toolkit.config.yaml` was silently rescoped to nothing and signed off with
  **exit 0**. A CI step naming a mistyped path passed while validating zero skills; a release step
  naming one published having built nothing, and reported success. Both errors now name the path and
  suggest `vat audit <path>` for scanning an arbitrary directory. Only an explicit argument is
  judged; the bare invocations are unchanged.
- **BREAKING: `-v` is no longer an alias for `--version`. It now means `--verbose` on every verb
  that has a `--verbose`.** The root registered `.version(…, '-v, --version')`, and Commander
  resolves a root option before the subcommand's own — so the short flag silently shadowed the
  `-v, --verbose` that `validate`, `verify`, `build`, `skills build` and `skills validate` each
  document in their own `--help`. `vat validate -v` printed the version string and exited **0**
  having validated nothing, so a CI step spelled that way was a permanently-green gate that ran no
  checks. Any script relying on `vat -v` to print the version must switch to `vat --version`. `vat
  audit` and `vat doctor` advertised only the long `--verbose`; both now carry the short form too.
- **`validation.severity` overrides now work in every lane and in BOTH directions.** The documented
  opt-out was a partial or total no-op in four places: `vat audit` consulted the merged override map
  for exactly one value (`!== 'ignore'`), so suppression worked while `error`, `warning` and `info`
  fell through — an adopter promoting a code to `error` saw `severity: warning`, `errors: 0`,
  `status: warning`, while `vat verify` on the *same config key* promoted correctly; `vat audit`'s
  config lookup never searched upward, so auditing `dist/skills/<name>` looked for
  `vibe-agent-toolkit.config.yaml` *inside the bundle* and skipped severity filtering entirely; the
  filter only considered results of skill type, so a finding on a **plugin** or marketplace tree
  kept its severity regardless of config (the load-bearing half — a plugin that intentionally ships
  a scaffold `CLAUDE.md` *template* lands on a plugin result, which no per-skill key can name); and
  `vat verify`'s `marketplace:<name>` phase read no project config at all, so two
  `PACKAGED_AGENT_INSTRUCTION_FILE` warnings survived `ignore` at `skills.defaults`, at every
  per-skill key, and at the plugin's own name, while its `packaged-content` phase honoured the same
  key on the same tree.

  `skills.defaults.validation.severity` now applies project-wide, with `skills.config.<name>`
  layering on top wherever a result names a skill, and one shared resolver serves every lane —
  skill, plugin, marketplace, required-file and in-plugin-skill findings alike. A promotion moves
  the reported severity, the result `status`, and `vat claude marketplace validate`'s exit code (1)
  that `vat verify` reads back as the phase status; it does **not** change `vat audit`'s exit code,
  which stays advisory. Manifest-unreadable findings are exempt. Per-plugin granularity remains
  unavailable: neither marketplace config schema has a `validation` key.

### Fixed

**Link integrity and packaging fidelity**

- **Frontmatter schemas declaring JSON Schema draft 2020-12 or 2019-09 now compile.** VAT compiled
  every external `frontmatterSchema` with Ajv's default export, which carries only draft-07 and
  older meta-schemas, so a schema declaring the current standard raised `FRONTMATTER_SCHEMA_ERROR`
  at **error** severity for *every file in the collection* — one adopter saw **247 errors from a
  single four-property schema**. VAT now selects the Ajv build matching the declared dialect, and
  also registers the non-canonical `http://` spelling of each dialect URI as an alias.
- **Root-relative (`/docs/…`) markdown links survive packaging instead of being silently stripped.**
  The link-graph walker resolved them and **bundled** the target while `ResourceRegistry` left the
  link unresolved, so the packaged prose lost the link entirely: on one real adopter document the
  packaged copy carried **4 links where the source had 15**, and the orphaned target then failed the
  build with an error-severity `PACKAGED_UNREFERENCED_FILE`. Relatedly, a root-absolute link is no
  longer misreported as `LINK_OUTSIDE_PROJECT`, which produced **81 false errors** on one monorepo.
- **A markdown link whose target does not ship is stripped to plain text, in every spelling, keeping
  its own text and inline formatting.** A directory link with a trailing slash (`[refs](refs/)`)
  survived verbatim and tripped `PACKAGED_BROKEN_LINK`; the same link without the slash, and any
  non-markdown asset dropped from the bundle, shipped `[text]()`; and two links sharing an href
  rendered the second with the **first** link's text (VAT's own `vat-skill-review` skill shipped
  "See cached guidance for a cached copy…" where the author wrote the filename). The inline-link
  regex also no longer runs past a stray unpaired `[` into the next link.
- **Link syntax inside fenced code blocks and inline code spans is no longer rewritten**, so a skill
  *teaching* link syntax ships the spelling a reader must type rather than the packaged path.
- **`<a id="short">` anchors in markdown resolve instead of being reported as broken links.** VAT
  indexed heading slugs only, so an explicit short anchor above a long heading produced
  `LINK_BROKEN_ANCHOR` for a link GitHub resolves — one adopter repointed working links at the long
  slug to appease the tool. An `id=` inside a code block is still never indexed.
- **A file declared in `files:` and also linked from `SKILL.md` now ships exactly once, at the
  destination it declares.** An **explicit** entry shipped twice — at the declared `dest:` and again
  where the link-follower puts it, with the rewritten link pointing at the second copy, while
  `filesPackaged` counted the `files:` side alone (reporting 2 where the disk held 4). A **glob**
  entry had the mirror-image bug: it skipped a file link traversal had already bundled, *before*
  computing its destination, so the file was missing from the declared `dest` subtree and the build
  exited 0 — and `integrity: true` did not catch it, the file being in neither the expected set nor
  the on-disk subtree. The path map is now built in two passes, globs first, explicit second.
- **`vat skills build` no longer fails on its own `files:` payload.** `PACKAGED_UNREFERENCED_FILE`
  (severity `error`) fired on files VAT itself had just copied in from a skill's `files:` map — a
  vendored engine, generated schemas, data packs. Adopters who added `validation.allow` waivers
  restating their own `files:` map can delete them.
- **A `files:` remap is now a real remedy for a filename collision.** `FILENAME_COLLISION` was
  judged on the naming strategy's *would-be* destinations, one step before `files:` entries override
  them, so an adopter who remapped both colliding sources to distinct dests still had the build
  failed at **error** severity for a collision that no longer physically occurred. The check now
  runs against the **final** destination map — and it moved rather than weakened: two `files:`
  entries pointing at one dest is a genuine collision the old check had no trace of.
- **A `files:` entry with a directory-shaped `dest` no longer writes a file named after the
  directory.** `dest: "guides/"` on a non-glob entry silently produced a *file* called `guides`
  holding the source's bytes. Such a `dest` is now rejected at config-parse time; globs are
  unaffected, their `dest` being a subtree root.
- **A `files:` glob with a `..` segment after its static base is now rejected when the config
  loads.** `source: "dist/gen/**/../../secrets/*"` parsed cleanly, passed `vat skills validate`, then
  killed the build at copy time. The static base may still begin with `..` (the deliberate
  sibling-base monorepo feature).
- **`packagingConfigToPackageOptions` now forwards `excludeNavigationFiles`.** It was dropped in the
  canonical config→options conversion whose docstring promises byte-for-byte parity, so with the
  flag `false` the pre-build gate predicted a `README.md` would ship and the build stripped it.
- **`resources validate` and `skills validate` agree on `files:`-declared build artifacts**, and a
  `files:` destination is exempt from the gitignore-leak rule even before the build runs — so
  building the project can no longer turn a previously-passing `vat skills validate` red on its own
  declared, gitignored output.
- **A file whose frontmatter fails to parse is no longer also reported as having no frontmatter.** A
  document with a duplicate YAML key drew both `FRONTMATTER_INVALID_YAML` and `FRONTMATTER_MISSING`,
  with two conflicting remediations.
- **`vat verify` now inspects skills discovered by `skills.include` globs, not just those with an
  explicit `skills.config.<name>` block.** Its in-process phases enumerated config keys, so a
  glob-discovered skill was silently skipped — and for a project using only `skills.defaults.files`,
  the `files-config-dests` check was a **total no-op while its phase banner still reported that it
  ran**. **Adopters should expect new findings** on projects that use `skills.defaults.files` or
  omit `skills.config`.

**Reports that told the truth about themselves**

- **Piped output is no longer truncated at 64 KB.** Node makes a pipe's stdio non-blocking and every
  command calls `process.exit()` without draining those buffers, so everything past the first pipe
  buffer was silently discarded, cut mid-token, **with exit code 0** — breaking exactly the usage
  the CLI's own docs recommend (`vat command | jq .status`). A large `vat resources scan --verbose`
  emitted **65,540 bytes through a pipe against 346,937 to a file**, so a consumer read a header
  claiming 1,322 files above a list containing 293. An interactive TTY is unbuffered and always
  looked correct. Both streams are now blocking at startup — including stderr, which carries the
  findings — in both published bins.
- **`writeYamlOutput` no longer emits a trailing `---`.** In YAML `---` OPENS a document, so every
  command's stdout was a two-document stream and a plain `YAML.parse()` threw `Source contains
  multiple documents` — on output this CLI documents as machine-parseable.
- **`vat audit --user` no longer audits every marketplace-installed plugin twice.** `marketplaces/`
  lives *inside* `plugins/`, and the user scan walked both recursively, so every finding class was
  inflated: one real install reported **12** agent-instruction findings for **7** distinct files.
  Roots contained in another root are now dropped, but only when the walk is recursive.
- **`vat audit`: info-severity findings are no longer invisible.** The terse renderer decided
  "nothing to show" from the result's *status*, and an info-only result is `success` — so a real
  `--user` scan counted 504 info findings and rendered none of the 167 belonging to the 128 skills
  that had info findings and nothing else. Info findings are also no longer labelled `[WARNING]`.
- **`vat audit`: a result's status, counts and summary follow its findings, and header totals agree
  with per-file totals.** A plugin carrying a warning reported `status: success`,
  `issueCounts: {0,0,0}` and `summary: Valid plugin` in the same entry that listed the warning. One
  `--user` run reported 55/422/504 in the header against 55/360/405 summed per file — **91 of 614
  entries declared `{0,0,0}` directly above the findings they listed.** Every total is now derived
  from one traversal of the final issue set.
- **The `skills` command family told four inconsistent stories; it now tells one.** Its header
  reported more warnings than its rows summed to (1814 vs 1800 on a large tree); a `skills` failure
  produced **zero bytes of stdout** before exiting 2; `vat skills build` and `vat skills package`
  exited 1 from their validation gate with empty stdout though `--help` documents a summary for
  exactly that case; and `vat skills package` hardcoded `status: success`, so a skill `vat skills
  build` reported as `warning` came back `success`. A build that fails only on built-output
  validation now also shows why.
- **`vat audit settings` emits the full `overrode` provenance chain** for every effective value,
  naming each value it replaced down to the lowest-precedence layer — the question the command
  exists to answer. It was computed and then dropped.
- **`vat audit --user`: cached skills are matched against their own source.** The cache/source index
  was keyed by bare skill name; one real scan had 93 collisions across two marketplaces, so cached
  copies were compared against unrelated same-named skills — reporting `cacheStatus: stale` for
  byte-identical copies, and able to hide genuinely drifted ones as `fresh`.
- **`vat verify`, `vat validate` and `vat build` reject a path argument instead of silently
  discarding it.** Commander accepts excess arguments by default, so `vat verify dist/skills/demo`
  threw the path away, ran an unscoped whole-project verify, and reported `status: success`; on
  `vat build` the same defect silently rescoped a command that *writes*. All three now exit 2 naming
  the discarded argument and pointing at `vat audit <path>` — exit 2 rather than Commander's
  usage-error 1, because on these commands 1 means "validation errors found".
- **Build and plugin failure messages no longer publish your absolute filesystem paths into
  machine-readable stdout.** Four `files:` failure routes interpolated the fully resolved absolute
  path into `failedSkills[].message` / `failures[].message` — the output adopters paste into CI logs
  and issue reports — disclosing the operator's home directory and the project's location on disk.
- **`vat --version` names the binary that produced it.** The `-dev (<path>)` suffix was derived from
  the *current directory*, not the binary, so a development build run by absolute path from another
  repository printed a version string byte-identical to the released one — precisely the situation
  every adopter integration test runs in. The output now carries a `binary:` line derived from the
  entry module Node actually loaded; the version still comes first, so `--version | head -1` parses
  as before.
**Crashes, hangs and stalls**

- **`vat skill test run` no longer crashes on Windows with `spawn EINVAL`.** On Windows `claude`
  resolves to an npm `.cmd` shim, and since the Node CVE-2024-27980 fix a bare `spawn` of a `.cmd`
  throws synchronously — so the harness died the instant it tried to launch the session (reported by
  an adopter across cmd.exe, PowerShell and Git Bash). Spawning now detects `.cmd`/`.bat`/`.ps1`
  shims and launches them through the shell with per-arg quoting. In-flight grader/executor children
  are also killed before the harness exits, rather than left running and billing tokens.
- **`vat audit` no longer dies on a single unreadable file.** One markdown file the process could
  not open — anywhere under the crawl root — aborted the whole command with `status: error` and exit
  **2**, returning none of the findings already gathered. It now degrades to one `parseError` per
  affected skill.
- **`vat audit <owner>/<repo>` no longer stalls ~60 seconds on a git credential prompt.**
  Interaction is disabled for the clone, but **only when the URL was inferred from shorthand**, so
  someone who typed a full URL for a private repo can still authenticate. `GIT_TERMINAL_PROMPT=0`
  alone was measured to be insufficient: every askpass hook short-circuits the terminal path before
  that variable is consulted, so an editor exporting `GIT_ASKPASS` would have kept the entire stall.
- **`vat build --only` with an unroutable phase prints a structured document instead of a stack
  trace.** It threw from outside the command's try block, so the user got a raw Node stack, **zero
  bytes of stdout**, and an exit 1 indistinguishable from "validation errors". The message was also
  self-refuting: *"Unknown phase: claude. Valid phases: skills, claude."*

**Performance**

- **`vat audit` re-did the most expensive thing VAT owns once per skill; it now does it once per
  project root.** On a ~1,200-document monorepo, auditing a directory of 46 skills did not complete
  in ten minutes while `vat resources validate` scanned the same tree in seconds. Two independent
  causes: the inventory link walk crawled with `respectGitignore: false`, which also means "include
  everything git is told to ignore" and abandons `git ls-files` for a full recursive walk of every
  build cache and nested worktree — **39,599 ms versus 16 ms**, for 1,146 files versus 1,143; and
  the registry was rebuilt per skill, parsing every markdown document under the project root (~20 s
  on that tree) N times over. Auditing a plugin directly went from **369 s to 42 s** for 2 skills
  and is now effectively flat in skill count (a 19-skill plugin audits in 27 s).
- **`vat claude plugin build` no longer re-reads the whole project once per skill.** The cost was
  fixed per skill and independent of the skill's own size: on a monorepo with 1,039 markdown files a
  1-file skill and a 17-file skill each cost **~25 s**, putting a 46-skill build past a 30-minute CI
  cap with no output during the gaps. The registry is now created once per run and threaded through
  (**~2× faster** per skill). `vat skills build` was never affected.

**Discovery and detection**

- **A newly-authored, uncommitted `SKILL.md` is now discovered.** Discovery crawled via
  `git ls-files`, which lists only tracked files, so a brand-new skill was invisible: `vat skills
  validate` silently reported one fewer skill and exited 0, and `vat skills build` did not ship it.
  Nothing warned — the count was the only tell.
- **`vat audit --user`: 52 of 59 errors were false; the run goes 59 → 7.** VAT modelled Claude
  Code's installed-plugins registry and `known_marketplaces.json` — maximally external data — with
  `.strict()` schemas, a non-optional `isLocal` that current Claude Code never writes, and a `scope`
  union missing the `project` and `local` values the real file contains. Drift stays visible via the
  new `REGISTRY_SHAPE_DRIFT`.
- **`ALLOW_UNUSED` is evaluated across the whole run instead of per skill.** `validation.allow` is
  declared per *package* but unused-ness was computed per *skill*, so an entry scoped to two files
  was reported unused by every other skill — **87 false warnings from 3 legitimate entries** on
  VAT's own 13-skill package, and 32 on `vat build` from a second, independent cause. Both go to 0,
  with all entries still listed under "Allowed issues" so the zero is a true answer rather than a
  suppression. A genuinely dead entry still yields exactly one warning for the run.
- **The bundled-resource-link detector can fire on `.md` files at all.** It hardcoded
  `['scripts','references','assets']` while the routing module that calls itself the single source
  of truth routes `.md` and every unknown extension to `resources/`, so the most common bundled
  shape was structurally unreachable; coverage was also computed per *directory*, so one live
  mention marked a whole directory referenced. Measured over the plugin corpus fixture: **6 → 19
  findings, 0 lost.**
- **`vat audit` no longer reports 179 real Python standard-library modules as third-party
  dependencies.** `PYTHON_IMPORT_THIRD_PARTY` classified imports against a hand-typed list of 151
  modules, so `import zoneinfo`, `import fcntl`, `import wsgiref` and 176 others were reported as
  depending on packages that do not exist. The list is now generated from CPython's own
  `sys.stdlib_module_names`, unioned across Python 3.10–3.14.
- **An external link no longer changes verdict between the first run and the second.** The
  fresh-fetch path judged "alive" against an exact allowlist while the cache-read path used a
  `>= 200 && < 400` range, so twelve status codes failed one run and then passed for the next 24
  hours off the persistent cache — self-concealing, since it disappeared on exactly the retry you
  would run to reproduce it.
- **`CLAUDE_CONFIG_DIR` is now normalised once, where it is read.** An empty or whitespace-only
  value — `CLAUDE_CONFIG_DIR=`, the ordinary way a shell or CI env block clears a variable — was not
  caught by the `??` default, so `$cwd/skills` and `$cwd/plugins` were treated as Claude install
  roots. A relative value made the answer depend on the working directory, and a `~/`-prefixed one
  (never expanded inside a `.env` file) resolved to `$cwd/~/.claude`, silently disabling
  install-root detection altogether. The value is now trimmed, treated as absent when blank,
  `~`-expanded and resolved at its single read site. Install-root comparisons additionally
  canonicalise both sides, so a symlinked Claude config directory — and, on macOS/Windows, a
  case-variant spelling of an ordinary repository path — no longer flips the verdict.

**Other**

- **The Vercel AI SDK adapters no longer discard an explicit `temperature: 0`.** Both
  `llm-analyzer` and `conversational-assistant` spread the setting through a truthiness guard, so
  the one value a caller is most likely to set deliberately — deterministic output — was silently
  replaced by the provider default. The same guard dropped `maxTokens: 0`. Both are now guarded on
  `!== undefined`.
- **`author.url` in your `plugin.json` is no longer destroyed by the plugin build.** `vat claude
  plugin build` replaced the whole `author` object with `{name, email}` built from the marketplace
  `owner`, and Claude's manifest supports `author.url` while VAT's config has no field for it — so
  an adopter who wrote `author: {name, email, url}` lost the URL on every build **with no config
  field to restore it**. `author` is now merged per subfield: `name` and `email` come from `owner`,
  everything else passes through untouched.
- **`vat rag` no longer silently degrades embeddings when the configured model is not BERT-shaped.**
  The local ONNX provider accepted any HuggingFace model id and loaded that model's own `vocab.txt`,
  but framed every sequence with **hardcoded** BERT special-token ids. Point it at a RoBERTa-derived
  encoder and those ids are arbitrary wordpieces while padding is written as `<s>` rather than
  `<pad>` — the vocab parses, dimensions match, no exception, no warning, and `vat rag index` builds
  a quietly worse index forever. Special-token ids are now read from the loaded vocabulary, and a
  vocabulary that does not define them fails at **load** time with an `IncompatibleVocabError`
  naming the model, the file, and the missing tokens. There is deliberately no bypass flag.
- **Two remediation strings no longer prescribe the wrong fix.** `PACKAGED_UNREFERENCED_FILE` and
  `SKILL_REFERENCES_BUT_NO_LINKS` told you to waive the finding via `validation.allow`; both now
  point at `skills.config.<name>.files`, where a declared `dest` is exempt outright. The old
  phrasing led one adopter to hand-write ~130 lines of waivers duplicating their own `files:` map.
- **VAT's published skill-review rubric no longer attributes VAT's own rules to Anthropic.**
  Re-verified against the live best-practices page, which showed **no vendor drift** — every numeric
  limit unchanged. Three items marked `[A]` are VAT's own and are now `[VAT]`, and the rubric records
  where VAT *under*-enforces the vendor: `REFERENCE_TOO_DEEP` fires only above 2 hops, so a chain
  that is Anthropic's own "Bad example: Too deep" passes validation. **No threshold value changed.**
- **`vat claude org`'s not-yet-implemented stubs no longer promise a release that already shipped.**
  They emitted `plannedFor: "0.1.22"` from a package 19 releases later. The version literal is gone
  rather than bumped, since any literal re-creates the same rot.

### Notes for adopters

- **`mustRun` means *invoked*; use `mustSucceed` for *worked*.** `mustRun` passes as long as the
  tool ran, even if it errored. Both are transcript-judged, so a skill that swallows a non-zero exit
  (`cmd || true`) can still read as success — pair it with an output expectation when you need
  certainty. Tracked in [#150](https://github.com/jdutton/vibe-agent-toolkit/issues/150).
- **`tool-eval.json` is always written** (`{"evals": []}` when no eval declares `toolExpectations`)
  so the fail-closed artifact check has something to read — check `.evals.length`, not file
  existence.
- **`--allow-eval-failure` (from 0.1.40) also downgrades a fail-fast-gated run to exit 0** —
  consistent with how it downgrades any eval failure, but worth knowing if you gate CI on tiered
  runs.
- **`status: warning` on a warnings-only project is deliberate.** `success` means "nothing you must
  act on", not "nothing to see" — so a CI gate should read `issueCounts.errors` or the exit code,
  both of which stay `0` through any number of warnings.

## [0.1.40] - 2026-07-12

### Changed

- **`vat skill test` now fails closed on eval failure by default.** A completed run whose expectations did not all pass now exits **4** (`EvalFailure`) instead of the previous exit **0**. This code stays distinct from the harness-broke codes (`1` internal/stall/timeout, `2` preflight, `3` bootstrap) so a CI consumer can tolerate eval failures while failing closed on everything else: `case $? in 0) ;; 4) tolerate/warn ;; *) exit 1 ;; esac`. The old opt-in `--fail-on-eval-failure` flag is **replaced** by an opt-out `--allow-eval-failure` (for interactive iteration), which downgrades a failing verdict back to exit 0. Which specific evals failed still lives in `results/grading.json`, never in the exit code. The timeout/stall/non-zero-exit → exit-1 semantics are unchanged.

### Added

- **`VAT_LINKAUTH_ALLOW_COMMAND=0` opt-out for token command sources (issue #113 §6.2).** Set `VAT_LINKAUTH_ALLOW_COMMAND=0` in your environment to skip all `{ command: ... }` token sources at runtime — only `{ env: ... }` sources are tried. Useful in security-sensitive CI environments or policies that prohibit arbitrary child-process execution from the link validator. The opt-out can also be set programmatically via `allowCommand: false` in the injected `TokenResolutionDeps`.

### Fixed

- **`vat skill test` path targets now honor the declared skill's `test:` config.** Pointing at a declared skill's built dist (`vat skill test run ./dist/skills/my-skill/`) now applies that skill's `skills.config.<name>.test` block — model, evals, timeout — and resolves the authored eval suite from the skill's **source** dir, so a path target behaves like the name `my-skill` (minus the rebuild). Previously a path target silently ignored the config and could spuriously bootstrap a fresh `evals.json` because it looked for the suite under the dist. The mapping is project-aware (`findDeclaredSkillForPath` walks up from the path, config-first) so it works regardless of the working directory. A path that maps to **no** declared skill is still tested as-is (config-blind); the one-line stderr note now fires only in that case and points at the name form (or the built-dist path) to get config honored.
- **`vat skill test` default `--timeout` now scales with the declared eval count** instead of a flat 5 minutes. A correctly-configured multi-eval suite was being truncated at the 300s wall and reported as a spurious exit-1 failure even though a complete, all-passing `grading.json` had already been written; the default is now ~`2min + 2min/eval` (floored at 5min, capped at 1h), which gives real suites headroom. An explicit `--timeout` still overrides. On timeout the error message now names the declared eval count and points to `--timeout`/`--stall`. The timeout/stall/non-zero-exit → exit-1 semantics are unchanged — a completed-but-killed run is still never laundered into a PASS.
- **`vat skill test` now surfaces `friction.json` entries to stderr at the end of a run — even when the verdict can't be computed.** Packaging friction (e.g. a declared runtime bundle absent from the staged tree, which silently reduces a "behavioral" suite to documentation comprehension) was written to `results/friction.json` but never echoed, so it hid behind a green-looking summary. Friction entries are now printed to stderr as `[severity] category: message`. The report is emitted from the harness `finally` block, so it also surfaces on the failure paths — a grader nonce/skew error (exit 1), a missing/invalid `grading.json`, or a timeout — where a hollow package tends to trip the friction *and* the error at once, and the friction ("your bundle is missing") is the key diagnostic that the error would otherwise mask.
- **`vat skill test run` warns when a path target bypasses the project's `test:` config.** A path/source target silently ignored the `skills.config.<skill>.test` block (model, evals) that a name target honors; it now prints a one-line stderr note pointing to the name-target form so the divergence is visible.
- **`gh auth token` (and other token commands) no longer fail when `vat resources validate` runs from a git pre-commit hook (issue #113 §6.1).** Git sets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and related vars before invoking hooks; these poison any tool that internally shells out to git, including `gh auth token`. The default token-command runner now strips all `GIT_*` vars from the environment before spawning, so authenticated link checking works correctly in both hook and non-hook contexts.

## [0.1.39] - 2026-07-03

### Added

- **Dogfood eval suites for the whole `vat-development-agents` skill set, plus the fixes that dogfooding surfaced.** Every published VAT dev skill now ships a committed `vat skill test` eval suite (`evals/<skill>/`): `vat-audit`, `vat-skill-authoring`, `vat-knowledge-resources`, `vat-skill-distribution`, `vat-rag`, `vat-agent-authoring`, and `markdown-rewriting` (joining the existing `vat-skill-review` suite), wired via `skills.config.<skill>.test`. Final grades: vat-skill-distribution 25/25, vat-agent-authoring 24/24, vat-rag 22/22, vat-knowledge-resources 22/22, markdown-rewriting 18/18, vat-skill-authoring 21/22 (one capability-headroom miss), vat-audit 33/40 baseline A/B (the without-skill failures demonstrate the skill's lift on CI-gating/compat knowledge). Running the suites caught real skill/doc bugs, now fixed:
  - **`markdown-rewriting` is now actually published.** It lived in the skills dir and `vat-skill-authoring` told agents to load `[[markdown-rewriting]]`, but the discovery glob (`vat-*.md`) didn't match its name, so it never shipped — a dangling skill reference. Added it to `skills.include` and `package.json` `vat.skills`; it now builds and ships.
  - **`vat-skill-authoring`** gained the conservative-frontmatter-keys rule (the standard key set; stamp `version`/`team`/ownership under `metadata:` or in config.yaml, never as bare top-level keys) — the agent was inventing top-level `version:`/`team:` fields.
  - **`vat-skill-review`** corrected a factual error: it claimed a `metadata:` field "will be rejected," but `metadata` is an allowed standard key (the sanctioned home for custom data per `SKILL_FRONTMATTER_EXTRA_FIELDS`).
  - **`vat-rag`** removed a nonexistent `vat rag index --rebuild` flag (the real reset is `vat rag clear`; indexing is incremental) and added the missing `OnnxEmbeddingProvider` to the providers table.
  - **`vat-knowledge-resources`** now states that `strict` mode only rejects extra fields when the schema sets `"additionalProperties": false`, and that collection validation defaults to `permissive`.
  - **Collection-validation docs** corrected: `mode` defaults to `permissive` (matching `validateAgainstCollectionSchema`), not `strict` as previously documented.
  - **Skill-test harness:** `buildForwardedEnv` now forwards `USER`/`LOGNAME` (see below) and eval fixtures (including intentionally-broken `.ts` files) are excluded from ESLint.

- **`vat skill test run` / `vat skill test configure` — behavioral skill testing in a context-isolated harness (#132).** Stage a packaged skill plus its declared dependencies into a throwaway, locked-down harness and run a canned, non-interactive evaluation that grades the skill against your `evals.json` (reusing skill-creator's grading rubric and JSON shapes) and writes `grading.json` (with a published [JSON Schema](docs/skill-test-grading-schema.md)), `friction.json`, and full transcripts you can inspect. `configure` writes a per-skill `test:` block to your config as a surgical edit — only the keys you pass change; surrounding formatting and comments are byte-preserved; a first `run` with no `evals.json` writes a template for you to fill in. Runs end-to-end against `claude` 2.x. **Security:** the harness runs the skill's own code with your account's privileges — it is *context* isolation, not an OS sandbox — so `run` requires `--i-understand-this-runs-skill-code`, enforced *before* anything runs (including the optional pre-stage build), and you should only test skills you trust. The pass/fail verdict is recomputed from the graded expectations, so a failing or empty grade is never silently reported as a pass; add `--fail-on-eval-failure` to make a failing eval exit non-zero and gate CI on it. See the new `vibe-agent-toolkit:vat-skill-testing` skill for auth modes, budget/turn/timeout caps, `--baseline` A/B runs, and exit codes.
  - **Pre-stage `build:` hook + plugin-root staging.** An optional `test.build` command runs once before staging, so a skill that depends on a generated, un-committed artifact has it present (a non-zero build fails fast at preflight, before any tokens are spent). Plugin-distributed skills stage under their real plugin-root layout with `CLAUDE_PLUGIN_ROOT` set; standalone skills stage flat.
  - **Declared test-env passthrough.** `passEnv` / `--pass-env` forwards host variables; `env` / `--env` injects values with `${fixturesDir}` / `${stagedSkillDir}` / `${harnessRoot}` / `${resultsDir}` interpolation. Both apply *after* the security allowlist — protected names always win, so committed test config can neither reroute your account credentials nor inject code: auth credentials, `PATH`, and credential-routing variables (`ANTHROPIC_BASE_URL` and the other endpoint/proxy overrides, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`) cannot be overridden. Fixtures under the skill's `evals/fixtures/` auto-stage with the eval tree.
  - **Project-aware subject resolution.** Name a skill declared in `vibe-agent-toolkit.config.yaml` and `run` builds it first and tests the shipping **dist** — link-following, reference-rewriting, nav-stripping, and `files:` injection all applied — so you exercise exactly what installs, not the source tree. A path (including an already-built dist dir), or a `workspace:` / `npm:` / `url:` / `path:` / `vendored` source, is tested as-is; use `./<name>` to force a local directory over a colliding declared name. `--no-build` stages an existing dist without rebuilding (and errors if it is absent); `--dry-run` assembles the command without building and flags when the previewed dist may be stale, and — when no `evals.json` exists yet — reports where a real run *would* scaffold the template (exit 3) instead of writing it, so a dry run never touches your tree. A build failure fails fast at preflight (exit 2), before any tokens are spent.
  - **Eval `files` are now provisioned.** Each eval's declared input files are staged into a per-eval working directory the executor operates on, enabling realistic "drop the agent in a project" evals. Files resolve relative to the `evals.json` directory and are materialized under `<harnessRoot>/workspaces/<id>/`; the experimenter prompt hands the executor that directory via a new `{{WORKSPACES_ROOT}}` token. A declared-but-missing input file fails fast at preflight (exit 2). Previously `files` was documented but inert.
  - **Merge-readiness: liberal eval-suite schema, macOS subscription-auth fix, expanded skill, first dogfood suite.** (1) `evals.json` is adopter-authored data VAT *reads*, so its schema is now liberal per VAT's Postel's Law: `EvalSuiteSchema`/`EvalEntrySchema` are `.passthrough()` and `id` accepts a descriptive **string** or an int — only the fields VAT consumes (`prompt`, `expected_output`, `expectations`) stay required. This reverses the earlier strict-parser call that rejected real adopter suites three ways (string `id`, `category`, `_category_note`) and restores compatibility for the flagship adopter's suites. The persisted `test:` *config* block stays **strict** (it's VAT-produced config) — the deliberate inverse. (2) **macOS subscription-auth fix:** the harness env allowlist (`buildForwardedEnv`) dropped the POSIX `USER`/`LOGNAME` vars, so on macOS `claude auth status` could not read the login Keychain with the API key scrubbed — `--auth subscription` (and `inherit`'s subscription fallback) wrongly failed preflight, and the experimenter child could not authenticate. `USER`/`LOGNAME` are now forwarded (non-secret; already derivable from the forwarded `HOME`). (3) The `vibe-agent-toolkit:vat-skill-testing` skill gains a research-grounded "Authoring `evals.json`" section (blind realistic prompts, discriminating + negative expectations, categories, fixtures, `--baseline` skill-lift, grading) and a full flag⇄config knob table. (4) Ships the first committed VAT dogfood suite (`vat-skill-review`, 5 evals across catch-violation / no-false-positive / guidance-correctness) wired via `skills.config.vat-skill-review.test`, with eval fixtures excluded from `vat resources validate`.
- **`files:` entries now support glob sources and an optional `integrity` byte-verify.** A `source` containing glob magic (`*`, `**`, `?`, `[`) fans out into a directory `dest`, preserving the directory structure below the static base (glob is VAT's existing idiom, as in `skills.include` — no `recursive` flag). Globbed dests are late-bound, so `SKILL.md` links into them are treated as deferred artifacts at validate time (no `LINK_TO_GITIGNORED_FILE` allowlist needed). Add `integrity: true` to byte-verify the copy at build time and assert an exact dest subtree for glob entries.
- **`NON_PORTABLE_ASSET_REFERENCE` validation code (default `warning`) — a portability check family.** `vat skills validate` / `vat audit` now flag a skill document that references a bundled script/asset via a non-portable anchor, scanning the `SKILL.md` body **and every reachable bundled markdown doc** (agents copy invocations from reference files too). It's a family of sub-checks under one code — `claude-plugin-root`, `claude-project-dir`, and `absolute-script-path` — each finding names the variant and carries a tailored fix, and a single `validation.allow` entry silences the whole family for a file. These anchors don't exist when a skill is mounted standalone (claude.ai upload, API container), so the path breaks on the agent's first invocation; reference bundled files relative to the skill directory instead. See [`NON_PORTABLE_ASSET_REFERENCE`](docs/validation-codes.md#non_portable_asset_reference).
- **Skill-authoring guidance: portable bundled-script paths.** The `vibe-agent-toolkit:vat-skill-authoring` skill now documents how to reference bundled scripts/assets portably (relative to the skill directory, never `CLAUDE_PLUGIN_ROOT`/absolute/env-var anchors), and `vibe-agent-toolkit:vat-skill-review` carries the matching pre-publication checklist item.
- **Skill-review guidance: reserved words `claude`/`anthropic` in skill names.** The `vibe-agent-toolkit:vat-skill-review` skill's Naming section now carries the reserved-word rule as a canonical `[A]` item — Anthropic's authoring guidance states a skill `name` "Cannot contain reserved words: 'anthropic', 'claude'", and Claude Code refuses to load a non-certified skill named that way, so it fails at install/validation, not just review (`[RESERVED_WORD_IN_NAME]`). Surfaced by dogfooding the skill against its own eval suite (the reviewer was noting the prefix as "redundant" but missing the install-blocking consequence). The rule directs the reviewer to surface that consequence when reviewing such a name and to include the warning when advising on naming.
- **`NON_PORTABLE_COMMAND` validation code (default `warning`) — a portability check family.** `vat skills validate` / `vat audit` now flag a skill document that tells an agent to run a GNU/Linux-only shell command, scanning the `SKILL.md` body **and every reachable bundled markdown doc** (agents copy invocations from reference files too). It's a family of sub-checks under one code — `timeout`, `grep-pcre` (`grep -P`), `sed-i-no-backup` (`sed -i` with no suffix), `readlink-f`, and `date-d` (GNU `date -d`) — each finding names the variant and carries a tailored fix, and a single `validation.allow` entry silences the whole family for a file. Patterns match commands in command position only (not bare prose), so `grep -E`/`sed -i.bak` and nouns like "the request will timeout" are not flagged. Promotes a former manual `vat skill review` checklist line into an automated check. See [`NON_PORTABLE_COMMAND`](docs/validation-codes.md#non_portable_command).
- **Authenticated link checking for private GitHub and SharePoint URLs (`resources.linkAuth`, issue #113).** Add a `resources.linkAuth` block to `vibe-agent-toolkit.config.yaml` and `vat resources validate` will authenticate requests to configured hosts instead of fetching anonymously — fixing the long-standing problem where private GitHub repository links and SharePoint pages always appear dead. Two built-in macros ship ready to use: `use: github` (token via `gh auth token`) and `use: sharepoint` (token from the `SHAREPOINT_TOKEN` environment variable); full inline providers are supported for any other private host. Authenticated responses surface as five new validation codes rather than the generic `EXTERNAL_URL_*` set: `LINK_AUTH_DEAD` (error — confirmed dead link on a host that does not mask unauthorized responses as 404, e.g. SharePoint), `LINK_AUTH_DEAD_OR_UNAUTHORIZED` (warn — 404 on a host like GitHub that may mask 403 as 404), `LINK_AUTH_FORBIDDEN` (warn — 403, token accepted but insufficient access), `LINK_AUTH_UNAUTHORIZED` (warn — 401, token missing or rejected), and `LINK_AUTH_UNVERIFIED` (warn — no token resolved; the link was skipped). Authenticated results cache per OS user under `<cacheDir>/auth-${user}/external-links.json`, so two runners on the same CI host cannot read each other's cache entries. Also ships `fetchAuthenticated(url, config)` as a new public export from `@vibe-agent-toolkit/resources` for retrieving the *bytes* of a private URL — useful when you need the file content, not just whether the link resolves. Pair it with the new optional `provider.fetch.headers` block to send different request headers for content retrieval than for link checking (e.g. `Accept: application/vnd.github.raw` to stream raw bytes inline versus `Accept: application/vnd.github+json` for the metadata-only link-health check).
- **Corpus seed expanded from 9 → 237 entries via a new committed importer at `packages/dev-tools/src/import-marketplace.ts` (`bun run import-marketplace [--allow-shrink]`).** The script fetches `.claude-plugin/marketplace.json` from `anthropics/claude-plugins-official` (205 of 209 raw entries kept) and `anthropics/knowledge-work-plugins` (30 of 60 — the knowledge-work catalog turns out to be ≈50% mirror entries of the official catalog) via `gh api`, maps each upstream entry to a `PluginEntry`, deduplicates by `source` URL (preserved VAT-owned entries always win; otherwise alphabetical-first-name wins within each duplicate cluster), and rewrites `corpus/seed.yaml`. Mapping rules: `bucket: official` uniformly (both catalogs are anthropics-curated marketplaces — `bucket` is the *reporting posture* per slice 1a, not code provenance); `confidence: first-party` for catalog-internal string sources and `github.com/anthropics/...` object sources, else `curated`; the `./partner-built/` knowledge-work convention overrides to `curated`; `maturity: production` for all entries. URL composition handles all five upstream source shapes (string, `git-subdir` ± `ref`, `url` ± `path`, `github`), throwing on unknown discriminators. The seven sample entries from slice 1a are regenerated from upstream manifests on every re-import. Re-import safety: the importer refuses to overwrite `corpus/seed.yaml` if either upstream catalog returned 0 plugins or the new entry count would drop more than 20% vs. the existing seed; `--allow-shrink` bypasses both gates for the rare case where shrinkage is real. The generated `seed.yaml` header dropped its earlier per-entry `validation:` claim (the importer throws on validation blocks today) and now states explicitly that entry `source` URLs pin a fragment ref (typically the default branch), not a per-entry commit SHA — the catalog SHAs in the header are this run's audit provenance. Issue #99 slice 1b — follows the schema change from PR #111 (slice 1a).
- **Empirical compatibility harness (`packages/dev-tools/src/compat-empirical/`).** Per-#100 research scaffold for measuring skill compatibility across `claude-code`, `claude-cowork`, and `claude-chat`: a CLI (`predict`/`run`/`judge`/`report`/`all`) that joins VAT's static predictions with deterministic runtime observations and an LLM-judge semantic read into a reality-vs-prediction matrix — an evidence artifact for proposing detector improvements that each cite specific (skill, runtime) cells. Probe coverage: multi-prompt + repeat-N with adaptive N=3→N=5 extension, mandatory positive+negative prompt pairing per corpus entry, and negative-prompt agreement inversion so false-positive triggers surface as `vat-optimistic`. Evidence quality: the deterministic class is widened from 6 to 9 values (splitting `error` into `install-failed`/`runtime-error`, `not-invoked` into `not-invoked-engaged`/`not-invoked-empty`, adding `refused`), with a v2 judge prompt that adds a `refused` verdict. Report fidelity: coverage stats, per-bucket headline (own/official/community × ran/agree/optimistic/pessimistic/gray-zone), gray-zone (mixed-signal) and high-variance subsections, and per-attempt variance rendered inline (`runtime-error (2/3) / failed (3/3)`). Judge replay persists `judge-calls/<skillId>-<promptId>-<target>-<attemptIdx>.json` artifacts that a new `re-judge` subcommand re-executes against an optionally different model or freshly-edited system prompt — without re-spending operator hours on the runtime side. Also landed: `git fetch --tags --force` before named-ref fetch (annotated tag refresh) and `setup()` teardown-first idempotency for the manual driver. No detector code or `RUNTIME_PROFILES` changes; lives entirely in the private `@vibe-agent-toolkit/dev-tools` package with no adopter-facing surface. Design: [the v2 harness design](./docs/research/2026-05-23-compat-empirical-harness-v2-design.md). Corpus authoring, the first real run, and the docs deliverable are the downstream work.
- **Cowork driver spike.** Added [`docs/contributing/cowork-driver-spike.md`](docs/contributing/cowork-driver-spike.md) — a time-boxed investigation (per §4a of the harness v2 design) of whether `claude-cowork` can be driven programmatically by the empirical compat harness today. Verdict: **not feasible**; cowork is a Claude Desktop app product with no public API/CLI surface. The `claude-cowork` runtime stays on `scripted-assisted` until Anthropic ships a Cowork CLI mode, Sessions API, or documented filesystem-import path. Adjacent finding (not a cowork replacement): the public-beta Skills API (`POST /v1/skills` + `container.skills[]` on `/v1/messages`) supports a fully-automatable *new* runtime — captured in the spike doc as a potential follow-up, gated on a separate design decision.
- **Subscription-only compat harness billing.** The harness now bills a Claude Pro/Max subscription instead of the API: both token-consuming surfaces (the `claude-code` runtime driver and the LLM judge) route through one shared `claude` CLI invoker (`runtimes/shared/claude-cli.ts`) that injects the operator's `CLAUDE_CODE_OAUTH_TOKEN` and deletes every API credential from the child env, so the CLI cannot fall back to API billing. The operator's own token is sourced at preflight — env var if set, otherwise an interactive prompt — so a run only ever spends the operator's personal plan. The judge was migrated off `@anthropic-ai/sdk` (dependency removed) onto the CLI, parsing a strict JSON verdict with one retry instead of the SDK's forced-tool call (`judge-system.md` now asks for a JSON object). `RunMetadata` gains `authMode` and the report methodology discloses subscription auth + parsed-not-forced verdicts. Premise (zero API billing under the OAuth token) still pending the manual smoke test.
- **Top-level `vat validate` command ([#128](https://github.com/jdutton/vibe-agent-toolkit/issues/128)).** A single command that runs the source-level validators the project's config declares — and only those: `resources validate` (when `resources:` is configured) and `skills validate` (when `skills:` is configured), in that stable order. Config is read from the resolved project root, so a run from a subdirectory still discovers the project's surfaces. Aggregates results and exits non-zero if any fail. A surface with no config block is skipped (no error, no noise, but a stderr warning if *nothing at all* is configured, so a config typo like `recources:` can't masquerade as a passing exit-0 run); `--only <surface>` restricts the run, and fails with **exit 1** whether the named surface is unrecognized or simply not configured — both are "you asked for a surface that can't run," and now share one exit code instead of splitting across 1 and 2. It is source-level only and **never requires a build**, so it is safe for pre-commit and CI-before-build, replacing the hand-composed `vat resources validate && vat skills validate` with one command. Decision (revisitable): marketplace-artifact validation is intentionally excluded — it runs against the built `dist/` tree, so it stays in `vat verify` (built mode) and `vat claude marketplace validate` (standalone) rather than coupling `vat validate` to a prior `vat build`.
- **First-class local HTML resources (#112).** `.html`/`.htm` files are now discovered, parsed, link- and anchor-validated, checked for well-formedness, and link-rewritten on bundle — using the same `ParseResult` contract and validation framework as markdown. A parse5-backed parser extracts `<a href>` and `<img src>` links plus `id`/`name` fragment anchors; `ResourceRegistry` routes HTML through it and persists optional `anchors`/`parseErrors` on `ResourceMetadata`. Anchor validation now uses a format-neutral fragment index (each file's markdown heading slugs or HTML `id`/`name`, with its case-matching policy carried per entry), enabling cross-format anchor checks (md↔html) with HTML ids matched case-sensitively and markdown slugs case-insensitively. A new `MALFORMED_HTML` code (default `info`) surfaces parser well-formedness diagnostics. On bundle, `<a href>`/`<img src>` values are rewritten by offset-splicing the original source (never re-serialized), so unchanged markup round-trips byte-for-byte and original attribute quoting is preserved (a rewritten value that would be unsafe unquoted is wrapped in quotes). Scope is `<a href>` + `<img src>` only; `<link>`/`<script>`/`<iframe>`/`<source srcset>`/CSS `url(...)` are deferred (asset/machinery references, not the content link graph). `<base href>` is not honored — relative hrefs resolve against the file's own directory (see the breaking note below for the `ResourceMetadataSchema` tightening that shipped with this work).
- **`DUPLICATE_RESOURCE_ID` validation code (default `error`).** When two files resolve to the same resource id after path normalization (e.g. `My Guide.md` and `my-guide.md` both → `my-guide-md`), `vat resources validate` now reports it as an `error` issue naming both files, instead of aborting the entire run with an uncaught `Duplicate resource ID` exception. Documented under [Resource Registry Codes](./docs/validation-codes.md).
- **Live audit/validate now sees source HTML links (issue #129 AC2).** `vat audit` / `vat skills validate` previously crawled `**/*.md` only, so links inside source `.html`/`.htm` files were invisible until build time. The live crawl now includes HTML (the registry already parses it via parse5), so the link-graph walker traverses HTML references and a broken local link inside a source HTML file surfaces as `LINK_MISSING_TARGET` at validate time, at parity with the built path's `PACKAGED_BROKEN_LINK`.
- **`LINK_DEFERRED_ARTIFACT` info code (issue #127, slice 2 of #129).** A `SKILL.md` link to a `files:`-declared artifact that doesn't exist yet (a dest built later, or a not-yet-created source) is no longer reported as a broken link — it downgrades from `LINK_MISSING_TARGET` to the new [`LINK_DEFERRED_ARTIFACT`](docs/validation-codes.md#link_deferred_artifact) info code at validate time, and `vat skills build` preserves and rewrites the link to the materialized dest instead of stripping it.

### Changed (breaking, pre-1.0)

- **`computeDeferredPaths` return type changed (issue #127, slice 2 of #129).** `computeDeferredPaths(files)` now returns `{ destPaths, sourcePaths }` instead of a flat `Set<string>` — a breaking API change (pre-1.0, intentional). Both `vat skills validate` and `vat skills build` now consume the deferred-path set (previously `deferredAssets` was silently dropped), and deferred dest/source paths resolve project-root-relative so the new behavior works for skills in subdirectories, not only at the project root. Plugin-local `files:` deferred paths remain out of scope for this slice (see [AC-10d](docs/architecture/skill-packaging.md#ac-10d--plugin-local-files-deferred-paths-are-out-of-scope-for-issue-127--slice-2-of-129)).
- **Directory links are now valid targets; `LINK_TARGETS_DIRECTORY` is narrowed to typed single-file slots (issue #126, slice 1 of #129).** A navigational local link that resolves to an existing directory (e.g. `[docs/](docs/)` in a ToC, README, or SKILL.md body) is no longer an error in `vat resources validate` or the skill-bundling link walk — previously any local link to a directory was a hard error. A renamed/deleted directory still fails via the ordinary broken-link path. `LINK_TARGETS_DIRECTORY` (still `error`) now fires **only** for a packaging `files:` *source* entry that resolves to a directory (the contract demands exactly one file). GitHub-style directory-index resolution (`docs/` → `docs/README.md`) is intentionally not implemented. Known limit (tracked for #129): a no-slash link such as `[Concepts](concepts)` that resolves to a directory is still treated as a file link; the slash form is the navigational case this slice covers.
- **`ResourceMetadataSchema` is now `strict()`.** Shipped with first-class HTML support (#112): the resource-metadata schema rejects unknown top-level fields instead of silently accepting them, so a typo or stale field in code that constructs `ResourceMetadata` now fails at parse time rather than passing through. Move any extra data into a recognized field or drop it.
- **Resource ids now carry a file-extension suffix.** `generateIdFromPath` appends `-<ext>` to every resource id (e.g. `guide.md` → `guide-md`, `guide.html` → `guide-html`, `README.md` → `readme-md`). This makes a markdown file and a same-stem HTML file distinct resources instead of colliding — the prerequisite for first-class HTML resources sharing a directory with their markdown source. Resource ids are internal, path-derived identifiers (never hand-authored in config or frontmatter), but anything that referenced an id by its old bare form must use the suffixed form — most visibly `vat rag query --resource-id` filters and re-indexed chunk ids (re-index to regenerate).
- **`vat resources validate` gains per-code severity configuration, and external-URL findings no longer fail the build by default.** Resource findings now use the same configurable severity framework as `vat skills`: each is a documented code (e.g. `LINK_BROKEN_FILE`, `EXTERNAL_URL_DEAD`) with a default severity, overridable per project under `resources.validation.severity` / `resources.validation.allow`. External-URL findings now default to `warning` and no longer flip the exit code (fixing a bug where they always failed the command); set their severity to `error` to restore failing. Severity now also accepts an `info` level. The never-implemented `resources.validation.checkLinks`/`checkAnchors`/`allowExternal` keys are removed.
- **`validation.severity` / `validation.allow` keys are validated against real codes.** A mistyped code key (e.g. `LNIK_OUTSIDE_PROJECT`) is now a config-load error instead of a silent no-op.
- **Corpus seed entries now require `bucket`, `confidence`, and `maturity` metadata fields.** `PluginEntrySchema` in `vat corpus scan`'s seed loader gains three required enum fields: `bucket: 'official' | 'community'`, `confidence: 'first-party' | 'curated' | 'listed'`, and `maturity: 'production' | 'experimental' | 'example'`. The bundled `corpus/seed.yaml` is updated; downstream callers running custom seeds must add the fields to every entry. `bucket` is the load-bearing discriminator (`official` entries report named findings; `community` entries are aggregate-only in follow-up work). The other two are descriptive metadata used by triage tooling.
- **`vat claude marketplace publish` no longer reports the project root `package.json` version in the CLI banner, commit message, status YAML, or CHANGELOG section lookup.** The label is now derived from the staged `marketplace.json`. Single-plugin marketplaces use the plugin's version — banner reads `Publishing marketplace "X" v0.0.4`, commit subject reads `publish v0.0.4`. Multi-plugin marketplaces drop the `v<X>` entirely — banner reads `Publishing marketplace "X"`, commit subject reads `publish X` — since the per-plugin `version` fields in the published `marketplace.json` are the source of truth for which plugin moved to which version. Two visible side-effects follow: (1) the status YAML's `published[*].version` field is now absent for multi-plugin marketplaces (previously it carried the misleading project version) — automation should read per-plugin versions from the published `marketplace.json` instead; (2) the stamped `## [X.Y.Z]` CHANGELOG lookup now uses the plugin's version rather than the project's, so a previously-ignored matching section will now be picked up as the commit body for single-plugin marketplaces. The `marketplace.json` schema's optional top-level `version` field is not yet consumed — that is a separate follow-up.
- **Adopter-facing `LinkAuthConfig` type renamed to `LinkAuthProjectConfig` (issue #113).** Both `@vibe-agent-toolkit/utils` (engine) and `@vibe-agent-toolkit/resources` (Zod-inferred adopter shape) previously exported a type named `LinkAuthConfig`, causing IDE auto-import ambiguity in any code that touched both. The adopter type — accessible as `import type { LinkAuthProjectConfig } from '@vibe-agent-toolkit/resources/schemas/link-auth'` — is the one renamed; the engine's `LinkAuthConfig` is unchanged (more API surface depends on it). Migration: rename the import. The Zod schema's name (`LinkAuthConfigSchema`) is unchanged.
- **External-link cache directory layout adds an `auth-${osUser}/` subdirectory and an entry `version: 1` field (issue #113 §6.3).** When `vat resources validate` runs with `resources.linkAuth` configured, authenticated-fetch results land under `<cacheDir>/auth-${sanitizedOsUser}/external-links.json` rather than the shared `external-links.json` used by the anonymous `markdown-link-check` path — two users on the same host (e.g. shared CI runners) cannot read each other's authenticated cache entries. All cache entries now carry an explicit `version: 1` field; entries written under a different (or missing) version are treated as a cache miss, so any pre-existing `external-links.json` triggers a one-time re-fetch on first run after upgrade. The `version` gate is forward-compat for slice 3's content-cache shape evolution.
- **`vat claude marketplace publish` no longer pushes per-plugin `<name>-v<version>` source-repo tags.** The post-publish tagging step (introduced alongside multi-plugin versioning) is removed entirely — no tags are created or pushed, and the misleading `Repository not found` / "tag already exists at a different commit" warnings it emitted on every cross-repo publish are gone ([#121](https://github.com/jdutton/vibe-agent-toolkit/issues/121)). The tags were pushed to the marketplace remote rather than a source remote, never landed anywhere useful, and there was no opt-in demand. Which plugin moved to which version is now determined solely by the per-plugin `version` fields in the published `marketplace.json`. No config key or flag is involved; if you relied on these tags, create them in your own release workflow.

### Fixed

- **`vat skill test` now verifies a per-run integrity nonce on `grading.json`, so untrusted skill code can no longer forge a passing result.** The experimenter writes `grading.json` into the harness results dir, which is inside the skill-writable sandbox (`--add-dir`, `bypassPermissions`) — an adversarial skill could therefore write or rewrite a passing `grading.json` that the harness would trust. The harness now stamps a secret per-run nonce into the experimenter prompt and requires `grading.json` to echo it in a top-level `runNonce`; a missing or mismatched nonce is rejected (exit 1). The nonce is delivered to the experimenter **only via stdin** — the prompt is no longer written to disk (`spawnHeadlessClaude` takes the prompt in memory), and the persisted `experimenter-prompt.txt` audit copy is redacted — so skill code cannot read the nonce back to forge a match. Surfaced by adversarial review; the harness still runs behind the `--i-understand-this-runs-skill-code` ack (this is defense-in-depth, not an OS sandbox).
- **A committed `test.*` config can no longer RAISE `vat skill test`'s built-in cost/runtime caps — only lower them.** `test.maxBudgetUsd` / `test.maxTurns` / `test.timeout` fed the same precedence slot as the CLI flags, so a subject repo you were merely testing could commit `maxBudgetUsd: 100` and silently bill a run far above the built-in $5 / 50-turn / 5-minute ceilings. A config-sourced value is now clamped to the built-in cap (with a one-line stderr note when clamped); a CLI flag, being explicit operator intent, may still exceed it. Surfaced by adversarial review.
- **`vat skill test` no longer cross-wires two injected plugins that share a directory basename.** The staged plugin-root dir was keyed on `basename(pluginDir)` alone, so two different `--with` plugins at e.g. `…/a/my-plugin` and `…/b/my-plugin` collided onto one staged root — the second silently inherited the first's `CLAUDE_PLUGIN_ROOT` and `.claude-plugin/` manifest, producing a misleading result. The staged segment is now keyed on the full resolved plugin path (basename kept as the readable slug, disambiguated by a hash of the full path).
- **A `files:` entry's `integrity: true` byte check is no longer silently skipped when the file was already link-bundled.** In `applyFilesConfig`, a non-glob entry whose source had already been materialized by link traversal short-circuited past the integrity verification — so a requested byte check simply didn't run for that file. The byte check now runs against the link-bundled dest (which lands at `entry.dest`) on the skip path, exactly as it would on the copy path.
- **A broken `vibe-agent-toolkit.config.yaml` is no longer silently ignored by `vat skill review` / `vat skill test` (regression fix).** The shared config walk-up (`loadConfigCached`, via `resolveSkillPackagingConfig`) swallowed a *present-but-broken* config to `undefined` — indistinguishable from "no config." That silently downgraded `vat skill review` (which previously errored on a bad config through the throwing `loadConfig`) and would let `vat skill test` apply defaults / stage the wrong subject against a config the author clearly intended. A broken config now raises a typed `ConfigLoadError` that skill-resolving commands surface (review reports it; `vat skill test` exits 2 with a clean message), while `vat audit` — a bulk linter that must keep scanning — explicitly catches it and falls back to config-free validation. An *absent* config still resolves to `undefined` as before. The error is cached so a broken config re-throws without re-parsing across a multi-skill scan.
- **`vat skill test run` now rejects a bad usage flag with a clean message and preflight exit code (2) instead of a raw stack trace.** Flag validation and config loading (`--auth`/`--require-auth` values, numeric `--max-turns`/`--max-budget-usd`/`--timeout`/`--stall`, the persisted test config) ran *before* the command's first `try`, so a malformed flag surfaced as an unhandled promise rejection (stack dump, exit 1). They now run inside a preflight guard: an unrecognized value prints `Error: --auth must be one of: …` and exits 2 without ever reaching the harness. `--auth`/`--require-auth` are validated on the run path too (previously only `configure` checked them), via a shared `auth-flags` helper so the two commands cannot drift. The `--dry-run` help no longer claims to print "the exact assembled command" (it shows the model flag; budget/turns/permission flags are added at spawn time).
- **`vat skill test`'s scrubbed-env deny-list now blocks the OS-linker and Node module-resolution code-injection vars.** A skill-under-test's committed config can forward named host env vars into the headless `claude` child via `test.passEnv`/`test.env`. The deny-list already refused `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS` (code injection before any userland code runs) but not their exact siblings — `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` (native `.so`/`.dylib` injection), `NODE_PATH` (module-resolution hijack), and `GIT_SSH_COMMAND` (arbitrary command on a `git:` source clone). These are now deny-only: a config naming one is ignored with a warning, the protected value wins. (The feature already runs behind an explicit `--i-understand-this-runs-skill-code` ack and a loud security warning; this closes a defense-in-depth gap surfaced by adversarial review.)
- **`vat resources validate` no longer flags inline `data:`/`blob:` resources as `LINK_UNKNOWN` warnings.** A `data:` URI embeds its own payload and a `blob:` URL references an in-memory object — neither has a target to fetch or an anchor to resolve, so there is nothing to validate. They previously fell into the "unknown link type" catch-all (any href containing `:` that wasn't `http(s)`/`mailto`) and surfaced as warnings, which is noise for the extremely common inline-image pattern (`<img src="data:image/svg+xml,…">`). A new `embedded` link type classifies them and skips validation, mirroring how `external`/`email` links are already skipped. Genuinely unrecognized schemes (`javascript:`, `tel:`, `ftp:`) still classify as `unknown`.
- **`vat resources validate` no longer emits false-positive `LINK_BROKEN_ANCHOR` errors for `#fragment` links in HTML files.** HTML fragment anchors are frequently resolved at runtime by client-side JavaScript — hash routers, SPA `#/route` links, hash-encoded query params (`#id=1&mode=x`) — rather than by a literal element `id`/`name` in the markup, and ids can also be injected dynamically at runtime. A static "id not found" is therefore not proof the link is broken. Anchor resolution is now **skipped for HTML targets by default**; markdown heading-anchor validation is unchanged and still errors on a genuine miss. A new `--check-html-anchors` flag (mirroring `--check-external-urls`) opts in to strict HTML anchor resolution for fully-static pages — and even then, structural non-anchors (`#/route`, `#k=v&…`) are skipped since they can never be element ids. This restores clean `vat verify`/`vat resources validate` runs for HTML/SPA projects, reported by an external adopter whose gating CI turned red on functional runtime deep-links.
- **`vat build` now fails when a shipped Claude plugin skill has a broken packaged link.** `vat claude plugin build` never ran a post-assembly link check on the plugin output tree — only the pool packaging path did. A plugin skill whose shipped links were broken (e.g. relative links that assumed pool-packaging relocation but the skill was verbatim tree-copied) previously shipped silently. `vat build` now runs the existing depth-free `checkBrokenPackagedLinks` check against every shipped skill dir after the `claude` phase and fails the build with a `PACKAGED_BROKEN_LINK` error on any dead link. The check is scoped per skill dir — a skill is a self-contained portable unit, so a link that escapes its own directory (even to a sibling skill that co-ships in the same plugin) is a broken shipped link.
- **`vat claude plugin build` no longer double-produces a skill that is both pool-selected and present in the plugin's own `skills/` source tree.** Tree-copy (verbatim, unaware of packaging) and pool-import (packaged, link-rewritten) never coordinated — a skill claimed by both mechanisms shipped as two coexisting copies at different depths inside the same `skills/<name>/` directory, with the raw tree-copy carrying un-rewritten (and therefore potentially dead) relative links. The plugin's resolved pool selector is now excluded from the verbatim tree-copy before it runs, so the pool-packaged copy is the sole source for a colliding skill; the build prints a warning naming the skill and both sources. Non-colliding tree-copy and pool-import usage is unaffected.
- **`validateSkill` no longer silently reports a boundary-escaping AND missing link as a warning-only boundary notice.** `validateLocalLink`'s boundary-escape check returned before the existence check ever ran, so a link that both escaped the skill directory boundary and pointed at a non-existent file was classified `LINK_OUTSIDE_PROJECT` (warning) and never surfaced as broken — this is why `vat claude marketplace validate` could report a shipped tree with a dead, boundary-escaping link as 0 errors. Existence is now checked before boundary classification: a missing target is always `LINK_INTEGRITY_BROKEN` (error), regardless of whether it also escapes the boundary. A link that escapes the boundary but resolves to an existing file is unaffected (still a warning).
- **Skill-test eval-suite schema hardened after an adversarial review of the Postel liberalization.** Four issues the `id`/passthrough widening introduced or left open, all verified against a real adopter's eval suites:
  - **String eval ids are now validated as filesystem-safe path segments** (`[A-Za-z0-9_-]+`). A string `id` names a per-eval working directory, and the experimenter substitutes it verbatim into `<workspaces>/<id>`; an id like `year:extraction` previously passed parse, then failed on Windows (illegal filename) — surfacing as a *misleading* "escapes the eval directory" copy error. Rejected at parse with a clear message instead. Hyphenated ids are unaffected.
  - **Numeric `1` and string `"1"` no longer slip past the uniqueness check.** Ids are deduped on their stringified form, since both name the same workspace directory and would otherwise silently clobber each other's staged files.
  - **A near-miss typo of the optional `files` field is now flagged** (`filez` → "did you mean files?"). Under plain `.passthrough()` such a typo was silently swallowed and the eval ran in an empty workspace. The check is a single-edit match scoped to recognized fields, so legitimate adopter extras (`name`, `category`, `notes`, `_category_note`) still pass through untouched.
  - **`stageEvalWorkspaces` no longer mislabels copy failures as containment escapes.** Containment (`joinUnderRoot`) and the filesystem copy are now in separate try/catch blocks, so a permission/illegal-filename/disk error reports accurately instead of as "escapes the eval directory."
- **Skill-test `expected_output` is now optional, and is fed to the grader as context when present.** The pass/fail verdict is always decided per `expectations` entry, so `expected_output` is no longer required (per Postel's Law) — this unblocks real adopter suites that grade with `expectations` alone. Previously the field was accepted but consumed by nothing; the experimenter prompt now passes it to the grader as the author's prose description of a correct result, informing judgment without becoming a checklist item. Still validated as a non-empty string when present.
- **`vat claude plugin build` now copies a tree-copied skill's `files:` artifacts into the distributed plugin (#127).** A skill that ships build-provided artifacts in its own directory via `files: [{ source, dest }]` but lives in a plugin's source tree was distributed by a verbatim tree-copy that skipped its `files:` step, so the shipped plugin was missing those artifacts. Build now applies each tree-copied skill's `files:` config into `skills/<name>/`, exactly as it already does for shared-pool skills — removing the need for an external inject-into-dist script (which VAT couldn't see, producing false `LINK_TO_GITIGNORED_FILE` and `missing-bundled-file` findings).
- **`vat verify` no longer false-flags skills in plugins distributed by verbatim tree-copy (`vat build --only claude`).** A plugin that ships its skills by copying its own `skills/` tree (`source:` set, `skills: []`) builds correctly, but two verify checks still assumed the shared-skill-pool model and failed a byte-correct artifact: `files-config-dests` looked for a skill's `files:` dests only under `dist/skills/<name>/` and missed the plugin tree where build actually wrote them, and `PUBLISHED_SKILL_NOT_IN_PLUGIN` was blind to `source:`, flagging every skill a tree-copy plugin ships. Both checks (and `vat build`) now agree on where a tree-copied skill lands, so the false failures are gone. (Whether private `.claude/skills/**` skills should count as "published" is unchanged and tracked separately.)
- **`ExternalLinkValidator.clearCache()` and `getCacheStats()` now operate on both caches (issue #113).** Slice 2 introduced a second cache instance for authenticated-link results (per-OS-user scoping); the existing `clearCache()` / `getCacheStats()` methods continued to touch only the anonymous cache, so an adopter rotating a token would see stale `401`/`403` entries until the auth cache TTL expired. Both methods now clear/sum across both caches.
- **`ExternalLinkCache` IO errors degrade to a cache miss instead of aborting validation (issue #113).** `loadCache()` previously threw on anything other than `ENOENT` / `SyntaxError` (e.g. `EACCES` on a permissions-restricted cache file, `EROFS` on a read-only filesystem); `saveCache()` had no try/catch (write errors propagated). A failed read / write on the status-cache file would abort the whole `vat resources validate` run. Both paths are now fail-soft: a read failure returns an empty in-memory cache, a write failure no-ops while the in-memory cache stays authoritative for the remainder of the run. Cost of a bad cache entry: one extra fetch. Cost of a bad cache entry under the previous behavior: the whole run.
- **Lazy-loaded embedding providers no longer mislabel model/runtime failures as "not installed" ([#118](https://github.com/jdutton/vibe-agent-toolkit/issues/118)).** `loadPipeline` in `transformers-embedding-provider.ts` wrapped both the dynamic `import('@xenova/transformers')` and the model download/inference in a single `catch` that always rethrew a fixed `@xenova/transformers is not installed` message, swallowing the real error (not even as `cause`) — so a model-download or `onnxruntime-node` native-backend failure on an installed package was reported as a missing dependency. The two failure modes are now separated: an import failure keeps the actionable install hint (now with the original error attached as `cause`), while a model/inference failure throws `Failed to load transformers model '<model>'` preserving `cause`. The sibling `onnx-embedding-provider.ts` was audited: its install-hint `catch` was already correctly scoped to the import alone, but its model download (`ensureModelFiles`) and session creation (`InferenceSession.create`) previously bubbled raw errors with no provider/model context, so they now throw `Failed to download ONNX model '<model>'` / `Failed to load ONNX model '<model>'` with `cause` preserved.
- **Transformers.js integration tests now skip on Windows CI instead of flaking.** `transformers-embedding-provider.integration.test.ts` and the Transformers.js block of `comparison.integration.test.ts` skip on Windows (in addition to skipping when the optional `@xenova/transformers` dependency is absent), matching the existing `onnx-embedding-provider` test. These tests download a model over the network and load the `onnxruntime-node` native backend — both flaky in Windows CI. Such a failure was previously mislabeled `@xenova/transformers is not installed` by an over-broad `catch` in the provider's `loadPipeline` (the package was installed; the model download/inference is what failed), which is also why an availability-only guard did not prevent it.
- **Config-first skill discovery now honors `..` in `skills.include` patterns.** `vat build`, `vat verify`, and `vat skills validate` all funnel through `discoverSkillsFromConfig`, which previously passed every include pattern to a single downward-only crawl rooted at `projectRoot` — so an include like `"../../docs/skills/*/SKILL.md"` (common in monorepos where SKILL.md sources live alongside, not inside, the package) silently matched zero skills. `vat audit` accepted the same config only because it has a separate filesystem-first walker. Each include pattern is now split into a literal base + glob remainder via `picomatch.scan`, patterns are grouped by their resolved absolute base, and the crawler runs once per base — making config-first discovery agree with audit. User-supplied excludes stay anchored to `projectRoot` so patterns like `docs/private/**` keep their original meaning, and a pattern resolving to a nonexistent base now silently produces zero matches.
- **Anchor validation no longer reports a false `LINK_BROKEN_ANCHOR` for un-indexed target files (#112).** Previously a fragment link to any file the resource registry had not parsed (e.g. a target outside the crawl) was reported as a broken anchor. Anchor checks now skip targets absent from the fragment index — affecting markdown and HTML alike — while genuinely missing fragments in indexed files are still reported.
- **`vat resources validate` no longer crashes on same-stem `.md` + `.html` sibling files (#116).** Making HTML first-class added `.html`/`.htm` to the crawl, and same-stem siblings (e.g. `index.md` + `index.html`) previously produced an uncaught `Duplicate resource ID` exception that aborted the whole command. Fixed by the extension-suffixed ids above (siblings now get distinct ids), with `DUPLICATE_RESOURCE_ID` as a graceful backstop for any genuine post-normalization collision.
- **Post-build link checks now cover bundled HTML (#116).** `checkBrokenPackagedLinks` and the unreferenced-file check previously scanned only `.md`, so a broken `<a href>`/`<img src>` inside a packaged `.html`/`.htm` file shipped with a green build. Both checks — and the reachability traversal — now extract HTML links via the same parser, so broken links in packaged HTML surface as `PACKAGED_BROKEN_LINK` (failing the build) and an HTML file referenced only by other HTML is no longer falsely flagged `PACKAGED_UNREFERENCED_FILE`.
- **Deferred-artifact existence parity in the link walker (issue #129 carry-forward).** `walk-link-graph`'s `checkDeferred` guarded only the `files:` *source* branch with `!existsSync`; the *dest* branch deferred unconditionally. An existing real file at a `files:` dest (e.g. a gitignored artifact already on disk) was therefore silently downgraded to the `LINK_DEFERRED_ARTIFACT` info code, masking a genuine `LINK_TO_GITIGNORED_FILE` / directory-target signal. Both branches now share the existence guard: a path is treated as deferred only when it does not yet exist on disk.
- **`computeDeferredPaths` resolves `files:` sources exactly as the packager does (issue #129 carry-forward).** The deferred-source set was computed with `resolve(projectRoot, source)`, which let an absolute-looking source escape the project root, while the packager copies with `resolve(join(projectRoot, source))`. The two now use the identical expression, so an absolute-looking source roots under the project root in both places and the deferred set matches what the build actually copies.

### Internal

- **Skill-test eval fixtures excluded from the remaining link/structure validators (CI hygiene, no adopter-facing change).** The intentionally-broken eval fixtures (`resources/skills/evals/**` — non-portable SKILL.md samples, a fake plugin for `vat audit`) are test input, not real docs/code. They were already excluded from the repo-root resource validation, ESLint, and repo-structure checks; now also from the `vat-development-agents` package config (so `vat verify`'s resources phase stops failing on the fixtures' deliberate `LINK_BROKEN_FILE`s) and the `project-validation` dogfooding system test (hardcoded exclude list). Every exclusion site cross-references the others.
- **Eval fixtures hold clean, realistic code — incidental smells removed.** Two fixtures carried code-quality issues unrelated to what their eval tests: the `release-notifier-plugin` notifier script (a payload that only needs to *exist* so `vat audit` can flag the skill's local-script dependency) now validates its `--changelog` path instead of opening it blind, and the `vat-knowledge-resources` starter config dropped a redundant `TODO` comment (the eval's prompt already states the task). Fixtures that are themselves the *subject under review* (e.g. the vat-agent-authoring analyzer the eval asks an agent to improve) keep their VAT-domain flaws by design.
- **Unified `resolveSkillSource` skill-source resolver (#132, foundation).** A `skill-source/` module in `@vibe-agent-toolkit/agent-skills` that materializes a typed source union (`workspace` / `npm` / `url(+sha256)` / `path` / `vendored`) to a hardened, content-addressed staged directory through a per-user, `0700`, uid-checked fetch cache. The git-URL parser moved from `@vibe-agent-toolkit/cli` to `@vibe-agent-toolkit/utils`. No user-facing CLI surface yet — this is the resolver consumed by `vat skill test`.
- **`corpus/seed.yaml` is now generated from the upstream Anthropic marketplaces (issue #99, slice 1b).** A committed importer (`bun run import-marketplace [--allow-shrink]`) fetches the `claude-plugins-official` and `knowledge-work-plugins` catalogs, deduplicates by `source` URL, and rewrites the seed — replacing the previously hand-maintained list. Re-import is guarded against accidental shrinkage (refuses to overwrite on a 0-plugin fetch or a >20% drop unless `--allow-shrink`); current entry counts and audit provenance live in the generated seed header.
- **Empirical compatibility harness (issue #100).** A research scaffold (`packages/dev-tools/src/compat-empirical/`) for measuring skill compatibility across `claude-code`, `claude-cowork`, and `claude-chat` — it joins VAT's static predictions with deterministic runtime observations and an LLM-judge read into a reality-vs-prediction matrix, as evidence for future detector improvements. Lives entirely in the private `dev-tools` package with no adopter-facing surface; no detector or `RUNTIME_PROFILES` changes. [Design](./docs/research/2026-05-23-compat-empirical-harness-v2-design.md).
- **Cowork driver spike.** [`docs/contributing/cowork-driver-spike.md`](docs/contributing/cowork-driver-spike.md) records a time-boxed finding that `claude-cowork` cannot currently be driven programmatically (no public API/CLI surface), so it stays on `scripted-assisted` in the compat harness. Notes the public-beta Skills API as a separate, fully-automatable runtime worth a future follow-up.
- **Subscription-only compat harness billing.** The compat harness now bills a Claude Pro/Max subscription via a shared `claude` CLI invoker (uses the operator's `CLAUDE_CODE_OAUTH_TOKEN` and strips all API credentials from the child env), instead of the API; the LLM judge migrated off `@anthropic-ai/sdk` onto the same CLI. Private `dev-tools` only — no adopter-facing surface.
- **Intent-aware skill-resource verdict engine (issue #129, slice 3).** Skill-resource validation now routes through a pure verdict engine (`packages/agent-skills/src/validators/rule-engine/`): `evaluate(ctx)` maps an intent-aware context to at most one validation code, and a single `materializeIssue` constructor sources severity/description/fix/reference from `CODE_REGISTRY` so docs, runtime, and tests cannot drift. This is a refactor of how the existing codes are produced — the built and live paths now share one engine instead of duplicated literals, with no change to which codes fire — guarded by a table-driven scenario harness that enforces one-code-per-context, registry equality, and an anti-workaround invariant on every code's `fix`.
- **Single-source rule catalog (issue #129 AC5).** `docs/validation-codes.md` gains a machine-readable skill-resource rule catalog (between `<!-- BEGIN:rule-catalog -->` markers) and a disambiguation map; a docs test enforces full cell-equality (severity/description/fix) with `CODE_REGISTRY` so the registry, docs, and runtime cannot drift.

## [0.1.38] - 2026-05-18

### Changed (breaking, pre-1.0)

- **`findProjectRoot` from `@vibe-agent-toolkit/utils` has new semantics.** It
  now walks `vibe-agent-toolkit.config.yaml` → `.git/` and returns
  `string | null` with no fallback to `cwd`. The previous workspace-anchored
  behavior (workspace `package.json` → git → `cwd`, returning `string`) moved
  to a new function: `findNodeWorkspaceRoot`, scoped to workspace `package.json`
  lookup only and also returning `string | null`. Migration: use
  `findNodeWorkspaceRoot` if you wanted Node-monorepo binary discovery; use
  `findProjectRoot` if you wanted the VAT authoring boundary. Either way,
  handle the `null` return — there is no more silent `cwd` fallback.

- **`resolveLocalHref` returns a discriminated union.** From
  `{ resolvedPath; anchor } | null` to one of `anchor_only | resolved |
  absolute_no_root | absolute_escapes_root`. The function exported from
  `@vibe-agent-toolkit/resources` now also accepts an optional `projectRoot`
  parameter. Leading-`/` markdown links and frontmatter URI-references now
  resolve against `projectRoot` per RFC 3986 §4.2 absolute-path-reference
  semantics — matching GitHub, MkDocs, Sphinx, Docusaurus, VuePress, Jekyll,
  Astro Starlight, Nextra, and MDN. Previously `safePath.resolve(sourceDir,
  '/docs/foo.md')` resolved to filesystem-absolute `/docs/foo.md`. The two
  new union kinds (`absolute_no_root`, `absolute_escapes_root`) surface to
  consumers as the existing `broken_file` issue with distinct messages — no
  new validation-code names. External callers destructuring the old return
  shape must update to switch on `kind`.

- **`ValidateLinkOptions.projectRoot` semantic narrowing.** In monorepos, the
  effective root for link validation is now the nearest
  `vibe-agent-toolkit.config.yaml` ancestor (or `.git/` ancestor), not the
  workspace root. Cross-package relative links (`../sibling-pkg/foo.md`) are
  still validated for file existence, case mismatches, and anchor resolution
  — path-based logic is unaffected. **The gitignore-safety gate, however,
  scopes to the sub-package's `projectRoot` only.** Adopters who own per-package
  `vibe-agent-toolkit.config.yaml` files in a monorepo and rely on
  workspace-wide gitignore checking for cross-package doc links must either
  move the config up to the workspace root or accept the narrower scope. In
  practice, the file-existence + anchor checks are what catch broken links;
  the narrower gitignore gate matches how VAT already treats links to
  truly-external files.

- **Some adopter configs may need `validation.allow.LINK_OUTSIDE_PROJECT`.**
  Because the effective `projectRoot` narrows in monorepos with per-package
  configs, cross-package links that previously passed under workspace-wide
  scope may now emit `LINK_OUTSIDE_PROJECT`. Add a `validation.allow` entry
  for the affected paths or `validation.severity` override at the config that
  governs the linking skill.

- **`Logger.warn` added to the CLI `Logger` interface.** The interface widened
  with a `warn(message: string): void` method that writes to stderr. If you
  implement the `Logger` interface directly (custom embedders, test doubles),
  add the method.

- **`excludeReferencesFromBundle` no longer masks cross-package links flagged
  as outside-project.** Under the new `projectRoot` model, `outside-project`
  fires before bundle-exclusion pattern match. If you used
  `excludeReferencesFromBundle` to hide cross-package links from audit, those
  links will now surface — switch to `validation.severity` or `validation.allow`
  on `LINK_OUTSIDE_PROJECT` for the relevant skill.

- **Skill packager rewrites frontmatter URI-references during packaging.**
  When a markdown file's collection has a `frontmatterSchema` configured, the
  packager now walks every schema-annotated URI-reference field (`format:
  uri-reference`, `uri`, `iri-reference`, `iri`) and rewrites the value with
  the same target-path lookup that drives body-link rewriting. Body and
  frontmatter URI-refs now agree on packaged paths, and inline comments on
  rewritten fields survive. Previously, packaged artifacts could ship with
  rewritten body links but stale source-path frontmatter pointers — a silent
  half-correct rewrite.

- **`@vibe-agent-toolkit/resource-compiler` now depends on
  `@vibe-agent-toolkit/resources`.** The markdown parser there goes through
  `openFrontmatter` so frontmatter comments survive into compiled output.
  Pure transitive consumers see no API change; embedders who installed
  `resource-compiler` standalone now pull `resources` too.

### Added

- **Canonical comment-preserving primitive for frontmatter edits:
  `openFrontmatter` from `@vibe-agent-toolkit/resources`.** Wraps `yaml`
  (eemeli) in a round-trip-safe editor with `get` / `set` / `setArrayItem` /
  `appendArrayItem` / `delete` / `toString` and a settable `body`. Comments,
  blank lines, key order, quoting style, anchors, and EOL survive on
  mutation. `openFrontmatter(x).toString()` is byte-identical to `x` until
  you mutate. Malformed YAML throws `FrontmatterParseError` with the
  underlying error on `.cause`. Use this instead of `gray-matter`,
  `front-matter`, or raw `yaml.parse` for any write path — those drop
  comments silently.

- **`createAjvWithUriFormats(options?)` from `@vibe-agent-toolkit/resources`** —
  Ajv factory pre-registered with the URI-family formats (`uri`,
  `uri-reference`, `iri`, `iri-reference`) plus the rest of the
  `ajv-formats` standard vocabulary. Use this anywhere downstream code
  compiles a schema that may reference those formats: vanilla
  `new Ajv({ allErrors: true })` throws `unknown format "uri-reference"
  ignored` under default strict mode, and adopters had to invent the
  workaround themselves. `iri` / `iri-reference` are registered as no-op
  validators (semantic validation is the caller's job — VAT uses
  `resolveLocalHref` for that). Ajv options pass through unchanged so
  callers control `allErrors`, `strict`, `verbose`, etc.

- **Three rewriter helpers sharing one `(href: string) => string` callback
  shape**, exported from `@vibe-agent-toolkit/resources`:
  - `rewriteBodyLinks(body, rewriteHref)` — inline links + reference
    definitions in the markdown body.
  - `rewriteFrontmatterFieldsAtPaths(editor, paths, rewriteHref)` — when you
    know the field paths by convention (`'meta.parent'`, `'adrs-cited[]'`).
  - `rewriteFrontmatterUriReferencesFromSchema(editor, schema, rewriteHref)`
    — when you have a JSON Schema and want every `format: uri-reference`
    field walked automatically. Compose with `rewriteBodyLinks` for the
    common file/folder-rename case.

- **New `markdown-rewriting` skill in the `vibe-agent-toolkit` Claude Code
  plugin** — steers any session about to programmatically edit markdown or
  frontmatter toward the comment-preserving primitives above. Includes the
  canonical file-move recipe (body + frontmatter together) and the
  schema-driven variant. Triggers on prompts like "rewrite references
  across these docs", "rename `/docs/specs/` to `/docs/architecture/`",
  "batch-update parent_spec".

- **URI-references in frontmatter are now a documented affordance.** Updates
  to two existing skills:
  - `vat-knowledge-resources` — explains the leading-`/` resolution
    + comment-preservation story for schema-annotated URI-ref fields.
  - `vat-skill-authoring` — recommends leading-`/` URI-refs for cross-document
    references in SKILL.md frontmatter and cross-links `markdown-rewriting`
    for programmatic edits.

- **Per-command `projectRoot` and config policies, documented and enforced.**
  Every `vat` command now declares its `projectRoot` policy (`required` /
  `tolerate null` / `loud-cwd` / `N/A`) and config policy (`required file` /
  `required fields` / `accept defaults` / `not used`) in `--help` output and
  in its CLI reference doc under `packages/cli/docs/` or `docs/cli/`. The
  canonical source is the new [Roots and Config — Canonical
  Concepts](docs/concepts/roots-and-config.md) doc. Run `vat <cmd> --help` to
  see the `Requirements:` block for any command.

- **Loud-cwd fallback for `vat resources scan` and `vat resources validate`.**
  When invoked without an explicit path and no `vibe-agent-toolkit.config.yaml`
  or `.git/` ancestor is found, these commands now fall back to `cwd` and emit
  a single stderr warning (`warn: no vibe-agent-toolkit.config.yaml or .git/
  ancestor; using <cwd> as projectRoot`) instead of failing silently or
  surprising the user. With an explicit path argument the path is used and no
  warning fires.

- **`docs/concepts/roots-and-config.md`** — single source of truth for the
  three-root model (`projectRoot` / `gitRoot` / `nodeWorkspaceRoot`), the
  config-then-git discovery ladder, the CLI-boundary discovery rule, the
  per-command policy matrix, and the loud-cwd fallback contract. Every
  command's `Requirements:` help block links to this doc.

### Removed

- `findConfigPath`, `findConfigFile` (from `packages/resources/src/config-parser.ts`),
  `findGoverningConfig`, `resetGoverningConfigCache`. Use `findConfigFile`
  from `@vibe-agent-toolkit/utils` for config discovery, and `findProjectRoot`
  + `loadConfigCached` for root + config loading at CLI boundaries. Cache
  resets: `resetGoverningConfigCache()` → `resetProjectRootCaches() +
  resetLoadedConfigCache()`.

### Performance

- **`vat audit` is faster on large scan targets.** Per-skill `projectRoot`
  lookup now hits a module-level cache pre-warmed during the scan descent, so
  large multi-skill audits no longer repeat filesystem walk-ups per skill.

### Fixed

- **Markdown links to directories now surface as `broken_file`.** Previously, links resolving to an existing directory (e.g., `/docs/`, `../`, or any href whose resolved path is a directory rather than a file) silently passed validation. They now emit `broken_file` with `Link target is a directory: <path>` and a suggestion to link to a file inside the directory.

- **Leading-`/` links no longer false-flag as path-traversal escapes when the project root traverses a symlink.** `isWithinProject` now canonicalizes both sides of the within-check symmetrically (via `realpathSync`). Previously, when `projectRoot` was a symlinked path — common on macOS (`/tmp` → `/private/tmp`), bind mounts, and CI containers — a legitimate `/foo.md` resolution to `projectRoot/foo.md` was incorrectly reported as `absolute_escapes_root` because only the file side was realpath'd. The same fix also corrects the latent identical bug in the pre-existing gitignore-safety gate of `validateLocalFile`.

- **`vat claude plugin install` post-install hints now point to the correct Claude Code slash command.** Both the standard and `--dev` install paths previously suggested `/reload-skills`, which is not a registered Claude Code CLI command — the real one is `/reload-plugins`. Docs (`packages/cli/docs/skills.md`, `docs/guides/distributing-vat-skills.md`, plugin READMEs, `vat-example-cat-agents` distribution doc) updated to match.

- **`vat resources validate` no longer floods stderr with `unknown format
  "uri-reference" ignored` warnings.** Ajv's default vocabulary doesn't
  include URI-family formats; with `format: uri-reference` first-class in
  frontmatter, the validator used to log one warning per occurrence (often 20+
  per validate run). The validator now registers `ajv-formats` against its
  Ajv instance, which silences the warnings without changing semantics — VAT's
  own walker validates URI-ref hrefs against `resolveLocalHref`, not Ajv's
  format definitions. Adopter-surfaced cleanup.

## [0.1.37] - 2026-05-16

### Fixed
- **`vat resources validate` no longer rejects unquoted ISO dates in frontmatter.** `js-yaml`'s default schema still applies the YAML 1.1 `!!timestamp` tag, silently promoting `date: 2026-04-15` to a JavaScript `Date` object. Schemas typed `{ "type": "string" }` then failed with `got: "2026-04-15T00:00:00.000Z". Expected type: "string"`. VAT now parses frontmatter (and all internal YAML) with the YAML 1.2 spec (js-yaml's `CORE_SCHEMA`), so unquoted ISO dates stay as strings — matching `yaml` (eemeli/yaml) and YAML 1.2 defaults across the ecosystem. Adopters with ADR/PRD frontmatter using the conventional unquoted date format no longer have to quote every date field. Norway-style booleans (`yes`/`no`/`on`/`off`) and octal literals were already handled correctly by js-yaml v4 defaults.

- **Clearer diagnosis when a `frontmatterSchema` resolves to a missing file.** When a `frontmatterSchema` configured as an npm bare specifier resolves through the package's `exports` map to a path that doesn't exist on disk (typically because the publishing package shipped its `exports` field but its build never wrote the artifact — e.g. a broken Windows-only main-module check in the publisher's `gen-schemas` script), `vat resources validate` now names the missing file, says "does not exist on disk", and points at the publisher's build. The previous generic "Cannot find module … Check the package's exports field, or run install in `<baseDir>`" message sent adopters hunting for install-state or path-separator bugs. `ERR_PACKAGE_PATH_NOT_EXPORTED` and "package not installed" remain distinct failure modes with their own messages.
- **`validation.allow` entries now match paths under dotfile directories.** `validation.allow[CODE].paths` globs like `**/*` and `**/SKILL.md` previously failed to match any path traversing a dotfile directory (`.claude/skills/...`, `.worktrees/<branch>/...`, `.config/...`). Allow entries on skills under those locations silently never applied, so suppressed `CAPABILITY_*` issues kept emitting and `unused` records stayed empty even when the allow was correct. Latent since `0.1.30`.
- **`excludeReferencesFromBundle` rules now match links under dotfile directories.** Same root cause: `excludeReferencesFromBundle` patterns silently failed to drop bundle references whose paths traversed a dotfile dir. Bundles included files the config asked to exclude.
- **`vat audit --exclude` patterns now match paths under dotfile directories.** Same root cause: `vat audit ~/.claude/plugins --exclude '**/foo'` silently ignored the exclude on dotfile-traversing paths.

## [0.1.36] - 2026-05-16

### Added
- **Frontmatter URI-reference link validation.** `vat resources validate` now walks frontmatter values at JSON Schema positions with a URI-family format (`uri-reference`, `uri`, `iri-reference`, `iri`) and validates them through the same engine as markdown links — file existence, anchor resolution, gitignore safety. Absolute URLs in those fields feed into the existing external URL health-check pass when enabled on the collection. Default-on for any collection whose schema declares those formats; opt out via `validation.checkFrontmatterLinks: false` per collection or the global CLI flag `--no-check-frontmatter-links`. Four new issue codes (`frontmatter_link_broken`, `frontmatter_anchor_missing`, `frontmatter_link_to_gitignored`, `frontmatter_unknown_link`) — see [`docs/validation-codes.md`](docs/validation-codes.md). Full guide: [`docs/guides/collection-validation.md#frontmatter-link-validation`](docs/guides/collection-validation.md#frontmatter-link-validation).
- **npm bare specifiers for `frontmatterSchema`.** Collection `frontmatterSchema` in `vibe-agent-toolkit.config.yaml` and the `vat resources validate --frontmatter-schema` flag now accept npm bare specifiers (`@scope/pkg/schemas/foo.json` or `pkg/schemas/foo.json`) in addition to filesystem paths. VAT resolves them from your project's `node_modules`, honoring the target package's `exports` map — so schema-publishing packages own their internal layout and consumers don't hardcode `dist/` paths. Filesystem-path behavior is unchanged. Full guide: [`docs/guides/collection-validation.md#schema-paths`](docs/guides/collection-validation.md#schema-paths).

## [0.1.35] - 2026-05-09

### Added
- **Multi-plugin marketplaces with independent versioning.** Each plugin in a marketplace can now declare its own version (in `plugins/<name>/.claude-plugin/plugin.json:version` or via the marketplace config's per-plugin `version` field), get its own per-plugin source-repo tag (`<plugin>-v<version>`) on `vat claude marketplace publish`, and ship its own CHANGELOG (default `<plugin.source>/CHANGELOG.md`, override via the per-plugin `changelog` field) bundled into the published marketplace at `plugins/<name>/CHANGELOG.md`. The published `marketplace.json` includes `version` per plugin entry when defined. Marketplaces with no per-plugin version inherit the root `package.json:version` (backwards compatible — exercised by integration test scenario 3 against an existing adopter marketplace shape). Unblocks a multi-plugin adopter marketplace where each topical plugin must version and release independently.

### Changed
- **Version precedence in `mergePluginJson` flipped.** When both a marketplace-config version and a `plugin.json:version` are present, config wins (with a reconciliation warning); when only `plugin.json:version` is present, it now wins over the root `package.json` version. Previously the root version always won. Single-version marketplaces (no per-plugin version anywhere) are unaffected.

## [0.1.34] - 2026-05-06

### Added
- **`vat inventory <path>`** — new top-level command emitting structural YAML/JSON for plugins, marketplaces, skills, and installs (`schema: vat.inventory/v1alpha`). Runs no validators; pure structural enumeration. Supports `--user`, `--shallow`, and `--format json|yaml`. The same inventory model is now the single substrate for `vat audit` — adopters who want to script structural questions about their plugins (declared vs. discovered components, parse errors, cross-references) can do so without re-walking the filesystem.
- **`vat corpus scan [seed-file] --out <dir>`** — audit and (with `--with-review`) review multiple plugins in one run. Reads a YAML seed of tracked plugins, audits each, and aggregates per-plugin output. Per-entry `validation:` overrides silence findings on a per-plugin basis. Ships with a starter `corpus/seed.yaml` of 11 plugins.
- **`vat audit` accepts a git URL.** Pass HTTPS, SSH, GitHub-shorthand (`owner/repo`), GitHub web URL, or `file://`, optionally with `#ref:subpath`. Shallow-clones, audits, cleans up. Auth is passthrough to your local `git` — VAT reads no tokens. `--debug` preserves the cloned tempdir.
- **`vat claude plugin build`** — bundle commands, hooks, agents, MCP servers, scripts, plugin-local `SKILL.md` files, and `plugin.json` from a `plugins/<name>/` directory into a self-contained Claude Code plugin (tree-copied verbatim, `.gitignore`-respecting). Pool-skill import via `marketplace.plugins[].skills` (`"*"` or `[names]`) preserved. New marketplace fields: `source` (path override) and `files[]` (compiled-artifact mappings). Case mismatches between declared plugin names and on-disk dirs fail the build.
- **`skill-claude-plugin` recognized as a distinct artifact shape.** A skill that self-publishes as a Claude plugin by co-locating `.claude-plugin/plugin.json` alongside its root `SKILL.md` now produces independent `agent-skill` and `claude-plugin` validation results. New `SKILL_CLAUDE_PLUGIN_NAME_MISMATCH` warning fires when the manifest name disagrees with the SKILL.md `name`.
- **Eleven new validation codes.**
  - Seven cross-walked from Anthropic's `plugin-dev` skill, all `info` severity per the rule-addition policy: `PLUGIN_MISSING_DESCRIPTION`, `PLUGIN_MISSING_AUTHOR`, `PLUGIN_MISSING_LICENSE`, `PLUGIN_NAME_NOT_KEBAB_CASE`, `SKILL_NAME_NOT_KEBAB_CASE`, `SKILL_REFERENCES_BUT_NO_LINKS`, `SKILL_BODY_NOT_IMPERATIVE`. Additive observability — no existing audit will newly fail.
  - Four structural codes derived from the inventory model:
    - `COMPONENT_DECLARED_BUT_MISSING` (warning) — manifest declares a component path that's absent on disk.
    - `COMPONENT_PRESENT_BUT_UNDECLARED` (info) — component exists under canonical layout but the manifest's explicit list omits it; the runtime will silently skip it. Fires only when `declared !== null`; auto-discovery (a missing field) is intentional and not flagged.
    - `REFERENCE_TARGET_MISSING` (error) — a manifest-resolved cross-component reference (hook script, MCP path) points at a missing file.
    - `MARKETPLACE_PLUGIN_SOURCE_MISSING` (error) — a marketplace declares a path-source plugin that doesn't exist.
- **Three `[VAT]` manual checklist items in `vat-skill-review.md`** for judgment calls automation can't make: description names concrete trigger phrases, description disambiguates from sibling skills, body avoids duplicating reference content.

### Changed
- **`vat audit <marketplace-dir>` now recurses into co-located, path-source plugins.** Previously a marketplace audit scanned only the manifest; plugins declared via `./plugins/<name>` were silently skipped. Each path-source plugin in `discovered.plugins[]` is now audited via the same plugin pipeline. Adopters who run `vat audit` against a marketplace directory in CI will see findings for the contained plugins and their skills (e.g., `vibe-validate.git#claude-marketplace`: 1 file scanned → 10). Git/npm sources stay out of scope.
- **Breaking (pre-1.0):** `ClaudePluginSchema`, `ClaudePlugin`, `ClaudePluginJsonSchema`, and `validatePlugin` moved from `@vibe-agent-toolkit/agent-skills` to `@vibe-agent-toolkit/claude-marketplace`. `agent-skills` is now vendor-neutral. Update imports.

### Documentation
- New `docs/architecture/skill-packaging.md` enumerates the four packaging shapes (standalone skill / skill-claude-plugin / claude-plugin / claude-marketplace) and the inventory model.
- New "Plugin Inventory Codes" section in `docs/validation-codes.md` and a "Declared vs discovered components" subsection in `docs/skill-quality-and-compatibility.md` document the tri-state declared/discovered model and the empirical Claude Code loader behavior behind it.

## [0.1.33] - 2026-04-21

### Added
- **Cross-platform ESM helpers in `@vibe-agent-toolkit/utils`.** Two new exports address Windows path footguns that can bite adopters once their code runs on Windows CI:
  - `resolveFromImportMeta(importMetaUrl, ...segments)`: OS-native absolute path from a module's `import.meta.url` and optional relative segments. Use instead of `new URL(rel, import.meta.url).pathname`, which returns `/D:/...` on Windows and breaks `fs` operations.
  - `dynamicImportPath<T>(absPath)`: wraps `await import(pathToFileURL(absPath).href)`. Use instead of `await import(absPath)` on an OS-native filesystem path — the bare form throws on Windows (ESM dynamic import requires a `file://` URL there).
- **Two new local ESLint rules** (registered in `@vibe-agent-toolkit/dev-tools/eslint-local-rules` and wired as `error` in the root `eslint.config.js`):
  - `local/no-url-pathname-for-fs`: flags `.pathname` access on `new URL(..., import.meta.url)`. Message points at the new `resolveFromImportMeta()` helper or `fileURLToPath()`.
  - `local/no-bare-dynamic-import-path`: flags `await import(expr)` where `expr` is a computed filesystem path (absolute literal, `path.join/resolve` result, path-shaped identifier). Message points at the new `dynamicImportPath()` helper or `pathToFileURL(p).href`. Intentionally narrow heuristic with one documented false-positive escape hatch (suppress per-line with `eslint-disable-next-line local/no-bare-dynamic-import-path` when the identifier already holds a `file://` URL).
  - RuleTester-based unit tests land alongside the rules via a shared harness (`packages/dev-tools/test/eslint-rule-test-harness.ts`). Adding a new local rule is now one row in `local-eslint-rules.test.ts`, not a new test file.
- Three new skill-smell validation codes (all default `warning`, per skill-smell philosophy):
  - `SKILL_FRONTMATTER_EXTRA_FIELDS`: frontmatter contains keys beyond the standard agentskills.io + Claude Code set. Allowed keys derive from `AgentSkillFrontmatterSchema` at module load, so the rule tracks the schema. Actionable when adopters put project-specific fields (`version:`, `tools:`, `permissions:`) at top level — `metadata.*` is the right home for custom data.
  - `SKILL_CROSS_SKILL_AUTH_UNDECLARED`: body prose declares a sibling-skill or `ANTHROPIC_*_KEY` dependency (e.g., "Requires `vibe-agent-toolkit:vat-enterprise-org`", "Requires `ANTHROPIC_ADMIN_API_KEY`") but the description omits it. Narrow heuristic to keep false-positive rate low; bare `ANTHROPIC_API_KEY` (the universal Claude-API default) is explicitly excluded.
  - `SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE`: detects mixed YAML scalar styles across sibling skills' `description` frontmatter in the same package. Detector registered and documented; pipeline wiring deferred to a follow-up RC (requires a package-level aggregation pass that the current single-file validator pipeline does not provide).

### Changed
- **Config model clarified: one `vibe-agent-toolkit.config.yaml` per VAT project; no composition across projects.** `vat audit` no longer walks the filesystem looking for every nested config under the scan path. Instead, for each SKILL.md it discovers, it walks up to the skill's nearest-ancestor config (if any) and applies only that skill's `skills.config.<name>` packaging rules to the finding. This removes the federated-skill-discovery behavior that was never a documented or intended feature. Lifecycle commands (`vat build`, `vat verify`, `vat skills validate`, `vat skills build`) continue to use exactly one config — the one at their cwd — as they have all along. Adopters who ran `vat audit <ancestor-path>` against monorepos with multiple per-package configs should now run `vat audit` inside each project directory (or use `--cwd`) for per-project validation. When audit encounters a non-scan-root `vibe-agent-toolkit.config.yaml`, it emits a one-time info breadcrumb so operators see which configs were observed. Performance: `vat audit .` on the VAT monorepo drops into the sub-second range because the tree walk is bounded to skill discovery, not to config discovery.
- `actions/checkout` and `actions/setup-node` bumped from `@v4` to `@v6` across `.github/workflows/*.yml`. Runs on Node 24; removes the Sept-2026 deprecation warning on `v4` runners.

### Fixed
- **Windows path-normalization regression in `GitTracker.isIgnored()`.** The cache was populated at init with `safePath.resolve(projectRoot, relPath)` (which drive-prefixes on Windows, e.g. `C:/project/README.md`), but `isIgnored()` queried the cache with the raw caller-supplied path. Every lookup missed on Windows and fell through to spawn `git check-ignore`, triggering three `packages/utils/test/git-tracker.test.ts` performance-assertion failures on every Windows CI run since rc.2. Fix normalizes the lookup key to match population. Sibling methods `hasActiveDescendant` and `isIgnoredByActiveSet` already normalized correctly; `isIgnored` was the outlier. Added a POSIX-visible regression test using a non-canonical path (containing `..`) so the invariant is guarded against future changes that might reintroduce raw-path lookups.
- **Windows infinite loop in `findConfigPath()` when scanning paths outside a VAT-configured project.** The root-detection used a hardcoded `/`, which never matches Windows drive roots (`C:\`, `D:\`), causing the walk-up loop to spin indefinitely. Fixed via `path.parse(dir).root` + `dirname()` with a `parent === currentDir` safety break so traversal halts at the filesystem root on every OS. Manifested as `vat audit` hangs on Windows whenever the scan target (or the caller's cwd for a `.` scan) had no `vibe-agent-toolkit.config.yaml` ancestor — common for temp-directory test fixtures and any audit run outside a project.
- Stale JSDoc examples referencing `vibe-agent-toolkit:resources` (renamed to `vibe-agent-toolkit:vat-knowledge-resources` during the 0.1.32 plugin restructure) replaced with `vibe-agent-toolkit:vat-audit` in `packages/cli/src/commands/claude/plugin/build.ts`, `packages/cli/src/commands/skills/build.ts`, `packages/agent-schema/src/package-metadata.ts`, and the companion test constant.
- **`duplication-check` now runs on Windows.** Previously it was skipped because `@jscpd/finder` calls `realpathSync()` on the input patterns, which on Windows fails when paths contain `..`/glob patterns and prevents the report from being generated (upstream issue [jscpd#143](https://github.com/kucherenko/jscpd/issues/143), unfixed since 2020). The fix ships as a Bun `patchedDependencies` entry at `patches/@jscpd%2Ffinder@4.0.4.patch` — Bun applies it automatically on `bun install`. The patch is a two-line removal of the `realpathSync()` call; jscpd doesn't depend on the resolved path for anything downstream. Cross-platform baseline portability is ensured by a companion change: `jscpd-check-new.ts` and `jscpd-update-baseline.ts` now normalize clone paths to forward slashes via `toForwardSlash()`, so a baseline captured on Linux/CI matches when `duplication-check` runs on Windows (where jscpd reports backslashes).
- **`safeExecSync` / `safeExecResult` in `@vibe-agent-toolkit/utils` no longer silently fail on Windows under Node 24+.** When the resolved command was a shell wrapper (`.cmd`/`.bat`) — e.g. `npx.cmd`, `bunx.cmd`, `npm.cmd` — the previous code passed args through `shell:true` as a separate array, which Node 24 rejects with `EINVAL` per [DEP0190](https://nodejs.org/api/deprecations.html#DEP0190) whenever any arg contains a shell metacharacter (`*`, `?`, `(`, `)` …). Symptom: the spawned process would fail immediately and produce no output, leaving callers to misattribute the crash to the downstream tool. Fix joins the command and args into a single string when the shell path is needed, keeping `shell:false` + absolute-path spawning as the default for all non-wrapper commands (the secure path). Was the actual reason `bun run duplication-check` failed on Windows CI even after the jscpd patch landed.
- **Windows `bun install` postinstall failures from `link-workspace-packages.ts`.** The postinstall script created workspace symlinks with `symlinkSync(target, link, 'dir')`, which requires the `SeCreateSymbolicLinkPrivilege` admin right on Windows and fails with `EPERM` in non-elevated shells. Fix uses directory **junctions** on Windows (`symlinkSync(absoluteTarget, link, 'junction')`) — junctions don't require elevation and are transparent to both Node's ESM resolver and Bun's workspace linking. POSIX platforms continue to use relative-path `'dir'` symlinks as before. Windows developers can now `bun install` in a standard (non-admin) shell.

### Performance
- **Walker unification on `GitTracker`.** Every `vat audit` / `vat skills validate` / `vat verify` scan now shares one pre-populated `GitTracker` per repo. The tracker pre-loads the full active file set (tracked + untracked-not-ignored) via `git ls-files --cached --others --exclude-standard`, precomputes the ancestor directory set, and answers every ignore check from an in-memory `Set` instead of spawning `git check-ignore`. Per-directory `gitCheckIgnoredBatch` calls and per-link `isGitIgnored` calls are gone from the hot paths in `packages/cli/src/commands/audit.ts`, `packages/agent-skills/src/walk-link-graph.ts`, `packages/agent-skills/src/validators/packaging-validator.ts`, and `packages/discovery/src/scanners/local-scanner.ts`. `@vibe-agent-toolkit/utils` **removes the `gitCheckIgnoredBatch` export** (no remaining in-tree or external callers); `isGitIgnored` is kept as the single-spawn fallback for code paths that don't have a tracker threaded in (e.g. one-off callers in `link-validator.ts` and `walk-link-graph.ts`).
- **Shared `ResourceRegistry` across skills in `vat skills validate`.** When a single `vat skills validate` invocation covers multiple skills that share one project root, the command now builds one crawled/link-resolved `ResourceRegistry` once and reuses it for every skill's validation instead of re-parsing the same markdown per skill. Heterogeneous scans (mixed project roots) transparently fall back to per-skill registries.
- **Measured wall-time (median of 3 runs on the VAT monorepo, M-series laptop):**
  - `vat audit .`: 6.85s → 2.50s (~2.7x, under the 3s target set in the rc.1 plan)
  - `vat verify --cwd packages/vat-development-agents`: 12.68s → 2.85s (~4.4x)
  - `vat skills validate packages/vat-development-agents`: 10.05s → 1.44s (~7x)
- No observable output changes for `vat audit` / `vat skills validate` / `vat verify` — YAML output diffs clean pre/post across all three commands except wall-time fields. One internal shift worth noting: `@vibe-agent-toolkit/discovery`'s `LocalScanner.scan()` now instantiates and eagerly `initialize()`s a `GitTracker` on every call so in-project gitignore checks are O(1); this adds a single `git ls-files` spawn per scan invocation (was effectively a no-op when only one file was scanned). New `GitTracker` APIs (`hasActiveDescendant`, `isIgnoredByActiveSet`) are non-breaking additions; `initialize()` accepts an options bag with `includeUntracked` defaulting to `true`.
- **Final spawn sweep (post-rc.3).** Two independent spawn-eliminations that together recover the rc.2 baseline and beat it for single-config projects. (1) `vat audit` now caches `discoverSkillsFromConfig` by governing-config root, so per-skill walk-up resolution no longer re-expands the same config's globs N times for an N-skill package. (2) `packages/resources/src/link-validator.ts` switched both `gitTracker.isIgnored()` call sites (source + target) to `isIgnoredByActiveSet`, which answers O(1) against the pre-populated active set for in-project paths. Link validation fires per link and skills typically have dozens of links, so this was the largest remaining spawn source in the audit hot path. Post-fix medians (M-series Mac, 3 runs): VAT self `vat audit .` ~2.5s (recovered rc.2 baseline after rc.3's ~12% regression); vibe-validate `vat audit .` 0.96s → ~0.20s (~5x faster); a large adopter monorepo `vat audit .` 5.43s → ~4.0s. Windows sees roughly 2x these wins since process-spawn overhead there is ~10x higher than on Linux.

## [0.1.32] - 2026-04-19

### Added
- **Evidence substrate** (`@vibe-agent-toolkit/agent-skills/evidence`). Parsers produce neutral `EvidenceRecord`s with stable pattern IDs from `PATTERN_REGISTRY`; a derivation step rolls evidence into capability `Observation`s; a verdict engine compares observations against declared targets. Designed so pattern refinement never changes the observation contract.
- **`vat audit --verbose`** renders the evidence chain beneath each `CAPABILITY_*` observation — pattern ID, file, line, match text — and includes an `evidence[]` array in YAML output. Use it to debug false positives or confirm what a detector actually saw.
- **Runtime profile table** (`RUNTIME_PROFILES` in `@vibe-agent-toolkit/claude-marketplace`) is the single source of truth for what each Claude runtime provides and lacks (local shell, browser, network level, preinstalled binaries).
- **Verdict engine** (`computeVerdicts`) combines capability observations with declared targets to produce `COMPAT_TARGET_*` issues. Four states: expected (silent), `COMPAT_TARGET_INCOMPATIBLE` (warning), `COMPAT_TARGET_NEEDS_REVIEW` (warning), `COMPAT_TARGET_UNDECLARED` (info).
- **Config-level `targets` declaration** in `vibe-agent-toolkit.config.yaml` under `skills.defaults.targets` and `skills.config.<name>.targets`. Declaring targets suppresses non-applicable compat verdicts.
- **Marketplace-level `defaults.targets`** in `.claude-plugin/marketplace.json`. Layer priority (highest to lowest): `plugin.json` → `marketplace.json` → `vibe-agent-toolkit.config.yaml`.
- **Post-build validation**: `vat skills build` runs the full validation suite against built `dist/skills/*/SKILL.md` (skipping source-only codes like `LINK_OUTSIDE_PROJECT`). Build failures surface identically to source failures.
- **`info` severity** in the validation framework. `CAPABILITY_*` and `COMPAT_TARGET_UNDECLARED` emit as info; they appear in output and respect `validation.severity` overrides but do not contribute to build failure status.
- New validation codes: `CAPABILITY_LOCAL_SHELL`, `CAPABILITY_EXTERNAL_CLI`, `CAPABILITY_BROWSER_AUTH` (info); `COMPAT_TARGET_INCOMPATIBLE`, `COMPAT_TARGET_NEEDS_REVIEW` (warning); `COMPAT_TARGET_UNDECLARED` (info).
- Validation-rule-design doc at `docs/validation-rule-design.md` articulating rule-addition bar, default severity posture, graduation path, and data-driven evolution. Referenced from `docs/validation-codes.md`.
- Cached Anthropic skill-authoring best-practices doc at `docs/external/anthropic-skill-authoring-best-practices.md` with attribution, source URL, and fetch date. Provides a diffable reference so VAT's tooling stays aligned with upstream Anthropic guidance. CLAUDE.md documents the periodic-refresh policy.
- `vat-skill-review.md` (formerly `skill-quality-checklist.md`) rewritten with `[A]` / `[VAT]` tags distinguishing Anthropic-aligned items from VAT-opinionated additions. Added gerund-form naming guidance (Anthropic's preferred pattern), frontmatter-key conservatism, cross-skill dependency disclosure, in-package YAML-styling consistency, and large-tables-to-reference-files guidance — all from dogfood findings across 17 real skills (8 from an adopter repo + 1 vibe-validate + 8 VAT dev-agents).
- Five new skill-quality validation codes, all non-blocking:
  - `SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT` (warning): description > 250 chars — Claude Code's `/skills` listing truncation limit since v2.1.86.
  - `SKILL_DESCRIPTION_FILLER_OPENER` (warning): description opens with `This skill...`, `A skill that...`, `Used to...`, `Use when you want to...`, or `Use when you need to...`.
  - `SKILL_DESCRIPTION_WRONG_PERSON` (warning): description uses first- or second-person voice (Anthropic: "Always write in third person").
  - `SKILL_NAME_MISMATCHES_DIR` (warning): frontmatter `name` differs from the parent directory name.
  - `SKILL_TIME_SENSITIVE_CONTENT` (info): body contains `as of <month> <year>`, `after <month> <year>`, etc. — will go stale.
- `vat audit` and `vat skills validate` now print a checklist-discovery footer when skill-level findings are present, pointing at the `vat-skill-review` skill for rationale and judgment-call items.
- **`vat skill review <path>` command**: deep-review a single skill. Combines `validateSkillForPackaging` output, config-aware compat verdicts (when inside a VAT project), and a manual-checklist walkthrough into one report. Groups automated findings by checklist section (Naming / Description / Body structure / References / Frontmatter hygiene / Compatibility). Supports `--yaml` for machine-readable output. Designed as a thin composition over existing primitives, not a new validation pipeline.
- **MCP interpreter observations**: the `.mcp.json` scanner's `MCP_SERVER_COMMAND` evidence now rolls up into a `CAPABILITY_EXTERNAL_CLI` observation when the command is a python interpreter (`python`, `python3`, `python3.11`, absolute paths) or a node interpreter (`node`, `nodejs`, absolute paths). Closes the gap where python3-MCP plugins produced no capability signal and verdicts couldn't fire against them. Bespoke commands (e.g. `./scripts/my-server.sh`) remain un-rolled-up by design.
- **`RESERVED_WORD_IN_NAME` (warning)** — code-registry-framework replacement for the legacy non-overridable error `SKILL_NAME_RESERVED_WORD`. Fires when a skill frontmatter `name` contains `anthropic` or `claude` (reserved for Anthropic's certified skills). Overridable via `validation.severity` / `validation.allow` like any other framework code. Per the skill-smell philosophy, reserved-word naming is a fix-before-publish smell, not a genuine build breaker, so default severity is `warning`.

### Changed
- **`vibe-agent-toolkit` plugin restructured into 10 sub-skills + a router.** Each sub-skill now has a sharp single responsibility and a name that aligns with its CLI command. Published skill names changed:
  - `resources` → `vat-knowledge-resources`
  - `distribution` → `vat-skill-distribution`
  - `authoring` → split into `vat-skill-authoring` (SKILL.md authoring) and `vat-agent-authoring` (TypeScript agents)
  - `org-admin` → `vat-enterprise-org` (also avoids the reserved word `claude` in the previous filename)
  - `audit` → `vat-audit`
  - `skill-quality-checklist` → `vat-skill-review` (now a first-class skill, no longer transcluded)
  - New: `vat-adoption-and-configuration`, `vat-skill-authoring`, `vat-rag`
  - Root `SKILL.md` (`vibe-agent-toolkit`) is now a thin discovery router (~60 lines, prose references to sub-skills only, no transclusion).
  - Pre-1.0: no backwards-compatibility shims for the old skill names. Adopters with pinned references to the old names should update to the new ones.
- **Contributor-only reference docs moved out of the plugin** to `docs/contributing/` (`vat-debugging.md`, `vat-install-architecture.md`). These are not installed with the plugin — they're for people working on VAT itself.
- Shortened over-limit descriptions on three VAT development-agent skills (renamed above: `vat-enterprise-org`, `vat-skill-distribution`) to stay under Claude Code's 250-character truncation limit.
- **BREAKING: Runtime target rename.** `claude-desktop` → `claude-chat`, `cowork` → `claude-cowork`. Update `plugin.json`, `marketplace.json`, and any config references. The `claude-desktop` name was architecturally wrong — Claude Desktop is a host application, not a runtime.
- **BREAKING: `runCompatDetectors` returns `DetectorOutput { evidence, observations }`** instead of `ValidationIssue[]`. The skill-validator converts observations to issues via `observationToIssue`; external callers must do the same or consume observations directly.
- **BREAKING: `CompatibilityResult` restructured.** Old shape: `{ declared, analyzed: Record<Target, Verdict>, evidence: CompatibilityEvidence[] }`. New: `{ declaredTargets, evidence: EvidenceRecord[], observations: Observation[], verdicts: Verdict[] }`.
- **BREAKING: Scanner output shape.** Scanners in `@vibe-agent-toolkit/claude-marketplace` now return `EvidenceRecord[]` with registered pattern IDs; `ScannerOutput { evidence, observations }` replaces `CompatibilityEvidence`.

### Fixed
- `vat audit --compat` now honors config-layer `targets` declared in `vibe-agent-toolkit.config.yaml`, matching `vat skills validate` verdicts inside a VAT project. Previously only `plugin.json` / `marketplace.json` targets flowed into plugin-level compat analysis. Multi-skill plugins use the union of every in-plugin skill's targets.
- `vat-skill-review.md` (formerly `skill-quality-checklist.md`): description-opener rule no longer contradicts Anthropic's official skill-description guidance. `Use when <concrete trigger>` is now explicitly allowed (it's the recommended pattern); only vague filler like `Use when you want to...` / `Use when you need to...` is banned. Prior wording banned all `Use when...` openers, which contradicted VAT's own authoring guidance.
- `readMarketplaceDefaultTargets()` now walks upward from the starting directory to find the enclosing `.claude-plugin/marketplace.json`, instead of only checking the parent directory. Canonical layouts (`~/.claude/plugins/marketplaces/<m>/<p>/`) still work identically; deeper nested layouts now resolve correctly. Safeguarded against runaway walks by max depth (10 levels) and `node_modules` / `.git` boundaries. Closes limitation #1 from the 0.1.32-rc.1 plan Outcome.
- **`vat audit` now walks to the nearest config per SKILL.md** instead of loading a single top-level config. In monorepos with per-package `vibe-agent-toolkit.config.yaml` files (e.g. `packages/<pkg>/vibe-agent-toolkit.config.yaml`), each skill's validation now honors its own package's config — eliminating cross-package config bleed where a root config was silently applied to skills owned by other packages.
- **`vat audit` now honors `resources.exclude` from the config.** Previously the `exclude` list in the `resources` section only affected `vat resources validate`; audit ignored it and reported findings against files the author had explicitly opted out of validation for.
- **`vat skill review <path>` accepts single-file skills** (any `.md` file), not just `SKILL.md` inside a directory. Useful when reviewing loose skill drafts or checklist-style skills that don't live in a dedicated directory.
- **`SKILL_NAME_MISMATCHES_DIR` false positive:** the mismatch check no longer fires when `SKILL.md` lives directly inside a generic container directory (`skills/`, `resources/`). The parent directory name in those layouts carries no signal about what the skill is named.
- Three directory-targeted markdown links in VAT docs (`CLAUDE.md`, `docs/README.md`, `docs/getting-started.md`) now point at specific files, silencing the corresponding `LINK_TARGETS_DIRECTORY` errors on VAT's own docs.

### Performance
- **~4x speedup on monorepo-scale `vat audit`.** `gitCheckIgnoredBatch` (used by the audit walker for every directory it visits) was unconditionally running a per-path `isGitIgnored` fallback after the batch `git check-ignore --stdin` call — spawning one git subprocess per non-ignored path even when the batch's results were authoritative. The fallback now only runs when the batch exits 128 (the fatal "beyond a symbolic link" case it was designed for), per git's documented exit-code semantics. Measurements on the VAT monorepo: `vat audit .` drops from ~30s → ~7s on this laptop. Correctness verified on an adopter repo that has gitignored symlinks into cloud-synced storage — audit produces the same zero-error, same-warning output in ~7s.

### Removed
- **BREAKING:** `COMPAT_REQUIRES_BROWSER_AUTH`, `COMPAT_REQUIRES_LOCAL_SHELL`, `COMPAT_REQUIRES_EXTERNAL_CLI` codes (replaced by `CAPABILITY_*` + `COMPAT_TARGET_*`).
- **BREAKING:** `CompatibilityEvidence` type, legacy `Verdict` string union (`'compatible' | 'needs-review' | 'incompatible'`), `ImpactLevel` type, `ALL_TARGETS` export, `aggregateVerdicts`, `hasNonOkImpact` helpers.
- **BREAKING:** Hardcoded `IMPACT_*` constants and `packages/claude-marketplace/src/scanners/impact-constants.ts` module. Impact logic now lives in the runtime profile table and verdict engine.
- `yaml` runtime dependency from `@vibe-agent-toolkit/claude-marketplace` (YAML parsing now lives in agent-skills via frontmatter delegation).
- Unused `FRONTMATTER_ALLOWED_TOOLS_ENTRY` pattern-registry entry (never emitted by any scanner).

### Migration Notes
Pre-1.0 breaking. Callers must:
1. Update `plugin.json` `targets` arrays to use `claude-chat` / `claude-cowork` / `claude-code`.
2. Replace `COMPAT_REQUIRES_*` entries in `validation.severity` / `validation.allow` with the matching `CAPABILITY_*` or `COMPAT_TARGET_*` code.
3. If consuming `CompatibilityResult` programmatically, migrate from `analyzed`/`declared` fields to `verdicts`/`declaredTargets`.
4. Declare runtime targets in at least one layer (plugin, marketplace defaults, or config) or accept `COMPAT_TARGET_UNDECLARED` info emissions.
5. Run `vat audit --verbose` to inspect evidence and confirm the refactor's output matches intent.
6. If any prompt, CLAUDE.md, or repo-level doc references the `vibe-agent-toolkit` Claude plugin skills by their old names, update them:
   - `vibe-agent-toolkit:authoring` → `vibe-agent-toolkit:vat-skill-authoring` (SKILL.md side) or `vibe-agent-toolkit:vat-agent-authoring` (TypeScript-agent side)
   - `vibe-agent-toolkit:resources` → `vibe-agent-toolkit:vat-knowledge-resources`
   - `vibe-agent-toolkit:distribution` → `vibe-agent-toolkit:vat-skill-distribution`
   - `vibe-agent-toolkit:org-admin` → `vibe-agent-toolkit:vat-enterprise-org`
   - `vibe-agent-toolkit:audit` → `vibe-agent-toolkit:vat-audit`
   - `vibe-agent-toolkit:debugging` — retired from the plugin; the contributor guide lives at `docs/contributing/vat-debugging.md` in the VAT repo.
   - `vibe-agent-toolkit:install` — retired from the plugin; the architecture doc lives at `docs/contributing/vat-install-architecture.md` in the VAT repo.
   - The `skill-quality-checklist` skill is now `vibe-agent-toolkit:vat-skill-review` (also accessible via `vat skill review <path>` CLI).
   Adopter repos that don't invoke the VAT plugin skills by name need no changes.
7. Replace any `SKILL_NAME_RESERVED_WORD` references in `validation.severity` / `validation.allow` with `RESERVED_WORD_IN_NAME`. Default severity is now `warning` (was error); re-override if your policy demands `error`.

## [0.1.31] - 2026-04-17

### Added
- **v1 compat smells.** Three new `COMPAT_*` codes — `COMPAT_REQUIRES_BROWSER_AUTH`, `COMPAT_REQUIRES_LOCAL_SHELL`, `COMPAT_REQUIRES_EXTERNAL_CLI` — detect per-skill runtime capabilities (browser auth, local shell, external CLI) via static analysis of SKILL.md and its transitively linked markdown. Default severity `warning`; configure per-skill via `validation.severity` / `validation.allow` like any other framework code. Full rationale and when-to-allow guidance in `docs/validation-codes.md`.
- **`vat audit --user` now documents `CLAUDE_CONFIG_DIR`.** Help text and `packages/cli/docs/audit.md` name the env var, mark `~/.claude` as the default rather than unconditional, and document a shell-loop pattern for multi-directory workflows. No code change — `CLAUDE_CONFIG_DIR` has always been honored in `packages/claude-marketplace/src/paths/claude-paths.ts` — but the UX gap closes.
- `vat audit`: gitignore-aware scanning. When scanning inside a git repository, paths matched by `.gitignore` are skipped by default — no hardcoded directory list needed. `--include-artifacts` opts back in. When the user explicitly targets a gitignored path (e.g., `vat audit dist/skills/`), filtering is disabled for that subtree.
- `vat audit`: config-aware validation in VAT projects. When `vibe-agent-toolkit.config.yaml` is found at the scan root, audit uses the project's build settings (`linkFollowDepth`, `files`, `excludeReferencesFromBundle`) to validate skills — eliminating false `LINK_OUTSIDE_PROJECT` warnings for links the build pipeline resolves. Audit never applies `validation.allow` (always shows all issues).
- `docs/skill-quality-and-compatibility.md`: new project stance doc articulating what VAT believes makes a skill good and compatible. Linked from the `authoring` skill and cross-referenced from `docs/validation-codes.md`.

### Changed
- `vat audit` now skips gitignored paths by default. Before this change, running `vat audit` in a TypeScript project scanned every SKILL.md in `node_modules/`, `dist/`, and other artifact directories (often hundreds of duplicate files). The new behavior uses the project's `.gitignore` rules, which adapts to each project's layout automatically. Use `--include-artifacts` to opt back in for deliberate artifact audits.

- **`SKILL_CONSOLE_INCOMPATIBLE` retired.** The Bash/Edit/Write/NotebookEdit tool-mention warning is replaced by the new `COMPAT_REQUIRES_LOCAL_SHELL`, giving adopters a single canonical detector with configurable severity and per-path allow entries.

### Removed
- **Top-level `parsed['targets']` reader in `claude-marketplace/src/scanners/frontmatter-scanner.ts`.** The reader violated VAT's `metadata.*`-for-extensions convention and served no concrete downstream use case after the unified validation framework landed in `0.1.30`. Information it captured migrates to framework codes and `validation.allow`.

## [0.1.30] - 2026-04-16

### Changed
- **BREAKING: Unified validation framework replaces `ignoreValidationErrors`.** Every overridable integrity check now flows through a single `validation` block (`severity` + `allow`) under `skills.defaults` / `skills.config.<name>` in `vibe-agent-toolkit.config.yaml`. The previous non-overridable error tier (`OUTSIDE_PROJECT_BOUNDARY`, `LINK_TARGETS_DIRECTORY`, `LINKS_TO_NAVIGATION_FILES`) is removed and replaced by unified `LINK_*` codes that accept the same overrides as everything else. Project-config schemas are now strict — configs containing the removed `ignoreValidationErrors` field (or any other unknown key) fail at parse time with `"Unrecognized key(s) in object"` instead of silently dropping, so upgrades surface the migration work immediately. See [jdutton/vibe-agent-toolkit#83](https://github.com/jdutton/vibe-agent-toolkit/issues/83) for full design rationale and the canonical code reference at `docs/validation-codes.md`.
- **BREAKING: `PACKAGED_UNREFERENCED_FILE` and `PACKAGED_BROKEN_LINK` now block the build.** Previously logged at info level without affecting exit code; now default severity `error` with `vat skills build` exiting `1`. Downgrade via `validation.severity: { PACKAGED_UNREFERENCED_FILE: warning }` if needed.
- **BREAKING: Expired `allow` entries no longer silently re-fire the underlying error.** The allow entry still applies; VAT emits a new `ALLOW_EXPIRED` warning to surface the stale date for re-review. Opt in to strict expiry with `validation.severity: { ALLOW_EXPIRED: error }`.
- **`vat audit` is now advisory.** Audit always exits `0` regardless of validation severity, honors `validation.severity` for display grouping only, and ignores `validation.allow`. Use `vat skills validate` or `vat skills build` for gated checks with per-path allow entries.

### Added
- **New validation codes** — `LINK_OUTSIDE_PROJECT`, `LINK_TARGETS_DIRECTORY`, `LINK_TO_NAVIGATION_FILE`, `LINK_TO_GITIGNORED_FILE`, `LINK_MISSING_TARGET`, `LINK_TO_SKILL_DEFINITION`, `LINK_DROPPED_BY_DEPTH`, `ALLOW_EXPIRED`, `ALLOW_UNUSED`. Full reference at `docs/validation-codes.md` with defaults, descriptions, and fix hints. `LINK_TO_SKILL_DEFINITION` fires only for cross-skill SKILL.md references; transitive self-references (a bundled resource linking back to the skill's own SKILL.md) are treated as no-ops.
- **`LINK_MISSING_TARGET`** closes a previously silent walker drop path: links to non-existent (non-deferred) files are now reported at the walker with a clear message, rather than only surfacing post-build as a generic `PACKAGED_BROKEN_LINK`.
- **`ALLOW_UNUSED`** — analogous to ESLint's unused-disable — surfaces `allow` entries that match no emitted issues.
- **Per-path `validation.allow`** with required `reason` and optional `expires` date, providing an audit trail for legitimate exceptions. `paths` is optional and defaults to `["**/*"]` (the whole skill) — so concerns that apply to an entire skill can omit the paths array entirely.
- **Canonical code reference** at `docs/validation-codes.md`, test-locked against the code registry so new codes cannot ship without documentation.

### Migration

| Old | New |
|---|---|
| `ignoreValidationErrors: { CODE: "reason" }` | `validation.severity: { CODE: ignore }` |
| `ignoreValidationErrors: { CODE: { reason, expires } }` | `validation.severity: { CODE: ignore }` for code-wide silence, OR `validation.allow: { CODE: [{ paths, reason, expires }] }` for scoped allow entries with re-review on expiry |

## [0.1.29] - 2026-04-16

### Added
- **`vat verify --consistency-check`** — post-build verification that skill distribution config in `vibe-agent-toolkit.config.yaml` and `package.json` are consistent. Detects skills missing from `package.json`, orphaned entries, and publish opt-out mismatches. Runs automatically as part of `vat verify`.
- **Post-build integrity checks for packaged skills** — `packageSkill()` now runs `PACKAGED_UNREFERENCED_FILE` and `PACKAGED_BROKEN_LINK` checks after copying files and rewriting links. Both are best-practice (overridable) errors surfaced via `PackageSkillResult.postBuildIssues`; the CLI logs them at info level (non-blocking). Suppress via `packagingOptions.ignoreValidationErrors`. Broken-link detection skips fenced code blocks and inline code spans so template strings aren't false-flagged. Unreferenced-file detection counts any mention of a packaged file's output-relative path — inside code blocks, inline code, or prose — as documented; CLI invocations like `node scripts/cli.mjs` are legitimate references even though they aren't `[text](href)` links.
- **Skill quality checklist** — new `skill-quality-checklist.md` resource bundled with the agent-authoring skill. 21-item checklist covering general skill authoring (description triggering, length limits, third-person voice, time-sensitive content, references one-level-deep, TOCs on long files) plus CLI-backed skill specifics (env guards, auth checks, cross-platform commands, `files` config). Reviewed against external best practices (Anthropic docs, anthropics/skills, superpowers conventions, Claude Code release notes through 2026-04-15).

### Fixed
- **Link rewriting now handles links with inline-formatted text correctly** — `transformContent` keyed its link lookup by `[text](href)` where `text` came from remark (formatting stripped) while the regex captured the raw source (formatting preserved). Any link whose text contained backticks, emphasis, or other inline markup silently fell through the rewriter, leaving the original (now-broken) relative path in the packaged output. Lookup is now keyed by `href`, which the regex and parser report identically. Templates also gain a new `link.rawText` variable exposing the original formatted text (falls back to `link.text` when raw text is unavailable), and the default bundled-link template uses it so `` [`foo.yaml`](…) `` survives rewriting as `` [`foo.yaml`](new/path) `` rather than losing its code styling.
- **`excludeReferencesFromBundle` patterns now apply to terminal non-markdown links** — links to YAML, JSON, images, and other assets that are not indexed by the registry were falling through the bundled-link rule and rendering as `[text]()` because `matchesPattern` short-circuited to `false` whenever the target resource was unresolved. `matchesPattern` now falls back to matching the link's raw href when no resolved resource is available, and `buildRewriteRules` evaluates per-pattern excludes before the bundled-link rule so terminal assets resolve to the user's template.
- **`files` config in `skills.config.<name>.files` was parsed but not applied at build time** — `vat skills build` merged the `files` entries from `vibe-agent-toolkit.config.yaml` and validated them (`vat verify` correctly reported missing dests), but never passed them into `packageSkill()`, so declared files were silently skipped. Now CLI binaries and other build artifacts declared via `files` config are copied into skill output as intended.
- **Skill bundler strips links to non-markdown bundled files** — links to YAML, JSON, and script files routed to `templates/`, `assets/`, or `scripts/` were rewritten to empty `()` because non-markdown assets weren't added to the output registry. Now all files in the path map are added to the output registry with their mapped output paths, including the duplicate-ID edge case for paired markdown/non-markdown files (e.g. `config.md` + `config.yaml`).
- **Skill bundler strips depth-boundary links to already-bundled resources** — when resource D linked to resource C and C was already bundled via a shorter path from SKILL.md, the link from D→C was stripped because depth-exceeded exclusions were unconditionally added to `excludedIds`. Bundle membership now wins: `excludedIds` filters out resources already in `bundledResources`.
- **Discovery scanner no longer traverses git worktrees** — `.worktrees/` and `.claude/worktrees/` added to `PERFORMANCE_POISON` exclusions, preventing the crawler from physically walking into worktree copies of the repo during scans.
- **System tests no longer flaky from vitest worker timeout** — refactored `skills-list.system.test.ts` to run CLI spawns once in `beforeAll` instead of 5 redundant full-project scans. Same coverage, 70% faster (90s → 27s), eliminates the `onTaskUpdate` timeout.

## [0.1.28] - 2026-04-14

### Fixed
- **Skill bundler no longer silently bundles gitignored files** — when a SKILL.md links to files inside a gitignored directory (e.g., `data/`), those files are now excluded from the bundle instead of being silently packaged and published. This includes files reached through symlinks in gitignored directories (e.g., OneDrive/shared drive mounts). Previously required manual `excludeReferencesFromBundle` workarounds; now handled automatically.

## [0.1.27] - 2026-04-11

### Breaking
- **Removed top-level `vat install` command.** Install of flat skills now uses `vat skills install <source> --target <target> --scope <user|project>`. Install of Claude plugins uses `vat claude plugin install <source>`.

### Added
- `vat skills install <source> --target <target> --scope <user|project>` — cross-platform flat skill installer. Supports 7 targets (claude, codex, copilot, gemini, cursor, windsurf, agents) and 2 scopes (user, project). Sources: local directory, `.zip`, `.tgz`, or `npm:@scope/package`. Pre-verifies all skills before touching the filesystem (all-or-nothing).
- `vat skills list npm:@scope/package` — inspect what skills are in an npm package without installing.
- `bun run pre-release` — pre-tag validation command that confirms CHANGELOG is stamped, no stale tags exist on remote, marketplace dry-run passes, and version section has content. Prevents failed CI publishes from unready state.
- `bun run bump-version` now auto-stamps CHANGELOG.md for stable versions — moves `[Unreleased]` content under a new `## [X.Y.Z] - date` heading. Safety guards: fails if `[Unreleased]` is empty, refuses to stamp if version already exists in CHANGELOG (prevents corruption from backward bumps or re-stamps). Skips for RC/prerelease versions.
- **Content-type routing** — auto-discovered files now route to `scripts/`, `templates/`, `assets/`, or `resources/` based on file extension instead of all going to `resources/`.
- **Skill files config** — declare `files` entries in `vibe-agent-toolkit.config.yaml` for build artifacts, unlinked files, or routing overrides. Supports default + per-skill merge with dest-based override. See `docs/guides/skill-files-and-routing.md`.
- **Deferred verification** — validation chain recognizes declared build artifacts at source time (deferred), enforces hard gates at build time (source must exist) and verify time (dest must exist in output).
- **`vat verify` files check** — post-build verification now confirms all `files[].dest` paths exist in the built output.

### Fixed
- **CHANGELOG check in pre-publish no longer skipped during `bun run validate`** — the CHANGELOG stamp check was incorrectly gated behind `--skip-git-checks` (a git check flag), but it's a content check. Now runs unconditionally.

### Changed
- Published VAT skills updated to describe the new `vat skills install` command surface.

## [0.1.26] - 2026-04-10

### Added
- **Cross-skill SKILL.md bundling prevention** — VAT now detects when a skill links to another skill's `SKILL.md` and excludes it from the bundle. A `SKILL.md` is a skill definition marker, not a resource — bundling one inside another skill creates duplicate definitions that break marketplace sync and confuse skill consumers. Two layers of protection: link-follow filtering (prevents the bad state) and post-build validation (safety net). The exclusion appears in build output as `skill-definition` reason.
- **ESLint rule: `no-fs-promises-cp`** — Prevents usage of async `cp()` from `node:fs/promises` in favor of `cpSync()` from `node:fs`. Node 22's async `cp({ recursive: true })` silently drops files in nested directories. The rule auto-fixes and explains the issue so developers can make an informed eslint-disable decision if async is truly needed.

### Fixed
- **Marketplace publish drops non-markdown files on Node 22** — `composePublishTree` used async `cp()` from `node:fs/promises` which silently drops `.mjs` files in nested directories on Node 22. Replaced with `cpSync` which works correctly across all Node versions. Added a system test that verifies `.mjs` scripts survive the full compose→publish pipeline.
- **Marketplace publish `--debug` flag not reaching logger** — `--debug` was defined on the publish command but consumed by a parent command in the Commander hierarchy. Options are now read via `optsWithGlobals()` so `--debug` works correctly.
- **Marketplace publish debug logging** — `vat claude marketplace publish --debug` now logs the full file list at each stage of the publish pipeline (cpSync output, git tracked files, git ignored files, early-exit tree). Diagnoses files disappearing between build output and published commit.

## [0.1.25] - 2026-04-09

### Security
- **Marketplace publish no longer logs git remote credentials.** `vat claude marketplace publish` previously echoed the full remote URL — including any credentials embedded by the user's config OR injected at runtime from `GH_TOKEN`/`GITHUB_TOKEN` — to stdout via its `Remote:` and `Pushed to …` log lines. In CI, GitHub Actions auto-masked the secret, but local runs (including adopter dry-runs) emitted the raw token to the terminal. All URL logging now passes through a `redactUrlCredentials()` helper that strips userinfo before logging. Git commands still receive the tokenized URL for authentication — only the logged copy is redacted.

### Changed
- **BREAKING: Marketplace publish no longer rewrites `CHANGELOG.md`.** `vat claude marketplace publish` now mirrors the source `CHANGELOG.md` byte-for-byte into the publish tree and extracts release notes for the commit body only. Accepts both Keep a Changelog workflows: a pre-stamped `[X.Y.Z]` section matching `package.json` (preferred) or a non-empty `[Unreleased]` section (fallback). Fails if neither is present. Workflow A adopters whose `main` branch CHANGELOG continues to carry `[Unreleased]` at publish time will see that heading on the publish branch too — stamp `CHANGELOG.md` on `main` before tagging if you want a stamped heading in the published file. Side benefit: corrections/typo-fixes to `CHANGELOG.md` on `main` now propagate to the publish branch on the next publish.

### Fixed
- **`toAbsolutePath()` and `getRelativePath()` now return forward-slash paths on Windows** — previously these returned backslash paths, bypassing cross-platform normalization.

## [0.1.24] - 2026-04-06

### Feature
- **Safe path normalization** — added `safePath.join()`, `safePath.resolve()`, `safePath.relative()` wrappers in `@vibe-agent-toolkit/utils` that always return forward-slash paths. New ESLint rules (`no-path-join`, `no-path-resolve`, `no-path-relative`) enforce their use over raw `node:path` functions, with auto-fix support. Adopters can copy these rules from `packages/dev-tools/eslint-local-rules/` into their own projects. Closes #38.
- **Cross-platform ESLint rule parity with vibe-validate** — ported `no-path-resolve-dirname` (enforces `normalizePath()` over `path.resolve(__dirname)` in tests for Windows 8.3 short name safety) and `no-test-scoped-functions` (enforces module-scope helper functions in test files, SonarQube S1515). VAT now ships 15 custom ESLint rules for cross-platform safety.

## [0.1.23] - 2026-04-02

### Feature
- **Marketplace publishing** — distribute Claude plugin marketplaces via Git branches. `vat claude marketplace publish` composes built artifacts with changelog, readme, and license into a squashed commit on a configurable branch. Consumers install with `/plugin marketplace add owner/repo#branch`. Includes standalone strict validation (`vat claude marketplace validate`) and automatic marketplace verification in `vat verify`.

### Docs
- **Marketplace testing guide** — added "Testing Your Marketplace" section to marketplace-distribution.md with full local test flow (`marketplace add` → `install` → `validate` → verify skills), known issues (name collision, `$schema` validation), and update workflow.
- **Marketplace README** — rewrote marketplace branch README as a developer-facing landing page with two-step install, skill descriptions, and architecture link.
- **Main README** — added "Claude Plugin Marketplace" section with install commands and links to marketplace branch and distribution guide.
- **Distribution skill** — added local marketplace testing subsection with commands and known-issue notes.

### Changed
- **Publish workflow** — added marketplace publish step to CI; stable tags push to `claude-marketplace` branch, RC tags push to `claude-marketplace-next`.
- **Pre-publish checks** — added marketplace dry-run validation (Check 12) to catch build/changelog issues before any npm mutations.

## [0.1.22] - 2026-04-01

### Added
- `vat claude org info` — org identity from Admin API (`/v1/organizations/me`).
- `vat claude org users list/get` — list and retrieve org members.
- `vat claude org invites list` — list pending and accepted invitations.
- `vat claude org workspaces list/get` — list and retrieve API workspaces.
- `vat claude org workspaces members list` — list workspace members.
- `vat claude org api-keys list` — inventory of org API keys with status and workspace scope.
- `vat claude org usage` — daily token usage report (model/workspace/key breakdown); autopaginates by advancing `starting_at`.
- `vat claude org cost` — USD cost report; `amount` field is string decimal. Valid `group_by[]` values: `description`, `workspace`.
- `vat claude org code-analytics` — Claude Code productivity metrics; `starting_at` is date-only `YYYY-MM-DD`.
- `vat claude org skills list` — workspace-scoped skills from `/v1/skills` (beta); skill IDs are slugs not UUIDs.
- `vat claude org skills install <source>` — upload a built skill directory or ZIP to the organization via Skills API (`POST /v1/skills`). Reads `display_title` from SKILL.md frontmatter; `--title` to override. Supports `--from-npm <pkg>@<version>` to download and upload all skills from an npm package (with optional `--skill <name>` filter).
- `vat claude org skills delete <skill-id>` — delete a skill from the organization via Skills API (`DELETE /v1/skills/{id}`).
- `OrgApiClient.uploadSkill()` / `OrgApiClient.deleteSkill()` — programmatic multipart upload and delete for Skills API.
- `buildMultipartFormData()` — zero-dependency multipart/form-data builder exported from `@vibe-agent-toolkit/claude-marketplace`.
- `vat claude org skills versions list <skill-id>` — list all versions of a skill.
- `vat claude org skills versions delete <skill-id> <version>` — delete a specific skill version (required before deleting the skill itself).
- `OrgApiClient.deleteSkillVersion()` — programmatic version deletion for Skills API.
- All other mutating org commands (`users update/remove`, `invites create/delete`, `workspaces create/archive`, `api-keys update`) return structured `not-yet-implemented` stubs.
- All `vat claude org` commands require `ANTHROPIC_ADMIN_API_KEY`; `org skills` commands require `ANTHROPIC_API_KEY`.
- `vibe-agent-toolkit:org-admin` skill — documents OrgApiClient programmatic API, CLI commands, report pagination quirks, and common recipes (cost summaries, API key audits, invite tracking).

### Fixed
- **Plugin version in plugin.json** — `vat claude plugin build` now includes `version` from package.json in generated plugin.json. Without it, Claude Code caches plugins under an `unknown/` directory, causing stale skill resolution across version upgrades.
- **`PLUGIN_MISSING_VERSION` audit check** — `vat audit` now warns when a plugin's plugin.json is missing the `version` field, explaining the stale cache impact.
- **Semver pre-release in plugin.json schema** — version field now accepts pre-release suffixes (e.g., `1.0.0-rc.3`) in addition to strict semver.
- **System test isolation** — `fakeHomeEnv()` now overrides `CLAUDE_CONFIG_DIR` to prevent shell-level environment variables from leaking into spawned test processes. Fixes false test failures when `CLAUDE_CONFIG_DIR` is set in the developer's shell.
- **`unknown_link` false positives** — `vat resources validate` no longer reports `unknown_link` errors for changelog headings (`## [Unreleased]`, `## [0.1.0] - 2026-01-01`) or bare filenames with extensions (`config.schema.json`, `image.png`). Unresolved `linkReference` nodes are now skipped, and bare filenames are classified as `local_file`.
- **Collection matching in dot-directories** — picomatch `**` globs now match paths containing dot-directory segments (e.g., `.claude/worktrees/`). Previously, collection validation silently returned 0 matches when the project path included a dotfile directory.
## [0.1.21] - 2026-03-31

### Breaking Changes
- **`vat skills install` removed** — replaced by `vat claude plugin install`. Update postinstall scripts to use `vat claude plugin install --npm-postinstall || exit 0` and add `vibe-agent-toolkit` to your package's `dependencies` (runtime, not devDependencies) so that `vat` is available via `./node_modules/.bin/` during postinstall.
- **`vat skills uninstall` removed** — replaced by `vat claude plugin uninstall`.
- **`vat claude build` replaced** — superseded by `vat claude plugin build` (same function, new location under the plugin command group). `vat build` now runs both `skills` and `claude` phases automatically; no separate step needed.
- **`vat claude verify` removed** — use `vat verify` (config-driven top-level command).
- **`vat-development-agents` plugin renamed to `vibe-agent-toolkit`** — the installed plugin name changes. Skill short names also updated: `agent-authoring` → `authoring`, `skills-distribution` → `distribution`, `install-architecture` → `install`. Installed skill IDs are now `vibe-agent-toolkit:authoring`, `vibe-agent-toolkit:distribution`, etc.

### Added
- `vat claude plugin install` — installs skill packages into Claude Code. Accepts `--target code|api.anthropic.com|claude.ai` (`code` is default; `claude.ai` returns a structured not-available stub). Correct postinstall pattern uses the local `node_modules` binary, never assumes a global `vat`.
- `vat claude plugin build` — generates `dist/.claude/plugins/marketplaces/` from `dist/skills/` and `vibe-agent-toolkit.config.yaml`. Cleans stale output before each build. Replaces `vat claude build`; now runs automatically as the `claude` phase of `vat build`.
- `vat claude plugin list` — lists installed plugins from the plugin registry and legacy skills directory.
- `vat claude plugin uninstall` — removes a plugin and all 5 install artifacts (marketplace dir, cache dir, `installed_plugins.json`, `known_marketplaces.json`, `settings.json`). Idempotent; `--all` finds plugins by npm package name; `--dry-run` previews without changes.
- **`vat build` now runs `skills → claude` phases** — full pipeline in one command; `claude` phase skipped automatically if no `claude.marketplaces` config is present.
- **`vat claude plugin install --dev` uses plugin tree symlinks** — skills appear as `{plugin}:{skill}` in Claude Code (e.g. `vibe-agent-toolkit:authoring`) instead of flat names. Requires `vat build` first. Gracefully rejects on Windows with a clear error.
- `vat-development-agents` self-adoption: postinstall now uses `vat claude plugin install --npm-postinstall` via `.bin/vat` (no path guessing, no global `vat` assumption).
- **`CLAUDE_CONFIG_DIR` env var support** — `getClaudeUserPaths()` now respects `CLAUDE_CONFIG_DIR` to override the default `~/.claude` location. Enables multiple Claude installations and non-standard config paths.

### Fixed
-**`vat skills build` cleans `dist/skills/` before rebuilding** — stale skill directories from renamed or removed skills no longer accumulate between builds.
- **`@next` dist-tag now updated on stable npm releases** — `publish.yml` now runs `determine-publish-tags.ts` to compute `update_next` and passes it to `publish-with-rollback.ts` via `UPDATE_NEXT` env; `publish-with-rollback.ts` now has a Phase 2 that applies `npm dist-tag add <pkg>@<version> next` to all packages when `UPDATE_NEXT=true`, with rollback on failure

## [0.1.20] - 2026-03-26

### Fixed
- **Plugin reinstall now removes stale skills** — reinstalling a plugin package that has fewer skills than the previous version no longer leaves orphaned skill directories in the Claude installation; the marketplace directory is fully replaced on each install rather than merged additively

## [0.1.19] - 2026-03-23

### Fixed
- **Audit: resolve URL-encoded paths in skill link traversal** — `vat audit` now correctly resolves `%20`, `%26`, and other percent-encoded characters in markdown link paths during skill link traversal; previously reported false `LINK_INTEGRITY_BROKEN` errors for files in directories with spaces or special characters (e.g., SharePoint-synced folders)

### Changed
- **Shared `resolveLocalHref` utility** — extracted common href → filesystem path resolution (anchor stripping, URL-decoding, relative path resolution) into `@vibe-agent-toolkit/resources` so both the audit and validate code paths use a single implementation

## [0.1.18] - 2026-03-20

### Added
- **`success` boolean on `SafeExecResult`** — convenience field (`success: exitCode === 0`) for cleaner conditional checks in callers of `safeExecSync()` and `safeExec()`

## [0.1.17] - 2026-03-20

### Fixed
- **Link validator: resolve percent-encoded paths** (fixes #59) — `%20` and other URL-encoded characters in markdown link paths are now decoded before filesystem resolution; bare relative paths with slashes (e.g., `files/doc.pdf`) are correctly classified as `local_file` instead of `unknown`
- **Windows Node.js v24+ compatibility** — fixed `ERR_UNSUPPORTED_ESM_URL_SCHEME` when running `vat` on Windows with Node.js v24, where bare absolute paths require `file://` URLs for dynamic imports

### Breaking Changes
- **Redesigned skill config and plugin distribution** (PR #55) — `vat.skills[]` in package.json is now an array of skill name strings (not objects); all config lives in `vibe-agent-toolkit.config.yaml`
  - `dist/.claude/` directory structure now mirrors `~/.claude/plugins/` directly — plugin install is a recursive copy, no manifest parsing needed
  - New `PluginJsonSchema` (strict: `name`, `description`, `author` only)
  - Removed `MarketplaceSchema`, `marketplace-validator.ts`, and all related code

### Added
- **marketplace.json build, validate, and audit** (PR #57) — full marketplace manifest lifecycle
  - `MarketplaceManifestSchema` in agent-skills with passthrough for all official source types (string, github, url, npm, pip)
  - `validateMarketplace()` validator mirroring the plugin-validator pattern
  - `vat claude build` now generates `.claude-plugin/marketplace.json` with relative source paths
  - `vat claude verify` validates marketplace.json against the schema
  - Unified validator routes marketplace type to `validateMarketplace()` (replaces placeholder UNKNOWN_FORMAT error)
  - `vat audit --user` now correctly validates marketplace directories
  - Plugin `description` is now optional in VAT project config (adopter compatibility)
  - Added marketplace-level `skills` selector to config schema
- **Transitive link traversal for `vat audit`** (PR #56) — follows all local file links from SKILL.md via BFS with cycle detection
  - Reports broken links (`LINK_INTEGRITY_BROKEN` error), boundary escapes (`OUTSIDE_PROJECT_BOUNDARY` warning), and unreferenced markdown files (`SKILL_UNREFERENCED_FILE` info with `--warn-unreferenced-files`)
  - Excludes CLAUDE.md, README.md, and other navigation files from unreferenced file detection
- **Implicit reference detection** — `extractImplicitReferences()` scans for non-markdown-link file references (backtick-quoted, bold, DOT graphviz, bare prose, `@`-prefix)
  - New `SKILL_IMPLICIT_REFERENCE` issue code for files referenced implicitly but not via `[text](path)` links
  - Reduces false-positive unreferenced file warnings from 18 to 9 when auditing real installed plugins
- **Settings schemas synced with official Claude Code docs** — `vat audit settings` now recognizes ~30 additional fields including sandbox filesystem/network controls, permission modes (`askEdits`, `readOnly`), and managed-only lockdown settings; fixes `autoUpdatesChannel` enum to match the official values (`stable`, `latest`)

## [0.1.15] - 2026-03-02

### Added
- **`vat build` and `vat verify` top-level commands** — orchestrate the full build and verification pipeline in dependency order
  - `vat build`: skills → claude plugins (future: cursor, etc.)
  - `vat verify`: resources → skills → claude artifacts
  - `--only <phase>` flag to run a single phase; `--marketplace <name>` to target a specific marketplace
- **`vat claude build`** — generates Claude plugin marketplace artifacts from pre-built skills
  - Reads `claude:` section from `vibe-agent-toolkit.config.yaml`; resolves skill selectors (exact names and globs)
  - Copies pre-built `dist/skills/<name>/` into `dist/plugins/<plugin>/skills/` (no re-bundling)
  - Generates `dist/plugins/<plugin>/.claude-plugin/plugin.json` and `dist/.claude-plugin/marketplace.json`
  - Sanitizes colon-namespaced skill names (e.g. `plugin:skill`) to double-underscore for Windows filesystem safety
- **`vat claude verify`** — validates Claude marketplace and plugin artifacts against schemas
  - Validates `marketplace.json` against `MarketplaceSchema`, `plugin.json` against `ClaudePluginSchema`
  - Validates `managed-settings.json` against `ManagedSettingsSchema` when `claude.managedSettings` is configured
  - Supports both source-layout (`file:`) and build-to-dist patterns
- **`claude:` config section in `vibe-agent-toolkit.config.yaml`** — configure Claude plugin distribution
  - `claude.marketplaces` — named map of marketplace definitions (inline or `file:` source-layout)
  - `claude.managedSettings` — path to managed-settings.json for schema validation
  - Marketplace config: `owner`, `skills` selector (exact or glob), `plugins` grouping, `output` paths
- **Claude plugin registry installer** (`packages/claude-marketplace`) — writes directly to Claude Code's plugin registry
  - Five-step install: copies plugin files to `~/.claude/plugins/marketplaces/` and `cache/`, updates `known_marketplaces.json`, `installed_plugins.json`, and `settings.json enabledPlugins`
  - Called automatically by `vat skills install --npm-postinstall` when `dist/.claude-plugin/marketplace.json` exists
- **`vat skills install` now routes through Claude plugin system** when package ships a plugin
  - If `dist/.claude-plugin/marketplace.json` exists: installs via plugin registry (namespaced, version-tracked)
  - If marketplace.json is absent: emits guidance to run `vat build` and exits 0 (no raw skill install)
  - `--user-install-without-plugin` flag: explicit opt-in to force `~/.claude/skills/` install
- **`vat --cwd <dir>` root flag** — change working directory before any command runs
  - Enables CI pipelines to run `vat build --cwd packages/my-agents` from the monorepo root
- **Marketplace settings schema fields** in `ClaudeSettingsSchema` and `ManagedSettingsSchema`
  - `extraKnownMarketplaces`, `enabledPlugins` added to settings/settings.local
  - `strictKnownMarketplaces` added to managed-settings only
  - `vat audit settings` output gains `marketplaces:` section showing registered marketplaces and enabled plugins
- **`plugin:skill` colon notation in skill names** - Skill names may now include a plugin namespace prefix (e.g., `vibe-agent-toolkit:audit`)
  - Format: `plugin-name:skill-name`; the prefix is the plugin/package namespace, the suffix is the skill's local name
  - Supported in both SKILL.md `name:` frontmatter and `package.json` `vat.skills[].name`
- **`vibe-agent-toolkit` skill package split** - Replaced the 1310-line monolith with an umbrella + 4 focused action skills
  - Umbrella `vibe-agent-toolkit` (~179 lines): concepts, archetypes overview, routing table, CLI quick reference
  - `vibe-agent-toolkit:resources` — resource collections, per-directory schema validation, `vat resources` commands
  - `vibe-agent-toolkit:distribution` — packaging, `--target claude-web`, `vat install`, npm and private distribution
  - `vibe-agent-toolkit:agent-authoring` — SKILL.md authoring, 4 archetypes with examples, packaging options reference
  - `vibe-agent-toolkit:audit` — `vat audit` flags, auto-detection table, `--compat` output, CI usage patterns
- **`vat audit --exclude <glob>`** - Filter paths from recursive scans (repeatable flag)
  - Example: `vat audit plugins/ --exclude "dist/**" --exclude "node_modules/**"`
  - Prunes directory traversal early for performance; does not just filter output
- **Unified `vat install` command** - Single command for installing any VAT resource type
  - Auto-detects resource type from source: `SKILL.md` → agent-skill, `.claude-plugin/plugin.json` → claude-plugin, `.claude-plugin/marketplace.json` → claude-marketplace
  - Routes to the correct `~/.claude/` subdirectory automatically
  - Flags: `--type` (explicit override), `--force`, `--dry-run`; YAML output includes `sourceType` field
  - `vat skills install` remains as an alias constrained to agent skills only
- **`vat audit --compat`** - Per-surface compatibility analysis for plugins and skills
  - Reports compatibility with `claude-code`, `cowork`, and `claude-desktop` surfaces with supporting evidence
  - Detects Python scripts, bash hooks, sqlite dependencies, and other surface-specific constraints
  - Works in both path mode and `--user` mode; combinable with recursive scanning for full marketplace matrices
- **`vat skills package --target <target>`** - Target-specific packaging for Claude.ai web upload
  - `--target claude-web` produces a ZIP with `references/` instead of `resources/`, matching the Claude.ai web upload spec
  - `--target claude-code` (default) preserves existing behavior unchanged
  - ZIP size validation for `claude-web`: warn at 4MB, error at 8MB

### Changed
- **`vat audit` is recursive by default** (**BREAKING**) - `vat audit <path>` now walks the full directory tree automatically
  - `--recursive` / `-r` flag removed; use `--no-recursive` to scan the top-level directory only
  - `--user` behavior unchanged: scans `~/.claude/` directories, exit code remains 0 (informational)
- **`CLAUDE.md` documentation additions** - Resource collections and licensing conventions added to the contributor guide
  - Resource collections: per-directory schema validation config, `permissive` vs `strict` modes, `vat resources validate` usage
  - Licensing conventions: table for open source / proprietary / not-yet-licensed packages with enterprise LICENSE template

## [0.1.14] - 2026-02-11

### Added
- **Content transform pipeline** - Shared `transformContent()` engine in `@vibe-agent-toolkit/resources` for rewriting markdown links before persistence
  - `LinkRewriteRule[]` configuration with match criteria (type, glob pattern, excludeResourceIds) and Handlebars templates
  - Template variables: `{{link.text}}`, `{{link.href}}`, `{{link.fragment}}`, `{{link.resource.*}}` (id, filePath, extension, mimeType, sizeBytes, estimatedTokenCount, frontmatter.*)
  - Consumer context variables for skill/project-specific data (e.g., `{{skill.name}}`, `{{kb.baseUrl}}`)
  - `ResourceLookup` interface decouples transform from full ResourceRegistry
  - First-match-wins rule ordering; unmatched links preserved as-is
- **Full document storage** (`rag_documents` table) - Optional `storeDocuments: true` config on LanceDB RAG provider
  - Stores complete document content alongside vector chunks for retrieval after search
  - `getDocument(resourceId)` returns full content, metadata, token count, chunk count, and indexing timestamp
  - Content transforms applied to stored documents
  - Incremental updates: changed content updates the document record
  - Cascading deletes: `deleteResource()` removes both chunks and document record
  - `DocumentResult` interface added to `@vibe-agent-toolkit/rag` provider interfaces
- **Content transform support in RAG indexing** - `contentTransform` option on LanceDB provider rewrites links before chunking
  - Content hash computed on transformed output for accurate change detection
  - Re-indexes automatically when transform rules change
- **OnnxEmbeddingProvider** - Local ONNX-based embedding generation (#45)
  - Makes `@lancedb/vectordb` and `onnxruntime-node` optional peer dependencies
  - Falls back gracefully when native dependencies unavailable

### Fixed
- **tokenCount in enrichChunks** - `tokenCount` field now populated on enriched chunks; chunk position metadata (`chunkIndex`, `totalChunks`, `isFirstChunk`, `isLastChunk`) added (#46)
- **Custom metadata overwriting core chunk fields** - `chunkToLanceRow()` now spreads metadata before core fields so `chunkIndex`, `totalChunks`, and other core columns cannot be overwritten by user-defined metadata schemas with colliding names
- **Path-relative resource IDs** - `ResourceRegistry` generates IDs relative to `baseDir` (e.g., `docs-guide` instead of `guide`), preventing collisions for same-named files in different directories

## [0.1.13] - 2026-02-10

### Added
- **Skills development install** (`vat skills install --dev`) - Symlink-based installation reads `vat.skills[]` from `package.json` and symlinks built skills into `~/.claude/skills/`
  - After rebuild, skills update immediately (no re-install needed)
  - `--build` flag auto-runs `vat skills build` before symlinking
  - `--name` flag to install a specific skill from multi-skill packages
  - `--force` to overwrite existing installations
  - `--dry-run` to preview without creating symlinks
- **Skills uninstall** (`vat skills uninstall <name>`) - Remove installed skills (directories or symlinks)
  - `--all` flag reads `package.json` and removes all declared skills
  - `--dry-run` to preview without removing
  - Reports `wasSymlink` in YAML output for each removed skill
- **MCP test client harness** - Reusable `MCPTestClient` class for reliable MCP server testing
  - Waits for server readiness signal before sending requests (eliminates race conditions)
  - Auto-incrementing request IDs with ID-based promise resolution
  - Graceful shutdown with SIGTERM/SIGKILL fallback

### Fixed
- **npm install installs ALL skills** - `vat skills install <npm-package>` now installs all skills from multi-skill packages instead of only the first one
- **Broken symlink detection** - `vat skills install --force` now correctly detects and removes broken symlinks using `lstatSync` instead of `existsSync`
- **MCP test reliability** - Replaced timing-based test approach with readiness-signal pattern; tests now complete in ~600ms instead of flaking at 2-3.5s

## [0.1.12] - 2026-02-10

### Added
- **External URL validation with caching** (#41)
  - Optional external URL validation via `--check-external-urls` flag
  - Filesystem-based cache with TTLs (24h alive, 1h dead)
  - Per-collection configuration for timeout, retry, ignore patterns
  - New issue types: `external_url_dead`, `external_url_timeout`, `external_url_error`
  - Cache stored in `.vat-cache/external-urls.json`
  - Uses `markdown-link-check` library for robust HTTP checking
- **Link Depth Control for Skills** - Control how deep to follow markdown links during skill packaging
  - `linkFollowDepth` in `packagingOptions`: `0` (skill only), `1` (direct links), `2` (default), `N`, or `"full"` (unlimited)
  - Prevents transitive link explosion in large knowledge bases (e.g., 493 files → ~10 files with depth 1)
- **Rule-Based Link Exclusion** - Selectively exclude files from bundles with per-pattern link rewriting
  - `excludeReferencesFromBundle` with ordered rules: each rule specifies glob patterns and optional Handlebars template
  - `defaultTemplate` for depth-boundary links that don't match explicit rules (default: `"{{link.text}}"`)
  - Template variables: `{{link.text}}`, `{{link.href}}`, `{{link.fragment}}`, `{{link.type}}`, `{{link.resource.id}}`, `{{link.resource.fileName}}`, `{{link.resource.relativePath}}`, `{{skill.name}}`
  - No dead links in output: every non-bundled link target is rewritten per its matched template
- **Resource Naming Strategies for Skills** - Flexible control over packaged resource file naming
  - Three strategies: `basename` (default, simple), `resource-id` (flatten to kebab-case), `preserve-path` (maintain directory structure)
  - Universal `stripPrefix` option removes path prefixes before applying naming strategy
  - Filename collision detection prevents duplicate names in flat output
  - Configure via `packagingOptions` in skill metadata (package.json `vat.skills[]`)
- **Non-Markdown Asset Bundling** - JSON schemas, images, and other non-markdown files linked from bundled markdown are now included in skill packages
- **Handlebars Template Utility** - Shared template rendering in `@vibe-agent-toolkit/utils` with compiled template caching
- **Directory Link Detection** - Links targeting directories now produce actionable validation errors suggesting README.md/index.md alternatives (previously crashed with ENOTSUP)
- **Expanded Validation Metadata** - `directFileCount`, `excludedReferenceCount`, and `excludedReferences` in validation results
  - `--verbose` flag on `vat skills validate` shows excluded reference details with reason (`depth-exceeded` / `pattern-matched`) and matched pattern
- **Packaging Options Documentation** - Comprehensive reference in VAT SKILL.md covering linkFollowDepth, resourceNaming, excludeReferencesFromBundle, and ignoreValidationErrors

### Changed
- **Default link follow depth is now 2** (was unlimited). Use `linkFollowDepth: "full"` to restore unlimited behavior.
- `LINK_TARGETS_DIRECTORY` validation is now overridable (transitively-bundled docs may contain directory links the skill author cannot control)

### Improved
- **Navigation file errors** now include full resolved paths and line numbers (not just basename)
- **Depth terminology** clarified as "link-chain hops" instead of misleading "levels deep"

### Internal
- **npm link reliability** - Topological sort, `--install-strategy=shallow`, and retry logic for workspace package linking

## [0.1.11] - 2026-02-09

**Note:** Version 0.1.10 was deprecated due to incomplete publish (phantom package in publish list caused partial release).

### Performance
- **Discovery Scan: 540x Faster** - File discovery now completes in ~0.5 seconds instead of 5+ minutes
  - Added `PERFORMANCE_POISON` patterns to exclude `.git`, `node_modules`, and `coverage` directories
  - Batch git-ignore checking reduces 794 subprocess calls to 1 (`git check-ignore --stdin`)
  - Skills list command that previously timed out now completes in seconds
- **Skills Validation: 12x Faster** - Validation improved from 13.5s to 1.13s
  - Introduced `GitTracker` to cache git-ignore checks across validations
  - Eliminates 174 redundant git subprocess calls during link validation
  - Pre-populates cache from `git ls-files` for instant lookups

### Fixed
- **LanceDB Database Size** - `getStats()` now accurately reports database disk usage
  - Previously always showed "0.00 MB" regardless of actual size
  - Implements recursive directory traversal to calculate true size in bytes
  - Helps users monitor disk usage and verify successful index builds
- **Phantom Package Validation** - Pre-publish check now catches packages declared but not existing
  - Previously only checked for undeclared packages (exist but not in lists)
  - Now validates both directions: undeclared packages AND phantom packages
  - Prevents publish failures from stale package list entries
  - Root cause of 0.1.10 publish failure

### Changed
- **Test Suite Reorganization**: Separated integration tests from unit tests for faster development feedback
  - Moved 15 integration tests (testing file I/O, git, databases, ML models) to separate test phase
  - Unit test execution time improved from 121s to 27-41s (63% faster)
  - Integration tests run separately in ~34-38s
  - Coverage thresholds adjusted to reflect unit test reality: 70% for project coverage, 80% for new code (patches)
  - Clearer separation enables faster development iteration and better CI parallelization

### Internal
- **Turborepo Integration**: Build orchestration with intelligent caching and parallel execution
- **Circular Dependency Resolution**: Removed circular dependencies between packages for cleaner architecture
- **Shared Test Infrastructure**: `@vibe-agent-toolkit/test-agents` package for consistent testing across runtime adapters
- **Test Parallelism**: Adaptive test parallelism with `availableParallelism()` for 2x dev speedup

## [0.1.9] - 2026-02-07

- **Resource Compiler** (`@vibe-agent-toolkit/resource-compiler`) - Compile markdown to TypeScript with full IDE support
  - Direct `.md` imports in TypeScript with type safety
  - H2 headings become typed fragment properties for granular access
  - Frontmatter parsing to typed objects
  - IDE autocomplete, go-to-definition, and hover tooltips
  - `vat-compile-resources` CLI: compile markdown to JS/TS modules
  - TypeScript Language Service Plugin for seamless `.md` imports
  - Build integration: copy generated resources to dist during build
  - Dog-fooded in vat-example-cat-agents package

- **VAT Distribution Standard** - Package-based skill distribution with build and install infrastructure
  - `vat skills build` command: Builds skills from source into `dist/skills/` during package build
  - `vat skills install` command: Smart installation from npm packages, local directories, or zip files
  - Package.json `vat` metadata convention for declaring skills, agents, pure functions, and runtimes
  - Automatic skill installation via npm postinstall hooks
  - Two distributable skills:
    - `vibe-agent-toolkit`: User adoption guide for VAT CLI and agent creation (from vat-development-agents)
    - `vat-example-cat-agents`: Orchestration guide for 8 example cat agents (from vat-example-cat-agents)
  - See [Distributing VAT Skills Guide](./docs/guides/distributing-vat-skills.md) for usage

- **Audit Misconfiguration Detection** - `vat audit` now detects misconfigured standalone skills
  - Identifies standalone SKILL.md files in ~/.claude/plugins/ that won't be recognized by Claude Code
  - Error code: SKILL_MISCONFIGURED_LOCATION with actionable fix suggestions
  - Helps users correct common installation mistakes

- `--user` flag for `vat skills validate` to validate installed user skills
- Shared utilities: claude-paths, skill-discovery, user-context-scanner, config-loader
- Case-insensitive skill discovery (finds malformed SKILL.md variations)

### Changed
- **BREAKING**: `vat skills list` now defaults to project skills (use `--user` for installed skills)
- **Plugin Schema Updated to Official Claude Code Spec** - Updated ClaudePluginSchema to match official documentation
  - Made `description` and `version` optional (only `name` required if manifest exists)
  - Added component path fields: `commands`, `skills`, `agents`, `hooks`, `mcpServers`, `outputStyles`, `lspServers`
  - Renamed types for clarity: `PluginSchema` → `ClaudePluginSchema`, `Plugin` → `ClaudePlugin`
  - Updated plugin-validator to handle optional version field with exactOptionalPropertyTypes
  - Tests updated to validate actual errors instead of missing optional fields
- **CLI Dependency Cleanup** - Removed example agent packages from automatic installation
  - Removed `@vibe-agent-toolkit/vat-example-cat-agents` from CLI dependencies
  - Added `@vibe-agent-toolkit/vat-development-agents` to CLI dependencies
  - Added comment warning against adding example packages to CLI dependencies
  - Example agents now opt-in via separate `npm install -g @vibe-agent-toolkit/vat-example-cat-agents`
- **Skill Naming Consistency** - Skill names now match package names
  - `vat-example-cat-agents` skill renamed from `cat-agents-skill` for consistency
- Refactored `vat skills validate` to use shared utilities and respect resource config boundaries
- Refactored `vat skills list` to use shared utilities

### Fixed
- **RAG Metadata Filtering**: Now works correctly regardless of which Zod version (v3 or v4) you have installed
  - Previously: Metadata filters returned 0 results if your Zod version differed from the library's
  - Now: Automatically detects and works with both Zod v3.25.0+ and v4.0.0+
  - No code changes required - filtering just works
- **RAG Line Number Tracking**: Chunks now preserve exact line ranges from source documents
  - Previously all chunks from the same section had identical line numbers
  - Fixed off-by-one error in line position calculation (1-based to 0-based conversion)
  - Properly flattens nested heading hierarchy during section extraction
  - Handles large paragraphs by splitting into line-level chunks
  - Enables accurate IDE navigation and source citations
- **BREAKING CHANGE**: RAG database column names are now lowercase (SQL standard)
  - Existing LanceDB indexes must be rebuilt - run `await provider.clear()` then re-index
  - Your code doesn't change - still use camelCase in queries: `{ metadata: { contentType: 'docs' } }`
  - Why: Prevents case-sensitivity issues, no quotes needed in queries, follows SQL conventions
  - See migration guide: `packages/rag-lancedb/README.md#upgrading-from-v018-to-v019`
- Eliminated path duplication across audit, install, and other commands
- `vat audit --user` now finds standalone skills in ~/.claude/skills

### Added
- **RAG Similarity Scores**: Search results now include confidence scores (0-1, higher is better)
  - Filter results by confidence threshold
  - Compare result relevance
  - Build smarter retrieval logic
- **RAG Progress Tracking**: See real-time progress when building large indexes
  - Shows resources indexed, chunks created, time elapsed/remaining
  - Add progress bars to your CLI tools
  - Monitor long-running index builds
- **Accurate Line Numbers**: Chunks now track exact line ranges in source files
  - Jump directly to source in your IDE
  - Show precise code citations
  - Build better documentation tools

### Internal
- Deleted obsolete skill-finder.ts (replaced by skill-discovery.ts)
- Removed registry tracking from skills install command (architectural simplification)
- Preserved audit.ts custom scanning logic (architectural decision for independence)

## [0.1.8] - 2026-02-06

### Fixed
- **RAG Metadata Filtering at Scale**: Fixed metadata filtering returning empty results on production-scale indexes (>1000 chunks)
  - Root cause: LanceDB struct column access (`metadata['field']`) doesn't scale
  - Solution: Store metadata as top-level columns with direct access (`` `field` ``)
  - All metadata fields now stored as top-level LanceDB columns instead of nested struct
  - Filter builder updated to use direct column access for efficient queries
  - Added system test validating metadata filtering with flattened schema
  - Fixes issue reported by an adopter project (753 docs, 4,321 chunks)

### Changed
- **BREAKING CHANGE**: Existing LanceDB indexes must be rebuilt
  - Metadata storage format changed from nested struct to top-level columns
  - Run `await ragProvider.clear()` then re-index resources
  - API remains backward compatible - no code changes required beyond index rebuild
  - See migration guide in `packages/rag-lancedb/README.md`

## [0.1.7] - 2026-02-05

### Added
- **RAG Extensible Metadata Schema Support**: Custom metadata fields with full type safety
  - Generic provider interfaces with `TMetadata` type parameter for compile-time type safety
  - Zod schema introspection for automatic serialization/deserialization
  - Support for arrays (CSV), objects (JSON), dates (timestamps), and primitives
  - Type-safe query filtering on custom metadata fields
  - `DefaultRAGMetadata` schema with standard fields (tags, title, description, category)
  - See `packages/rag-lancedb/README.md` for usage examples

## [0.1.6] - 2026-02-04

### Fixed
- Umbrella package now works with `npx vibe-agent-toolkit` by adding ESM type declaration
- Version output now shows project root for local installs instead of "unknown"

## [0.1.5] - 2026-02-04

### Fixed
- CLI now works correctly with `npx` commands in CI environments without global installation
- Link validation detects case mismatches in filenames, preventing failures on case-sensitive filesystems (Linux)

## [0.1.4] - 2026-02-03

### Added
- **Multi-Collection Resource Validation System**: Comprehensive resource type system with frontmatter validation
  - Multi-collection support via `vibe-agent-toolkit.config.yaml` with pattern resolution
  - Per-collection frontmatter validation with JSON Schema
  - Validation modes: strict vs permissive
  - Collection filtering via `--collection <id>` flag in scan/validate commands
  - Format options: `--format yaml|json|text` for structured or human-readable output
  - Package-based schema references (e.g., `@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json`)
  - Enhanced validation error messages with actual/expected values
  - Enhanced `vat doctor` command validates config file schema and checks schema file existence
- **Agent Skills Package Rename**: `@vibe-agent-toolkit/runtime-claude-skills` → `@vibe-agent-toolkit/agent-skills`
  - Exported JSON schemas: `skill-frontmatter.json` and `vat-skill-frontmatter.json`

### Changed
- **Output Format Improvements**: Enhanced validation and scan output
  - Added error summary by type
  - Added per-collection error tracking (filesWithErrors, errorCount)
  - Simplified scan output with `--verbose` flag for file details
  - Errors grouped by file in structured output (YAML/JSON)

## [0.1.3] - 2026-02-01

### Added
- **Frontmatter Validation**: Parse and validate YAML frontmatter in markdown files
  - CLI flag `--frontmatter-schema` for `vat resources validate` to validate against JSON Schema
  - Reports YAML syntax errors and schema validation failures
  - `ResourceMetadata` includes parsed frontmatter data when present

## [0.1.2] - 2026-01-30

### Added
- **Session Management System**: Pluggable session persistence for stateful agents
  - `RuntimeSession<TState>` type with id, history, state, and metadata
  - `SessionStore<TState>` interface for pluggable persistence strategies
  - `MemorySessionStore` - in-memory sessions with TTL support and sliding window expiration
  - `FileSessionStore` - file-based persistence in `~/.vat-sessions/` (runtime-agnostic)
  - CLI transport integration with `--session-store` and `--session-id` flags
  - Session management commands: `/clear` (or `/restart`), `/state`
  - Commands shown upfront in CLI welcome message for better UX
  - Conversational demo supports session resumption across restarts
  - Session helpers: `validateSessionId`, `createInitialSession`, `updateSessionAccess`, `isSessionExpired`
  - Reusable test helpers to eliminate duplication across store implementations
- **Audit Command Enhancements**: Comprehensive validation of Claude skills
  - Transitive link validation - recursively follows and validates all linked markdown files
  - Unreferenced file detection with `--check-unreferenced` flag
  - BFS traversal to discover entire skill structure
  - Comprehensive statistics for all files in skill
  - Handles circular references gracefully
- **MCP Gateway**: Expose VAT agents through Model Context Protocol (`@vibe-agent-toolkit/gateway-mcp`)
  - Stdio transport for Claude Desktop integration
  - Stateless agent support (Pure Function Tools, One-Shot LLM Analyzers)
  - Multi-agent server support (expose multiple agents through single gateway)
  - Runtime-agnostic architecture with adapter pattern
  - Observability hooks (console logger, OpenTelemetry-aligned interfaces)
  - Error classification (retryable vs non-retryable)
  - Complete documentation and examples (haiku-validator, photo-analyzer, combined server)
  - Integration and system tests
- **Agent Runtime Architecture**: Core VAT agent archetype system
  - Pure function agents: Deterministic, synchronous tools
  - LLM analyzer agents: AI-powered analysis with structured I/O
  - Function orchestrator, event consumer, agentic researcher, conversational assistant archetypes
  - Provider-agnostic LLM integration via context.callLLM()
  - Shared validation and execution wrappers
- **Example Cat Agents**: Comprehensive agent examples for testing
  - Haiku generator/validator, name generator/validator
  - Photo analyzer, description parser
  - Human approval workflow
- **Runtime Adapters**: Convert VAT agents to framework-specific formats
  - `@vibe-agent-toolkit/runtime-vercel-ai-sdk`: Vercel AI SDK tools and functions
  - `@vibe-agent-toolkit/runtime-langchain`: LangChain DynamicStructuredTool
  - `@vibe-agent-toolkit/runtime-openai`: OpenAI function calling tools
  - `@vibe-agent-toolkit/runtime-claude-agent-sdk`: Claude Agent SDK MCP tools
  - All support both pure function and LLM analyzer archetypes
  - Multi-provider demos (Anthropic Claude, OpenAI GPT)
- **Shared Test Factories**: Zero-duplication test infrastructure in dev-tools
  - `createPureFunctionTestSuite()` and `createLLMAnalyzerTestSuite()` factories
  - Consistent testing across all runtime adapters
  - Runtime-specific behavior through config interfaces
- **Common Demo Infrastructure**: Runtime-agnostic demo framework
  - Single demo implementation works with any runtime adapter
  - Demonstrates agent portability across frameworks
  - Multi-provider comparison support
- **Documentation**: Guide for adding new runtime adapters
  - Package structure and configuration patterns
  - Adapter implementation best practices
  - Testing with shared factories
  - Validation checklist and common pitfalls
- **Result Constructors Re-exported**: Convenience exports from `@vibe-agent-toolkit/agent-runtime`
  - `createSuccess`, `createError`, `createInProgress`
  - Error constants: `LLM_REFUSAL`, `LLM_INVALID_OUTPUT`, `LLM_TIMEOUT`, etc.
  - All result types and metadata types re-exported for single-package convenience

### Changed
- Upgraded vibe-validate from 0.18.2-rc.1 to 0.18.4-rc.1 (fixes caching bug)
- Migrated from deprecated `vectordb@0.4.20` to `@lancedb/lancedb@0.23.0`
  - Resolves Bun compatibility issues with Apache Arrow
  - Changed nullable number fields to use -1 sentinel values instead of null
  - API changes: `search().execute()` → `vectorSearch().toArray()`, `filter().execute()` → `query().where().toArray()`
- Updated OpenAI SDK from 4.67.0 to 6.16.0 (resolves node-domexception deprecation warnings)
- **BREAKING: Pure Function Agent API Simplified** - Consolidated to single `definePureFunction` API
  - **Removed**: `createPureFunctionAgent` and `createSafePureFunctionAgent` (use `definePureFunction` instead)
  - **API Change**: Agents now return output directly (unwrapped) instead of `OneShotAgentOutput` envelopes
  - **API Change**: Pure function agents are now synchronous (`execute(input): TOutput`) instead of async
  - **API Change**: Invalid input throws exceptions instead of returning error envelopes
  - **API Change**: Handler function receives validated input, returns output directly (no manual wrapping)
  - **Archetype renamed**: `pure-function-tool` → `pure-function` for consistency
  - **Migration Path**: Replace `createPureFunctionAgent((input) => createSuccess(output), manifest)` with `definePureFunction(config, (input) => output)`
  - **Runtime adapters updated**: All four runtime packages handle new unwrapped API
  - **Documentation updated**: `docs/agent-authoring.md` shows only `definePureFunction` pattern

## [0.1.1] - 2026-01-12

### Added
- **`vat doctor` Diagnostic Command**: System health checks and troubleshooting
  - Validates Node.js, Bun, Git, TypeScript installations
  - Checks database connectivity (LanceDB)
  - Validates configuration files
  - Verifies installation integrity
  - Exit codes: 0 (all checks passed), 1 (issues found), 2 (system errors)
- **Resource Collection System**: Advanced resource querying with checksums
  - Content checksumming for change detection
  - Advanced filtering and querying capabilities
  - Test isolation infrastructure for improved reliability
- **Plugin & Marketplace Audit System** (`vat audit`): Comprehensive plugin ecosystem validation
  - Validates `plugin.json` manifests (name, version, description, metadata)
  - Validates `marketplace.json` with bundled skills, git repos, LSP servers
  - Registry tracking for installed plugins and known marketplaces
  - Cache staleness detection - detects stale cached skills vs installed plugins
  - Compares checksums between cache and source
  - Identifies cache-only and installed-only resources
  - Hierarchical output with cache status indicators (stale/fresh/orphaned)
  - `--verbose` flag for detailed diagnostic output
  - Filter plugin/marketplace results from skill-only scans
  - Performance optimizations for large plugin collections

## [0.1.0] - 2026-01-04

### Added
- **Publishing System**: Automated npm publishing with rollback safety
  - `validate-version`: Ensures all packages have unified version
  - `publish-with-rollback`: Publishes 11 packages in dependency order with automatic rollback/deprecation on failure
  - `extract-changelog`: Extracts version-specific changelog for GitHub releases
  - GitHub Actions workflow triggered by version tags (v*)
  - Smart npm dist-tag handling: RC versions → @next, stable versions → @latest
  - Manifest tracking for publish progress and rollback capability
  - Cross-platform test helpers with security validation
- **Agent Runtime**: Execute agents with `vat agent run <name> "input"` using Anthropic API
- **Agent Discovery**: List all agents in your project with `vat agent list`
- **Agent Validation**: Validate manifests and resources with `vat agent validate <name>`
- **Claude Skills Audit**: Comprehensive validation of Claude Skills with `vat agent audit [path] --recursive`
  - Validates frontmatter fields (name, description, license, compatibility)
  - Enforces naming conventions (lowercase, hyphens, reserved words)
  - Checks link integrity (broken links, Windows paths)
  - Detects console-incompatible tool usage (Write, Edit, Bash)
  - Exit codes: 0 (success), 1 (validation errors), 2 (system errors)
- **Claude Skills Import**: Convert SKILL.md to agent.yaml with `vat agent import <skillPath> [options]`
  - Extracts frontmatter metadata to agent manifest
  - Validates before conversion
  - Supports custom output paths with `--output`
  - Force overwrite with `--force`
- **Claude Skills Packaging**: Build agents as Claude Skills with `vat agent build <name>`
- **Installation Management**: Install/uninstall Claude Skills locally with `vat agent install/uninstall <name>`
- **Installation Scopes**: Control installation location with `--scope user|project`
- **Dev Mode**: Symlink-based development workflow with `--dev` flag
- **Gitignore Support**: File crawler and link validator now respect `.gitignore` patterns
- **RAG System**: Document indexing and semantic search with LanceDB
- New package: `@vibe-agent-toolkit/agent-config` - agent manifest loading and validation
- New package: `@vibe-agent-toolkit/runtime-claude-skills` - Claude Skills builder, installer, validator, and import/export
- New package: `@vibe-agent-toolkit/discovery` - format detection and file scanning utilities
- New documentation: [Agent Skills Best Practices Guide](./docs/guides/agent-skills-best-practices.md)
- New documentation: [Audit Command Reference](./docs/cli/audit.md)
- New documentation: [Import Command Reference](./docs/cli/import.md)
- **Resources System**: Markdown resource scanning and validation of link integrity

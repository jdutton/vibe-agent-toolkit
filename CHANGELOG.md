# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`vat skill test` — transcript-grounded evaluation with a separate executor and grader (issue #145).** Each eval now runs in two roles instead of one self-grading agent: a blind **executor** (the skill under test) performs the eval task and its transcript is captured **in memory**, then a separate **grader** judges that transcript against skill-creator's rubric and emits a per-eval fragment. **vat is the sole writer** of `results/` — it merges the grader fragments into `grading.json`/`friction.json`/`tool-eval.json` after re-verifying a secret per-run nonce carried in each fragment. This is the anti-forgery model: the executor never receives the nonce (it is delivered only via the grader's stdin, never written to disk or an argv), so untrusted skill code running in the shared sandbox cannot **blindly** mint a result vat will accept, forge its own passing grade, or tamper with the transcript (same-uid caveat under **Security**). A grader-side internal failure or a missing/forged nonce aborts the run with the harness-broke exit **1** and is never laundered into a pass/fail verdict.
- **Separate grader model — new `graderModel` config and `--grader-model` flag.** The existing `model` config (and `--model`) now selects the **executor** model; a new `graderModel` (and `--grader-model <id>`, default `claude-sonnet-5`) independently selects the **grader** model, so you can run the skill under one model and grade under a stronger/cheaper one. `--concurrency <n>` bounds how many evals run in parallel (each retrying a rate-limit with backoff).
- **Declared tool-expectations — assert which tools/executables a skill should (and shouldn't) invoke.** An eval may declare a `toolExpectations` block (`mustRun` / `mustNotRun` / `mustSucceed` / `sequence`) in `evals.json`; the grader judges it **from the transcript** (preferring the structured `tool_use`/`tool_result` entries, and recognizing varied launch forms of the same executable — `uv run dxa.py`, `python3 dxa.py`, `./dxa`, `node dist/dxa.mjs` — as the same tool) and emits a tool verdict. vat writes these to a new **`tool-eval.json`** (kept in its own channel — tool verdicts never leak into `grading.json`). To help the grader recognize a skill's own executables, the skill packaging config accepts a `declaredExecutables` manifest (`{ path, kind, howInvoked }`); those flow into the grader prompt as recognition hints (**fenced as untrusted data** — see Security).
- **`mustSucceed` — assert a tool ran *and* succeeded.** `toolExpectations.mustSucceed: [<executable>…]` checks each executable ran **and** its `tool_result` wasn't an error (issue [#148](https://github.com/jdutton/vibe-agent-toolkit/issues/148)). It's judged from the transcript, so a skill that swallows a non-zero exit (`cmd || true`) still reads as succeeded — pair it with an output expectation when you need certainty.
- **Advisory eval-weakness warning.** Before any spend, the harness warns (non-fatally) when an eval's expectations are all presence-only (`"mentions X"`) with no negative check or `toolExpectations` — the pattern that lets a wrong answer pass. Never changes the exit code.
- **Advisory undeclared-executable warning.** Also before any spend, the harness warns (non-fatally) when a `toolExpectations` entry names an executable that looks like a **typo** of one of the skill's `declaredExecutables` (e.g. `dxa-py` when the skill declares `dxa`) — a name that never matches a real tool makes `mustRun`/`mustSucceed`/`sequence` fail for the wrong reason (or `mustNotRun` pass vacuously). Conservative by design: it fires only when there is a specific declared name the reference is probably a typo of (single-edit or separator-decorated), so a deliberate reference to a built-in/system tool (`Bash`, `git`) is never flagged, and it stays silent when the skill declares no executables. Zero-token static check; never changes the exit code. *(Adopter follow-up from the #145 beta.)*
- **Run-wide spend aggregation in the summary.** The summary line now carries a `≈$<total> across <N> sessions` suffix rolling up `total_cost_usd` across every executor **and** grader session — so a `--dry-run`-then-live cadence (pre-release/nightly) has a visible per-run cost to budget against. The suffix is omitted when no session reported a cost (e.g. a mock-spawn test); it rides the verdict line after any `(N tool)` marker, and the fail-fast SKIPPED note stays on its own following line. *(Adopter follow-up from the #145 beta.)*
- **Composite verdict — output + tool expectations, fail-closed.** The reported pass/fail now ANDs the per-expectation output grade with every tool verdict, and the run fails closed (exit **4**) if any of `grading.json`/`friction.json`/`tool-eval.json` is missing, unparseable, or invalid after the merge. The summary suffix names tool failures (e.g. `FAIL 1/1 (1 tool)`).
- **Cost-tiered fail-fast — spend on cheap evals first.** Evals may declare a numeric `tier`; the harness runs ascending tiers (cheapest first), bounded-parallel within a tier, and **gates between tiers** — once a cheaper tier fails a gating expectation the higher (more expensive) tiers are **SKIPPED**, never graded and never counted as passed. A fail-fast-gated run is an eval failure (exit **4**), and the summary names the skipped tier and eval count.

- **`vat skill test run --evals <path>` — grade a skill against an eval suite outside its own tree (issue [#163](https://github.com/jdutton/vibe-agent-toolkit/issues/163)).** This is the missing half of a feature that already shipped: `npm:`/`url:`/`vendored` subjects have always been testable, but suite lookup only ever searched *inside* the subject's tree — and a correctly packaged skill provably carries no suite, because the suite is the answer key and excluding it from the bundle is exactly what VAT enforces. The only external skill you could eval was one whose publisher shipped their answer key. `--evals` resolves against the **current directory** (so an operator's shell path means what they typed), while config `test.evals` continues to resolve against the **skill source**; both now accept an absolute path or an npm bare specifier (honoring the target package's `exports` map, so a shared eval corpus can be distributed as a package). Each eval's declared input `files` resolve relative to the *suite's* directory, so fixtures travel with the suite rather than with the skill, and the suite itself is still never staged anywhere the executor can reach.
  - **Bug fixed in passing:** an absolute `test.evals` was silently folded into `<skillDir>/<path>` by a plain path join. That path did not exist, so the run did not fail — it **bootstrapped a starter template there and exited 3**, telling the operator to fill in a suite they had already written.
- **A skill's own `evals/` is now stripped from the staged tree even when the run grades a different suite.** Staging used the *same* value for "where do I read the suite" and "what do I remove from every staged copy", so pointing `test.evals`/`--evals` at any other location silently disabled the strip — nothing inside the skill matched the configured path, so nothing was removed and the skill's own answer key sat in the executor's working directory. The conventional `evals/` is now always stripped in addition to the configured suite (a no-op in the common case, where they are the same path). The invariant is "the executor's filesystem contains no answer key", not "…none for the suite we happen to be grading". Caught by the existing answer-key canary once it was pointed at an out-of-tree suite.

- **`workspaces/` and `results/` are now created `0700`.** They previously inherited the umask (typically `0755`) and were protected only by the `0700` harness root — which `--out` can relocate and `--keep` preserves. They hold each eval's declared input files and, in `grading.json`, verbatim quotes from the executor transcript; with an out-of-tree suite that can be data that was never in your repo. Note this narrows *who can read* those artifacts, not *what is written*: anything a skill reads out of a fixture still lands in `results/` as evidence text, and `results/` survives `--keep` by design.

- **Dependency-audit CI gate + accepted-risk register.** A new `.github/workflows/dependency-audit.yml` runs OSV-Scanner against the committed `bun.lock` (on push/PR to `main`, weekly, and on demand) and **fails on any advisory not listed in the new `osv-scanner.toml` register**. The register documents each deferred advisory with a reason (multi-major glob tooling that can't be safely pinned, dev/test-only packages outside the consumer install graph, or fixes requiring a breaking major bump). A green audit means "zero un-triaged vulnerabilities", not "zero vulnerabilities".
- **Grouped Dependabot config (`.github/dependabot.yml`).** One batched weekly PR for npm dependencies and one for GitHub Actions (grouped `patterns: ["*"]`), instead of a PR per dependency.
- **Corrected provenance on `VALIDATION_THRESHOLDS`, plus two repo gates that keep unverifiable claims visible.** The threshold table was headed "based on Anthropic guidance"; of its six numbers only `RECOMMENDED_SKILL_LINES` (500) is actually Anthropic's, and `MAX_DESCRIPTION_CHARS_CLAUDE_CODE` (250) is VAT's own reading of where the Claude Code `/skills` listing truncates — Anthropic documents 1024. `MAX_TOTAL_LINES`, `MAX_FILE_COUNT`, `MAX_REFERENCE_DEPTH` and `MIN_DESCRIPTION_LENGTH` are VAT-originated. Adopters tuning these should know which are vendor-sourced. Backing this up, `bun run validate-structure` gained two warning-level rules: claims about the outside world (other vendors' install paths, runtime capability profiles, semantics read out of someone else's binary) now carry a greppable `reviewed=`/`verify=` annotation and are reported once the 90-day review window lapses; and tracked files that cite documents under gitignored working directories are reported, since such citations are unfollowable from any clone. A third, error-level rule ratchets per-severity counts: a lane that publishes a validation status alongside a findings collection must publish per-severity counts beside it, since a status alone cannot express a three-valued severity distribution. It lands with every currently-nonconforming lane listed explicitly (19 at first, 11 after the shared-collapse migration below) and asserts both directions — a listed lane that starts conforming fails the build until its entry is removed, and a newly-added lane that is in no bucket fails until it is classified — so the list can only shrink. (`validate-structure` also no longer announces "validation failed" on a warnings-only run that then exits 0.)

- **User-facing docs for `vat skill test` and its config surface (`packages/cli/docs/skill-test.md`).** The per-skill `skills.config.<skill>.test` block and the global `test:` node were previously discoverable only via `--help` or by reading source — an adopter reported finding `timeout` by reading `run.js`. The new page documents every knob with its type/unit, default, and equivalent CLI flag (including `timeout`'s eval-count-scaled default and `graderModel`/`concurrency` defaults), plus the exit-code contract, the `results/` artifacts, and companion-staging behavior. `vat skills` (plural) docs and the CLI index now signpost it, since the singular/plural split is where adopters looked first.
- **`LINK_UNRESOLVED_REFERENCE` (default `warning`) — detects dangling reference-style links.** `[text][label]` and the collapsed `[label][]` form have no matching `[label]: url` definition; CommonMark resolves references at parse time, so a dangling one degrades to literal bracketed text with no link node ever produced — an mdast-based checker is structurally blind to it, so a dedicated raw-source scanner (`packages/resources/src/unresolved-references.ts`) catches it instead. Deliberately tuned for precision over recall: numeric, single-character, punctuation-edged, and multi-line references are never reported. See [`LINK_UNRESOLVED_REFERENCE`](docs/validation-codes.md#link_unresolved_reference).
- **Declared test input is now auto-excluded from packaged output.** Declaring a path under `skills.config.<name>.test.evals` names it as a skill's eval suite — the `expected_output`/`expectations` answer key for the tasks the skill is graded on — and that declaration now *is* the instruction not to package it: VAT drops it automatically via both entry routes (link traversal and `files:` entries) instead of requiring a second declaration or config edit. The new `PACKAGED_TEST_INPUT` code (default `warning`) is a receipt, not a gate — it fires once per dropped target, whether a `files:` entry or a markdown link pointed at it, so neither a `files:` entry that silently did nothing nor a link silently rewritten out of the shipped `SKILL.md` can be mistaken for one that worked. Every lane that models the bundle (`vat skills validate`, `vat skills build`, the plugin build) applies the same exclusion and emits the same receipt at the same location. The receipt covers the skipped copy only: if `SKILL.md` links the `dest` that entry would have produced, that link is still reported as a broken link (and fails the build) in every lane, because VAT has decided nothing will materialize it. See [`PACKAGED_TEST_INPUT`](docs/validation-codes.md#packaged_test_input) and `packages/agent-skills/src/test-input.ts`.
- **`mdast-util-to-string` is now a declared dependency of `@vibe-agent-toolkit/resources`.** It was previously used transitively in `link-parser.ts` but did not actually resolve under Bun; it's now a direct `package.json` dependency, with heading-anchor slugging pinned to `includeImageAlt: false` so the swap is behavior-preserving.

### Fixed

- **Piped output is no longer truncated at 64 KB.** Node makes a pipe's stdio non-blocking, so `console.log` and `process.stdout.write` are buffered and asynchronous — and every command in this CLI calls `process.exit()` the moment it finishes, which does not drain those buffers. Everything past the first pipe buffer was silently discarded, cut mid-token, with exit code `0`, so nothing signalled the loss. This broke exactly the usage the CLI's own docs recommend (`vat command | jq .status`): a large `vat resources scan --verbose` emitted **65,540 bytes through a pipe against 346,937 to a file**, so a consumer parsing the piped document read a header claiming 1,322 files above a list containing 293. An interactive TTY is unbuffered and always looked correct, which is why it went unnoticed. Both streams are now set blocking at startup, so no writer can lose its tail at exit — this covers stderr as well, which carries progress output and the `file:line:column: severity:` findings, where a report silently losing its tail is worse than one that never printed. `--help --verbose` had been fixed in isolation earlier with a synchronous drain loop; that loop is now shared rather than duplicated, and the general fix means no future output helper has to remember.
- **BREAKING: a path argument no longer voids the project's `resources.exclude` patterns.** `vat resources validate <path>`, `vat resources scan <path>` and `vat rag index <path>` re-based the crawl onto the given path, which silently discarded every root-relative `include` **and** `exclude` glob — the help text documented this as intentional. So naming a subdirectory scanned build output, vendored trees and deliberately-broken test fixtures the project had excluded on purpose, turning a green project red: on VAT's own tree, `vat resources validate packages/vat-development-agents` reported **50 files / 7 errors** where the configured run reported success, and all 7 were link errors inside a directory of intentionally-broken fixtures that the package excludes with a comment saying exactly why. The crawl base now stays at the project root so config globs are evaluated on the basis they were declared against, and the path argument narrows `include` only — `exclude` always applies (50 → 25 files, 7 → 0 errors). A path *outside* the project root warns that config patterns do not describe it rather than dropping them silently, and a path that does not exist or is not a directory now fails loudly instead of reporting `filesScanned: 0` as a success.
- **`vat audit --verbose --compat`: evidence locations are project-relative, not absolute.** Every evidence record's `location.file` carried the scanning machine's absolute path, so a shared or archived audit leaked `$HOME` and could not be resolved against the `root:` the document itself states. There were **two** constructors of that field and they leaked *differently*: one was handed absolute skill paths (the `$HOME` leak), the other plugin-relative paths anchored at a base the document never names, so `join(root, location.file)` resolved to nothing. Both are now a single helper taking a **required** root and relativizing inside it, which makes an absolute evidence location unrepresentable rather than merely discouraged. The anchor-contract gate that should have caught this was structurally blind: it recorded only *string*-valued `path`/`location` keys, and an evidence `location` is an object, so the collector recursed straight past its `file`. It now unwraps object-valued locations — the producer fix and the gate widened together, because the fix would otherwise ship unguarded.
- **`ALLOW_UNUSED` is evaluated across the whole run instead of per skill.** `validation.allow` is declared per *package*, but unused-ness was computed per *skill*, so an entry scoped to two files was reported "unused" by every other skill in the package — measured at **87 false warnings from 3 legitimate entries** on VAT's own 13-skill dogfood package. An entry is now reported unused only when no skill in the run matched it (87 → 0, with all three entries still listed under "Allowed issues", so the zero is a true answer rather than a suppression), while a genuinely dead entry still yields exactly one warning for the whole run, published as `runIssues` under its own heading. `AllowFilterResult.unused` is renamed `usage` with a `used` flag — the negative name read as a verdict when it was only a local observation — and the per-skill entry point is now `runSingleUnitValidation`, so using it in a loop over skills states something visibly false.
- **`vat audit <owner>/<repo>` no longer stalls ~60 seconds on a git credential prompt.** Bare `owner/repo` shorthand is expanded to an HTTPS clone URL, and a typo'd or private repo then blocked on an interactive prompt. Interaction is now disabled for the clone — but **only when the URL was inferred from shorthand**, so someone who typed a full URL for a private repo can still authenticate. `GIT_TERMINAL_PROMPT=0` alone is not sufficient, and was measured not to be: every askpass hook (`GIT_ASKPASS`, `core.askPass`, `SSH_ASKPASS`) short-circuits the terminal path *before* that variable is consulted, so an editor which exports `GIT_ASKPASS` into its integrated terminal would have kept the entire stall. The policy forbids *interaction*, not *authentication* — nothing resets `credential.helper`, so a helper holding a valid token still clones a private shorthand repo successfully.
- **VAT's published skill-review rubric no longer attributes VAT's own rules to Anthropic.** Re-verified against the live best-practices page, which showed **no vendor drift** — every numeric limit unchanged. Three items marked `[A]` are VAT's own and are now `[VAT]`, including "Build clean", which requires a build step Anthropic does not have; and the "trigger keywords first" item no longer claims "Claude truncates descriptions aggressively", which Anthropic never says (their stated rationale is selection pressure across 100+ available skills — the 250-character truncation argument is VAT's own reading and is labelled as such). Two other items gained the vendor quote that actually backs them. The rubric now also records where VAT **under**-enforces the vendor: `REFERENCE_TOO_DEEP` fires only above 2 hops, so the chain `SKILL.md → advanced.md → details.md` passes validation even though it is Anthropic's own "Bad example: Too deep" — a clean `vat audit` therefore does not mean that item is satisfied. `SKILL_TOO_MANY_FILES`'s example text asserted "Official skills use 1-5 files"; Anthropic's own canonical `pdf/` example ships 7, so it is now labelled a VAT heuristic. **No threshold value changed.**
- **`vat skills build` no longer fails on its own `files:` payload.** `PACKAGED_UNREFERENCED_FILE` (severity `error`) fired on files VAT itself had just copied into the packaged output from a skill's `files:` map — a vendored engine, generated schemas, data packs, anything consumed by code rather than read by a human. The rule engine has always treated a `files:` declaration as proof of intent on equal footing with a link or a documented mention; the post-build check never received the list, so every declared dest was evaluated as "not declared." The packager now passes the dests `applyFilesConfig` reports (glob entries expanded) to the orphan check, and both sides normalize through one exported `normalizeRelPath`. Adopters who added `validation.allow` waivers restating their own `files:` map can delete them. The check keeps its teeth: a packaged file that is neither linked, nor mentioned, nor declared in `files:` still fails the build.
- **`PACKAGED_UNREFERENCED_FILE` remediation text** no longer tells you to waive the finding for a programmatically-consumed file; it points at `skills.config.<name>.files`, where a declared `dest` is exempt outright. The same correction was applied to a second, stale copy of that string and to VAT's own `vat-skill-authoring` skill, which had been prescribing the waiver to agents.
- **A root-absolute markdown link (`/docs/guide.md`) is no longer reported as `LINK_OUTSIDE_PROJECT`.** RFC 3986 §4.2 absolute-path references resolve against the **project root**, which is what `resolveLocalHref` has always done for `vat resources validate`. The skill link-graph walker instead resolved every href with `path.resolve(dirname(source), href)` — and `path.resolve` **discards its base** when the second argument is absolute, so `/docs/guide.md` came back as the *filesystem*-root path and was then classified outside every project root but `/`. One link, two lanes, two answers: the resources lane resolved it and found the file; this lane raised an **error** against a target that exists and is in the registry. Measured on one real monorepo: **81 such errors, all false**, enough to fail an adopter's build. The walker now delegates to the single resolver rather than restating the rule; a root-absolute link that genuinely escapes the project root is still excluded. This was previously unreachable for the skills most affected, because link traversal for them was returning zero linked files (see below).
- **`vat claude plugin build` no longer re-reads the whole project once per skill.** Plugin-local skills are packaged through `packageSkill`, which builds a project-wide `ResourceRegistry` — crawling and parsing **every markdown file in the project** — when the caller passes none. This lane passed none, in a loop, so an N-skill plugin paid N full-project scans. The cost is fixed per skill and independent of the skill's own size: on a monorepo with 1039 markdown files, a 1-file skill and a 17-file skill each cost the same **~25s**, which put a 46-skill build past a 30-minute CI cap with no output during the gaps. The build now creates the registry **once per run** and threads it through every plugin and skill (**~2× faster** per skill; the one-time project scan is now visible up front and logged under `--debug`). `vat skills build` was never affected — it already went through `packageSkills`, whose doc comment says "one registry for the entire project (crawling all .md files once)": two producers of a plugin's skills, two answers about how many times the project gets read. The shared builder is now exported as `createProjectRegistry`, and `packageSkills` uses it too — it had been building its registry **without the project config**, so skills built through that lane belonged to no collection while skills built through the single-skill fallback did, and the packager rewrites frontmatter URI-references per collection schema.
- **Skill discovery can see `dist/` again.** `NEVER_CRAWL_GLOBS` was adopted verbatim as the discovery scanner's exclusion list, but that list carries `**/dist/**` and the scanner's deliberately did not: classifying what it finds as source or **build output** is the scanner's job, so a scanner that cannot walk `dist/` reports zero build outputs and calls it a clean scan. Build output now lives in its own `BUILD_OUTPUT_GLOBS` — excluded by the crawler's default, not spread by discovery — so "never user content" and "output we produced" stay two questions with two answers.
- **A newly-authored, uncommitted `SKILL.md` is now discovered.** Config-driven skill discovery crawled via `git ls-files`, which lists only tracked files, so a brand-new skill was invisible: `vat skills validate` silently reported one fewer skill and exited 0, and `vat skills build` did not ship it. Nothing warned — the count was the only tell. Discovery now passes `includeUntracked: true`, the documented knob for exactly this, which keeps the fast path.
- **`vat audit`: info-severity findings are no longer invisible.** The terse renderer decided "nothing to show" from the result's *status*, and an info-only result is `success` — so a real `--user` scan counted 504 info findings and rendered none of the 167 belonging to the 128 skills that had info findings and nothing else. The decision now keys on whether the result has findings at all.
- **`vat audit`: a result's status, counts and summary now follow its findings.** Detector findings were appended after the primary validator had already published a verdict, so a plugin carrying a warning reported `status: success`, `issueCounts: {0,0,0}` and `summary: Valid plugin` in the same entry that listed the warning — and a marketplace with a missing plugin source reported overall `success` above a `severity: error` finding. Applying a `validation.severity: ignore` config had the same effect on `issueCounts`.
- **`vat audit --user`: cached skills are matched against their own source.** The cache/source index was keyed by bare skill name; one real scan had 93 such collisions across two marketplaces, so cached copies were compared against unrelated same-named skills — reporting `cacheStatus: stale` for byte-identical copies, and able to hide genuinely drifted ones as `fresh`. Matching is now keyed on marketplace + plugin + skill.
- **`vat skills validate` no longer reports warnings as success.** The top-level `status` was a two-value collapse that could not express `warning`, so a run with active warnings printed `status: success` and "✅ All validations passed" above them. Warning- and info-only findings are now rendered in the human-readable report at all — previously only skills that failed the gate were printed, and of their warnings only `ALLOW_EXPIRED`. Warnings remain non-blocking (exit 0).
- **Info-severity findings are no longer labelled `[WARNING]`** in `vat skills build` and `vat claude plugin build`.
- **A build that fails only on built-output validation now shows why.** Both build lanes read only one of the two post-build issue channels that the failure condition ORs, so a skill whose packaged output failed validation aborted the build with no issue text at all. Issue sets are also now labelled by what they contain (`3 post-build issues (1 error, 1 warning, 1 info)`) instead of calling every set "post-build error(s)".
- **`vat skills build` no longer prints `status: success` on a failed build** (the YAML status was a literal, contradicting exit code 1), and `--dry-run` now reports `validated: false`, since it validates nothing.
- **`vat skills package` reports warnings and info findings.** The renderer dropped every info finding and ran only for error-severity results, so a warning-severity result printed a bare "✅ Validation passed".
- **`vat audit settings` emits the full `overrode` provenance chain** for every effective value, naming each value it replaced down to the lowest-precedence layer — the question the command exists to answer. It was computed and then dropped.
- **`writeYamlOutput` no longer emits a trailing `---`.** In YAML `---` OPENS a document, so every command's stdout was a two-document stream and a plain `YAML.parse()` threw `Source contains multiple documents` — on output this CLI documents as machine-parseable. The repo's own test helper had been written around it with `parseAllDocuments(...)`, which is what kept it invisible.

### Changed

- **BREAKING: `vat resources validate`'s `status` uses the shared three-value vocabulary.** It was `'success' | 'failed'` while every other validation lane answers the same question with `'success' | 'warning' | 'error'` — so a warning-only run was structurally inexpressible and reported `success`. `status` is now *typed from* the shared `calculateValidationStatus` helper rather than restating its values, so the two cannot drift apart again: the worst **actionable** severity wins, info-only is `success` (honest because `issueCounts` rides beside it and the issues are still listed — success is not silence), and `ignore` counts in no bucket. **Consumers matching on `status: failed` must now match `error`.** A file-local `countBySeverity` that counted `ignore` as info is deleted in favour of the shared one, so the number of status implementations went *down* rather than up.
- **BREAKING: `vat validate`, `vat verify`, `vat build`: exit code 2 ("System error") is now actually reachable.** A phase whose child exits 2, is killed by a signal, or never spawns exits 2 instead of 1 — previously every non-zero child exit was reported as 1, making a broken config indistinguishable from a broken link, and rendering the documented exit code unreachable. `runPhase` also no longer ignores `result.error`/`result.signal`. Per-phase `status` changes from `passed`/`failed` to `success`/`warning`/`error`/`system-error`, each phase carries `exitCode`/`signal`/`error` where applicable, and the top-level status uses the same vocabulary (worst phase wins; `system-error` outranks `error`). `vat verify --only consistency` now exits 1 in a project with no `skills:` block instead of exiting 0 with an empty phase list.
- **BREAKING: `vat verify`'s consistency phase reports `warning` (not `passed`) when it emits warnings**, and publishes `issueCounts` plus the findings themselves into the archived YAML — they previously went to stderr only, so the artifact of record said nothing happened. Warnings still do not fail the run.
- **BREAKING: `vat skill review --yaml`'s `status` now agrees with its exit code.** It was `PackagingValidationResult.status` — the two-valued packaging *gate* verdict, structurally unable to say `warning` — so a warning-bearing review reported `status: success` while exiting 1. The exit code (the deliberate, documented contract) is unchanged; the lying channel was the status. `summary:` is renamed `issueCounts:` to match every other lane.
- **BREAKING: `vat audit` output names file counts and finding counts apart.** `summary.success|warnings|errors` (which count FILES) become `summary.filesPassed|filesWithWarnings|filesWithErrors`, and the top-level `issues` counts block (which counts FINDINGS) becomes `issueCounts` — the same field name and meaning it already has on every file entry. Two different denominators previously shared one word in adjacent keys.
- **BREAKING: `vat audit --user` plugin groups are named after the plugin.** The marketplace plugin name was read at a fixed offset from `marketplaces/`, which in Claude Code's real installed layout (`marketplaces/{m}/plugins/{p}/skills/...`) is the literal segment `plugins` — 242 of 257 skills in one scan were grouped under a single fake plugin named `plugins`. Cached groups were likewise named after the version directory (`6.1.1`, `d884ae04edeb`).
- **BREAKING: `vat doctor` reports four outcomes per check instead of a pass/fail boolean** — `pass`, `fail`, `undetermined`, `skipped`. A check that could not reach an answer (npm unreachable, an unreadable package.json) was counted as PASSING; it is now `undetermined` (❓). The summary changed from `7/7 checks passed` to `7 checks — 7 passed, 0 failed, 0 undetermined, 0 skipped`, and the concise view states how many checks it did not print — it previously claimed "7/7 checks passed" while rendering none of them, because `runDoctor` returned only the displayed subset while counting all of them. Exit codes unchanged: only `fail` exits 1. `DoctorCheckResult.passed` → `.outcome`; `DoctorResult.allPassed`/`.passedChecks` → `.outcomeCounts`.
- **BREAKING: `vat audit settings --file` replaces `valid: true|false` with `status` + `issueCounts` + `findings`**, and adds `typeConfidence` (`declared`|`inferred`|`ambiguous`|`undetermined`) — user and project settings share one schema, so a file without managed-only fields is now reported as ambiguous rather than silently answered as `user`. `fields: null` (could not read) is now distinct from `fields: []` (none declared). `--show-paths` may report `exists`/`readable` as `"undetermined"` with an `accessError`, where a permission error on a parent previously read as "absent".
- **BREAKING: `vat inventory --shallow` marks lists it did not walk as `null`, not `[]`**, and adds a `projection: shallow` marker. A shallow document was previously byte-identical to a real scan of an artifact containing nothing.
- **BREAKING: `@vibe-agent-toolkit/claude-marketplace` settings surface.** `SettingsValidateResult` loses `valid`/`errors` for `status`/`issueCounts`/`findings`/`typeConfidence`; `getSettingsFileFields()` returns `null` (not `[]`) when unreadable; `getSettingsPaths()` returns `SettingsPathCandidate[]` with no `exists`/`readable` (a synchronous enumeration cannot know — use `resolveSettingsPaths()`); `SettingsPathEntry.exists`/`.readable` widen to `boolean | 'undetermined'`. New exports: `probePathAccess`, `summarizeSettingsFindings`, `SettingsFinding`, `SettingsTypeConfidence`, `SettingsFileField`, `SettingsPathCandidate`.
- **`vat claude marketplace validate` publishes `issueCounts`** and its summary string gained the info term it never had. `vat build` and `vat claude plugin build` publish `issueCounts` beside their status.
- **The `coherence-audit` skill ships in the `vibe-agent-toolkit` plugin.** It carries the method this release's audit used: the one-contract question, the failure-direction tell (every serialization defect here mapped the unrepresentable case to the *reassuring* one, which is why none was ever reported), the doc-comment-versus-code sweep, how to bound a defect class honestly, how to spot a green-but-blind test suite, and vendor-claim staleness. The name drops the `vat-` prefix because the method is generic.
- **Removed dead `PluginJsonSchema`** from `@vibe-agent-toolkit/agent-skills` (exported from two barrels, no consumer). Its `.strict()` `author` shape would have REJECTED the `author.url` this release fixed.
- **The RAG WordPiece tokenizer now refuses a CASED vocabulary** instead of silently degrading. Its preprocessing (lowercase + strip accents) is unconditional and correct only for an uncased model; on a cased one every capitalized word missed its vocab entry and became `[UNK]` or a wrong subword, producing embeddings that are right-shaped, right-normed, and worse — with nothing downstream able to tell. Detected from the vocab itself (bracketed literals excluded) and raised as `CasedVocabError`. There is no bypass flag, matching `IncompatibleVocabError`.
- **One canonical never-crawl list.** Three divergent exclude lists disagreed about which directories VAT refuses to walk; the crawler's omitted worktrees entirely, so a crawl could report the same file two or three times under different paths (a worktree is a full repo copy, and this repo keeps its own at `.claude/worktrees/`). `NEVER_CRAWL_GLOBS` in `@vibe-agent-toolkit/utils` is now the single source, spread by the discovery scanner.
- **The `vat` CLI help-docs directory is now checked in both directions.** `REQUIRED_HELP_FILES` listed 4 of 9 shipped documents and never checked the reverse, so a page could be written, published to npm, and reachable from no `--help --verbose` at all — which is true of five of them (`audit.md`, `doctor.md`, `mcp.md`, `skills.md`, `skill-test.md`, now recorded as reference-only).
- **Ten dangling doc citations removed.** Each pointed at a design document under a gitignored working directory — unfollowable from any clone, and demonstrably so: none of them exist in a fresh worktree. The rule each was standing in for is now stated inline. Relatedly, `docs/external/anthropic-skill-authoring-best-practices.md`'s own refresh procedure cited a deleted file twice, making it unfollowable — which is likely why that cache is past its 90-day window — and `docs/architecture/skill-packaging.md` described a `status: partially-conclusive` source-review document as "empirical" when its verification runbook has never been executed.
- **BREAKING: there is now ONE answer to "issues → status", and every validation result carries per-severity counts.** Six places independently collapsed a set of findings into a status, and they did not agree: for an **info-only** issue set, `calculateValidationStatus` (feeding the marketplace, registry and plugin validators) said `warning`, `vat audit` said `success`, `vat claude marketplace validate` said `success`, `skill-validator` re-derived it a fourth time, and `corpus/runner`'s `statusFromCounts(errors, warnings)` could not see info **at all** — its signature had no third parameter, so an info-only plugin was filed as `audit_clean`. Two commands could therefore report different statuses for the same artifact. Now:
  - `calculateValidationStatus(issues)` and `countBySeverity(issues)` live in `@vibe-agent-toolkit/agent-schema` and are the only implementation. Status is the worst **actionable** severity: errors ⇒ `error`, warnings ⇒ `warning`, otherwise `success`.
  - **An info-only result is `success`** — a change for every lane that went through `calculateValidationStatus`. That is defensible only because the counts now travel beside the status, which is the rest of this entry.
  - **`ValidationResult.issueCounts` is REQUIRED** (`{ errors, warnings, info }`). Required rather than optional on purpose: the compiler now asks a new producer for the distribution instead of a reviewer having to notice it is missing. `vat claude marketplace validate` publishes the same block in its YAML, and its `summary` string gained the info term it never had.
  - **`ignore` counts in no bucket.** Those findings were suppressed by the adopter's own `validation.allow`; counting them would resurrect something they deliberately silenced.
  - Library callers: `calculateValidationStatus` is **removed** from `@vibe-agent-toolkit/agent-skills` and its barrels — import it from `@vibe-agent-toolkit/agent-schema`. Anything constructing a `ValidationResult` must add `issueCounts: countBySeverity(issues)`.
  - The `validate-structure` severity-counts ratchet shrank from 19 lanes to 11. Fixing it also exposed two blind spots in the ratchet itself: it could not see the ES shorthand `issueCounts,`, and it defined its population from keyword shapes that the migration *deleted* — `audit.ts` became invisible the moment `status: 'error'` became `status: calculateValidationStatus(issues)`. It now treats a call to the shared collapse as sufficient evidence of a lane, and strips comments first, because a doc comment telling readers to call `countBySeverity(...)` read as the fix itself.

- **BREAKING: `vat audit` output now states its base once (`root`) and every `path` and `location` is relative to it.** The previous change made `location` a *relative* path but left its BASE unstated and non-uniform: each resource anchored its findings at its own nearest-ancestor `vibe-agent-toolkit.config.yaml`, and a single audit run recurses across many such roots. One document therefore mixed coordinate systems. Measured on this repo's own fixture tree, two **different** files — `multi-plugin-marketplace/plugins/plugin-a/.claude-plugin/plugin.json` and `single-version-marketplace/plugins/plugin-a/.claude-plugin/plugin.json` — emitted the byte-identical `location: plugins/plugin-a/.claude-plugin/plugin.json`, while other findings in the same run were based at the repo root. A consumer could not open the file a finding named without reimplementing the governing-config walk-up, and anything that groups, de-duplicates, counts-by-file, or annotates a PR by `location` silently merged distinct plugins. Where no config or git root exists at all (auditing `~/.claude`, a plugin cache), the base collapsed to the skill's own directory and every skill's `location` became the bare string `SKILL.md`. Meanwhile `path` stayed absolute, leaking `$HOME` once per scanned file. Now:
  - **`root`** *(new, first key)* — the invocation scan root, and the only absolute path in the document. `--user` states the shared Claude config dir (`$CLAUDE_CONFIG_DIR`, else `~/.claude`); a URL audit omits `root` because the clone lives in a tempdir nothing downstream can resolve, and the provenance header already names the base.
  - **`files[].path`** — now relative to `root`, forward-slashed. It remains a unique identifier, and `join(root, path)` is the resource.
  - **`location`** — now relative to the same `root`, so `join(root, location)` is the file the finding is in, and one `location` cannot name two files.
  - Human (stderr) output is root-relative too, and `--user` no longer abbreviates paths with `~`.
  - The scan root is an **anchor**, not a validation-policy boundary. Per-skill packaging rules still come from each skill's nearest-ancestor config (configs do not compose); that discovery no longer has any say in how a path is spelled. The two concerns are now separate variables and separate parameters throughout the validators (`locationRoot` vs `projectRoot`), because conflating them is what produced the defect.
  - Library callers: `ValidateOptions.projectRoot` is renamed to `locationRoot`; `validatePlugin`, `validateMarketplace`, `validateInstalledPluginsRegistry`, `validateKnownMarketplacesRegistry`, and `validate` accept a `locationRoot` option (new `AnchorRootOptions`); `SkillValidationSharedContext` gains `locationRoot`; `buildHierarchicalOutput` and `getValidationResults` take the run root explicitly. Each falls back to the resource's own project root when omitted, which is correct exactly when a run covers one project.

- **BREAKING: `ValidationIssue.location` is now always a project-relative POSIX path, and the things it used to double as have their own fields.** One field was carrying six incompatible kinds of value at once — absolute paths (`/Users/you/skills/foo/SKILL.md`), absolute paths with a line glued on (`…/SKILL.md:24`), relative paths (the resources lane's convention leaking through), document-internal pointers that are not paths at all (`frontmatter.description`, `validation.allow.SKILL_TOO_MANY_FILES`), Zod field paths joined by the *same* colon a line number uses (`plugin.json:plugins.0.name`), and — for walker-derived link findings — the link **target** rather than the file containing the link. A consumer could not parse `location` uniformly, could not know what to resolve it against, and absolute paths leaked the developer's home directory into CI logs. Now:
  - **`location`** — the file you would open, as a project-relative POSIX path. **Never absolute**, enforced by a schema refinement (it was a bare `z.string()`, which is how 235 absolute paths shipped unnoticed) and by a contract test that asserts the invariant over *every* issue the skills lane emits, so a new producer with a new convention is caught the day it lands.
  - **`line`** — the 1-based line, as a number. The field already existed on the type; no skills-lane producer had ever set it, they concatenated `:${line}` instead.
  - **`field`** *(new)* — a dotted pointer INSIDE that document (`frontmatter.description`, `hooks[0].script`, a Zod issue path).
  - **`link`** — a link href or target the issue concerns. Never the file to open.
  - Human output renders these as `path:line (field)` via one shared formatter, so the split does not hide information that used to be visible.
- **BREAKING: a link finding is now anchored to the file that CONTAINS the link, not to the link's target.** For a missing target the old `location` named a path that does not exist, so "open this to fix it" pointed at nothing — and `vat skills validate` and the packaging walker disagreed about the same code (`LINK_OUTSIDE_PROJECT`), one anchoring to the containing file and one to the target. The target now travels in `link`.
- **BREAKING: `validation.allow` globs for link codes should be rewritten against the containing file (or the href).** `allow` entries match an issue's `location` **or** its `link`. Entries written against the resolved *target* — the value `location` used to hold for walker-derived link findings — no longer match. Rewriting them against the containing file is usually both shorter and more precise (VAT's own six-pattern `LINK_OUTSIDE_PROJECT` entry collapsed to one), and target globs were depth-fragile anyway: picomatch's `**` does not cross a leading `../`, so each extra level of nesting needed its own `../../../…` pattern.
- **BREAKING: `validateFrontmatterSchema`, `validateFrontmatterRules`, `detectUndeclaredCrossSkillAuth`, `detectBundledResourceWithoutLinks` and the five inventory detectors take an extra argument** (the skill location / project root). They previously had no way to name the file their findings were about — which is exactly why they emitted `location: 'frontmatter'`. `ValidateOptions` gains an optional `locationRoot`, defaulting to the same config-root → git-root → skill-dir chain `validateSkillForPackaging` already used, so both skills-lane entry points express locations in one coordinate system. `issueLocation()` moved from `@vibe-agent-toolkit/resources` (internal) to `@vibe-agent-toolkit/utils` (exported) and now requires a root instead of silently falling back to an absolute path.

- **Compat verdicts now honor the `location` contract in every command, not just `vat audit`.** The verdict producer took a pre-rendered `location` string, so each of its four call sites answered "relative to what?" independently — and three answered "absolute". `vat skill review --yaml` emitted a single document carrying **two coordinate systems** (relative locations from the packaging validator alongside an absolute one from the verdict), `vat skills validate` leaked the full home-directory path into `COMPAT_TARGET_*` findings, and `vat skills build` had no root to re-base against at all; only `vat audit` was correct. `computeConfigVerdicts` / `applyConfigVerdicts` now take the skill path **plus** the anchor root and re-base internally, so no caller can emit an absolute location. Library callers passing a rendered location must pass `(skillSourcePath, locationRoot)` instead.
- **`NON_PORTABLE_COMMAND`'s `readlink -f` advice was stale and is corrected.** The fix text claimed `readlink -f` "is not available on macOS by default"; verified against macOS 26.5.2, it is present and resolves existing paths. The real, still-current hazard is narrower: on macOS it fails when the final path component does not exist, where GNU canonicalizes it (and `-f` was absent from macOS for years). The other four variants (`timeout`, `grep -P`, `sed -i`, `date -d`) were re-verified and hold. Because CI runs Ubuntu + Windows only, nothing in this repo can contradict these macOS claims, so the variant table now carries a `@vendor-claim` annotation and comes due for re-verification on a 90-day clock.
- **BREAKING: `vat resources validate` output now says what severity each finding is — and every field named `error*` counts errors only.** The validation framework has always resolved a severity per issue, and only `error` fails the run. Neither output format said so. `--format text` printed every finding as `file:line:column: message`, so an informational note and a build-breaking error were byte-identical in shape; the structured output named four fields after "error" while three of them counted issues of *all* severities, so a scan could report `status: success` beside `filesWithErrors: 1` beside `errorsFound: 0` beside a non-empty `errors` array of info items. An adopter scanning a large monorepo got 57 findings of which ~4 were errors, had to hand-classify the report to find them, and then asked for three separate codes to be "downgraded to warnings" — all three were already `info`. The output was the only thing that said otherwise. Now:
  - **Text format is `file:line:column: severity: message`** (the GCC/ESLint-compact convention, which editors and CI log scrapers already parse).
  - **Naming contract:** a field named `error*` counts ERROR-severity issues only; a field named `issue*` counts every severity. `errorsFound` is unchanged (it was already error-only). `filesWithErrors` and the per-collection `filesWithErrors`/`errorCount` now count error-severity issues only — previously any info note made a file "a file with errors".
  - **Renamed** `errorSummary` → `issueSummary` and the detail array `errors` → `issues` (with each file's inner `errors` → `issues`), since both legitimately carry all severities. Consumers parsing those keys must update.
  - **Added** `issueCounts: {errors, warnings, info}`, matching the `issues:` block `vat audit` already emits — the two lanes now use one vocabulary for one question.

- **BREAKING: `vat skills install` installs a skill under the name it declares, not the name of the directory it arrived in.** Every other lane in VAT treats the SKILL.md frontmatter `name` as the skill's identity — it is what `vat skills build` keys its output directory on, what the plugin-build collision referee matches on, and what `SKILL_CLAUDE_PLUGIN_NAME_MISMATCH` tells you to align a `plugin.json` *to*. Install was the one place that never asked the skill its name: it took the directory leaf, and for an archive source there is no meaningful leaf. A ZIP whose `SKILL.md` sits at the archive root (rather than under a top-level folder) installed as **`vat-skills-install-zip-<random>`** — the extraction temp directory — leaving an unloadable skill under a garbage name. Install already parsed the declared name during pre-verification and discarded it; it now uses it, guarded against path separators the same way `--name` always was. `--name` continues to override. Two consequences:
  - A source directory whose leaf disagrees with the declared name now installs under the **declared** name. `vat audit` still reports the authoring mismatch separately (`SKILL_NAME_MISMATCHES_DIR`); install no longer propagates it into your skills directory.
  - A multi-skill source in which **two skills declare the same name** now fails the whole batch, naming both directories, instead of silently installing one over the other.
- **`vat skills install` now says which of its seven targets VAT can see back.** VAT writes to seven platform locations and reads from exactly one: `resolveSkillTarget` has a single non-test caller (install), while `vat skills list --user` and `vat audit --user` scan `~/.claude` only. Both read-side commands already documented their own Claude scope; nothing said so at the point where you *choose* a target, so installing to `cursor` succeeded and then silently fell outside VAT's own tooling. Documented in `--help` and the skills docs. Also: the target table cited `docs/plans/2026-04-08-agent-skills-ecosystem-analysis.md` as its justification — a file that is not in the repository (`docs/plans/` is untracked), so the citation could not be followed. Replaced with the review date and an explicit statement that no test verifies a path is where a platform actually looks: the tests assert the table's *shape*, so a vendor moving its convention means installs land unread with every check still green. **No paths changed** — verifying seven vendors' current conventions is research, not cleanup.
- **A staged-tree inventory gate, closing the staging-side analogue of the packaged-output drift gate.** The drift gate exists because nothing compared *built* bytes against a baseline. The tree `vat skill test` hands the executor had the same hole from the other end: every staging test asserted one *named* property (this lands flat, that plugin nests there, a deleted source file is pruned), and all of them keep passing when staging starts emitting an **extra** file — which is exactly what an eval answer key in the executor's working directory is. `packages/agent-skills/test/integration/staged-tree-inventory.integration.test.ts` asserts the complete set of staged paths and fails on anything that appears or vanishes; proven to catch the class by disabling the eval strip and watching it name all four leaked files. Also pins the two behaviors the strip depends on: the subject's suite is *held* outside the harness root (readable by vat, unreachable by the executor) while a companion's is removed outright.
- **`isolateEvalSuite` now rejects a missing containment root explicitly.** Its `assertInsideRoot` guard is the last line of defense before a recursive delete, and with an absent `stagingRoot` it failed with `The "from" argument must be of type string` from deep inside the path helpers — which reads as a path-handling bug rather than "the containment root is missing, so nothing can be proven safe to delete."
- **`vat claude plugin uninstall` help no longer claims to reverse artifacts it does not touch.** It said it reverses "all install artifacts"; it removes the *plugin* artifacts (marketplace plugin dir, cache dir, both registry entries, settings) and never touches `~/.claude/skills/` — where `vat claude plugin install <dir|zip>`, `--dev`, and `vat skills install` all write. Four writers, no remover. The help now says which artifacts it reverses and which it does not.
- **`vat claude org skills install` no longer publishes an eval suite to your organization.** The command documents "a built skill directory" as its input, but it uploaded *every* file under whatever directory it was given — and the easy mistake is pointing it at the **source** tree, which is where a skill's `evals/` (its answer key) actually lives. `evals/`, `node_modules/`, and `.git/` are now excluded at any depth, and each exclusion is named in the command's output so the skip is never silent. For a correctly built skill directory this changes nothing; it is the backstop for the case where it would have mattered most, since publishing to an org is the widest blast radius in the lifecycle. Same invariant the eval-isolation work enforces for the test sandbox: **a published skill carries no answer key**, not "…none when the operator remembered to build first."
- **`vat skills list` reports the declared name too.** It is the preview for `vat skills install` — including `vat skills list npm:@scope/pkg`, which inspects a package without installing it — so listing directory leaves would have named directories the install never creates. The leaf remains the fallback for a `SKILL.md` too damaged to declare a name.

- **BREAKING: plugin-local skills are now packaged, not copied verbatim.** A skill living in a plugin's own `skills/` source tree (`vat claude plugin build`) now goes through the same `packageSkill` packager that produces pool skills — link-following, reference-rewriting, `files:` injection, and declared-test-input exclusion all apply, and a plugin-local skill that fails post-build validation now **fails the build**, matching the bar `vat skills build` already holds pool skills to. Previously the whole source directory was tree-copied verbatim: eval suites (answer keys included), scratch files, and un-rewritten links all shipped, and packaging errors were never checked. `applyTreeCopiedSkillFiles` is removed; `packages/cli/src/commands/claude/plugin/build.ts` and `tree-copy.ts` no longer treat skill directories as tree-copy content — the packager owns them exclusively now (the build's `skillFilesCopied` result field is renamed `localSkillsPackaged` accordingly). Three consequences worth checking against your own plugin tree:
  - **NESTED plugin-local skills are packaged too.** A `skills/<group>/<skill>/SKILL.md` is a skill Claude Code loads, so VAT now discovers it recursively and packages it in place, at the same depth. Previously only immediate `skills/*` directories were recognized; a nested skill fell through to the verbatim tree-copy and shipped its eval suite — answer key included — into the published bundle.
  - **A gitignored or untracked skill directory is no longer published.** Skill discovery for the plugin build now honors the same git visibility the tree-copy always did (tracked files only, inside a git repo), so the two producers of a plugin's `skills/` tree agree on which files exist at all. A skill directory you keep out of the repo — and which `vat skills build` never discovers — is not packaged. A skill dir that is neither tracked nor gitignored (a new skill you have not `git add`ed yet) gets a build warning naming it, so its absence from the bundle is never silent.
  - **The pool-collision referee matches on the declared NAME, and only the declared name.** A skill named `foo` authored in `skills/bar/`, or a nested `skills/group/foo/`, now correctly defers to the pool copy when the plugin's `skills:` selector also resolves `foo`. Previously both cases produced the skill twice — two definitions of one skill, at two depths, inside a single plugin. The winning pool copy now lands at the plugin-local skill's own authored path (`skills/group/foo/`), so `vat skill test` and `vat verify` look for the built skill where the build actually wrote it. The directory name is no longer matched as well: a plugin-local skill named `bar` living in `skills/foo/`, in a plugin selecting an *unrelated* pool skill `foo`, used to be refereed away and ship nowhere; that case is now the error it always was — **two different skills claiming one output directory fails the build**, naming both. `DistributedSkillLocation.skillDirName` is renamed `skillDirPath` (it is a path now, not a bare name), as is `SkillDistribution`'s field of the same name.
- **`vat skill test` — a `<path>` at a config-declared skill's authored source directory now resolves to `buildable`, not `source`.** It builds the skill (real entry points) and tests the **dist**, matching what its bare name already did and what companion staging has done since issue #153 — a path was the one reference form that still silently tested un-packaged source. `--no-build` remains the escape hatch to reuse an existing dist without rebuilding (hard-failing if none exists yet); `--dry-run` is the only route that still falls back to raw source, and only when no dist exists yet. See [Skill Reference Resolution](docs/architecture/skill-packaging.md#skill-reference-resolution).
- **BREAKING: local RAG embeddings are now batteries-included, backed by `onnxruntime-web` (WASM) instead of native `onnxruntime-node`.** `OnnxEmbeddingProvider` (the default embedding provider) no longer requires any install step — `onnxruntime-web` ships as a regular dependency of `@vibe-agent-toolkit/rag`. `TransformersEmbeddingProvider` (and its `@xenova/transformers` optional dependency) is **removed entirely** — it was the exact native-runtime code path this change replaces. `openai` remains the only opt-in peer dependency, for `OpenAIEmbeddingProvider`. Default model is unchanged (`Xenova/all-MiniLM-L6-v2`, 384 dims, int8-quantized).
- **`model` in a skill's `test:` config now selects the executor, not a single self-grading agent.** With the executor/grader split above, a `test.model` value drives the skill-under-test run; grading defaults to `graderModel` (`claude-sonnet-5`) unless you set it. Existing single-`model` configs keep working — they just no longer also determine the grader.
- **`vat skill test` — `--with`/`--with-optional` now stage companion skills, and a run tests exactly one subject (issue [#153](https://github.com/jdutton/vibe-agent-toolkit/issues/153)). BREAKING.** `--with name=<src>` (repeatable, or config `with:`) stages a **required** companion skill the subject can invoke; `--with-optional` (or config `optional:`) stages an **optional** one. Both make the skill invocable in the executor session — matching what every doc already promised. This replaces an accidental, undocumented behavior where `--with` merely *overrode the staging source of an already-listed positional skill* and **silently no-op'd** any name that wasn't positional (so a routing/deferral eval "passed" against a skill set that never contained the companion — the reported bug). Consequences: the positional argument is now a single `<skill>` (was variadic `<skill...>`); a **required** companion whose source can't be resolved fails the run (exit **2**), an **optional** one is skipped with a stderr warning; and staging the same name twice across subject/`--with`/`--with-optional` is a `DuplicateStagedSkillError` (exit **2**). Config `skills.config.<skill>.test.with`/`optional` now behave the same way (they previously never staged anything).

### Fixed

- **`<a id="short">` anchors in markdown now resolve, instead of being reported as broken links.** VAT indexed heading slugs and nothing else, so an author who put an explicit short anchor above a long heading — `<a id="materialize"></a>` above `## Materialize the warehouse snapshot into a local DuckDB file` — got `LINK_BROKEN_ANCHOR` for `toolbox.md#materialize`, a link GitHub resolves. An adopter repointed working links at the long slug to appease the tool. Markdown documents now contribute `id`/`name` attributes from raw-HTML nodes as fragment targets, matching GitHub. Only raw-HTML nodes are read, so an `id=` shown inside a fenced block, an indented block, or a backticked span is being *documented* rather than declared and is never indexed — that is why this reads the AST instead of scanning source. Markdown ids are matched case-insensitively, following markdown's existing case-folded fragment policy; erring toward resolving is deliberate, since the other direction's cost is a false error on a link that works. Unconditional for markdown: the `--check-html-anchors` opt-in governs `.html` *targets*, whose fragments are frequently defined at runtime by JS and so are not statically authoritative, which is not true of static markdown. See [`LINK_BROKEN_ANCHOR`](docs/validation-codes.md#link_broken_anchor).
- **BREAKING (widens the scan): `.claude/` and every other dot-directory are no longer invisible to VAT's file crawler.** picomatch's default refuses to let `*` or `**` traverse a path segment beginning with a dot, so `**/*.md` — the include pattern `vat resources validate` and friends default to — could never match inside `.claude/`, `.github/`, or any other dotted directory. An adopter who dropped their `include` allowlist specifically because we told them it would widen the scan still had **68 tracked files silently uncrawled**: `.claude/rules/` (15), `.claude/skills/` (48), `.claude/commands/` (3), `.claude/agents/` (1). Adding an explicit `.claude/**/*.md` took their scan from 941 to 996 files, found a real frontmatter defect (an unquoted internal colon), and produced zero false positives — but restating VAT's own defaults as a workaround means they stop tracking future default changes. This was also, again, one question two lanes: `vat audit` already compiles its `--exclude` patterns with `dot: true` and carries a comment saying that without it "the exclude silently never fires"; the include side never got the same treatment, and neither did the crawler. `crawlDirectory` now compiles every pattern — include *and* exclude — with `dot: true`, and its `dot` option is gone, because "is this path visible?" is answered by git and by your excludes, never by whether a component happens to start with a dot. **What to expect:** if you have tracked markdown under a dot-directory and no `include` allowlist narrowing it away, VAT will now scan it and may report findings there for the first time. `.claude/` in particular is Claude's own home for the rules, skills, commands and agents VAT exists to validate.
- **BREAKING for `owner/repo` shorthand: `vat audit <path>` never reaches the network for a path that exists.** The command asked "is this a git URL?" before asking "is this a directory?", and `isGitUrl` accepts bare GitHub shorthand — which is spelled exactly like an ordinary two-segment relative path. So `vat audit plugins/arc` (and `docs/guides`, and `packages/cli`) resolved to `https://github.com/plugins/arc.git`: the local tree was never audited, the command silently contacted github.com with a name derived from the caller's own directory layout, and the failure surfaced as `Repository not found` for a directory sitting right there. Worse, anyone registering that `owner/repo` could have had their tree cloned and reported back as your audit. An argument naming an existing file or directory is now always a path; shorthand applies only when nothing of that name exists locally. `./plugins/arc` was never affected, which is why the documented example escaped it. *(Found while trying to measure the audit-performance bug below — the first round of timings were failed clones, not audits.)*
- **`vat audit` re-did the most expensive thing VAT owns once per skill; it now does it once per project root.** On a ~1,200-document monorepo, `vat audit` over a directory of 46 skills did not complete in ten minutes, while `vat resources validate` scanned the same tree in seconds. Two independent causes, both the same shape — a lane that had already solved this and a lane that had not:
  - **The inventory link walk asked git the wrong question.** It crawled with `respectGitignore: false` — deliberately, to pick up untracked files an author is still editing — but that flag also means "include everything git is told to ignore", and getting there means abandoning `git ls-files` for a full recursive walk of every build cache, nested worktree and generated tree. Measured on the same repository: **39,599 ms versus 16 ms**, for 1,146 files versus 1,143. `crawlDirectory` gains an `includeUntracked` option that asks the narrower question (`git ls-files --others --exclude-standard`) and keeps the fast path; `respectGitignore: false` now documents that it costs the whole walk and is only for callers that genuinely want ignored files.
  - **The registry was rebuilt per skill.** Building one parses every markdown (and HTML) document under the project root — ~20 s on that tree — so N skills paid it N times, twice over (once in the packaging validator, once in the inventory walk). `vat skills validate` has always shared one registry across its batch, and `crawlAndResolveRegistry`'s own documentation says it is exported "so external callers (e.g. the inventory layer) can build a registry once and pass it down rather than re-crawling per skill" — the audit lane simply never wired it. It now caches both registries per project root for the run (kept separate: the validator's crawl includes HTML and the inventory walk has always been markdown-only, and merging them would quietly widen the link graph `files.linked` is computed from).

  Measured on that monorepo: auditing a plugin directly went from **369 s to 42 s** for 2 skills, and is now effectively flat in skill count at that level (a 19-skill plugin audits in 27 s — the fixed cost of parsing the corpus twice). Recursively auditing the *parent* directory of 46 skills now **completes in 571 s** where it previously did not finish in ten minutes; that residual is neither re-crawling (both caches hit — the tree has a single project root) nor duplicated work (the run performs exactly 46 skill validations for 46 skills), but ~12 s of genuine per-skill validation, which is a separate and still-open issue.

- **A file whose frontmatter fails to parse is no longer also reported as having no frontmatter.** Two lanes answer "does this file have frontmatter?" — the parser, which records the parse error and knows the block is present but broken, and the schema validator, which sees only the parse *result*. A failed parse yields `undefined`, and the schema validator read `undefined` as "absent". So a document with a duplicate YAML key drew **both** `FRONTMATTER_INVALID_YAML` and `FRONTMATTER_MISSING` — the second asserting "No frontmatter found in file" about a file whose frontmatter is plainly there — and handed the author two conflicting remediations ("fix the YAML syntax" versus "add the required frontmatter"). Schema validation is now skipped for a document that did not parse, in both the global-schema and per-collection lanes; the parse error is emitted unconditionally and is the actionable finding. A file that genuinely has no frontmatter still reports `FRONTMATTER_MISSING` exactly as before. *(Found by scanning a large real monorepo: an archived ADR declaring `superseded_by` twice.)*
- **A markdown link whose target does not ship is now stripped to plain text, in every spelling.** Three ordinary link shapes used to leave broken markdown in the packaged skill, and one of them failed the build outright. A link to a **directory** written with a trailing slash (`[refs](refs/)`) matched no rewrite rule at all, survived packaging verbatim, and then tripped `PACKAGED_BROKEN_LINK` — an `error` whose own remediation text reads "Report the issue — this indicates a VAT bug." The same link written without the slash (`[refs](refs)`), and any **non-markdown asset** dropped from the bundle (`[key](evals/evals.json)`), instead shipped `[text]()` — a valid markdown link to nowhere — because the bundled-link template interpolated an undefined target path. All three now render as plain prose, which is what an excluded *markdown* link already did. A directory link can never survive packaging: bundled resources are flattened into `resources/`, so no authored directory exists in the output to point at. This also makes `PACKAGED_TEST_INPUT`'s promise ("the link is removed from the packaged output") true for all three spellings rather than one. A companion fix in the link-rewrite regex was required to land this safely: the inline-link pattern excluded only `]` from link text, so a stray unpaired `[` in prose (e.g. a sentence listing glob metacharacters ``(`*`, `**`, `?`, `[`)``) started a match that ran forward to the *next* link, swallowing the prose between them into the link text — invisible while the template re-emitted that text verbatim, but content-destroying the moment it did not. The pattern now excludes `[` as well, anchoring each match to its own link.
- **BREAKING: `<skill-root>/evals/evals.json` is now a declaration in the packaging lane too — the default eval-suite convention.** The harness has always defaulted to that path, reading, stripping and grading the suite whether or not a `test:` block exists. The packager did not: without an explicit `test:` block it treated nothing as test input, on the reasoning that VAT should not guess a directory named `evals/` is one. The two lanes therefore disagreed about the same skill, in the dangerous direction — the harness protected the eval signal while the build **packaged and published the answer key**. The convention is now shared, so a skill that follows it needs no config to be protected. The inference is deliberately narrow and both halves are enforced by test: it is keyed on the suite **file** existing, never on a directory's name, and it names exactly `<skill-root>/evals` — a `docs/evals/` elsewhere in the tree still ships, as does a root `evals/` holding no `evals.json`. An explicit `test.evals` still wins. **If you keep a `<skill-root>/evals/evals.json` suite and relied on it shipping, declare its contents through `files:` or move it.**
- **`vat skill test run --dry-run` now builds (when acknowledged).** It previously reused whatever `dist/` already existed and warned the preview might be stale — so what it previewed was not necessarily what a real run would test, which is the one job a preview has. It now builds and stages exactly as a real run would, then stops: no Claude session, no tokens. **The build is gated on `--i-understand-this-runs-skill-code`**, because building runs the repo's committed `test.build` hook — an arbitrary shell command. Without the acknowledgement, `--dry-run` behaves as before (existing dist, stale warning), so it remains the one mode safe to point at an untrusted clone. `--no-build` still skips the build regardless.
- **BREAKING: `${fixturesDir}` now resolves per eval, under that eval's own staged workspace.** Eval-suite isolation (below) removes `<staged>/evals/` from every staged subject — and `fixtures/` is a child of it — so the token, which resolved to `<stagedSkillDir>/<evalsDir>/fixtures`, named a directory that no longer exists. Interpolation is a plain string substitution with no existence check, so a skill declaring `env: { SNAP: "${fixturesDir}/snap.json" }` was handed a dead path and failed in a way that read as a *skill* bug. The token now names `<eval workspace>/fixtures` — where each eval's declared input `files` are staged, and which is also the executor's working directory. **Two consequences:** an eval that declares no input `files` has no workspace and therefore no fixtures directory, so using `${fixturesDir}` there now fails the run at preflight (exit **2**) with a message naming the env key, instead of silently injecting a path to nowhere; and declared `env` values are resolved per eval rather than once per run (the stderr transparency line is still emitted once). Pointing the token back at the suite directory was rejected deliberately — it would hand the executor a sibling path to `evals.json` and reopen the leak this release closes. **This also supersedes a 0.1.39 note** that "fixtures under the skill's `evals/fixtures/` auto-stage with the eval tree": they no longer do, because that tree is no longer staged at all. A fixture reaches the executor only by being declared in its eval's `files` list, which stages it into that eval's workspace. Note this is distinct from [#163](https://github.com/jdutton/vibe-agent-toolkit/issues/163) (eval suites stored *outside* the skill tree), which remains unimplemented.
- **Link syntax inside fenced code blocks and inline code spans is no longer rewritten.** The rewrite pass replays a raw regex over the whole document while the parsed link list comes from mdast, which never yields a link node for code. The two views agreed only by accident: a fenced ``[Guide](refs/guide.md)`` survived merely because no *real* link claimed that href. Let a real link elsewhere in the file point at the same target and the lookup hit, so a skill teaching authored link syntax shipped a lesson pointing at the **packaged** path instead of the one a reader must type — or, for a target that does not ship, stripped the example to bare text. Code ranges are now masked before replacement, in both the inline-link and reference-definition passes, so skipping them is intentional rather than incidental.
- **A stripped link now keeps its own text, and the author's inline formatting.** When two links in one document shared an href, stripping rendered the second one with the **first** link's text: the rewriter keys parsed links by href and lets the first occurrence win, and the strip template read `link.text` from that map. Shipped prose silently swapped one phrase for an unrelated one — VAT's own `vat-skill-review` skill shipped "See cached guidance for a cached copy…" where the author wrote the filename. The rewrite branch never exposed this because it re-emits `link.rawText`, the per-occurrence capture; the strip template now uses the same capture, which also preserves the inline markup the author wrote (``[`foo.yaml`](…)`` strips to `` `foo.yaml` ``, not bare `foo.yaml`). The map is keyed by the full href *including* any `#fragment`, so links that collide there resolve to the same target and same fragment — the display text was the only thing that could differ, and it is now per-occurrence.
- **Eval answer-key leak: `vat skill test` no longer stages a skill's eval suite where the executor under test can read it.** Every subject-resolution route — a plain path, a plugin tree-copy, an npm/url/vendored artifact, and a `packageSkill` dist — used to carry the eval suite (`evals.json` plus its `fixtures/`, including the `expected_output`/`expectations` answer key) into the staged tree the executor runs against, letting a skill under test read its own answer key and pass while demonstrating nothing — silently, and in the direction that makes evals look *more* correct. The harness (`packages/agent-skills/src/skill-test/eval-suite-isolation.ts`) now strips the suite from every staged copy before it is copied onward or content-hashed, and relocates the subject's suite to a VAT-only, mode-`0700` directory outside the harness root; the harness reads the suite from the authored scaffold instead of the staged copy. A canary integration test walks cwd, the sandbox dir, every plugin dir, and the whole harness root at executor-spawn time to guard against regression. `overlayAuthoredEvalSuite` is removed.
- **`resources validate` and `skills validate` now agree on `files:`-declared build artifacts.** A missing target declared under `skills.config.<name>.files` used to downgrade to the info-level `LINK_DEFERRED_ARTIFACT` under `vat skills validate`/`vat skills build`, but still hard-failed as `LINK_BROKEN_FILE` (exit 1) under `vat resources validate` — the two lanes disagreed about the same link. `vat resources validate` now reuses the same skill discovery and `files:` config merge as the skills lane, so a deferred build artifact reports the same `LINK_DEFERRED_ARTIFACT` info notice in both places.
- **`files:` destinations are exempt from the gitignore-leak rule even before the build runs.** A `files:` entry's declared `dest` is now excluded from `LINK_TO_GITIGNORED_FILE`/`LINK_TO_GITIGNORED` regardless of whether it exists on disk yet, in both the skills-packaging lane and the general resources lane. Previously the exemption only applied once the artifact existed on disk, so **building the project could turn a previously-passing `vat skills validate` run red** on its own declared, gitignored build output.
- **`vat skill test run --with`/`--with-optional` now build a companion that maps to a declared skill, instead of staging its raw source (issue [#158](https://github.com/jdutton/vibe-agent-toolkit/issues/158)).** A companion given as `path:<source-dir>` used to be tree-copied verbatim — skipping the `files:` build-artifact injection the subject always gets, so a companion backed by a bundled executable (e.g. a compiled CLI) staged non-functional and could hang the executor at runtime with no diagnostic. A `path:` spec pointing at a declared skill's source directory is now resolved and built exactly like the subject (same `--no-build`/`--dry-run`/security-ack gating): a **required** `--with` companion's build failure fails the run with a clear error; an **optional** `--with-optional` companion falls back to its raw (unbuilt) source only for a *non-destructive* build failure — a `pool`-distribution build, or no build attempted at all (`--no-build`/`--dry-run`) — since a failed `plugin-local` marketplace build first wipes the marketplace output tree, so continuing would stage from a deleted tree; that failure, and a security-acknowledgement, config-load, or build-hook failure, always fails the run instead. A path outside the project's config (npm-packaged, workspace, or undeclared) is unaffected. Each declared skill now builds **at most once per run** — a subject that is also a companion, or several companions sharing one marketplace, no longer trigger duplicate builds. A companion's own `test.build` pre-stage hook now runs too, scoped so the command and its working directory always come from that companion's own config (previously the subject's command could run with a companion's config root as its `cwd`); the one exception is `plugin-local` companions sharing a marketplace, where only the first participant's hook runs, because a single marketplace build serves them all. Under `--no-build`, a **required** `--with` companion with no built dist now hard-fails the run (exit **2**) instead of silently continuing.
- **Tool checks no longer silently pass.** If an eval declared `toolExpectations` but the grader returned no tool verdict, it used to count as a pass; now it's a hard error (exit **1**). Same for a grader tool verdict whose `passed` disagrees with its own sub-checks.
- **No more orphaned `claude` processes on failure.** When one parallel eval failed, in-flight grader/executor children were left running and billing tokens; they're now killed before the harness exits.
- **`vat skill test run` no longer crashes on Windows with `spawn EINVAL`.** On Windows, `claude` resolves to an npm `claude.cmd` shim, and since the Node CVE-2024-27980 fix a bare `child_process.spawn` of a `.cmd` throws `EINVAL` synchronously — so the harness died the instant it tried to launch the headless session (reported by an adopter across cmd.exe, PowerShell, and Git Bash). The `claude` spawn now routes through a new hardened `spawnHardened` helper (exported from `@vibe-agent-toolkit/utils`) that detects `.cmd`/`.bat`/`.ps1` shims and launches them through the shell with per-arg quoting (no injection), reusing the Windows handling `safeExecSync` already had. A Windows-only integration test spawns a real `.cmd` shim (`npm`) to guard against regression. The same latent defect in the internal compat-empirical harness is fixed too.
- **`spawnHeadlessClaude` reaps the child on a spawn `'error'` event.** The `'error'` handler unregistered the child from the orphan-reap set without killing it; it now kills the process tree first, closing a narrow orphan-leak window (no-ops when the child never spawned).
- **`knip` held at `~5.85.0` — 5.86.0+ hard-crashes the `dependency-check` step.** From 5.86.0 onward, knip aborts with `ENOTDIR: not a directory, scandir .../runtime-vercel-ai-sdk/test/llm-regression.test.ts` — it appears to read the `test:llm-regression` package script (`bun test test/llm-regression.test.ts`) and then scan the *file* argument as if it were a directory. This is an uncaught exception, not a finding, so it takes the whole check down rather than reporting anything. Bisected to the 5.85.0 → 5.86.0 boundary; pinned to `~5.85.0` so 5.85.x patches still flow. The newest 5.x line is affected, so the fix path is a `knip` 6 major bump, tracked with the other pending majors. Dev tooling only — no consumer impact.
- **`author.url` in your `plugin.json` is no longer destroyed by the plugin build.** `vat claude plugin build` replaced the whole `author` object with `{name, email}` built from the marketplace `owner`, and Claude's plugin manifest supports `author.url` while VAT's config has no field for it — so an adopter who wrote `author: {name, email, url}` lost the URL on every build with **no config field to restore it**. That is data loss, not a precedence policy. `author` is now merged **per subfield**, and ownership is decided by what the config can express: `name` and `email` come from `owner` (omitting `owner.email` still publishes an author with no email — a deliberate config statement), and every other subfield, `url` included, passes through from `plugin.json` untouched. The `plugins[].author` entries in the generated `marketplace.json` now republish that same merged object instead of rebuilding one from `owner`, so a plugin's manifest and its marketplace listing cannot disagree about who authored it. Two related fixes fall out: the "author disagrees with the marketplace owner" warning now names the specific config-owned subfields that were overridden (and no longer fires merely because `plugin.json` lists its author keys in a different order), and a **non-object** `author` — npm's `"Name <email> (url)"` string form — is still replaced wholesale, now with a warning that says why and shows the object form. See [Who owns which `author` subfield](docs/guides/marketplace-distribution.md#who-owns-which-author-subfield).
- **`vat rag` no longer silently degrades embeddings when the configured model is not BERT-shaped.** The local ONNX embedding provider accepts any HuggingFace model id and loads *that model's own* `vocab.txt` — but then framed every sequence with **hardcoded** BERT special-token ids (`[CLS]`=101, `[SEP]`=102, `[UNK]`=100, `[PAD]`=0). Point it at a RoBERTa/XLM-R derived encoder, whose vocabulary uses `<s>`/`</s>`/`<pad>` at entirely different ids, and 101/102 are arbitrary wordpieces from that vocab while padding is written as `<s>` rather than `<pad>`. Nothing catches it: the vocab file parses, the tensor dimensions match, no exception, no warning — `vat rag index` builds a quietly worse index and `vat rag query` returns plausible-but-degraded results indefinitely. The special-token ids are now **read from the loaded vocabulary** rather than assumed, so a BERT-family model that orders them differently tokenizes *correctly*; and a vocabulary that does not define `[CLS]`/`[SEP]`/`[UNK]`/`[PAD]` at all — the signal that it is byte-level BPE or SentencePiece, which this WordPiece tokenizer cannot handle regardless of ids — now fails at **load** time with an `IncompatibleVocabError` naming the configured model, the vocab file, which tokens were missing, and which tokens were found instead. There is deliberately no flag to bypass the check: a silently-degraded index is worse than one that refused to build.
- **BREAKING: `license: <spdx-id>` in your marketplace config now only accepts identifiers VAT can render in full — the other nine wrote a legally void `LICENSE` file.** `vat claude marketplace publish` vouched for eleven SPDX shortcuts (`mit`, `apache-2.0`, `gpl-2.0`, `gpl-3.0`, `lgpl-2.1`, `lgpl-3.0`, `bsd-2-clause`, `bsd-3-clause`, `isc`, `mpl-2.0`, `unlicense`) but carried real license text for one. Nine fell through to a two-line stub — `This software is licensed under the gpl-3.0 license.` plus a copyright line — and `apache-2.0` emitted only the short-form notice header, which points at the terms instead of stating them. That string was written verbatim as the published marketplace's `LICENSE`, so a `publish` that reported success shipped a distribution whose license file grants nothing; GPL-3.0 §4 and Apache-2.0 §4(a) both require that a complete copy of the License be conveyed with the work. Nothing flagged it, because `isSpdxIdentifier()` returning `true` was exactly the signal that made the value look supported. VAT now only claims the licenses it embeds: `mit` renders as before, and the other ten are still *recognized* — solely so they get a specific error naming the identifier, linking its canonical text on spdx.org, and telling you to set `license` to a file path (`./LICENSE`), which `publish` has always supported. **What to expect:** a config using any shortcut other than `mit` now fails at publish with that message instead of silently producing a void `LICENSE`; download the official text and point `license` at it. Embedding a license is no longer separable from claiming it — the identifier table is *derived* from the table of texts, so an identifier cannot be listed without one, and a test iterates every entry asserting the output is license terms rather than a summary or a notice header. Existing coverage named `mit` and `apache-2.0` only, and the `apache-2.0` test passed against the notice header.
- **`vat audit` no longer reports 179 real Python standard-library modules as third-party dependencies.** The `PYTHON_IMPORT_THIRD_PARTY` scanner classified imports against a hand-typed list of 151 modules labelled "Python 3.10+ standard library" — so a plugin script with `import zoneinfo`, `import pkgutil`, `import array`, `import atexit`, `import binascii`, `import bz2`, `import dbm`, `import fcntl`, `import termios`, `import pty`, `import ntpath`, `import codeop`, `import wsgiref` or `import imghdr` was reported as depending on a third-party package that does not exist. The list is no longer hand-maintained: it is generated from CPython's own `sys.stdlib_module_names`, unioned across Python 3.10–3.14 (a union because modules come and go between releases — `imghdr` and `distutils` exist on 3.10 and were removed by 3.13 — and a script importing one is targeting an older Python, not pulling a dependency), committed as a generated artifact, and checked by tests that iterate the whole table plus an opportunistic cross-check against any local Python 3.10+ interpreter. Regenerate with `bun run generate:python-stdlib` in `packages/claude-marketplace` (needs `uv`). The previous tests could not have caught this: they checked a hand-written list of 31 modules that should be present and 11 packages that should be absent — two hand-written lists checked against a third cannot detect a module nobody thought to name.

### Security

- **Bumped `adm-zip` to `0.6.0`, fixing a path-traversal advisory ([GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85), CVSS 7.5).** `adm-zip` is a direct dependency used at runtime by `@vibe-agent-toolkit/agent-skills`' URL skill source to extract zip archives fetched from skill-source URLs — content that isn't necessarily trusted — so this isn't just a dev-tooling audit fix.
- **Eliminated the vulnerable `protobufjs@6` transitive chain (11 advisories, incl. a 9.8-critical) for every consumer, unconditionally.** It previously entered via `@vibe-agent-toolkit/rag`'s native embedding backend (`@xenova/transformers@2` → `onnxruntime-web@1.14.0` → `onnx-proto` → `protobufjs@^6.8.8`), and reached anyone installing `vibe-agent-toolkit` (the CLI depends on `rag`). Adopters could not override it (`onnx-proto` pins `protobufjs@^6`). Fixed by replacing the native backend with `onnxruntime-web` directly (see BREAKING note above): it resolves the patched `protobufjs@7` line with no `onnx-proto` in between. `onnx-proto`/`protobufjs@6` are absent from the lockfile, for every consumer — not just those who opt out of local embeddings.
- **Swept the remaining transitive advisories via root `package.json` `overrides`.** Patched in-range pins for `undici`, `hono`/`@hono/node-server`, `path-to-regexp`, `qs`, `tar`, `basic-ftp`, `js-yaml`, `form-data`, `fast-uri`, `ip-address`, `express-rate-limit`, `postcss`, `smol-toml`, `yaml`, `flatted`, `lodash`, `rollup`, `vite`, and `vitest`; `handlebars`, `ws`, and `turbo` were bumped in range. Net OSV result on `bun.lock`: **32 vulnerable packages / 120 advisories → 7 / 26**, all remaining ones triaged in `osv-scanner.toml`. (Note: `overrides` harden VAT's own tree; downstream consumers already re-resolve VAT's floating ranges to these patched versions on a fresh install.)
- **Routine dev-toolchain refresh — 19 in-range devDependency bumps, clearing 3 more advisories from the dev tree.** `eslint` `9.39.5`, `@typescript-eslint/*` `8.65.0`, `@types/node` `25.9.5`, `secretlint`/`@secretlint/*` `11.7.1`, `jscpd` `4.2.5`, `tsx` `4.23.1`, `@vitest/coverage-v8` `3.2.7`, plus `rimraf`, `semver`, `eslint-plugin-n`, `eslint-plugin-sonarjs`, and assorted `@types/*`. OSV filtered-advisory count on `bun.lock`: **31 → 28**, still **0 un-triaged**. No runtime dependency changed, so consumer resolution is unaffected. *(`knip` is deliberately held at `~5.85.0` — see the **Fixed** entry. The four pending majors — `zod` 4, `typescript` 7, `vitest` 4, `eslint` 10 — are each a real migration and are excluded from this pass.)*
- **Refreshed the transitive-dependency pins to clear a further 15 advisories, including a 9.2-critical.** `tar` moved to `7.5.22` (five advisories, incl. [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw), CVSS 9.2 — `tar` is a direct dependency of the CLI and extracts archives VAT does not author); `fast-uri` to `3.1.4`, `hono` to `4.12.27`, `js-yaml` to `4.3.0`, `postcss` to `8.5.18`, and a new pin for `body-parser` at `2.3.0`. `sharp` (build-time image tooling) moved to `0.35.3`, picking up the libvips fixes in [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj). Net OSV result on `bun.lock`: **10 vulnerable packages / 20 advisories → 0 / 0** un-triaged. The two that remain un-pinnable — `brace-expansion` (no fix exists in either coexisting major line) and `@hono/node-server` (the vulnerable `serve-static` export is never imported, and the fix is a major bump outside the MCP SDK's declared range) — are documented with their reasoning in `osv-scanner.toml`.
- **The per-run grader nonce is kept off disk and off argv.** The vat-only grader directory is named by an independent random token (not the integrity nonce), and the nonce travels only through the grader's stdin prompt. This closes a window where same-user skill code running with bypassed permissions could read the nonce from the world-listable OS temp-dir name (or a child process's argv) and forge a valid-nonce fragment.
- **The grader's transcript fence is bound to the secret nonce.** The untrusted transcript is fenced between `===BEGIN/END TRANSCRIPT DATA <nonce>===` markers; because the executor never sees the nonce, a prompt-injected skill cannot emit a matching closing delimiter to break out of the fence and have its trailing text read as grader instructions.
- **A skill's `declaredExecutables` strings are fenced too.** They now reach the grader inside the same nonce-bound untrusted-data fence — so a malicious third-party skill can't hide grader instructions in its own `howInvoked`/manifest strings.
- **Grader fragments are consumed on read.** vat unlinks each fragment the instant it reads it, so skill code can't harvest the run's nonce from a leftover file and forge later verdicts. Same-uid caveat: the grader runs as the same OS user as the skill, so this raises the bar but isn't full isolation — running the grader under a separate uid/container is tracked in [#149](https://github.com/jdutton/vibe-agent-toolkit/issues/149).
- **`vat claude org skills install` no longer publishes an eval suite that lives outside `evals/`.** The uploader's answer-key backstop was a hardcoded directory-*name* match (`evals`, `node_modules`, `.git`), so it enforced only the weaker property its own comment disclaimed. The eval suite's location is the adopter's to declare — `skills.config.<name>.test.evals`, of which `evals/evals.json` is merely the default — so a project that declares its suite anywhere else (`fixtures/qa/evals.json`, a bare `answers.json`) uploaded every `expected_output` to its Anthropic org workspace, exited 0, and printed an empty exclusion list: an affirmative report that nothing had been withheld. This was a fourth lane disagreeing with the harness, the packager, and staging about what a skill's test input is. The uploader now resolves the *declared* suite through the same nearest-ancestor config walk-up `vat audit` and `vat skill review` use — anchored on the directory argument, since pointing at a source tree by mistake is the whole scenario this backstop exists for — and withholds the suite unit (its directory, or the single file for a root-level suite) in addition to the name-based exclusions, which remain as the unconditional fail-safe when no config is discoverable. Every withheld path is reported.

### Notes for adopters

- **Fixed: `vat rag index`/`query` no longer exits 134 on macOS.** The previous native embedding backend (`onnxruntime-node`, loaded transitively via `@xenova/transformers`) raced LanceDB's native runtime at process teardown — their static destructors could abort with `libc++abi: mutex lock failed` (SIGABRT, exit 134) **after** the command had already produced correct output. Replacing it with `onnxruntime-web` (WASM, no native addon, no static destructors) removes the race entirely; `vat rag index`/`query` now exits 0 on macOS. The RAG-CLI dogfooding system tests are un-skipped accordingly.
- The `--allow-eval-failure` opt-out (from 0.1.40) also downgrades a **fail-fast-gated** run to exit **0** — consistent with how it downgrades any eval failure, but worth knowing if you gate CI on tiered runs.
- **`mustRun` means *invoked*; use `mustSucceed` for *worked*.** `mustRun` passes as long as the tool ran, even if it errored. If you care that it actually succeeded, use `mustSucceed` (above) — and remember both are transcript-judged, so a swallowed non-zero exit can still read as success.
- **`tool-eval.json` is always written** (`{"evals": []}` when no eval declares `toolExpectations`) so the fail-closed artifact check has something to read — consumers should check `.evals.length`, not file existence.
- A malformed **friction** item from the grader (e.g. a bare string instead of the object shape) is now **dropped with a warning** rather than aborting the run — friction is advisory, so it never discards the verdict-bearing grading. The grader prompt also spells out the friction object shape and scopes friction to packaging fidelity. *(Hardening from real-adopter beta testing of this feature.)*
- **`mustSucceed` is transcript-judged — a captured exit code is the honest ceiling.** Because `Bash` reports `is_error: false` on a swallowed non-zero exit, ground-truth tool success needs a captured/observed exit code. Two fast-follows track the stronger guarantees: nudging the executor to echo exit codes so `mustSucceed` is near-deterministic ([#150](https://github.com/jdutton/vibe-agent-toolkit/issues/150)), and naming the ceiling explicitly alongside separate-uid isolation ([#151](https://github.com/jdutton/vibe-agent-toolkit/issues/151), [#149](https://github.com/jdutton/vibe-agent-toolkit/issues/149)).

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
  - **Merge-readiness: liberal eval-suite schema, macOS subscription-auth fix, expanded skill, first dogfood suite.** (1) `evals.json` is adopter-authored data VAT *reads*, so its schema is now liberal per VAT's Postel's Law: `EvalSuiteSchema`/`EvalEntrySchema` are `.passthrough()` and `id` accepts a descriptive **string** or an int — only the fields VAT consumes (`prompt`, `expected_output`, `expectations`) stay required. This reverses the earlier strict-parser call that rejected real adopter suites three ways (string `id`, `category`, `_category_note`) and restores compatibility for the flagship adopter (app-platform/dxa). The persisted `test:` *config* block stays **strict** (it's VAT-produced config) — the deliberate inverse. (2) **macOS subscription-auth fix:** the harness env allowlist (`buildForwardedEnv`) dropped the POSIX `USER`/`LOGNAME` vars, so on macOS `claude auth status` could not read the login Keychain with the API key scrubbed — `--auth subscription` (and `inherit`'s subscription fallback) wrongly failed preflight, and the experimenter child could not authenticate. `USER`/`LOGNAME` are now forwarded (non-secret; already derivable from the forwarded `HOME`). (3) The `vibe-agent-toolkit:vat-skill-testing` skill gains a research-grounded "Authoring `evals.json`" section (blind realistic prompts, discriminating + negative expectations, categories, fixtures, `--baseline` skill-lift, grading) and a full flag⇄config knob table. (4) Ships the first committed VAT dogfood suite (`vat-skill-review`, 5 evals across catch-violation / no-false-positive / guidance-correctness) wired via `skills.config.vat-skill-review.test`, with eval fixtures excluded from `vat resources validate`.
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
- **Skill-test eval-suite schema hardened after an adversarial review of the Postel liberalization.** Four issues the `id`/passthrough widening introduced or left open, all verified against the real `dxa` adopter suites in `app-platform`:
  - **String eval ids are now validated as filesystem-safe path segments** (`[A-Za-z0-9_-]+`). A string `id` names a per-eval working directory, and the experimenter substitutes it verbatim into `<workspaces>/<id>`; an id like `year:extraction` previously passed parse, then failed on Windows (illegal filename) — surfacing as a *misleading* "escapes the eval directory" copy error. Rejected at parse with a clear message instead. dxa's hyphenated ids (`dollar-quote-recovery`) are unaffected.
  - **Numeric `1` and string `"1"` no longer slip past the uniqueness check.** Ids are deduped on their stringified form, since both name the same workspace directory and would otherwise silently clobber each other's staged files.
  - **A near-miss typo of the optional `files` field is now flagged** (`filez` → "did you mean files?"). Under plain `.passthrough()` such a typo was silently swallowed and the eval ran in an empty workspace. The check is a single-edit match scoped to recognized fields, so legitimate adopter extras (`name`, `category`, `notes`, `_category_note`) still pass through untouched.
  - **`stageEvalWorkspaces` no longer mislabels copy failures as containment escapes.** Containment (`joinUnderRoot`) and the filesystem copy are now in separate try/catch blocks, so a permission/illegal-filename/disk error reports accurately instead of as "escapes the eval directory."
- **Skill-test `expected_output` is now optional, and is fed to the grader as context when present.** The pass/fail verdict is always decided per `expectations` entry, so `expected_output` is no longer required (per Postel's Law) — this unblocks real adopter suites (e.g. `dxa-consumption`) that grade with `expectations` alone. Previously the field was accepted but consumed by nothing; the experimenter prompt now passes it to the grader as the author's prose description of a correct result, informing judgment without becoming a checklist item. Still validated as a non-empty string when present.
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
- **Multi-plugin marketplaces with independent versioning.** Each plugin in a marketplace can now declare its own version (in `plugins/<name>/.claude-plugin/plugin.json:version` or via the marketplace config's per-plugin `version` field), get its own per-plugin source-repo tag (`<plugin>-v<version>`) on `vat claude marketplace publish`, and ship its own CHANGELOG (default `<plugin.source>/CHANGELOG.md`, override via the per-plugin `changelog` field) bundled into the published marketplace at `plugins/<name>/CHANGELOG.md`. The published `marketplace.json` includes `version` per plugin entry when defined. Marketplaces with no per-plugin version inherit the root `package.json:version` (backwards compatible — exercised by integration test scenario 3 against the existing avonrisk-sdlc shape). Unblocks the AvonRiskBuilders marketplace where each topical plugin must version and release independently.

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
- **Final spawn sweep (post-rc.3).** Two independent spawn-eliminations that together recover the rc.2 baseline and beat it for single-config projects. (1) `vat audit` now caches `discoverSkillsFromConfig` by governing-config root, so per-skill walk-up resolution no longer re-expands the same config's globs N times for an N-skill package. (2) `packages/resources/src/link-validator.ts` switched both `gitTracker.isIgnored()` call sites (source + target) to `isIgnoredByActiveSet`, which answers O(1) against the pre-populated active set for in-project paths. Link validation fires per link and skills typically have dozens of links, so this was the largest remaining spawn source in the audit hot path. Post-fix medians (M-series Mac, 3 runs): VAT self `vat audit .` ~2.5s (recovered rc.2 baseline after rc.3's ~12% regression); vibe-validate `vat audit .` 0.96s → ~0.20s (~5x faster); avonrisk-sdlc `vat audit .` 5.43s → ~4.0s. Windows sees roughly 2x these wins since process-spawn overhead there is ~10x higher than on Linux.

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
- `vat-skill-review.md` (formerly `skill-quality-checklist.md`) rewritten with `[A]` / `[VAT]` tags distinguishing Anthropic-aligned items from VAT-opinionated additions. Added gerund-form naming guidance (Anthropic's preferred pattern), frontmatter-key conservatism, cross-skill dependency disclosure, in-package YAML-styling consistency, and large-tables-to-reference-files guidance — all from dogfood findings across 17 real skills (8 avonrisk-sdlc + 1 vibe-validate + 8 VAT dev-agents).
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
- **~4x speedup on monorepo-scale `vat audit`.** `gitCheckIgnoredBatch` (used by the audit walker for every directory it visits) was unconditionally running a per-path `isGitIgnored` fallback after the batch `git check-ignore --stdin` call — spawning one git subprocess per non-ignored path even when the batch's results were authoritative. The fallback now only runs when the batch exits 128 (the fatal "beyond a symbolic link" case it was designed for), per git's documented exit-code semantics. Measurements on the VAT monorepo: `vat audit .` drops from ~30s → ~7s on this laptop. Correctness verified on `avonrisk-sdlc` (which has gitignored symlinks into OneDrive) — audit produces the same zero-error, same-warning output in ~7s.

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

---
name: vat-skill-review
description: Use when reviewing a skill before publication or running `vat skill
  review`. Pre-publication quality checklist grouped into general (all skills)
  and CLI-backed items, tied to VAT validation codes and Anthropic's
  skill-authoring best practices.
---

# Skill Quality Checklist (vat skill review)

Work through this checklist before publishing a skill. Items are grouped into general (all skills) and CLI-backed (skills that bundle and invoke scripts).

This content is also surfaced by the `vat skill review` CLI command, which formats the checklist around a specific skill's validation output.

## Guidance freshness

Skill authoring standards move fast. Before applying this checklist to a non-trivial change:

- Re-fetch the source of `docs/external/anthropic-skill-authoring-best-practices.md` named in its preamble. If the content has shifted, update the cache and this checklist together.
- Web search for the latest Claude Code release notes when trigger semantics, frontmatter rules, or packaging behavior may have changed. Don't rely on training-data recall.
- Promote any manual item below to a programmatic validator when the pattern is detectable from file contents — see the shift-left notes in `packages/vat-development-agents/resources/skills/CLAUDE.md`.

## About this checklist

Items fall into two categories:

- **[A]** items directly mirror Anthropic's official skill-authoring best practices (see the cached guidance or the [live doc](https://platform.claude.com/docs/en/docs/agents-and-tools/agent-skills/best-practices)). These are safe to treat as canonical.
- **[VAT]** items are VAT-opinionated additions not explicitly in Anthropic's doc. They come from adopter experience, corpus observations, or Claude Code behavior changes. Individual teams can override any **[VAT]** item with `validation.severity` or `validation.allow` (with a `reason`).

Tooling enforcement: items marked with a bracketed code (e.g., `[SKILL_DESCRIPTION_FILLER_OPENER]`) are checked by `vat skills validate` / `vat audit`. The rest are judgment calls for a human or agent reviewer.

## General — All Skills

### Naming

- **[A] Name format**: short, specific, lowercase-with-hyphens. Matches what the skill does, not how. `[SKILL_NAME_INVALID]` enforces this.
- **[A] Prefer gerund form** (`processing-pdfs`, `analyzing-spreadsheets`). Anthropic recommends gerund form as the primary pattern — "clearly describes the activity or capability the Skill provides." Noun phrases (`pdf-processing`) and action-oriented forms (`process-pdfs`) are "acceptable alternatives." Avoid vague names like `helper`, `utils`, `tools`.
- **[A] No reserved words `claude` / `anthropic` in the name** — this is the single most consequential naming rule, because it blocks installation, not just style. Anthropic's authoring guidance lists `name` as one that "Cannot contain reserved words: 'anthropic', 'claude'" (their Avoid list names `anthropic-helper`, `claude-tools`), and Claude Code refuses to load a non-certified skill whose `name` contains either word — so a name like `claude-pdf-helper` fails at install/validation, not merely review. `[RESERVED_WORD_IN_NAME]` flags it (warning, so it's catchable before ship). Fix by renaming (`claude-pdf-helper` → `processing-pdfs`); the only escape hatch is a genuinely certified Anthropic distribution, allowed via `validation.severity: { RESERVED_WORD_IN_NAME: ignore }`. When *reviewing* a name that contains these words, always surface the install-blocking consequence — not just that the prefix looks redundant. When *advising* on naming, include this warning explicitly.
- **[VAT] Name matches built skill directory name**: `[SKILL_NAME_MISMATCHES_DIR]` fires when the `name` frontmatter field differs from the parent directory name after build. The schema allows inference from the directory, but explicit mismatches are usually bugs.

### Description

- **[A] Trigger keywords first**: lead with the concepts that should trigger this skill. Anthropic's stated reason is selection pressure, not truncation — "The description is critical for skill selection: Claude uses it to choose the right Skill from potentially 100+ available Skills." Front-loaded trigger terms are what let it pick yours out of that field. `Sprint analysis, velocity tracking, work item queries. Use when ...` beats `This skill is used for when you need to analyze sprints`. (Anthropic never claims Claude truncates descriptions; the 250-char truncation argument is VAT's own and lives in the `[VAT]` item below.)
- **[A] Third-person voice**: Anthropic guidance is unambiguous — "**Always write in third person**. The description is injected into the system prompt, and inconsistent point-of-view can cause discovery problems." Avoid first/second person: `I can help...`, `You can use...`. `[SKILL_DESCRIPTION_WRONG_PERSON]` flags these.
- **[A] `Use when <concrete trigger>` is the recommended pattern** — every Anthropic example uses it after a verb phrase. What's banned is vague variants like `Use when you want to...` / `Use when you need to...` that don't name a concrete trigger.
- **[VAT] Prefer a verb phrase or `Use when ...` opener** — not a meta-description of the skill-as-object. `[SKILL_DESCRIPTION_FILLER_OPENER]` warns on `This skill...`, `A skill that...`, `Used to...` — these waste the first tokens describing the wrapper rather than the behavior. Anthropic doesn't ban these explicitly, but their own examples never use them; VAT is stricter here.
- **[A] Be specific**: include both what the skill does and when to use it. `[DESCRIPTION_TOO_VAGUE]` fires below 50 chars. Anthropic's bad examples — `Helps with documents`, `Processes data`, `Does stuff with files` — are rejected for vagueness, not length.
- **[VAT] Description ≤250 characters**: Claude Code truncates descriptions at 250 characters in the `/skills` listing (since v2.1.86). `[SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT]` warns at 250; `[SKILL_DESCRIPTION_TOO_LONG]` errors at the 1024-char schema hard max. Aim for ≤200 chars for safety; ≤130 chars if shipping a large skill collection (60+ skills) so the total budget fits.
- **[VAT] Description names concrete trigger phrases** — does the description list specific user-said trigger phrases (in quotes) or at least one concrete scenario? `SKILL_DESCRIPTION_NO_CONCRETE_SCENARIO` is intentionally a checklist line: "concrete enough" is judgment, not a regex. Refer to plugin-dev's "Triggering" section for examples.
- **[VAT] Description disambiguates from sibling skills** — if a reviewer only saw this skill's name+description and the names+descriptions of siblings in the same plugin, could an agent reliably pick the right one? Cross-skill semantic comparison is judgment-only — no automated detector for it.

### Body structure

- **[A] SKILL.md body ≤500 lines**: Anthropic recommends keeping SKILL.md under 500 lines. `[SKILL_LENGTH_EXCEEDS_RECOMMENDED]` warns as you approach the limit. Split detailed content into reference files.
- **[VAT] Purpose statement in first 3 lines**: an agent skimming the top of SKILL.md should understand what it does and when to use it without reading further. Anthropic requires this of the *description*, not of the body's opening lines — the first-3-lines rule is VAT's.
- **[VAT] Single responsibility**: the skill does one thing well. If it has multiple unrelated sections, consider splitting into separate skills. Anthropic's closest guidance is organizing content by domain for progressive disclosure; splitting the *skill* is VAT's reading.
- **[A] Consistent terminology**: pick one term per concept and use it throughout. Mixing `artifact` / `bundle` / `package` confuses agents.
- **[A] No time-sensitive content**: `[SKILL_TIME_SENSITIVE_CONTENT]` flags patterns like `as of November 2025` or `after July 2026`. Route deprecated guidance into a clearly labeled `Old patterns` section so agents skip it.

### References and bundled files

- **[A] Every bundled file is referenced**: if a file is in the package, some markdown file should link to it or explain what it is. `[PACKAGED_UNREFERENCED_FILE]` enforces this at build time. Anthropic's grounding, from "Observe how Claude navigates Skills": "**Ignored content:** If Claude never accesses a bundled file, it might be unnecessary **or poorly signaled in the main instructions**." Note that second clause — the remedy is usually to signal the file better, not to delete it. (Anthropic does *not* consider bundle size itself a problem: "Bundle comprehensive resources … no context penalty until accessed." VAT's `[SKILL_TOTAL_SIZE_LARGE]` and `[SKILL_TOO_MANY_FILES]` are maintainability heuristics against that vendor grain — both `[VAT]`, both overridable.)
- **[VAT] Every referenced path is bundled**: the inverse question — does every bundled-subdirectory path the docs *name* (`scripts/setup.mjs`, `references/api.md`) actually exist in the packaged output? `[PACKAGED_REFERENCED_PATH_MISSING]` (warning, built phase) reports the ones that do not, and it is the only check that can see a **build drop**: a reference that is correct in the source repository whose target did not survive into the bundle, so neither human review nor an agent reading the source can catch it. Warning rather than error because it extracts path tokens from prose — measured at 2 misfires in 52 built adopter skills (3.8%), the irreducible class being a skill whose *subject* is skill authoring citing example paths it does not ship. Each finding carries the missing path as its `link`, so waive a single illustrative path via `validation.allow` rather than silencing the whole document.
- **[A] Bundle fits the Skills API upload ceiling**: `[PACKAGED_SIZE_EXCEEDS_API_LIMIT]` (warning, built phase) measures the packaged bundle in **bytes** against Anthropic's documented "Total upload size must be under 30 MB (uncompressed)". Do not confuse it with the two heuristics above: those count lines and files and are VAT opinions the vendor counter-signals; this one is the API's own refusal, and it is the only byte measurement in VAT. A single large binary — a bundled `.wasm` runtime, a model file — has no lines and is one file, so it is invisible to both line and file counters and is the shape that actually blocks a publish. The finding names the largest files, which is usually the whole diagnosis. The ceiling is **30 MiB (31,457,280 bytes)**, measured against the live API rather than read off the docs — a 30,700,000-byte bundle, above the decimal reading, uploads fine. If *this* skill is never published to the Skills API, waive it with a `validation.allow` entry naming the largest file the message reports (each finding carries that file as its `link`); reach for `severity: ignore` only if no skill in the project is API-published, because that turns the check off everywhere. A bundle over the ceiling still installs fine as a Claude Code plugin either way. Read a clean result together with any `[SCAN_PATH_UNREADABLE]` findings from the same build: entries the walk could not weigh make the measured size a lower bound.
- **[A] References one level deep**: link reference files directly from SKILL.md, not via intermediate hubs. Anthropic is explicit — "Keep references one level deep from SKILL.md" — because "Claude may partially read files when they're referenced from other referenced files," using `head -100`-style previews and getting incomplete information. **VAT's tooling is one hop laxer than the vendor here:** `[REFERENCE_TOO_DEEP]` fires only above 2 hops (`MAX_REFERENCE_DEPTH: 2`), so the chain `SKILL.md → advanced.md → details.md` passes validation even though it is Anthropic's own "Bad example: Too deep". A clean `vat audit` therefore does *not* mean you satisfied this item — check depth by hand if you care about the vendor's rule.
- **[A] TOC on reference files >100 lines**: long reference files should include a table of contents at the top. Claude often previews with partial reads — a TOC ensures the full scope of available content is visible.
- **[A] All links resolve**: every `[text](path)` link points to a file that exists. `[LINK_MISSING_TARGET]` and siblings enforce.
- **[A] Name files descriptively**: Anthropic — "Use names that indicate content: `form_validation_rules.md`, not `doc2.md`", and "Organize for discovery" (good: `reference/finance.md`, `reference/sales.md`; bad: `docs/file1.md`, `docs/file2.md`). Not enforced by any validation code; a shift-left candidate awaiting corpus evidence per `docs/validation-rule-design.md`.
- **[VAT] Build clean**: `vat skills build` succeeds and `vat verify` passes with zero errors. This is VAT's own gate — Anthropic has no build step.
- **[A] Test the trigger**: ask "if an agent sees only this name and description, will it know when to load this skill?" If understanding the description requires reading the SKILL.md, the description is wrong.
- **[VAT] Body avoids duplicating reference content** — when the skill bundles `references/`, does SKILL.md teach the agent *when to load each reference*, without repeating the reference's own content? Information should live in either SKILL.md or `references/`, not both. Semantic duplication is judgment, not regex.

### Frontmatter hygiene

- **[VAT] Frontmatter keys stay conservative**: stick to the standard key set (`name`, `description`, `allowed-tools`, `argument-hint`, `metadata`, `license`, `compatibility`, `model`, and the Claude Code behavior flags). `[SKILL_FRONTMATTER_EXTRA_FIELDS]` warns (one issue per field) on anything outside it — a bare project-specific `version:` or `team:` key looks declarative but carries no semantics off your project. Put custom data under the allowed `metadata:` mapping (e.g. `metadata.version`), or per-project VAT config in `vibe-agent-toolkit.config.yaml` — not as a bare top-level key.
- **[VAT] Sibling skills use consistent YAML styling**: within a single skill package, don't mix folded (`description: >-`) and inline (`description: "..."`) string forms. Pick one and apply it to every skill. `[SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE]` flags mixed styles across a package (detector implemented, pipeline wiring pending).

### Cross-skill dependencies

- **[VAT] State cross-skill dependencies in the description**: if this skill delegates auth, pre-flight, or setup to a sibling skill, say so in the description (`Requires ado skill for auth`). Agents may load one without the other; a silent dependency fails mysteriously at runtime. `[SKILL_CROSS_SKILL_AUTH_UNDECLARED]` flags body prose that requires a sibling skill or `ANTHROPIC_*_KEY` env var without naming it in the description.

### Readability

- **[VAT] Large tables move to reference files**: if a table exceeds ~15 rows, move it to a sibling reference file and link from SKILL.md. Long tables compete for context budget and push the main skill content further down.

## CLI-Backed Skills — Additional Checks

These apply to skills that bundle executable scripts and instruct agents to run commands.

- **[A] MCP tool names are fully qualified**: if the skill tells an agent to call an MCP tool, write `ServerName:tool_name` (`BigQuery:bigquery_schema`, `GitHub:create_issue`), never the bare tool name. Anthropic: "Without the server prefix, Claude may fail to locate the tool, especially when multiple MCP servers are available." `[MCP_TOOL_NAME_UNQUALIFIED]` (warning) enforces this automatically. It reports a bare tool name only when the SAME document also spells that tool fully-qualified **in its body prose** — so it never has to guess whether a skill drives MCP, which is what the old "awaiting corpus evidence" caveat here was waiting on. Leading YAML frontmatter is stripped first, so an `allowed-tools:` list of `mcp__…` names is a manifest and does not by itself make a bare name in the body a finding. A line that already spells the tool qualified is exempt per match, so a gloss or a bare-to-qualified mapping table needs no waiver; anything genuinely deliberate (an availability probe, say) is waivable per identifier via `validation.allow`, since each finding carries the bare tool name as its `link`. Re-measured 2026-09-06 with the current detector over 883 documents in two corpora: 7 firing documents, 11 occurrences, 0 false positives, and the authoring project fires 0. Since it only sees tools the document itself names twice, a skill that mentions MCP purely in prose is invisible to it — check those by hand.
- **[NON_PORTABLE_ASSET_REFERENCE] Portable script paths (relative to the skill root)**: bundled scripts/assets are referenced by a skill-relative path (`scripts/run.mjs`), never via an env-var anchor, a host mount point, or an absolute path. The `NON_PORTABLE_ASSET_REFERENCE` code (warning) is a **family of five variants**, each named in its own finding: `claude-plugin-root`, `claude-project-dir`, `claude-skill-dir`, `api-skill-mount` and `absolute-script-path`. `CLAUDE_PLUGIN_ROOT` is Claude-Code-plugin-only and points at the plugin (not the skill), so a `${CLAUDE_PLUGIN_ROOT}/skills/<name>/…` path breaks the moment the skill is mounted standalone (claude.ai upload, API container) — on the user's first invocation. `CLAUDE_SKILL_DIR` is set by Claude Code and expands to **empty** in the API code-execution container, so `node "${CLAUDE_SKILL_DIR}/scripts/x.mjs"` becomes `node "/scripts/x.mjs"`; `api-skill-mount` is the same mistake reversed — that container's literal `/skills/<name>/` hardcoded into a skill, which resolves nowhere in Claude Code. All three spellings of an env-var anchor are matched (`$NAME`, `${NAME}`, and PowerShell's `$env:NAME`). `CLAUDE_PROJECT_DIR` is the exception with no mechanical fix: it denotes the *user's repository*, which no skill-relative path can express — take that location as an explicit parameter with `$CLAUDE_PROJECT_DIR` as a fallback instead of rewriting it. See `vibe-agent-toolkit:vat-skill-authoring` → "Referencing bundled scripts and assets". If an occurrence is an intentional teaching example, allow it with a reason via `validation.allow` — one entry silences the whole family for that file.
- **[VAT] Environment guard**: the skill checks that the CLI binary exists before running commands (e.g., verify `scripts/cli.mjs` is present). Agents should get a clear error, not a cryptic Node.js stack trace.
- **[VAT] Pre-flight auth check**: if the CLI requires credentials or tokens, the skill verifies them before operations. Fail fast with clear guidance on how to authenticate.
- **[VAT] CLI invocation section**: provide exact command patterns with placeholder arguments. Agents copy these verbatim — ambiguous prose gets misinterpreted.
- **[VAT] Error handling guidance**: document what to do when the CLI fails. Which errors are retryable? When should the agent stop and ask the user?
- **[VAT] No bare command names in prose or tables**: agents may try to execute anything that looks like a command. Wrap command references in context or use code blocks with clear framing.
- **[NON_PORTABLE_COMMAND] Cross-platform commands**: bundled commands use portable utilities/flags, not GNU/Linux-only ones. The `NON_PORTABLE_COMMAND` code (warning) flags `timeout` (not on macOS), `grep -P` (use `grep -E`), `sed -i` with no suffix (use `sed -i.bak`), `readlink -f`, and GNU `date -d` automatically — matching only commands in command position, not prose. If an occurrence is an intentional teaching example, allow it with a reason via `validation.allow`.
- **[VAT] `files` config declares CLI binaries**: use `files` entries in `vibe-agent-toolkit.config.yaml` so VAT copies scripts into the skill package at build time. Don't rely on external copy scripts.
- **[VAT] Document bundled assets and templates**: if scripts reference files programmatically (not via markdown links), explain what's bundled and why in the SKILL.md. The consuming agent should understand the full package contents.

## Using This Checklist

This is a living document. When a new failure pattern is discovered in skill authoring, add a checklist item here. The goal is shift-left: catch issues before they ship rather than debugging them in production.

Items marked as checks (not automated validation) are judgment calls that tooling can't fully enforce. An agent or human reviews them manually. Items that *can* be automated are enforced by `vat skills validate` / `vat audit` — their validation-code IDs are shown in brackets above.

When a VAT validation code fires, its `fix:` field will suggest a concrete remediation; this checklist is the reference for the underlying principle. For a walkthrough that combines automated validation with this checklist, run `vat skill review <path>`.

**Source of truth**: [Anthropic's skill-authoring best practices](https://platform.claude.com/docs/en/docs/agents-and-tools/agent-skills/best-practices). See `docs/external/anthropic-skill-authoring-best-practices.md` for a cached copy of the load-bearing portions with the VAT-vs-Anthropic delta called out.

Reviewed against external best practices (Anthropic skill-authoring docs, anthropics/skills repository, Claude Code release notes through 2026-07-30).

<!-- @vendor-claim reviewed=2026-07-30 verify=Re-fetch https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices, diff it against docs/external/anthropic-skill-authoring-best-practices.md, and re-check every [A] label below against what that page actually says -->


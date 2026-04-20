---
name: vat-skill-review
description: Use when reviewing a skill before publication or running `vat skill review`. Pre-publication quality checklist grouped into general (all skills) and CLI-backed items, tied to VAT validation codes and Anthropic's skill-authoring best practices.
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
- **[VAT] Name matches built skill directory name**: `[SKILL_NAME_MISMATCHES_DIR]` fires when the `name` frontmatter field differs from the parent directory name after build. The schema allows inference from the directory, but explicit mismatches are usually bugs.

### Description

- **[A] Trigger keywords first**: lead with the concepts that should trigger this skill. Claude truncates descriptions aggressively — the most important words must come first. `Sprint analysis, velocity tracking, work item queries. Use when ...` beats `This skill is used for when you need to analyze sprints`.
- **[A] Third-person voice**: Anthropic guidance is unambiguous — "**Always write in third person**. The description is injected into the system prompt, and inconsistent point-of-view can cause discovery problems." Avoid first/second person: `I can help...`, `You can use...`. `[SKILL_DESCRIPTION_WRONG_PERSON]` flags these.
- **[A] `Use when <concrete trigger>` is the recommended pattern** — every Anthropic example uses it after a verb phrase. What's banned is vague variants like `Use when you want to...` / `Use when you need to...` that don't name a concrete trigger.
- **[VAT] Prefer a verb phrase or `Use when ...` opener** — not a meta-description of the skill-as-object. `[SKILL_DESCRIPTION_FILLER_OPENER]` warns on `This skill...`, `A skill that...`, `Used to...` — these waste the first tokens describing the wrapper rather than the behavior. Anthropic doesn't ban these explicitly, but their own examples never use them; VAT is stricter here.
- **[A] Be specific**: include both what the skill does and when to use it. `[DESCRIPTION_TOO_VAGUE]` fires below 50 chars. Anthropic's bad examples — `Helps with documents`, `Processes data`, `Does stuff with files` — are rejected for vagueness, not length.
- **[VAT] Description ≤250 characters**: Claude Code truncates descriptions at 250 characters in the `/skills` listing (since v2.1.86). `[SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT]` warns at 250; `[SKILL_DESCRIPTION_TOO_LONG]` errors at the 1024-char schema hard max. Aim for ≤200 chars for safety; ≤130 chars if shipping a large skill collection (60+ skills) so the total budget fits.

### Body structure

- **[A] SKILL.md body ≤500 lines**: Anthropic recommends keeping SKILL.md under 500 lines. `[SKILL_LENGTH_EXCEEDS_RECOMMENDED]` warns as you approach the limit. Split detailed content into reference files.
- **[A] Purpose statement in first 3 lines**: an agent skimming the top of SKILL.md should understand what it does and when to use it without reading further.
- **[A] Single responsibility**: the skill does one thing well. If it has multiple unrelated sections, consider splitting into separate skills.
- **[A] Consistent terminology**: pick one term per concept and use it throughout. Mixing `artifact` / `bundle` / `package` confuses agents.
- **[A] No time-sensitive content**: `[SKILL_TIME_SENSITIVE_CONTENT]` flags patterns like `as of November 2025` or `after July 2026`. Route deprecated guidance into a clearly labeled `Old patterns` section so agents skip it.

### References and bundled files

- **[A] Every bundled file is referenced**: if a file is in the package, some markdown file should link to it or explain what it is. `[PACKAGED_UNREFERENCED_FILE]` enforces this at build time. Dead files confuse agents and waste context.
- **[A] References one level deep**: link reference files directly from SKILL.md, not via intermediate hubs. Claude does partial reads on nested references and may miss content several hops down. `[REFERENCE_TOO_DEEP]` enforces.
- **[A] TOC on reference files >100 lines**: long reference files should include a table of contents at the top. Claude often previews with partial reads — a TOC ensures the full scope of available content is visible.
- **[A] All links resolve**: every `[text](path)` link points to a file that exists. `[LINK_MISSING_TARGET]` and siblings enforce.
- **[A] Build clean**: `vat skills build` succeeds and `vat verify` passes with zero errors.
- **[A] Test the trigger**: ask "if an agent sees only this name and description, will it know when to load this skill?" If understanding the description requires reading the SKILL.md, the description is wrong.

### Frontmatter hygiene

- **[VAT] Frontmatter keys stay conservative**: use only the standard keys `name`, `description`, `allowed-tools` (plus `argument-hint` for slash-command-shaped skills). VAT generates SKILL.md under strict schema — novel keys like project-specific `version:` or `metadata:` fields will be rejected. If you need per-skill config, put it in `vibe-agent-toolkit.config.yaml`, not the frontmatter. `[SKILL_FRONTMATTER_EXTRA_FIELDS]` warns on non-standard keys.
- **[VAT] Sibling skills use consistent YAML styling**: within a single skill package, don't mix folded (`description: >-`) and inline (`description: "..."`) string forms. Pick one and apply it to every skill. `[SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE]` flags mixed styles across a package (detector implemented, pipeline wiring pending).

### Cross-skill dependencies

- **[VAT] State cross-skill dependencies in the description**: if this skill delegates auth, pre-flight, or setup to a sibling skill, say so in the description (`Requires ado skill for auth`). Agents may load one without the other; a silent dependency fails mysteriously at runtime. `[SKILL_CROSS_SKILL_AUTH_UNDECLARED]` flags body prose that requires a sibling skill or `ANTHROPIC_*_KEY` env var without naming it in the description.

### Readability

- **[VAT] Large tables move to reference files**: if a table exceeds ~15 rows, move it to a sibling reference file and link from SKILL.md. Long tables compete for context budget and push the main skill content further down.

## CLI-Backed Skills — Additional Checks

These apply to skills that bundle executable scripts and instruct agents to run commands.

- **[VAT] Environment guard**: the skill checks that the CLI binary exists before running commands (e.g., verify `scripts/cli.mjs` is present). Agents should get a clear error, not a cryptic Node.js stack trace.
- **[VAT] Pre-flight auth check**: if the CLI requires credentials or tokens, the skill verifies them before operations. Fail fast with clear guidance on how to authenticate.
- **[VAT] CLI invocation section**: provide exact command patterns with placeholder arguments. Agents copy these verbatim — ambiguous prose gets misinterpreted.
- **[VAT] Error handling guidance**: document what to do when the CLI fails. Which errors are retryable? When should the agent stop and ask the user?
- **[VAT] No bare command names in prose or tables**: agents may try to execute anything that looks like a command. Wrap command references in context or use code blocks with clear framing.
- **[VAT] Cross-platform commands**: avoid `timeout` (not on macOS), platform-specific `sed` flags, `grep -P`, and other non-portable utilities. If platform-specific, document alternatives.
- **[VAT] `files` config declares CLI binaries**: use `files` entries in `vibe-agent-toolkit.config.yaml` so VAT copies scripts into the skill package at build time. Don't rely on external copy scripts.
- **[VAT] Document bundled assets and templates**: if scripts reference files programmatically (not via markdown links), explain what's bundled and why in the SKILL.md. The consuming agent should understand the full package contents.

## Using This Checklist

This is a living document. When a new failure pattern is discovered in skill authoring, add a checklist item here. The goal is shift-left: catch issues before they ship rather than debugging them in production.

Items marked as checks (not automated validation) are judgment calls that tooling can't fully enforce. An agent or human reviews them manually. Items that *can* be automated are enforced by `vat skills validate` / `vat audit` — their validation-code IDs are shown in brackets above.

When a VAT validation code fires, its `fix:` field will suggest a concrete remediation; this checklist is the reference for the underlying principle. For a walkthrough that combines automated validation with this checklist, run `vat skill review <path>`.

**Source of truth**: [Anthropic's skill-authoring best practices](https://platform.claude.com/docs/en/docs/agents-and-tools/agent-skills/best-practices). See cached guidance for a cached copy of the load-bearing portions with the VAT-vs-Anthropic delta called out.

Reviewed against external best practices (Anthropic skill-authoring docs, anthropics/skills repository, Claude Code release notes through 2026-04-18).

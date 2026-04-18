# Skill Quality Checklist

Work through this checklist before publishing a skill. Items are grouped into general (all skills) and CLI-backed (skills that bundle and invoke scripts).

## General — All Skills

- [ ] **Name**: short, specific, lowercase-with-hyphens. Matches what the skill does, not how.
- [ ] **Description — trigger keywords first**: lead with the concepts that should trigger this skill. Claude truncates descriptions aggressively — the most important words must come first. "Sprint analysis, velocity tracking, work item queries" not "This skill is used for when you need to analyze sprints."
- [ ] **Description — no filler openers, third-person voice**: never start with "This skill...", "A skill that...", "Used to..." — these waste the first tokens on zero-information words. Avoid first/second person ("I can help...", "You can use...") — Anthropic guidance is third person throughout. `Use when <concrete trigger>` is the recommended pattern (matches Anthropic's official skill-description guidance); what's banned is vague filler like `Use when you want to...` or `Use when you need to...` — those don't name a trigger, they just add words.
- [ ] **Description ≤250 characters**: Claude Code truncates descriptions at 250 characters in the `/skills` listing (since v2.1.86). Aim for ≤200 chars for safety; ≤130 chars if shipping a large skill collection (60+ skills) so the total budget fits.
- [ ] **Purpose statement in first 3 lines**: an agent skimming the top of SKILL.md should understand what it does and when to use it without reading further.
- [ ] **SKILL.md body ≤500 lines**: Anthropic recommends keeping SKILL.md under 500 lines. Split detailed content into reference files when approaching the limit.
- [ ] **Single responsibility**: the skill does one thing well. If it has multiple unrelated sections, consider splitting into separate skills.
- [ ] **Consistent terminology**: pick one term per concept and use it throughout. Switching between synonyms ("artifact" vs "bundle" vs "package") confuses agents.
- [ ] **No time-sensitive content**: avoid "as of November 2025" or "use the new API after July 2026". Route deprecated guidance into a clearly labeled "old patterns" section so agents skip it.
- [ ] **Every bundled file is referenced**: if a file is in the package, some markdown file should link to it or explain what it is. Dead files confuse agents and waste context.
- [ ] **References one level deep**: link reference files directly from SKILL.md, not via intermediate hubs. Claude does partial reads on nested references and may miss content several hops down.
- [ ] **TOC on reference files >100 lines**: long reference files should include a table of contents at the top. Claude often previews with partial reads — a TOC ensures the full scope of available content is visible.
- [ ] **All links resolve**: every `[text](path)` link points to a file that exists. Run `vat verify` to check.
- [ ] **Build clean**: `vat skills build` succeeds and `vat verify` passes with zero errors.
- [ ] **Test the trigger**: ask yourself "if an agent sees only this name and description, will it know when to load this skill?" If you need to read the SKILL.md to understand the description, the description is wrong.

## CLI-Backed Skills — Additional Checks

These apply to skills that bundle executable scripts and instruct agents to run commands.

- [ ] **Environment guard**: the skill checks that the CLI binary exists before running commands (e.g., verify `scripts/cli.mjs` is present). Agents should get a clear error, not a cryptic Node.js stack trace.
- [ ] **Pre-flight auth check**: if the CLI requires credentials or tokens, the skill verifies them before operations. Fail fast with clear guidance on how to authenticate.
- [ ] **CLI invocation section**: provide exact command patterns with placeholder arguments. Agents copy these verbatim — ambiguous prose gets misinterpreted.
- [ ] **Error handling guidance**: document what to do when the CLI fails. Which errors are retryable? When should the agent stop and ask the user?
- [ ] **No bare command names in prose or tables**: agents may try to execute anything that looks like a command. Wrap command references in context or use code blocks with clear framing.
- [ ] **Cross-platform commands**: avoid `timeout` (not on macOS), platform-specific `sed` flags, `grep -P`, and other non-portable utilities. If platform-specific, document alternatives.
- [ ] **`files` config declares CLI binaries**: use `files` entries in `vibe-agent-toolkit.config.yaml` so VAT copies scripts into the skill package at build time. Don't rely on external copy scripts.
- [ ] **Document bundled assets and templates**: if scripts reference files programmatically (not via markdown links), explain what's bundled and why in the SKILL.md. The consuming agent should understand the full package contents.

## Using This Checklist

This is a living document. When a new failure pattern is discovered in skill authoring, add a checklist item here. The goal is shift-left: catch issues before they ship rather than debugging them in production.

Items marked as checks (not automated validation) are judgment calls that tooling can't fully enforce. An agent or human reviews them manually. Items that _can_ be automated are already enforced by `vat verify` — this checklist covers the gaps.

Reviewed against external best practices (Anthropic skills documentation, anthropics/skills repository, superpowers conventions, Claude Code release notes through 2026-04-15) before initial publication.

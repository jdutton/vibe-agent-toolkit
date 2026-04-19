# VAT Plugin Skills — Development Guide

This directory ships the `vibe-agent-toolkit` Claude Code plugin. When editing
or creating skills here, follow the boundaries and rules below. The goal is
that each sub-skill has a single, sharp trigger and that they collectively
cover VAT's user-facing surface without overlap.

## Skill inventory and boundaries

| Skill | Owns | Does NOT own | CLI |
|---|---|---|---|
| `vibe-agent-toolkit` (router, `SKILL.md`) | What VAT is, when to use it, routing to sub-skills | Any deep content — keep ≤150 lines, prose-only references to sub-skills | — |
| `vat-adoption-and-configuration` | Project setup, `vibe-agent-toolkit.config.yaml` orientation, repo structure, vibe-validate integration, npm postinstall hook | Per-section config depth (each owning skill covers its own slice) | — |
| `vat-skill-authoring` | `SKILL.md` files: frontmatter, body structure, references, packagingOptions (linkFollowDepth, excludeReferencesFromBundle), validation overrides | TypeScript agent functions, plugin packaging, RAG | — |
| `vat-agent-authoring` | TypeScript portable agents: archetypes (Pure Function Tool, One-Shot LLM Analyzer, Conversational Assistant, External Event Integrator), `agent.yaml`, result envelopes, runtime adapters (Vercel/LangChain/OpenAI/Claude Agent SDK) | SKILL.md authoring, plugin/marketplace config | — |
| `vat-audit` | `vat audit` on plugins/marketplaces/skills/settings; `--compat`, `--exclude`, `--user`, CI usage | What to fix (defer to other skills) | `vat audit` |
| `vat-knowledge-resources` | Markdown collections, `vibe-agent-toolkit.config.yaml` `resources` section, frontmatter schemas, validation modes | RAG indexing (separate skill) | `vat resources validate` |
| `vat-skill-distribution` | `vat build`, `vat verify`, plugin/marketplace config, npm publishing, postinstall hooks, `vat.skills` field | Authoring the SKILL.md itself | `vat build`, `vat verify` |
| `vat-rag` | `vat rag index`, `vat rag query`, native embedding/vector store support, extension points, "contributions welcome" callout | Markdown collection authoring (knowledge-resources owns) | `vat rag` |
| `vat-skill-review` | Pre-publication review rubric, validation-code reference, Anthropic best-practices integration, `vat skill review` command | The validators themselves (live in code) | `vat skill review` |
| `vat-enterprise-org` | Anthropic Admin API: org users, cost/usage, workspace skills, `ANTHROPIC_ADMIN_API_KEY` | Per-user runtime auth | `vat claude org` |

## Cross-cutting: `vibe-agent-toolkit.config.yaml`

This file is multi-skill. Each section is owned by one skill:

| Config section | Owning skill |
|---|---|
| Top-level structure, version, multi-section orientation | `vat-adoption-and-configuration` |
| `skills:` (include, defaults, per-skill config, packagingOptions) | `vat-skill-authoring` |
| `resources:` (collections, schemas, validation modes) | `vat-knowledge-resources` |
| `claude:` (marketplaces, plugins, publish, owner) | `vat-skill-distribution` |

When a skill needs to mention a section it doesn't own, link to the owning skill rather than re-explaining the section.

## Naming rules (programmatic + advisory)

- **Forbidden words in `name`**: `claude`, `anthropic`. Claude Code rejects skills containing these words unless they are official certified skills. Enforced by validator code `RESERVED_WORD_IN_NAME` (warning severity).
- **Prefer CLI-name alignment**: when a skill primarily covers a CLI command, use the same root word (`vat-audit` → `vat audit`, `vat-skill-review` → `vat skill review`). Discovery hook for users running `--help`.
- **Kebab-case**, lowercase letters, digits, hyphens. Matches `^[a-z][a-z0-9-]*$`.
- **No vague nouns**: `vat-resources` was renamed to `vat-knowledge-resources` because "resources" alone could mean anything. Each name should carry its subject.
- **No platform names** unless certified: see forbidden words rule above. Say "enterprise" not "claude" / "anthropic".

## Description quality

A description must let Claude Code trigger correctly. Required elements:
- **Action verb or "Use when..."** opener
- **Subject** (what kind of work fires this skill)
- **2-4 trigger keywords** (the words a user is likely to use)
- **What it covers** (one short clause)
- ≤250 chars total (Claude Code listing truncates at 250)

Example (`vat-audit`):
> Use when running `vat audit` to validate Claude plugins, marketplaces, or skills. Covers the audit command, `--compat` for surface compatibility, `--exclude` for noise filtering, and interpreting findings.

Triggers on: "audit my plugin", "validate plugin compatibility", "what does this audit warning mean".

## Router skill (`SKILL.md` / `vibe-agent-toolkit`) — special rules

The router exists for **discovery + routing**, not content. Strict rules:

1. **≤150 lines total**
2. **Prose references to sub-skills** — never markdown links: write `vibe-agent-toolkit:vat-audit`, not `[vat-audit](./vat-audit.md)`. Markdown links cause VAT's packager to transclude the sibling, bloating the bundle.
3. **No code examples beyond a 5-line CLI overview** — depth lives in sub-skills
4. **Description triggers entry questions** ("what is VAT", "how do I get started"), not specific tasks

Verify after edits: `vat skill review packages/vat-development-agents/resources/skills` should report `fileCount: 1` (no transclusion).

## Single-responsibility — when to split

Split a skill when its description must list two unrelated subjects to trigger correctly. Example: the original `vat-authoring` covered both SKILL.md files and TypeScript agent functions — two distinct mental models, hence the split into `vat-skill-authoring` and `vat-agent-authoring`.

## Contributor vs user content

This plugin is for **users of VAT**. Contributor-facing material (debugging VAT internals, designing install architecture, working on the codebase) belongs in `docs/contributing/`, not in a SKILL.md here. The root CLAUDE.md routes contributors to those docs.

If a skill description says "use when developing/contributing to VAT", it doesn't belong in this directory.

## This area moves fast — verify current standards

Skill authoring, agent design, and Claude Code's own skill-loading semantics are evolving rapidly. Cached guidance under `docs/external/` (e.g. `anthropic-skill-authoring-best-practices.md`) ages quickly. Before making non-trivial changes:

- Re-fetch the source URL named in the cached doc's preamble; diff against the cache; if material has changed, update the cache and propagate the delta into validators and `vat-skill-review`.
- Web search for the latest Claude Code release notes when changing trigger semantics, frontmatter rules, or packaging behavior. Don't rely on training-data recall.
- The `vat-skill-review` skill must carry this same instruction explicitly — it's the skill agents load when they're about to apply quality standards.

## Shift left — every manual check is a future validator

When a quality issue is caught manually (in code review, by the user noticing an error from Claude Code, or via a checklist walkthrough), treat it as a candidate for **promotion to a programmatic validator**. The bar is: if the issue has a clear pattern that can be detected from the file contents, it should not stay a manual check.

**Canonical example**: the `RESERVED_WORD_IN_NAME` rule. The `claude`/`anthropic` naming restriction was discovered through an install-time rejection — the kind of failure a developer hits once, remembers forever, but new contributors keep re-hitting. Encoding it as a validator (warning severity, fires at `vat audit` / `vat skills validate` time) shifts the discovery left from "Claude Code rejects my install" to "validator warns me before I commit."

When you add a validator:
1. Register the code in `validation-rules.ts` with severity, message template, fix hint, and a `reference` pointer to the rationale (often a section of `vat-skill-review` or external doc)
2. Wire it into the appropriate validator pipeline (frontmatter, link, packaging) so it actually fires
3. Add a checklist entry in `vat-skill-review` that references the same code (so the manual rubric and the automated check stay aligned)
4. Default severity is **warning** unless the issue genuinely blocks distribution — even then, prefer warning + clear fix hint per the [skill-smell philosophy](../../../docs/skill-smell-philosophy.md)

When `vat-skill-review` lists a checklist item that is currently a `[ ]` manual judgment call, ask: *can this be detected programmatically?* If yes, file a follow-up to add the validator and convert the manual item to an automated reference.

## Pre-commit checks

Before committing a skill change:

```bash
# Review the specific skill you touched
bun run vat skill review packages/vat-development-agents/resources/skills/<skill>.md

# Audit the whole plugin
bun run vat audit packages/vat-development-agents

# Full validation
bun run validate
```

Watch for:
- `RESERVED_WORD_IN_NAME` (warning) — naming policy violation
- `SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT` — trim to ≤250 chars
- `SKILL_DESCRIPTION_FILLER_OPENER` — start with action verb or "Use when"
- `SKILL_NAME_MISMATCHES_DIR` (should not fire — generic-container exemption applies here)
- `LINK_TO_NAVIGATION_FILE` — link to specific files, not READMEs
- `LINK_TARGETS_DIRECTORY` — link to specific files, not directories

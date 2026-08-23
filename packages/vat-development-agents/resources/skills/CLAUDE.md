# VAT Plugin Skills — Development Guide

This directory ships the `vibe-agent-toolkit` Claude Code plugin. Follow the
boundaries below so each sub-skill keeps a single, sharp trigger and the set
covers VAT's user-facing surface without overlap.

## Skill inventory and boundaries

| Skill | Owns | Does NOT own | CLI |
|---|---|---|---|
| `vibe-agent-toolkit` (router, `SKILL.md`) | What VAT is, when to use it, routing to sub-skills | Any deep content (see "Router skill" rules below) | — |
| `vat-adoption-and-configuration` | Project setup, `vibe-agent-toolkit.config.yaml` orientation, repo structure, vibe-validate integration, npm postinstall | Per-section config depth (see below) | — |
| `vat-skill-authoring` | `SKILL.md` files: frontmatter, body structure, references, packagingOptions, validation overrides | TypeScript agent functions, plugin packaging, RAG | — |
| `vat-agent-authoring` | TypeScript portable agents: archetypes, `agent.yaml`, result envelopes, runtime adapters | SKILL.md authoring, plugin/marketplace config | — |
| `vat-audit` | `vat audit` on plugins/marketplaces/skills/settings: `--compat`, `--exclude`, `--user`, CI usage | What to fix (defer elsewhere) | `vat audit` |
| `vat-knowledge-resources` | Markdown collections, `resources:` config section, frontmatter schemas, validation modes | RAG indexing (separate skill) | `vat resources validate` |
| `vat-skill-distribution` | `vat validate`, `vat build`, `vat verify`, plugin/marketplace config, npm publishing, `vat.skills` field | Authoring the SKILL.md itself | `vat validate`, `vat build`, `vat verify` |
| `vat-rag` | `vat rag index`, `vat rag query`, native embedding/vector store support, extension points | Markdown collection authoring (knowledge-resources owns) | `vat rag` |
| `vat-skill-review` | Pre-publication review rubric, validation-code reference, best-practices integration | The validators themselves (live in code) | `vat skill review` |
| `vat-enterprise-org` | Anthropic Admin API: org users, cost/usage, workspace skills, `ANTHROPIC_ADMIN_API_KEY` | Per-user runtime auth | `vat claude org` |
| `coherence-audit` | Auditing a subsystem's internal consistency: one-contract question, failure-direction tell, bounding a class honestly, testing the tests, vendor-claim staleness | VAT-specific rules or CLI behavior (deliberately generic) | — |

## Cross-cutting: `vibe-agent-toolkit.config.yaml`

This file is multi-skill. Each section is owned by one skill:

| Config section | Owning skill |
|---|---|
| Top-level structure, version, multi-section orientation | `vat-adoption-and-configuration` |
| `skills:` (include, defaults, per-skill config, packagingOptions) | `vat-skill-authoring` |
| `resources:` (collections, schemas, validation modes) | `vat-knowledge-resources` |
| `claude:` (marketplaces, plugins, publish, owner) | `vat-skill-distribution` |

When a skill mentions a section it doesn't own, link to the owning skill rather than re-explain it.

## Naming rules

- **Forbidden words in `name`**: `claude`, `anthropic` (say "enterprise" instead). Claude Code rejects non-certified skills using them; `RESERVED_WORD_IN_NAME` (warning) enforces it.
- **Prefer CLI-name alignment**: reuse the CLI command's root word (`vat-audit` → `vat audit`) for `--help` discovery.
- **Kebab-case**: lowercase letters, digits, hyphens — `^[a-z][a-z0-9-]*$`.
- **No vague nouns**: name should carry its subject (`vat-resources` → `vat-knowledge-resources`).

## Description quality

Required elements for reliable triggering:
- **Action verb or "Use when..."** opener
- **Subject** — what work fires this skill
- **2-4 trigger keywords** a user is likely to type
- **What it covers** (one short clause)
- ≤250 chars total (Claude Code truncates at 250)

Example (`vat-audit`): "Use when running `vat audit` to validate Claude plugins or skills. Covers `--compat`, `--exclude`, and interpreting findings."

## Router skill (`SKILL.md` / `vibe-agent-toolkit`) — special rules

The router exists for **discovery + routing**, not content. Strict rules:

1. **≤150 lines total**
2. **Prose references to sub-skills**, never markdown links: `vibe-agent-toolkit:vat-audit`, not `[vat-audit](./vat-audit.md)` — markdown links make the packager transclude the sibling, bloating the bundle.
3. **No code examples beyond a 5-line CLI overview** — depth lives in sub-skills
4. **Description triggers entry questions** ("what is VAT?"), not specific tasks

Verify: `vat skill review packages/vat-development-agents/resources/skills` should report `fileCount: 1` (no transclusion).

## Single-responsibility — when to split

Split a skill when its description must list two unrelated subjects to trigger correctly — e.g. `vat-authoring` (SKILL.md files + TypeScript agents) split into `vat-skill-authoring` and `vat-agent-authoring`.

## Contributor vs user content

This plugin is for **users of VAT**, not contributors — debugging internals, install architecture, and codebase work belong in `docs/contributing/`. A description like "use when developing/contributing to VAT" doesn't belong here.

## This area moves fast — verify current standards

Skill authoring, agent design, and Claude Code's own skill-loading semantics are evolving rapidly. Cached guidance under `docs/external/` (e.g. `anthropic-skill-authoring-best-practices.md`) ages quickly. Before making non-trivial changes:

- Re-fetch the source URL named in the cached doc's preamble; diff against the cache; if material has changed, update the cache and propagate the delta into validators and `vat-skill-review`.
- Web search for the latest Claude Code release notes when changing trigger semantics, frontmatter rules, or packaging behavior. Don't rely on training-data recall.
- The `vat-skill-review` skill must carry this same instruction explicitly — it's the skill agents load when they're about to apply quality standards.

## Shift left — every manual check is a future validator

When a quality issue is caught manually (in code review, by the user noticing an error from Claude Code, or via a checklist walkthrough), treat it as a candidate for **promotion to a programmatic validator**. The bar is: if the issue has a clear pattern that can be detected from the file contents, it should not stay a manual check.

**Canonical example**: the `RESERVED_WORD_IN_NAME` rule. The `claude`/`anthropic` naming restriction was discovered through an install-time rejection — the kind of failure a developer hits once, remembers forever, but new contributors keep re-hitting. Encoding it as a validator (warning severity, fires at `vat audit` / `vat skills validate` time) shifts the discovery left from "Claude Code rejects my install" to "validator warns me before I commit."

When you add a validator:
1. Register the code in `packages/schema/src/validation-codes.ts` (the `CODE_REGISTRY`) with default severity, description, fix hint, and a `reference` anchor into `docs/validation-codes.md`
2. Wire it into the appropriate validator pipeline (frontmatter, link, packaging) so it actually fires
3. Add a checklist entry in `vat-skill-review` that references the same code (so the manual rubric and the automated check stay aligned)
4. Default severity is **warning** unless the issue genuinely blocks distribution — even then, prefer warning + clear fix hint per the [validation-rule-design policy](../../../../docs/validation-rule-design.md)

When `vat-skill-review` lists a checklist item that is currently a `[ ]` manual judgment call, ask: *can this be detected programmatically?* If yes, file a follow-up to add the validator and convert the manual item to an automated reference.

## Pre-commit checks

Before committing a skill change:

```bash
# Review the touched skill
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
- `SKILL_NAME_MISMATCHES_DIR` — shouldn't fire here (generic-container exemption applies)
- `LINK_TO_NAVIGATION_FILE` — link to specific files, not READMEs
- `LINK_TARGETS_DIRECTORY` — `files:` sources must be a file, not a directory (other directory links are fine)

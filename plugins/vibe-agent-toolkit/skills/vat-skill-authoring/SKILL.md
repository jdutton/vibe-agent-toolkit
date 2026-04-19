---
name: vat-skill-authoring
description: Use when authoring or revising a SKILL.md file — frontmatter, body structure, references, packagingOptions (linkFollowDepth, excludeReferencesFromBundle), and validation overrides. Paired with vat-skill-review for pre-publication checks.
---

# VAT Skill Authoring: SKILL.md Structure and Packaging

This skill covers authoring SKILL.md files for portable Claude skills: frontmatter shape, body structure, reference links, and the packaging options that control how the skill is bundled for distribution. For the TypeScript agent side (archetypes, result envelopes, orchestration, runtime adapters) use `vibe-agent-toolkit:vat-agent-authoring`.

## SKILL.md Structure

A SKILL.md file is the definition file for a portable skill. It tells Claude what the skill does and how to use it. All SKILL.md files must have YAML frontmatter:

```markdown
---
name: my-skill
description: One sentence — what this skill does and when to use it (≤250 chars)
---

# My Skill

Rest of the skill documentation...
```

Required frontmatter fields:

- `name` — unique identifier, kebab-case (`^[a-z][a-z0-9-]*$`), matches the skill's directory name after build. Avoid the reserved words `claude` and `anthropic` (Claude Code rejects non-certified skills using those words — surfaced as `RESERVED_WORD_IN_NAME`).
- `description` — trigger description used for Claude's skill routing; be specific about activation conditions.

Best practices for `description`:

- Lead with an action verb or `Use when <concrete trigger>` — filler openers like "This skill...", "A skill that...", "Use when you want to..." fire `SKILL_DESCRIPTION_FILLER_OPENER`.
- Include 2–4 trigger keywords a user is likely to type.
- Write in third person. First-person ("I can...") and conversational second-person ("You can use...") fire `SKILL_DESCRIPTION_WRONG_PERSON`.
- Keep under 250 characters so the Claude Code `/skills` listing doesn't truncate the tail (target ≤200 for safety, ≤130 if shipping a large skill collection). The hard schema limit is 1024.

## Body Structure

- Lead with a short orientation paragraph: what the skill owns and when to reach for it.
- Use H2 sections for major content blocks; avoid deeply nested H3/H4 trees — they hurt Claude's ability to route attention inside the file.
- Keep SKILL.md under ~500 lines. Longer than that fires `SKILL_LENGTH_EXCEEDS_RECOMMENDED` and is a strong signal to split via progressive disclosure (linked reference files) or to spin the content into a sibling skill.
- Avoid time-sensitive phrasing like "as of April 2026" in the body — it ages the skill quickly (`SKILL_TIME_SENSITIVE_CONTENT`).

## References Section

A short `## References` section at the bottom is the canonical place to list linked resources. Two patterns:

- **Progressive disclosure** — link to `.md` files inside the skill directory that get bundled. Keep reference depth ≤ 2 hops; deeper chains fire `REFERENCE_TOO_DEEP`.
- **Prose references to sibling skills** — write `vibe-agent-toolkit:vat-audit`, not `[vat-audit](./vat-audit.md)`. Markdown links to sibling SKILL.md files cause the packager to transclude the other skill (and fire `LINK_TO_SKILL_DEFINITION`).

Avoid linking to navigation files (`README.md`, `index.md`) — they're excluded from the bundle and the link resolves to nothing (`LINK_TO_NAVIGATION_FILE`).

## packagingOptions Reference

Packaging options are configured per skill in `vibe-agent-toolkit.config.yaml` under `skills.config.<name>`:

```yaml
skills:
  include: ["resources/skills/SKILL.md", "resources/skills/*.md"]
  defaults:
    linkFollowDepth: 2
  config:
    my-skill:
      linkFollowDepth: 1
      resourceNaming: resource-id
      stripPrefix: knowledge-base
      excludeReferencesFromBundle:
        rules:
          - patterns: ["**/concepts/**"]
            template: "Use search to find: {{link.text}}"
        defaultTemplate: "{{link.text}} (search knowledge base)"
```

**`linkFollowDepth`** — How deep to follow links from SKILL.md:

| Value | Behavior |
|-------|----------|
| `0` | Skill file only (no links followed) |
| `1` | Direct links only |
| `2` | Direct + one transitive level **(default)** |
| `"full"` | Complete transitive closure |

**`resourceNaming`** — How bundled files are named:

| Strategy | Example | Use When |
|----------|---------|----------|
| `basename` | `overview.md` | Few files, unique names **(default)** |
| `resource-id` | `topics-quickstart-overview.md` | Many files, flat output |
| `preserve-path` | `topics/quickstart/overview.md` | Preserve structure |

Use `stripPrefix` to remove a common directory prefix (e.g., `"knowledge-base"`).

**`excludeReferencesFromBundle`** — Rules for excluding files and rewriting their links:

- `rules[]` — ordered glob patterns (first match wins), each with optional Handlebars template
- `defaultTemplate` — applied to depth-exceeded links not matching any rule

**Template variables:**

| Variable | Description |
|----------|-------------|
| `{{link.text}}` | Link display text |
| `{{link.href}}` | Original href (without fragment) |
| `{{link.fragment}}` | Fragment including `#` prefix, or empty |
| `{{link.type}}` | Link type (`"local_file"`, etc.) |
| `{{link.resource.id}}` | Target resource ID (if resolved) |
| `{{link.resource.fileName}}` | Target filename (if resolved) |
| `{{skill.name}}` | Skill name from frontmatter |

## Validation Overrides

The `validation` sub-key in a skill's config provides the unified override framework for VAT validation codes:

```yaml
skills:
  config:
    my-skill:
      validation:
        severity:
          LINK_DROPPED_BY_DEPTH: error           # upgrade: block on depth-dropped links
          LINK_TO_NAVIGATION_FILE: ignore        # silence: this skill intentionally links to READMEs
        allow:
          PACKAGED_UNREFERENCED_FILE:
            - paths: ["templates/runtime.json"]
              reason: "consumed programmatically at runtime"
              expires: "2026-09-30"
          SKILL_LENGTH_EXCEEDS_RECOMMENDED:
            - reason: "whole-skill concern; paths defaults to ['**/*']"
```

Two sub-keys, each covering a different override granularity:

- **`severity`** — class-level. Raise any code to `error` (blocks build), lower to `warning` (emits, non-blocking), or `ignore` (fully suppressed). Applies to every instance of that code.
- **`allow`** — per-instance. Suppress specific `(code, path)` matches with a required `reason` and optional `expires` date. `paths` is optional (defaults to `["**/*"]` — the whole skill). Use for legitimate exceptions that don't warrant code-wide silencing.

Common adjustments:

- Downgrade `LINK_DROPPED_BY_DEPTH` to `ignore` when intentionally linking out to external docs.
- Allow specific files under `PACKAGED_UNREFERENCED_FILE` when they're consumed programmatically by CLI scripts at runtime.
- Raise `ALLOW_EXPIRED` to `error` for zero-tolerance expiry policies.

Expired `allow` entries still apply — VAT emits `ALLOW_EXPIRED` as a reminder rather than silently re-surfacing the underlying issue (no surprise build breaks when a date passes). Unused `allow` entries surface as `ALLOW_UNUSED` (analogous to ESLint's unused-disable).

`vat audit` is advisory: it applies `severity` for display grouping only, ignores `allow`, and always exits 0. Use `vat skills validate` or `vat skills build` for gated checks.

## Pre-publication Check

Before shipping a skill, walk through the `vibe-agent-toolkit:vat-skill-review` checklist — it covers naming, description quality, structure, validation-code triage, and Anthropic's skill-authoring best practices. The `vat skill review <skill>` CLI command renders a skill-specific view of the same checklist.

## References

- `vibe-agent-toolkit:vat-skill-review` — pre-publication quality checklist (general + CLI-backed items, tied to VAT validation codes)
- `vibe-agent-toolkit:vat-skill-distribution` — plugin/marketplace config, `vat build`, `vat verify`, npm publishing
- `vibe-agent-toolkit:vat-knowledge-resources` — the `resources:` config section for multi-collection frontmatter schema validation
- Validation Codes Reference — full list of codes VAT emits, their default severity, and override recipes.
- Skill Quality and Compatibility — VAT's Stance — what VAT believes makes a skill good and compatible.

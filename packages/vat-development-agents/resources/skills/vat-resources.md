---
name: vibe-agent-toolkit-resources
description: Use when working with VAT resource collections, per-directory frontmatter schema validation, link validation, or the vat resources command. Covers collection configuration, schema mapping, and validation modes.
---

# VAT Resources: Collections & Frontmatter Validation

## What Resource Collections Are

A **resource collection** is a named group of files that share a validation schema.
Collections are defined in `vibe-agent-toolkit.config.yaml` and enable different
directories to have different required frontmatter — without writing a single line of code.

## Config Format

```yaml
version: 1

resources:
  collections:
    # Name your collection to match the doc type
    systems:
      include: ["docs/systems/**/*.md"]
      exclude: ["docs/systems/README.md"]   # exclude human-only ToCs
      validation:
        frontmatterSchema: "schemas/system.schema.json"
        mode: permissive    # required fields enforced; extra fields allowed

    adrs:
      include: ["docs/architecture/adr/**/*.md"]
      validation:
        frontmatterSchema: "schemas/adr.schema.json"
        mode: permissive

    skills:
      include: ["**/SKILL.md"]
      validation:
        frontmatterSchema: "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"
        mode: strict         # SKILL.md: no extra fields beyond spec
```

## Validation Modes

| Mode | Required fields | Extra fields | Use for |
|---|---|---|---|
| `permissive` | Enforced | Allowed | Docs with project-specific extras |
| `strict` | Enforced | Error | SKILL.md, API specs, tightly controlled schemas |

## Running Validation

```bash
# Validate all collections (reads vibe-agent-toolkit.config.yaml)
vat resources validate

# Validate specific collection only
vat resources validate --collection systems

# Validate with extra schema (adds to collection schemas)
vat resources validate --frontmatter-schema ./extra.json
```

## A File Can Belong to Multiple Collections

If a file matches multiple `include` patterns, **all matching schemas are validated**.
Validation fails if any schema fails.

## Schema Path Formats

```yaml
frontmatterSchema: "./schemas/system.schema.json"          # relative to config
frontmatterSchema: "/absolute/path/schema.json"            # absolute
frontmatterSchema: "@vibe-agent-toolkit/agent-skills/..."  # npm package export
```

## Adding a New Doc Type

1. Create `schemas/<type>.schema.json` with `required` fields
2. Add a collection entry in `vibe-agent-toolkit.config.yaml`
3. Run `vat resources validate` — any existing docs missing required fields will be flagged
4. Fix frontmatter in existing docs, then CI is clean

## Validation Output

```yaml
status: success
filesScanned: 47
collections:
  systems:
    resourceCount: 7
    hasSchema: true
    validationMode: permissive
  adrs:
    resourceCount: 12
    hasSchema: true
    validationMode: permissive
duration: 234ms
```

Errors appear in stderr with `file:line: message` format for editor navigation.

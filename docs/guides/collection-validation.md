# Per-Collection Resource Validation

> Validate frontmatter in markdown files using JSON Schemas, organized by collections

## Overview

The resources package supports per-collection frontmatter validation, allowing you to:
- Group markdown files into collections (guides, documentation, skills, etc.)
- Define frontmatter schemas per collection
- Validate frontmatter fields, types, and patterns
- Choose strict or permissive validation modes

**Real-world example**: This toolkit uses collections to validate its own documentation, guides, and package READMEs.

## Quick Start

### 1. Define Collections in Config

Create `vibe-agent-toolkit.config.yaml` at project root:

```yaml
version: 1
resources:
  collections:
    guides:
      pattern: "docs/guides/**/*.md"
      validation:
        frontmatterSchema: "schemas/guide-frontmatter.json"
        mode: strict  # No extra fields allowed

    documentation:
      pattern: "docs/**/*.md"
      validation:
        frontmatterSchema: "schemas/doc-frontmatter.json"
        mode: permissive  # Extra fields allowed

    skills:
      pattern: "**/*-SKILL.md"
      validation:
        frontmatterSchema: "schemas/skill-frontmatter.json"
        mode: strict
```

### 2. Create JSON Schemas

**Example: `schemas/guide-frontmatter.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["title", "category"],
  "additionalProperties": false,
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "description": "Guide title"
    },
    "category": {
      "enum": ["getting-started", "advanced", "reference"],
      "description": "Guide category"
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Optional tags"
    }
  }
}
```

**Example: `schemas/skill-frontmatter.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["name", "description", "version"],
  "additionalProperties": false,
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9-]+$",
      "description": "Skill name in kebab-case"
    },
    "description": {
      "type": "string",
      "minLength": 20,
      "description": "Clear description (min 20 chars)"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Semantic version (e.g., 1.0.0)"
    }
  }
}
```

### 3. Add Frontmatter to Markdown Files

**Example: `docs/guides/getting-started.md`**

```markdown
---
title: Getting Started with VAT
category: getting-started
tags: [beginner, setup]
---

# Getting Started

Your guide content here...
```

### 4. Validate

```bash
vat resources validate

# Output shows any frontmatter validation errors:
# docs/guides/advanced-guide.md:1:1: error: Frontmatter validation failed for 'category' (got: "advanced-topics"). Expected one of: "getting-started", "advanced", "reference"
```

## Validation Modes

### Strict Mode (`mode: strict`)

**Behavior**: Only fields defined in schema are allowed. Extra fields cause validation errors.

**Use when**: You want tight control over frontmatter structure (skills, API docs, structured content).

**Schema requirement**: Set `"additionalProperties": false`

**Example error**:
```
error: Frontmatter validation failed for '(root)'. Additional property 'custom_field' is not allowed
```

### Permissive Mode (`mode: permissive`)

**Behavior**: Fields defined in schema are validated, but extra fields are allowed.

**Use when**: You want flexibility for team-specific metadata while enforcing minimum requirements.

**Schema requirement**: Omit `"additionalProperties"` or set to `true`

**Example**: Documentation with required title/description, but teams can add custom fields:

```yaml
collections:
  documentation:
    pattern: "docs/**/*.md"
    validation:
      frontmatterSchema: "schemas/doc-frontmatter.json"
      mode: permissive  # Allow custom fields
```

```markdown
---
title: My Doc
description: Overview
custom_team_field: value  # Allowed in permissive mode
---
```

## Multi-Collection Support

A resource can belong to multiple collections if it matches multiple patterns:

```yaml
resources:
  collections:
    all-docs:
      pattern: "docs/**/*.md"
      validation:
        frontmatterSchema: "schemas/base-doc.json"
        mode: permissive

    guides:
      pattern: "docs/guides/**/*.md"
      validation:
        frontmatterSchema: "schemas/guide-frontmatter.json"
        mode: strict
```

A file like `docs/guides/setup.md` matches both collections and must satisfy both schemas.

## Schema Patterns

### Minimum Required Fields

Most common pattern - require essential fields, allow extras:

```json
{
  "type": "object",
  "required": ["title", "description"],
  "properties": {
    "title": { "type": "string", "minLength": 1 },
    "description": { "type": "string" }
  }
}
```

Use with `mode: permissive` to allow custom fields.

### Enum Validation

Restrict fields to specific values:

```json
{
  "properties": {
    "status": {
      "enum": ["draft", "review", "published", "archived"]
    },
    "priority": {
      "enum": ["low", "medium", "high"]
    }
  }
}
```

### Pattern Validation

Enforce formats like kebab-case, semantic versions, URLs:

```json
{
  "properties": {
    "slug": {
      "type": "string",
      "pattern": "^[a-z0-9-]+$",
      "description": "URL-friendly slug (kebab-case)"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "source_url": {
      "type": "string",
      "format": "uri"
    }
  }
}
```

### Length Constraints

Ensure descriptions are meaningful:

```json
{
  "properties": {
    "description": {
      "type": "string",
      "minLength": 20,
      "maxLength": 500
    }
  }
}
```

## Error Messages

Validation errors show **actual values** and **expected values**:

```
docs/guides/invalid.md:1:1: error: Frontmatter validation failed for 'category' (got: "invalid-category"). Expected one of: "getting-started", "advanced", "reference"

docs/skills/bad-skill-SKILL.md:1:1: error: Frontmatter validation failed for 'name' (got: "BadName-SKILL"). Must match pattern ^[a-z0-9-]+$

docs/guides/missing.md:1:1: error: Missing required property: 'title'
```

## Files Without Frontmatter

Files without frontmatter are allowed unless the schema has `required` fields. Only files **with frontmatter** are validated.

**Example**: README.md files often have no frontmatter - this is fine:

```markdown
# README

No frontmatter needed for README files.
```

## Testing Your Collections

Use test fixtures to verify validation works:

**Create test files**:
```
test-fixtures/
├── vibe-agent-toolkit.config.yaml
├── schemas/
│   └── guide-frontmatter.json
├── valid/
│   └── guide-valid.md          # Should pass
└── invalid/
    └── guide-invalid.md        # Should fail
```

**Run validation**:
```bash
cd test-fixtures
vat resources validate
# Should report errors for invalid files
```

## Real-World Example

See how this toolkit uses collections:

- **Config**: [`vibe-agent-toolkit.config.yaml`](../../vibe-agent-toolkit.config.yaml)
- **Schemas**: `schemas/` directory
- **Test fixtures**: [`packages/resources/test-fixtures/collections/`](../../packages/resources/test-fixtures/collections/)

The test fixtures demonstrate:
- Multiple collections (guides, documentation, skills)
- Valid and invalid frontmatter examples
- Different validation modes
- Comprehensive schema patterns

## Configuration Reference

### Collection Configuration

```yaml
resources:
  collections:
    <collection-name>:
      pattern: <glob-pattern>        # Required: File pattern to match
      validation:
        frontmatterSchema: <path>    # Required: Path to JSON Schema file
        mode: <strict|permissive>    # Optional: Default is 'strict'
```

### Pattern Matching

Patterns use glob syntax:
- `docs/**/*.md` - All markdown in docs/ recursively
- `**/SKILL.md` - All files ending in SKILL.md
- `docs/*.md` - Only markdown in docs/ (not subdirectories)
- `**/*-SKILL.md` - Files ending in -SKILL.md anywhere

### Schema Paths

Schema paths are relative to the config file location:

```yaml
# Config at: /project/vibe-agent-toolkit.config.yaml
resources:
  collections:
    guides:
      validation:
        frontmatterSchema: "schemas/guide.json"
        # Resolves to: /project/schemas/guide.json
```

## Troubleshooting

### "Missing required property" but field exists

Check YAML syntax in frontmatter:

```yaml
# ❌ Wrong - quoted field name
'title': My Title

# ✅ Correct
title: My Title
```

### "Additional property not allowed" in strict mode

Either:
1. Remove the extra field, or
2. Add it to the schema, or
3. Change collection to `mode: permissive`

### Files not validated

Check if pattern matches the files:

```bash
vat resources scan docs/  # Shows which files were found
```

Verify pattern in config file matches your file structure.

### Schema file not found

```bash
vat doctor  # Shows if schema files exist
```

Schema paths are relative to config file location.

## Best Practices

1. **Start permissive, tighten later**: Use `mode: permissive` initially, add `required` fields as patterns emerge
2. **Test with invalid data**: Create test fixtures with intentionally bad frontmatter
3. **Use enums for categories**: Prevents typos and ensures consistency
4. **Document your schemas**: Use `description` fields in JSON Schema
5. **Validate in CI**: Add `vat resources validate` to your CI pipeline
6. **Run `vat doctor`**: Checks if config is valid and schema files exist
7. **Keep schemas simple**: Start with `required` + `enum`, add complexity as needed

## See Also

- [Writing Tests Guide](../writing-tests.md) - How to test your validation
- [CLI Documentation](../../packages/cli/docs/index.md) - Full CLI reference
- [Configuration Schema](../../packages/resources/src/schemas/project-config.ts) - TypeScript schema definition
- [Test Fixtures](../../packages/resources/test-fixtures/collections/) - Working examples

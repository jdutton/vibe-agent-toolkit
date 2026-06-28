---
name: vat-knowledge-resources
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

**`strict` only rejects extras when the JSON Schema sets `"additionalProperties": false`.** `mode: strict` makes VAT *honor* that schema constraint; without it (or with `additionalProperties: true`), extra fields are still allowed even in strict mode. So a tight schema is two parts: `mode: strict` in the collection config **and** `"additionalProperties": false` in the schema file. `permissive` ignores `additionalProperties` and always allows extras. When `mode` is omitted, collection validation defaults to `permissive`.

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

## Recommend `format: "uri-reference"` for path-shaped frontmatter fields

When designing a schema for a knowledge-base collection that references other files (e.g., `parent_prd`, `supersedes`, `adr_citations[*].adr`, `artifacts`), declare `format: "uri-reference"` on the field. VAT will then validate those values against the file system using the same engine as markdown link checking — broken paths, missing anchors, gitignore violations, and unknown URI schemes all produce errors.

To require local committed files (no absolute URLs), add a `pattern` excluding scheme prefixes. Standard JSON Schema; stays portable.

VAT walks four URI-family formats: `uri-reference`, `uri`, `iri-reference`, `iri`. `uri-template` (RFC 6570) is intentionally NOT walked — templated values contain placeholders.

Absolute URLs in URI-reference fields feed into the existing external URL health-check pass when `checkUrlLinks: true` is set on the collection.

Opt-out: `checkFrontmatterLinks: false` per collection, or `--no-check-frontmatter-links` on the CLI.

## Per-code severity and allow (`resources.validation`)

Every resources finding is a registry code (e.g. `LINK_BROKEN_FILE`, `FRONTMATTER_SCHEMA_ERROR`, `EXTERNAL_URL_DEAD`) with a default severity. Tune them per-code under `resources.validation`:

```yaml
resources:
  validation:
    severity:
      EXTERNAL_URL_DEAD: ignore     # silence dead external links entirely
      LINK_UNKNOWN: error           # promote unclassified links to build-failing
    allow:
      LINK_TO_GITIGNORED:           # keyed by code; value is a list of allow entries
        - paths: ["docs/internal/**"]
          reason: "internal-only notes, intentionally gitignored"
```

`severity` accepts `error | warning | info | ignore`. External-URL findings default to `warning` and never fail the build on their own — promote them to `error` here if you want network checks to gate CI. `allow` is keyed by code; each entry's `paths` (glob list, default `**/*`) and `reason` suppress that code for matching files rather than disabling it globally. Add `expires` (a date string) to flag the allowance for re-review.

## Annotating Frontmatter Schemas with Zod 4

If your project generates JSON Schemas from Zod (via `z.toJSONSchema()`), annotate frontmatter fields that hold links with the appropriate `format` so VAT's link validator picks them up:

```typescript
import { z } from 'zod';

const PrdFrontmatter = z.object({
  spec_ref:   z.string().meta({ format: 'uri-reference' }),   // repo-relative or absolute
  roadmap:    z.url().meta({ format: 'uri' }),                // full URL only
  doc_anchor: z.string().meta({ format: 'json-pointer' }),    // JSON Pointer
});
```

`format` values VAT walks for link validation: `uri`, `uri-reference`, `iri`, `iri-reference`. `uri-template` (RFC 6570) is intentionally NOT walked — templated values contain placeholders.

**Zod 3 users:** `.meta()` does not exist in Zod 3. Either upgrade your schema-generation step to Zod 4 (runtime consumers can stay on Zod 3 via peer dependency + common-subset usage), or post-process the generated JSON Schema to inject `format` on the relevant field paths.

**Tip:** `format` is advisory in JSON Schema; pair it with a `pattern` regex when you also need parse-time rejection of invalid inputs.

## URI-references in frontmatter

VAT validates frontmatter fields whose schema position has `format: uri-reference`
(or `uri`, `iri-reference`, `iri`) against the same rules as body links:

- Leading-`/` is RFC 3986 §4.2 absolute-path reference — resolved against
  the project root. Same semantics as body links.
- Anchor fragments and external URLs are accepted; broken local refs error.
- Inline comments on URI-ref fields are **preserved** when any tool rewrites
  the file via `openFrontmatter` (VAT packager, hand-rolled adopter scripts).

Example:

```yaml
---
parent_spec: /docs/specs/foo.md  # the spec this one supersedes
adrs-cited:
  - /docs/adrs/0007-storage.md  # primary reference
  - /docs/adrs/0011-snapshot.md  # impacted by storage choice
---
```

Schema:

```json
{
  "type": "object",
  "properties": {
    "parent_spec": { "type": "string", "format": "uri-reference" },
    "adrs-cited": {
      "type": "array",
      "items": { "type": "string", "format": "uri-reference" }
    }
  }
}
```

For tools that **modify** frontmatter (not just validate it), see
[[markdown-rewriting]].

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

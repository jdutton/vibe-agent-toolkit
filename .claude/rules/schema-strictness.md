---
paths:
  - "packages/*/src/schemas/**/*.ts"
  - "packages/resources/src/frontmatter-validator.ts"
---

# Schema strictness follows Postel's Law: liberal reading, conservative writing

> *"Be conservative in what you send, be liberal in what you accept."*

**Reading/auditing external data** (Claude settings, user plugins, third-party manifests —
files we don't control) → `z.object({...}).passthrough()`. Unknown fields pass through
silently; we validate what we understand and ignore the rest.

**Producing/validating our own output** (SKILL.md frontmatter, plugin manifests, agent
configs, anything VAT writes or emits) → `z.object({...}).strict()`. Unknown fields are
errors — they indicate a typo or bug in our own code.

```typescript
// ✅ Reading external settings (liberal)
const ExternalSchema = z.object({ model: z.string() }).passthrough();

// ✅ Validating our own output (conservative)
const OurSchema = z.object({ model: z.string() }).strict();
```

## Zod vs JSON Schema vs AJV

- **Zod** defines every schema in TypeScript — single source of truth, `zod-to-json-schema`
  generates the JSON Schema from it. Never write JSON Schema by hand for something Zod
  already models.
- **AJV** is reserved for validating JSON Schema **we did not author** against data: an
  adopter's `--frontmatter-schema`, or a vendored upstream schema used as an oracle. Zod
  covers everything else, and the ban on hand-writing JSON Schema for something Zod already
  models is unaffected — a schema someone else wrote is not one we authored.

  Current call sites, so a reader is not negotiating against a false premise:
  `packages/resources/src/ajv-factory.ts` (the shared `createAjvWithUriFormats`, **exported**
  from the `@vibe-agent-toolkit/resources` barrel), its caller
  `packages/resources/src/frontmatter-validator.ts`, and
  `packages/agent-skills/test/schema-export.test.ts`, which validates VAT's exported schemas.
  Route a new use through the exported factory rather than constructing Ajv again — that is
  what keeps this a reservation rather than a headcount.

## Schema organization

Each package keeps its schemas in `src/schemas/<name>.ts` (Zod) with a generated,
git-committed `<name>.schema.json` sibling. TypeScript types are always `z.infer<>` from the
Zod schema, never hand-written.

## Frontmatter validation

`vat resources validate` only enforces frontmatter when a schema is configured (via
collections — see `docs/guides/collection-validation.md`). Files with no frontmatter are not
an error unless the schema requires fields; use `required: [...]` for must-have fields and
leave `additionalProperties` open for project-specific extras.

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
- **AJV** is reserved for validating arbitrary *user-supplied* JSON Schema files (e.g.
  `--frontmatter-schema`) against user data — `packages/resources/src/frontmatter-validator.ts`
  is the only place using it. Zod covers everything else.

## Schema organization

Each package keeps its schemas in `src/schemas/<name>.ts` (Zod) with a generated,
git-committed `<name>.schema.json` sibling. TypeScript types are always `z.infer<>` from the
Zod schema, never hand-written.

## Frontmatter validation

`vat resources validate` only enforces frontmatter when a schema is configured (via
collections — see `docs/guides/collection-validation.md`). Files with no frontmatter are not
an error unless the schema requires fields; use `required: [...]` for must-have fields and
leave `additionalProperties` open for project-specific extras.

# @vibe-agent-toolkit/schema

The shared contracts every VAT package speaks: the validation code registry,
validation issues and the report envelope, severities, the exit-code contract,
the project validation config, and the package.json `vat` metadata. Each is a Zod
schema with its TypeScript type; the config and package metadata are also
published as JSON Schema.

## Installation

```bash
bun add @vibe-agent-toolkit/schema
```

## JSON Schema (External Tools)

JSON Schema files are available in the `schemas/` directory:

```typescript
import vatPackageMetadataSchema from '@vibe-agent-toolkit/schema/schemas/vat-package-metadata.json';
```

Available schemas:
- `validation-config.json` - the `validation` block of `vibe-agent-toolkit.config.yaml`
- `vat-package-metadata.json` - VAT package.json metadata (distribution standard)

## Exported Schemas

- `ValidationConfigSchema` - project validation config (severity overrides, allow entries)
- `VatPackageMetadataSchema` - package.json `vat` field for distribution
- `VatSkillMetadataSchema` - one skill name in `vat.skills`
- `ValidationIssueSchema`, `FindingSchema`, `reportSchema` - issues, findings and the report envelope

## Validate package.json VAT metadata

```typescript
import { VatPackageMetadataSchema } from '@vibe-agent-toolkit/schema';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));

if (packageJson.vat) {
  const result = VatPackageMetadataSchema.safeParse(packageJson.vat);

  if (!result.success) {
    console.error('Invalid VAT metadata:');
    result.error.issues.forEach(issue => {
      console.error(`- ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }
}
```

## Schema Generation

JSON Schemas are generated from the Zod schemas during build:

```bash
bun run generate:schemas
```

The set generated is `JSON_SCHEMA_TARGETS` in `src/json-schema-targets.ts`.

## License

MIT

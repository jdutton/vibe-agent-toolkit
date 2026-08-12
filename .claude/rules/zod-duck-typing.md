---
paths:
  - "packages/rag-lancedb/src/filter-builder.ts"
  - "packages/rag-lancedb/src/schema.ts"
  - "packages/utils/src/zod-introspection.ts"
---

# Introspect Zod schemas by duck typing, never `instanceof`

VAT supports both Zod v3.25.0+ and v4.0.0+. `instanceof` checks against Zod classes **break**
when the library's Zod version differs from the user's:

```typescript
// ❌ WRONG — never executes across a v3/v4 boundary
import { z } from 'zod';
if (zodType instanceof z.ZodString) { /* ... */ }
```

Use duck typing via `_def.typeName` instead, through the shared helpers:

```typescript
// ✅ CORRECT — works across all Zod versions
import { getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';

const typeName = getZodTypeName(zodType);
if (typeName === ZodTypeNames.STRING) { /* ... */ }
```

Apply this whenever introspecting a user-provided Zod schema, detecting types at runtime for
serialization, or building filters/validation logic that inspects schema structure. Not needed
for a plain `.parse()`/`.safeParse()` call.

Available from `@vibe-agent-toolkit/utils`: `getZodTypeName(zodType)`, `isZodType(zodType,
ZodTypeNames.STRING)`, `unwrapZodType(zodType)`, `ZodTypeNames`.

Full docs: [docs/zod-compatibility.md](../../docs/zod-compatibility.md).

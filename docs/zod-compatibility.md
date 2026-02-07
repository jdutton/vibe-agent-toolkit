# Zod Version Compatibility Guide

## Overview

VAT supports both Zod v3.25.0+ and v4.0.0+ through **duck typing** instead of `instanceof` checks. This ensures compatibility when library and user Zod versions differ.

## The Problem

When your application uses a different Zod version than vibe-agent-toolkit, `instanceof` checks fail because each Zod version defines its own classes:

```typescript
// ❌ WRONG - Breaks across Zod versions
import { z } from 'zod'; // User has v4
import type { ZodTypeAny } from 'zod';

function checkType(zodType: ZodTypeAny) {
  if (zodType instanceof z.ZodString) {  // z is from library's v3
    // This NEVER executes when zodType is from user's v4!
    return 'string';
  }
}
```

**Real-world impact**: Metadata filtering in RAG queries returned 0 results when manuscript-tools (Zod v4) used vibe-agent-toolkit v0.1.8 (Zod v3).

## The Solution: Duck Typing

Instead of `instanceof`, use the `_def.typeName` property, which is **stable across Zod v3 and v4**:

```typescript
// ✅ CORRECT - Works across all Zod versions
import { getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';

function checkType(zodType: unknown) {
  const typeName = getZodTypeName(zodType);
  if (typeName === ZodTypeNames.STRING) {
    // This works regardless of Zod version!
    return 'string';
  }
}
```

## Using the Zod Introspection Utilities

VAT provides version-agnostic utilities in `@vibe-agent-toolkit/utils`:

### Basic Type Detection

```typescript
import {
  getZodTypeName,
  isZodType,
  ZodTypeNames
} from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

const schema = z.string();

// Get type name
const typeName = getZodTypeName(schema);
console.log(typeName); // 'ZodString'

// Check if matches expected type
if (isZodType(schema, ZodTypeNames.STRING)) {
  console.log('It\'s a string!');
}
```

### Unwrapping Optional/Nullable Types

```typescript
import { unwrapZodType, getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

const schema = z.string().optional();
const unwrapped = unwrapZodType(schema);

console.log(getZodTypeName(schema));     // 'ZodOptional'
console.log(getZodTypeName(unwrapped));  // 'ZodString'
```

### Handling All Zod Types

```typescript
import { getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';

function serializeValue(value: unknown, zodType: unknown): string | number {
  const typeName = getZodTypeName(zodType);

  switch (typeName) {
    case ZodTypeNames.STRING:
      return String(value);
    case ZodTypeNames.NUMBER:
    case ZodTypeNames.BIGINT:
      return Number(value);
    case ZodTypeNames.BOOLEAN:
      return value ? 1 : 0;
    case ZodTypeNames.ARRAY:
      return JSON.stringify(value);
    case ZodTypeNames.OBJECT:
      return JSON.stringify(value);
    case ZodTypeNames.DATE:
      return value instanceof Date ? value.getTime() : -1;
    default:
      return JSON.stringify(value);
  }
}
```

## Available Type Constants

The `ZodTypeNames` object provides constants for all Zod types:

```typescript
export const ZodTypeNames = {
  STRING: 'ZodString',
  NUMBER: 'ZodNumber',
  BOOLEAN: 'ZodBoolean',
  ARRAY: 'ZodArray',
  OBJECT: 'ZodObject',
  ENUM: 'ZodEnum',
  OPTIONAL: 'ZodOptional',
  NULLABLE: 'ZodNullable',
  DATE: 'ZodDate',
  LITERAL: 'ZodLiteral',
  UNION: 'ZodUnion',
  INTERSECTION: 'ZodIntersection',
  TUPLE: 'ZodTuple',
  RECORD: 'ZodRecord',
  MAP: 'ZodMap',
  SET: 'ZodSet',
  FUNCTION: 'ZodFunction',
  LAZY: 'ZodLazy',
  PROMISE: 'ZodPromise',
  BIGINT: 'ZodBigInt',
  NATIVENUM: 'ZodNativeEnum',
  // ... and more
} as const;
```

## Peer Dependencies

VAT declares Zod as a **peer dependency** following [Zod's official guidance for library authors](https://zod.dev/library-authors):

```json
{
  "peerDependencies": {
    "zod": "^3.25.0 || ^4.0.0"
  }
}
```

This ensures:
- Users control their Zod version
- Single Zod version in the dependency tree
- Compatibility across the v3→v4 transition

## Why Not `instanceof`?

The Zod maintainers acknowledge this limitation. From [GitHub Issue #2543](https://github.com/colinhacks/zod/issues/2543):

> "All Zod type definitions have a `typeName` property within their `_def` object, though accessing `someSchema._def.typeName` at runtime can result in TypeScript errors because `typeName` isn't formally part of the `ZodTypeDef` interface."

The duck typing approach using `_def.typeName` is the **recommended solution** for cross-version compatibility.

## Zod v3 → v4 Transition

The TypeScript ecosystem is transitioning from Zod v3 to v4 (stable release: May 2025). Key points:

- **Zod v4 benefits**: 14x faster string parsing, 7x array, 6.5x objects ([Release Notes](https://zod.dev/v4))
- **Subpath versioning**: Zod v3.25.0+ includes both v3 and v4 at subpaths (`zod/v3`, `zod/v4`)
- **Peer dependency pattern**: Libraries should support both versions during transition
- **Industry adoption**: Major libraries (Speakeasy, react-hook-form) support both versions

**References**:
- [Zod v4 Release - InfoQ](https://www.infoq.com/news/2025/08/zod-v4-available/)
- [Zod Library Authors Guide](https://zod.dev/library-authors)
- [Zod Versioning Strategy](https://zod.dev/v4/versioning)

## Testing Across Zod Versions

When developing VAT packages that use Zod introspection:

### 1. Test with Both Versions

```bash
# Test with Zod v3
bun add -D zod@^3.25.0
bun test

# Test with Zod v4
bun add -D zod@^4.0.0
bun test
```

### 2. Verify Duck Typing Works

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';

describe('Zod Version Compatibility', () => {
  it('should detect string type regardless of Zod version', () => {
    const schema = z.string();
    const typeName = getZodTypeName(schema);
    expect(typeName).toBe(ZodTypeNames.STRING);
  });

  it('should detect array type regardless of Zod version', () => {
    const schema = z.array(z.string());
    const typeName = getZodTypeName(schema);
    expect(typeName).toBe(ZodTypeNames.ARRAY);
  });
});
```

## Migration from `instanceof` to Duck Typing

If you're updating existing code:

### Before (Broken)

```typescript
import { z } from 'zod';

function buildFilter(zodType: any) {
  if (zodType instanceof z.ZodString) {
    return 'string filter';
  }
  if (zodType instanceof z.ZodArray) {
    return 'array filter';
  }
}
```

### After (Fixed)

```typescript
import { getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';

function buildFilter(zodType: unknown) {
  const typeName = getZodTypeName(zodType);

  if (typeName === ZodTypeNames.STRING) {
    return 'string filter';
  }
  if (typeName === ZodTypeNames.ARRAY) {
    return 'array filter';
  }
}
```

## When to Use These Utilities

**Use duck typing when**:
- Accepting Zod schemas from users (e.g., custom metadata schemas)
- Introspecting schema types at runtime
- Building tools that work with user-provided Zod schemas
- Your library has Zod as a peer dependency

**Don't need duck typing when**:
- Only using Zod for validation (`.parse()`, `.safeParse()`)
- Not introspecting type structure
- Both library and user control Zod version (internal tooling)

## Real-World Example: RAG Metadata Filtering

VAT's LanceDB RAG provider introspects user-provided metadata schemas to build SQL filters. This **must** work regardless of user's Zod version:

```typescript
// User provides schema (could be Zod v3 or v4)
const CustomMetadataSchema = z.object({
  category: z.string(),
  tags: z.array(z.string()),
  priority: z.number(),
});

// VAT introspects and builds SQL (duck typing ensures compatibility)
function buildWhereClause(filters: any, schema: ZodObject<any>) {
  for (const [key, value] of Object.entries(filters)) {
    const zodType = schema.shape[key];
    const typeName = getZodTypeName(zodType);

    // Generate SQL based on type (works with any Zod version)
    if (typeName === ZodTypeNames.STRING) {
      return `\`${key}\` = '${value}'`;
    }
    if (typeName === ZodTypeNames.ARRAY) {
      return `\`${key}\` LIKE '%${value}%'`;
    }
  }
}
```

## Summary

✅ **Do**: Use duck typing (`getZodTypeName`, `ZodTypeNames`) for runtime introspection
✅ **Do**: Declare Zod as peer dependency (`^3.25.0 || ^4.0.0`)
✅ **Do**: Test with both Zod v3 and v4
❌ **Don't**: Use `instanceof` checks for Zod types
❌ **Don't**: Bundle Zod as a direct dependency (use peer deps)

**Further Reading**:
- [Zod v4 Release Notes](https://zod.dev/v4)
- [Library Authors Guide](https://zod.dev/library-authors)
- [Why Peer Dependencies Matter](https://dev.to/dianjuar/npm-peerdependencies-in-depth-a-comprehensive-introduction-1o6g)

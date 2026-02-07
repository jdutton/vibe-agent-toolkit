# Metadata Schema and Column Names

## Column Name Convention

RAG metadata fields are stored in LanceDB with **lowercase column names** following SQL convention:

- Code/YAML: `contentType: "concepts"` (camelCase)
- Database: `contenttype` column (lowercase)
- Queries: `WHERE contenttype = 'concepts'` (no quotes needed)

### Why Lowercase?

1. **SQL standard** - Most SQL databases use lowercase columns
2. **Case-insensitive** - Prevents user errors with field name casing
3. **No quotes needed** - Lowercase columns don't require backticks/quotes
4. **Fast queries** - No LOWER() function overhead

### Schema Definition

Define schemas in code using camelCase (idiomatic JavaScript):

```typescript
import { z } from 'zod';

const METADATA_SCHEMA = z.object({
  contentType: z.string(),  // Stored as: contenttype
  domain: z.string(),       // Stored as: domain
  category: z.string().optional(),
});
```

### Automatic Transformation

The serialization layer handles case transformation:

- **Write**: `contentType` → `contenttype` (DB column)
- **Read**: `contenttype` → `contentType` (returned to code)
- **Filter**: `metadata: { contentType: "value" }` → `WHERE contenttype = 'value'`

### Migration from v0.1.8

If upgrading from v0.1.8 or earlier with existing indexes:

1. LanceDB indexes must be rebuilt (column names changed)
2. Run your index build script to recreate the database
3. No code changes needed (API unchanged)

### Direct LanceDB Access

If bypassing RAGProvider to access LanceDB directly, use lowercase field names:

```typescript
// ❌ DON'T - camelCase doesn't exist in DB
const rows = await table.query().toArray();
const type = rows[0].contentType;  // undefined!

// ✅ DO - use lowercase
const type = rows[0].contenttype;

// ✅ BETTER - use RAGProvider (handles case automatically)
const results = await provider.query({ text: "search" });
const type = results.chunks[0].contentType;  // camelCase restored
```

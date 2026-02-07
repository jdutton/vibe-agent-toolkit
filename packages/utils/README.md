# @vibe-agent-toolkit/utils

Core shared utilities with no dependencies on other packages.

## Philosophy

This package provides utilities that are needed by multiple packages in the toolkit. Utilities are **added as real needs arise**, not speculatively.

If you need a utility function and multiple packages would benefit from it, add it here. Otherwise, keep it local to the package that needs it.

## Installation

```bash
bun add @vibe-agent-toolkit/utils
```

## Usage

```typescript
import {
  safeExecSync,
  toForwardSlash,
  crawlDirectory,
  isGitIgnored,
  getGitRootDir,
  setupTestTempDir,
} from '@vibe-agent-toolkit/utils';
```

## Available Utilities

### Zod Type Introspection (Version-Agnostic)

**Purpose**: Runtime Zod type detection that works across Zod v3 and v4.

Uses duck typing via `_def.typeName` instead of `instanceof` checks, which fail when library and user Zod versions differ. Essential for libraries that accept user-provided Zod schemas.

**Quick Example**:
```typescript
import { getZodTypeName, isZodType, ZodTypeNames } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

const schema = z.string().optional();

// Get type name (works with Zod v3 or v4)
const typeName = getZodTypeName(schema);
console.log(typeName); // 'ZodOptional'

// Check if matches expected type
if (isZodType(schema, ZodTypeNames.STRING)) {
  console.log('String type!');
}
```

**Available Functions**:
- `getZodTypeName(zodType)` - Extract `_def.typeName` safely
- `isZodType(zodType, typeName)` - Check if type matches expected name
- `unwrapZodType(zodType)` - Unwrap optional/nullable to get inner type
- `isZodOptional(zodType)` - Check if type is optional
- `isZodNullable(zodType)` - Check if type is nullable

**Available Constants** (`ZodTypeNames`):
```typescript
STRING, NUMBER, BOOLEAN, ARRAY, OBJECT, ENUM,
OPTIONAL, NULLABLE, DATE, BIGINT, NATIVENUM,
UNION, INTERSECTION, TUPLE, RECORD, MAP, SET,
FUNCTION, LAZY, PROMISE, and more...
```

**See**: [docs/zod-compatibility.md](../../docs/zod-compatibility.md) for complete guide

**Peer Dependency**: Requires `zod ^3.25.0 || ^4.0.0`

---

### Process Spawning
- `safeExecSync()` - Cross-platform secure command execution without shell

### Path Utilities
- `toForwardSlash()` - Convert paths to forward slashes (Windows/Unix compatibility)
- `getRelativePath()` - Get relative path between two absolute paths
- `normalizeFilePath()` - Normalize file paths for consistent comparisons

### File System
- `crawlDirectory()` - Recursively crawl directories with pattern filtering
- `readFileContent()` - Read file content with encoding detection

### Git Integration
- `isGitIgnored()` - Check if file is gitignored (cached per directory)
- `getGitRootDir()` - Find git repository root directory
- `ensureGitRepository()` - Verify current directory is in a git repo

### Test Helpers
- `setupTestTempDir()` - Create temp directory for tests with cleanup

## License

MIT

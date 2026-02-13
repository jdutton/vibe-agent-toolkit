# Writing Tests Guide

**CRITICAL**: Code duplication in tests will block commits and PR merges. Follow these patterns to avoid duplication from the start.

## Quick Reference

**When writing ANY new test file:**
1. Create `test/test-helpers.ts` if it doesn't exist
2. After writing 2-3 similar tests, extract a `setupXTestSuite()` helper
3. Use `toForwardSlash()` from `@vibe-agent-toolkit/utils` for cross-platform path comparisons
4. Run `bun run duplication-check` before committing

## Test File Organization

### Directory Structure

```
packages/my-package/
├── src/
│   └── my-module.ts           # Source code
├── test/
│   ├── test-helpers.ts        # Shared test utilities
│   ├── my-module.test.ts      # Unit tests
│   ├── integration/
│   │   └── workflow.integration.test.ts
│   └── system/
│       └── e2e.system.test.ts
└── package.json
```

### Test Types

| Type | Location | Purpose | Speed | Dependencies |
|------|----------|---------|-------|--------------|
| **Unit** | `test/*.test.ts` | Test functions/classes in isolation | < 100ms | Mock external deps |
| **Integration** | `test/integration/*.integration.test.ts` | Test multiple modules together | < 5s | Real file system, DBs |
| **System** | `test/system/*.system.test.ts` | End-to-end workflows | < 30s | Real external services |

### Test Classification Rules

Misclassified tests are the #1 cause of flaky CI and slow unit test suites. If your test does any of the following, it is **NOT a unit test**:

| If your test... | It belongs in... | Why |
|----------------|-----------------|-----|
| Makes real HTTP requests | **Integration** | Network flakiness breaks CI; 2-15s per request |
| Loads ML models (Transformers.js, ONNX) | **Integration** | Model loading costs 2-5s; native bindings crash threads pool |
| Spawns child processes (`spawnSync`, `exec`) | **System** | Node startup overhead ~1-2s per spawn |
| Connects to a real database | **Integration** | Requires external service |
| Reads/writes real files (not mocked) | **Integration** | I/O-dependent, slower |

**Unit tests must be deterministic, fast, and isolated.** Mock all I/O, network, and heavy dependencies. If you're unsure, ask: "Would this test fail on an airplane?" If yes, it's not a unit test.

**Network-dependent integration tests** should use `describe.skipIf(!!process.env.CI)` if they hit external services that may be unreachable in CI:

```typescript
// Tests that make real HTTP requests — skip in CI where egress may be restricted
describe.skipIf(!!process.env.CI)('ExternalLinkValidator (integration)', () => {
  // ...
});
```

## Vitest Pool Compatibility

Unit tests run with **threads pool on Mac/Unix** (shared module cache, ~20% faster) and **forks pool on Windows** (required for native module isolation). This affects what you can do in tests.

### `process.chdir()` — Forbidden in unit tests

`process.chdir()` throws in worker threads (all workers share one process). Use `vi.spyOn(process, 'cwd')` instead:

```typescript
// ❌ WRONG — throws in threads pool (Mac/Unix unit tests)
beforeEach(() => {
  originalCwd = process.cwd();
  process.chdir(tempDir);
});
afterEach(() => {
  process.chdir(originalCwd);
});

// ✅ CORRECT — works in both threads and forks
beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});
afterEach(() => {
  vi.restoreAllMocks();
});
```

**Caveat**: `vi.spyOn(process, 'cwd')` only affects code that calls `process.cwd()`. It does NOT affect `fs.existsSync('relative/path')` — Node's `fs` module resolves relative paths against the real OS-level CWD, not the mocked one. If your code under test uses `fs` with relative paths, you need one of:
- Absolute paths in your test setup
- `process.chdir()` in integration tests (forks pool)
- Mocking the `fs` functions

### When `process.chdir()` is acceptable

In **integration** or **system** tests (which use forks pool), `process.chdir()` is safe. If a unit test absolutely requires it, add a comment explaining why and ensure the test restores CWD in `afterEach`.

## The Test Suite Helper Pattern

**CRITICAL**: The #1 source of test duplication is repeated `beforeEach`/`afterEach` setup across describe blocks.

### When to Create a Suite Helper

Create a `setupXTestSuite()` helper when:
- ✅ Starting a new test file (proactive)
- ✅ After writing 2-3 similar describe blocks (reactive)
- ✅ You notice repeated setup/teardown code

**Don't wait for 10+ duplicates to accumulate!**

### Basic Pattern

**Step 1: Create the helper** (in `test/test-helpers.ts`):

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MyRegistry } from '../src/my-registry.js';

/**
 * Setup test suite with standard lifecycle hooks
 * Eliminates duplication of beforeEach/afterEach setup
 */
export function setupMyTestSuite(testPrefix: string): {
  tempDir: string;
  registry: MyRegistry;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
} {
  const suite = {
    tempDir: '',
    registry: null as unknown as MyRegistry,
    beforeEach: async () => {
      suite.tempDir = await mkdtemp(join(tmpdir(), testPrefix));
      suite.registry = new MyRegistry();
    },
    afterEach: async () => {
      await rm(suite.tempDir, { recursive: true, force: true });
    },
  };

  return suite;
}
```

**Step 2: Use in test files**:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupMyTestSuite } from './test-helpers.js';

const suite = setupMyTestSuite('my-test-');

describe('MyModule basic usage', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should work', async () => {
    // Use suite.tempDir, suite.registry
    const result = await doSomething(suite.tempDir);
    expect(result).toBeDefined();
  });
});

describe('MyModule advanced usage', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should also work', async () => {
    // Same suite, different tests
    const result = await doSomethingElse(suite.registry);
    expect(result).toBeDefined();
  });
});
```

### Real-World Examples

#### Example 1: Resource Tests

From `packages/resources/test/test-helpers.ts`:

```typescript
export function setupResourceTestSuite(testPrefix: string): {
  tempDir: string;
  registry: ResourceRegistry;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
} {
  const suite = {
    tempDir: '',
    registry: null as unknown as ResourceRegistry,
    beforeEach: async () => {
      suite.tempDir = await mkdtemp(join(tmpdir(), testPrefix));
      suite.registry = new ResourceRegistry();
    },
    afterEach: async () => {
      await rm(suite.tempDir, { recursive: true, force: true });
    },
  };

  return suite;
}
```

**Impact**: Eliminated 8-10 lines per describe block across 6 describe blocks = ~50 lines removed

#### Example 2: RAG System Tests

From `packages/cli/test/system/test-helpers.ts`:

```typescript
export function setupRagTestSuite(
  testName: string,
  binPath: string,
  getTestOutputDir: (pkg: string, ...segments: string[]) => string
): {
  tempDir: string;
  projectDir: string;
  dbPath: string;
  beforeAll: () => void;
  afterAll: () => void;
} {
  const suite = {
    tempDir: '',
    projectDir: '',
    dbPath: '',
    beforeAll: () => {
      suite.dbPath = getTestOutputDir('cli', 'system', `rag-${testName}-db`);
      const result = setupIndexedRagTest(
        `vat-rag-${testName}-test-`,
        'test-project',
        binPath,
        suite.dbPath
      );
      suite.tempDir = result.tempDir;
      suite.projectDir = result.projectDir;
    },
    afterAll: () => {
      fs.rmSync(suite.tempDir, { recursive: true, force: true });
    },
  };

  return suite;
}
```

**Impact**: Eliminated 41-62% duplication across 4 system test files

## Other Common Helper Patterns

### Factory Functions

Create test entities with sensible defaults:

```typescript
export function createTestResource(overrides?: Partial<Resource>): Resource {
  return {
    id: 'test-id',
    name: 'Test Resource',
    path: '/tmp/test.md',
    ...overrides,
  };
}

// Usage:
const resource = createTestResource({ name: 'Custom Name' });
```

### Assertion Helpers

Extract repeated assertion patterns:

```typescript
export async function assertValidation(
  options: {
    link: ResourceLink;
    sourceFile: string;
    expected: ValidationIssue | null;
  },
  expectFn: (actual: unknown) => Assertion<unknown>
): Promise<void> {
  const result = await validateLink(options.link, options.sourceFile);

  if (options.expected === null) {
    expectFn(result).toBeNull();
  } else {
    expectFn(result).not.toBeNull();
    expectFn(result?.severity).toBe(options.expected.severity);
    expectFn(result?.type).toBe(options.expected.type);
  }
}
```

### Workflow Helpers

Combine setup → action → partial assert:

```typescript
export async function createAndAddResource(
  tempDir: string,
  filename: string,
  content: string,
  registry: ResourceRegistry
): Promise<ResourceMetadata> {
  const filePath = join(tempDir, filename);
  await writeFile(filePath, content, 'utf-8');
  const resource = await parseMarkdown(filePath);
  registry.add(resource);
  return resource;
}
```

## Cross-Platform Testing

### Path Comparisons

**CRITICAL**: Path comparisons must work on Windows (`\`) and Unix (`/`).

**Always use `toForwardSlash()` from utils when comparing paths**:

```typescript
// ❌ WRONG - fails on Windows
expect(resource.filePath.includes('/docs/')).toBe(true);

// ✅ CORRECT - works everywhere
import { toForwardSlash } from '@vibe-agent-toolkit/utils';
expect(toForwardSlash(resource.filePath).includes('/docs/')).toBe(true);
```

**Why this works**: Windows accepts both forward slashes and backslashes as path separators.
`toForwardSlash()` normalizes all paths to use forward slashes for consistent string comparisons.

**Example**:
```typescript
// Windows path: "docs\\api\\guide.md"
// Unix path: "docs/api/guide.md"
// Both normalize to: "docs/api/guide.md"
import { toForwardSlash } from '@vibe-agent-toolkit/utils';
expect(toForwardSlash(resource.filePath)).toContain('/api/')
```

### Path Construction

Use `path.join()` for constructing paths, never string concatenation:

```typescript
// ❌ WRONG
const filePath = tempDir + '/' + 'test.md';

// ✅ CORRECT
const filePath = join(tempDir, 'test.md');
```

### Hardcoded Path Constants

When tests use hardcoded fake paths (not real filesystem paths), always use `path.resolve()` so they include the drive letter on Windows. Functions like `path.resolve()`, `path.dirname()`, and `path.join()` prepend the current drive on Windows — if your constants don't match, lookups and assertions fail.

```typescript
// ❌ WRONG — '/project/docs/guide.md' becomes 'D:\project\docs\guide.md' after path.resolve()
const PROJECT_ROOT = '/project';
const GUIDE_PATH = '/project/docs/guide.md';

// ✅ CORRECT — path.resolve() makes constants platform-appropriate
import { resolve } from 'node:path';
const PROJECT_ROOT = resolve('/project');           // '/project' on Unix, 'D:\project' on Windows
const GUIDE_PATH = resolve('/project/docs/guide.md');
```

### `path.join()` with Two Absolute Paths on Windows

On POSIX, `path.join('/a/b', '/c/d')` produces `/a/b/c/d` (valid). On Windows, `path.join('C:\\a', 'C:\\b')` produces `C:\\a\\C:\\b` — the colon from the second drive letter creates an **invalid path** that crashes `fs` operations.

```typescript
// ❌ DANGEROUS — breaks on Windows when both args are absolute
const targetDir = join(distDir, generatedDir); // C:\dist\C:\gen — invalid!

// ✅ SAFE — use relative paths or basename for the second argument
const targetDir = join(distDir, 'generated');
```

If your function joins two user-supplied paths and both could be absolute, you have a Windows compatibility bug. Either:
1. Ensure one argument is always relative
2. Use platform-conditional logic (chdir on Windows, absolute paths on Unix)

## When to Extract Helpers

### The 2-3 Rule

Extract helpers after seeing a pattern **2-3 times**, not 10+:

```typescript
// ❌ BAD - Wait until 10+ duplicates accumulate
describe('Test 1', () => { /* 10 lines of setup */ });
describe('Test 2', () => { /* 10 lines of setup */ });
describe('Test 3', () => { /* 10 lines of setup */ });
// ... 7 more times
// Finally: "Oh, maybe I should extract this?"

// ✅ GOOD - Extract early
describe('Test 1', () => { /* 10 lines of setup */ });
describe('Test 2', () => { /* 10 lines of setup */ });
// "I see a pattern" → Extract setupXTestSuite()
describe('Test 3', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);
});
```

### Questions to Ask

While writing tests:
- ❓ "Have I written similar setup code before?" → Extract factory function
- ❓ "Am I repeating the same assertions?" → Extract assertion helper
- ❓ "Is this a common workflow?" → Extract workflow helper
- ❓ "Do I have 2+ describe blocks with identical beforeEach/afterEach?" → Extract suite helper

## Code Duplication Detection

### Running the Check

```bash
# Before every commit
bun run duplication-check

# If it fails
bun run duplication-check  # See what's duplicated
# → Refactor to eliminate duplication
# → Re-run until it passes
```

### Policy: Zero Tolerance

**Code duplication will block your PR.** The CI system runs `duplication-check` and fails if any duplication is detected.

**When duplication is detected:**
1. ❌ **Don't** update the baseline
2. ❌ **Don't** add eslint-disable comments
3. ✅ **Do** extract helpers to eliminate duplication
4. ✅ **Do** refactor until the check passes

**The baseline exists to track progress towards zero, not to accept new duplication.**

## Time-Dependent Tests

Never use real `setTimeout` or `Date.now()` waits in tests. They're flaky on loaded CI machines and waste wall-clock time.

```typescript
// ❌ WRONG — flaky on slow CI, wastes 10ms per test
await new Promise(resolve => setTimeout(resolve, 10));
expect(cache.isExpired(key)).toBe(true);

// ✅ CORRECT — deterministic, instant
vi.useFakeTimers();
cache.set(key, value, { ttl: 100 });
vi.advanceTimersByTime(101);
expect(cache.isExpired(key)).toBe(true);
vi.useRealTimers();
```

## Testing Anti-Patterns

### ❌ Don't: Copy-paste test setup

```typescript
// BAD - Duplicated in every describe block
describe('Feature A', () => {
  let tempDir: string;
  let registry: Registry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'test-'));
    registry = new Registry();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });
});

describe('Feature B', () => {
  // ... same 10 lines repeated
});
```

### ✅ Do: Extract suite helper

```typescript
// GOOD - Shared via helper
const suite = setupTestSuite('my-test-');

describe('Feature A', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);
});

describe('Feature B', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);
});
```

### ❌ Don't: Inline path operations without normalization

```typescript
// BAD - Fails on Windows
expect(resource.filePath.includes('/docs/')).toBe(true);
```

### ✅ Do: Normalize before comparison

```typescript
// GOOD - Works everywhere
expect(toForwardSlash(resource.filePath)).toContain('/docs/');
```

### ❌ Don't: Write 10 tests before extracting

```typescript
// BAD - Wait until massive duplication accumulates
it('test 1', () => { /* repeated setup */ });
// ... 9 more times with identical setup
// Finally extract helper after SonarQube complains
```

### ✅ Do: Extract after 2-3 similar patterns

```typescript
// GOOD - Extract early, prevent accumulation
it('test 1', () => { /* setup */ });
it('test 2', () => { /* same setup */ });
// "I see a pattern" → Extract helper now
it('test 3', () => { /* uses helper */ });
```

## Summary Checklist

When writing tests:

**Classification:**
- [ ] Test is in the right tier (no network/ML/process spawning in unit tests)
- [ ] Network-dependent integration tests use `describe.skipIf(!!process.env.CI)` if needed

**Cross-platform:**
- [ ] Used `toForwardSlash()` from utils for path comparisons
- [ ] Used `path.resolve()` for hardcoded fake path constants
- [ ] No `path.join()` with two absolute paths (breaks on Windows)
- [ ] No `process.chdir()` in unit tests (use `vi.spyOn(process, 'cwd')`)
- [ ] All tests pass on both Windows and Unix systems

**Patterns:**
- [ ] Created `test/test-helpers.ts` for the package
- [ ] Extracted `setupXTestSuite()` helper after 2-3 similar describe blocks
- [ ] Created factory functions for common test entities
- [ ] Extracted assertion helpers for repeated validation patterns
- [ ] Used `vi.useFakeTimers()` instead of real `setTimeout` for time-dependent tests

**Quality:**
- [ ] Ran `bun run duplication-check` before committing
- [ ] No code duplication detected

## Real-World Impact

**Before applying these patterns:**
- resources package: 25.6% duplication in tests
- RAG system tests: 41-62% duplication per file
- Frequent Windows CI failures from path issues

**After applying these patterns:**
- resources package: 0% duplication
- RAG system tests: 0% duplication
- All tests pass on Windows and Ubuntu
- Test files 30-50% shorter and more maintainable

**The key**: Extract helpers EARLY (after 2-3 patterns), not LATE (after 10+ duplicates).

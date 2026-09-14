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

| Type | Location | Purpose | Per-test aspiration | Per-FILE budget (enforced) | Per-test timeout | Dependencies |
|------|----------|---------|---------------------|----------------------------|------------------|--------------|
| **Unit** | `test/*.test.ts` | Test functions/classes in isolation | < 100 ms | 1,000 ms | 15 s (150 s Windows) | Mock external deps |
| **Integration** | `test/integration/*.integration.test.ts` | Test multiple modules together | < 5 s | 5,000 ms | 60 s (15 min Windows) | Real file system, DBs |
| **System** | `test/system/*.system.test.ts` | End-to-end workflows | < 30 s | 30,000 ms | 120 s | Real external services |

### The per-file duration budget

The per-test numbers are aspirations. What is **enforced** is a per-FILE budget: a vitest
reporter (`packages/dev-tools/src/test-tier-budget-reporter.ts`) fails the run when a spec file's
duration exceeds its tier's budget — unless the file is on the ratchet allowlist in
`packages/dev-tools/src/test-tier-budget-allowlist.ts`, which names the integration-shaped work
each listed file does and what it measured when listed (`measuredMs`). The allowlist may only
shrink, and an entry buys headroom, never exemption:

- a file **not listed** that runs over its tier budget fails the run (`OVER BUDGET`);
- a file **listed** that runs over `max(tier budget, 8 × measuredMs)` fails the run
  (`OVER HEADROOM`) — fix the regression, or re-measure and update `measuredMs` with the reason;
- a file **listed** that runs under 10 % of its own `measuredMs` fails the run (`STALE ENTRY`)
  until its entry is deleted.

**Where it is judged — and only there:** the three root configs (`vitest.config.ts`,
`vitest.integration.config.ts`, `vitest.system.config.ts`), which run the whole repo in one
vitest process with `fileParallelism: false`, so a file's duration is its own cost. CI judges all
three tiers in the coverage job (`coverage.yml`, Linux on the Node floor), and the allowlist is
seeded from that job's log. The per-package turbo lanes — `bun run test:<tier>`, the local gate,
validate.yml — carry **no** budget reporter: beside every other package's workers a 200 ms file
reads as 1–3 s depending on what else is running that second, and six CI runs each crossed a
different handful of files. A turbo-lane duration is load, not a measurement, and a ratchet fed
one either churns or silently widens. An entry whose `8 × measuredMs` is within the tier budget
bounds nothing an unlisted file is not already bound to; the allowlist test refuses such an entry
and the seed script prints `DELIST` for one that has become so.

**When the reporter fails your new or changed file:** first ask whether the file is in the right
tier (a unit file that builds a real temp tree, spawns a process or inits a repo belongs in
integration). The same question is asked at the desk by `local/no-io-in-unit-tier`, which flags
`mkdtemp*`, `spawn*`, `exec*` and `child_process` imports in a unit-tier file; its `allowFiles`
ratchet in `eslint.config.js` names today's 116 offenders and may only shrink. The two ratchets
overlap by only a third — I/O is not the only thing that makes a file slow — so a file leaving one
list should be checked against the other. If the work is legitimate for its tier, add an entry with the mechanism as its
reason. To re-seed a tier: save the serial root run's output — the coverage job's log
(`gh api repos/<owner>/<repo>/actions/jobs/<id>/logs`), or locally
`bunx vitest run --config vitest.<tier>.config.ts > <log>` — then
`bun run seed:test-tier-budget <tier> <log>` prints an entry for every file over its budget and a
refreshed one for every file already listed, with reasons classified from each file's source —
never an entry for a file under budget (listing one can only widen its ceiling). Prefer the CI
log: the floor's numbers are the ones judged. Review before pasting.

The reporter is **not wired on Windows**: the allowlist is measured on Linux, and this repo's own
Windows CI runs 6–9× slower, past the headroom. A Windows seed would enable it there.

**Goldens (`UPDATE_DRIFT_GOLDEN=1`).** The two byte-golden suites — `packaged-output-drift`
(system, `vat-development-agents`) and `pipeline-oracles` (integration, `cli`) — compare BUILT
output. Their failure messages carry the regeneration command; the procedure is always **build
first** (`bun run build`), then run the one file from its package directory with the env var set.
Regenerating from a stale `dist/` writes a stale golden that passes.

### Test Classification Rules

Misclassified tests are the #1 cause of flaky CI and slow unit test suites. If your test does any of the following, it is **NOT a unit test**:

| If your test... | It belongs in... | Why |
|----------------|-----------------|-----|
| Makes real HTTP requests | **Integration** | Network flakiness breaks CI; 2-15s per request |
| Loads ML models (ONNX) | **Integration** | Model loading + first-run download costs 2-5s |
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

Note that `bun run validate` (the full gate) runs with `CI=1` locally — see the two-tier gate in
`vibe-validate.config.yaml` — so a suite gated this way runs only when its tier is invoked directly
(`bun run test:integration`), never inside a gate.

**Platform skips need a reason at the site.** Every `it.skipIf(process.platform === 'win32')` /
`describe.skipIf(...)` carries a one-line comment naming the mechanism that cannot run there (a
shebang fixture, a `bash -e -c` step, a whole-project scan), or points at the file header that does.
A skip whose reason has stopped being true is deleted, not kept — two `safe-exec` skips that named
`.cmd` handling came off when `shouldUseShell` landed. The six CLI system files that do not run on
Windows are listed once, in `WINDOWS_EXCLUDED_CLI_SYSTEM_TESTS` in `vitest.shared.ts`, and consumed
by both the root and the `packages/cli` system configs.

## Test Fixtures

Large test data for system/integration tests should be stored as compressed archives to avoid
SonarQube analyzing third-party code:

**Pattern**: `packages/X/test/fixtures/*.zip` (committed)
**Extraction**: Use cross-platform libraries (e.g., `adm-zip` npm package) in test setup
**Location**: Extract to temp directories during test execution (gitignored)

**Why compressed archives?**
- SonarQube treats raw third-party code as production code
- Users don't see walls of foreign code in the repo
- Smaller repo size (~65% compression for plugins snapshot)
- Single binary file vs 1,000+ text files

**Why ZIP instead of TAR.GZ?**
- ZIP extraction is significantly faster on Windows (3-5s vs 100+ seconds)
- `adm-zip` is pure JavaScript and works consistently across platforms
- Similar compression ratio to TAR.GZ (~7% larger, acceptable trade-off)

**Example**: `packages/cli/test/fixtures/claude-plugins-snapshot.zip`
- Contains snapshot of real ~/.claude/plugins directory
- Extracted by `test-fixture-loader.ts` during test setup using `adm-zip`
- Tests run against extracted version in temp directory

For small test data (<10 files), raw files in `test/fixtures/` are fine.

**Never use gitignored directory names (`dist/`, `node_modules/`, `coverage/`, `build/`) in
committed fixtures.** Files committed under these names silently disappear in CI (clean clone)
while appearing to work locally — the guard fires from
[`.claude/rules/test-fixtures.md`](../.claude/rules/test-fixtures.md) when a fixture is read.
Store committed artifact sources under a non-gitignored name (e.g., `build-artifacts/`) and have
test `beforeAll` copy them to `tempDir/dist/`, simulating a real build step.

**Example**: `packages/agent-skills/test/fixtures/skill-files/build-artifacts/bin/cli.mjs` is the
committed source. The integration test copies it to `tempDir/dist/bin/cli.mjs` during setup, and
the `files` config references `source: 'dist/bin/cli.mjs'`.

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

From `packages/cli/test/system/test-helpers/rag-setup.ts`:

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
): Promise<ValidationIssue | null> {
  const result = await validateLink(options.link, options.sourceFile);

  if (options.expected === null) {
    expectFn(result).toBeNull();
  } else {
    expectFn(result).not.toBeNull();
    expectFn(result?.severity).toBe(options.expected.severity);
    expectFn(result?.type).toBe(options.expected.type);
  }

  // Return what was asserted on, so the caller can assert too — see
  // "Every assertion of absence needs a positive control" below.
  return result;
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

### ❌ Don't: Claim coverage you don't provide

```typescript
// BAD - the suite lists a case it never runs
it.skip('validates broken links', () => { ... });

// BAD - reports as PASSING while asserting nothing about the code
it('should export all types', () => {
  expect(true).toBe(true); // TypeScript will catch it
});
```

Both are caught by the `local/require-justified-skip` ESLint rule. A third shape,
`expect(IMPORTED_CONSTANT).toBe(literal)` / `expect(registry).toHaveLength(N)`, is caught by
`local/no-registry-count-pin`: it re-types a number from `src` and detects change without checking
anything. Assert the SET a count stands for, or the relationship the constant must hold; a
genuinely MEASURED literal (an exit code, a calibration) keeps its number behind an
`eslint-disable-next-line` that names the measurement. A genuine
platform gate is a *condition*, not a skip — use `it.skipIf(...)` /
`describe.runIf(...)`, or the ternary form `(NET ? describe : describe.skip)(...)`,
neither of which is flagged. If a skip really must stay, annotate it with
`// SKIP(#123): reason` (uppercase keyword, `#`-prefixed issue, non-empty reason)
on the line above. Both rules are in the generated table in
[custom-eslint-rules.md](custom-eslint-rules.md#current-rules).

### Every assertion of absence needs a positive control

This is the part no linter can enforce, and it is where the real damage lives. A
test that asserts *nothing happened* is indistinguishable from a test whose
detector never ran:

```typescript
// BAD - passes whether suppression works or the detector is simply broken
it('suppresses the issue when severity is ignore', async () => {
  const result = await packageSkill(fixture, { severity: { X: 'ignore' } });
  expect(result.postBuildIssues ?? []).toHaveLength(0);
});
```

Pair it with a sibling that proves the detector fires **on the same fixture**:

```typescript
// GOOD - the pair is what makes the empty result meaningful
it('reports the issue by default', async () => {
  const result = await packageSkill(fixture, {});
  expect(result.postBuildIssues?.some(i => i.code === 'X')).toBe(true);
});

it('suppresses the issue when severity is ignore', async () => {
  const result = await packageSkill(fixture, { severity: { X: 'ignore' } });
  expect(result.postBuildIssues ?? []).toHaveLength(0);
});
```

Worked example in tree: `packages/agent-skills/test/integration/skill-packager.integration.test.ts`
→ `skill-packager: post-build integrity`.

The same rule applies to assertion helpers. A helper that asserts internally is
invisible to both SonarJS and the reader, so **return the value it asserted on**
and let the caller assert too — that call-site assertion is the positive control
on the helper:

```typescript
// GOOD - helper returns its result; caller asserts independently
const issue = await assertValidation({ ...options }, expect);
expect(issue?.code).toBe('LINK_BROKEN_FILE');
```

## Summary Checklist

When writing tests:

**Classification:**
- [ ] Test is in the right tier (no network/ML/process spawning in unit tests)
- [ ] The file runs inside its tier's per-file budget, or its allowlist entry names why it cannot
- [ ] Network-dependent integration tests use `describe.skipIf(!!process.env.CI)` if needed
- [ ] Every platform skip has a one-line reason at the site

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

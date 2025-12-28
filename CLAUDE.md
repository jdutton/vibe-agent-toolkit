# Project Development Guidelines

This document provides guidance for AI assistants and developers working on vibe-agent-toolkit.

## Project Purpose

The vibe-agent-toolkit is a modular toolkit for building, testing, and deploying portable AI agents that work across various LLMs, frameworks, and deployment targets.

See [docs/architecture.md](docs/architecture.md) for detailed package architecture and evolution plan.

## Project-Specific Technical Principles

### Schema Strategy

**JSON Schema for Agentic Interfaces and Metadata**
- Use JSON Schema for all agent inputs, outputs, and resource metadata
- JSON Schema provides language-agnostic validation and documentation
- Enables interoperability across different tools and platforms
- Supports both JSON and YAML validation

**Zod for Type Safety**
- Use Zod to define schemas in TypeScript
- Zod ensures TypeScript types and JSON schemas remain perfectly synchronized
- Convert Zod schemas to JSON Schema using `zod-to-json-schema` when needed
- Single source of truth: define schema once in Zod, get both TypeScript types and JSON Schema

**Example Pattern**:
```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Define schema with Zod
const ResourceMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// Get TypeScript type (automatically inferred)
type ResourceMetadata = z.infer<typeof ResourceMetadataSchema>;

// Get JSON Schema (for validation and documentation)
const ResourceMetadataJsonSchema = zodToJsonSchema(ResourceMetadataSchema);

// Runtime validation
const result = ResourceMetadataSchema.safeParse(data);
```

### CLI Development

**Commander.js for Command-Line Interface**
- Use Commander.js for all CLI commands and argument parsing
- Provides consistent, well-documented CLI patterns
- Supports subcommands, options, help text, and validation
- Industry standard with excellent TypeScript support

**Example Pattern**:
```typescript
import { Command } from 'commander';

const program = new Command();

program
  .name('vibe-agent')
  .description('Toolkit for building and testing portable AI agents')
  .version('0.1.0');

program
  .command('validate <path>')
  .description('Validate resources at the specified path')
  .option('-f, --fix', 'Fix issues automatically')
  .action((path, options) => {
    // Implementation
  });

program.parse();
```

### Package-Specific Guidelines

**utils package**:
- No dependencies on other internal packages
- Add utilities only when needed by other packages (not speculatively)
- Avoid creating string/array/object helpers without real use cases
- Example: cross-platform process spawning, schema validation utilities
- May have external npm dependencies (Zod, etc.)

**resources, rag, claude-skills packages**:
- Depend on `utils` for shared functionality
- Define their own schemas using Zod
- Export both TypeScript types and JSON schemas
- Keep schemas in `src/schemas/` directory

**cli package**:
- Uses Commander.js for all command parsing
- Orchestrates other packages (don't duplicate logic)
- User-facing entry point for the toolkit

### Schema Organization

Each package defines its own schemas:

```
packages/resources/
  src/
    schemas/
      metadata.ts           # Zod schema + types
      metadata.schema.json  # Generated JSON Schema (git-tracked)
    types.ts                # Re-export types from schemas
    index.ts
```

**Build process**:
- Generate JSON Schema files from Zod schemas during build
- Commit generated JSON Schema files to git (for external tools)
- TypeScript types are always derived from Zod schemas (never manually written)

## Project Structure

This is a TypeScript monorepo using:
- **Package Manager**: Bun
- **Build Tool**: TypeScript compiler (tsc)
- **Testing**: Vitest
- **Linting**: ESLint with strict rules (sonarjs, unicorn, security plugins)
- **Validation**: vibe-validate for git-aware validation orchestration
- **CI/CD**: GitHub Actions with Node 22/24 on Ubuntu/Windows

## Monorepo Architecture

```
vibe-agent-toolkit/
├── packages/          # Published packages
│   ├── utils/        # Core shared utilities (no package deps)
│   ├── resources/    # Resource parsing & validation (planned)
│   ├── rag/          # Document chunking & embeddings (planned)
│   ├── claude-skills/ # Claude skill packaging (planned)
│   ├── cli/          # Command-line interface (planned)
│   └── dev-tools/    # Build and development tools (private)
├── docs/             # Documentation
├── .github/          # CI/CD workflows
└── [config files]    # Root-level configuration
```

## Coding Standards

### TypeScript Configuration

- **Target**: ES2024
- **Module**: NodeNext (ESM)
- **Strict Mode**: Enabled with additional strictness:
  - `noUncheckedIndexedAccess: true`
  - `noImplicitOverride: true`
  - `exactOptionalPropertyTypes: true`

### ESLint Rules

- **Zero Warnings Policy**: `--max-warnings=0`
- **Cognitive Complexity**: Max 15 for production, 20 for tests/tools
- **No Explicit Any**: Errors in production code, allowed in tests
- **Security**: Full security plugin rules enforced
- **Import Organization**: Alphabetical with newlines between groups

### Code Quality Thresholds

- **Test Coverage**: 80% minimum (statements, branches, functions, lines)
- **Code Duplication**: **ZERO TOLERANCE** - See Critical Duplication Policy below
- **SonarQube**: Configured for free tier (sonarway) - ESLint catches issues first

### **CRITICAL: Code Duplication Policy**

**Goal: ZERO duplicates. The baseline must remain at 0.**

**For Claude Code and AI assistants:**
- ❌ **NEVER** run `bun run duplication-update-baseline` without explicit user permission
- ❌ **NEVER** update `.github/.jscpd-baseline.json` without explicit user permission
- ❌ **NEVER** accept or ignore duplication failures
- ✅ **ALWAYS** fix duplication by refactoring when `duplication-check` fails
- ✅ **ALWAYS** extract duplicated code to shared utilities
- ✅ **ALWAYS** ask the user for permission if you believe updating the baseline is necessary

**If duplication check fails:**
1. Analyze the duplicated code
2. Refactor to eliminate duplication (extract to utils, create shared functions, etc.)
3. Re-run `duplication-check` to verify it passes
4. If you cannot fix it, explain why and ask the user for guidance

**The baseline is for tracking progress towards zero duplication, not for accepting new duplication.**

Only the project owner can approve baseline updates. This is non-negotiable.

## Testing Conventions

All packages must follow these testing patterns for consistency:

### Test File Naming

1. **Unit Tests**: `*.test.ts` or `*.spec.ts`
   - Location: `test/` directory (NOT co-located with source)
   - Purpose: Test individual functions/classes in isolation
   - Mock external dependencies
   - Fast execution (< 100ms per test)

2. **Integration Tests**: `*.integration.test.ts`
   - Location: `test/integration/` directory
   - Purpose: Test multiple modules working together
   - May use real dependencies (file system, databases)
   - Medium execution time (< 5s per test)
   - Run with: `bun test:integration`

3. **System Tests**: `*.system.test.ts`
   - Location: `test/system/` directory
   - Purpose: End-to-end testing of complete workflows
   - Use real external services when possible
   - Longer execution time (< 30s per test)
   - Run with: `bun test:system`

### Test Organization Example

```
packages/my-package/
├── src/
│   └── utils.ts               # Source code only
├── test/
│   ├── utils.test.ts          # Unit tests
│   ├── integration/
│   │   └── workflow.integration.test.ts
│   └── system/
│       └── e2e.system.test.ts
└── package.json
```

### Test Standards

- All tests must be **cross-platform** (Windows, macOS, Linux)
- Use absolute paths with `path.resolve()` for file operations
- Clean up temp files/directories in `afterEach` hooks
- Use descriptive test names: `it('should [expected behavior] when [condition]')`
- One assertion per test when practical
- Prefer `toThrow()` over try-catch blocks for error testing

### Preventing Test Duplication

**Test code is the most common source of duplication.** Follow these patterns to avoid it:

**1. Extract Test Helpers Early (not after duplication accumulates)**
- Create `test/test-helpers.ts` when starting a new package
- Extract patterns after writing 2-3 similar tests (not 10+)

**2. Common Test Helper Patterns**
```typescript
// Factory functions for test data
export function createTestEntity(overrides?: Partial<Entity>): Entity { ... }

// Assertion helpers for common validation patterns
export async function assertValidation(options: {...}, expectFn: ...) { ... }

// Workflow helpers (setup → action → assert)
export async function setupAndExecute(options: {...}) { ... }
```

**3. When Writing Tests, Ask:**
- "Have I written similar setup code before?" → Extract factory function
- "Am I repeating the same assertions?" → Extract assertion helper
- "Is this a common workflow?" → Extract workflow helper

**4. Review Tests After Writing**
- After completing a test file, scan for repeated patterns
- Run `bun run duplication-check` before committing
- Extract helpers immediately when duplication is detected

**Example from resources package:**
- ❌ **Before**: 9 duplicates from repeated validation + assertion patterns
- ✅ **After**: 0 duplicates using `createLink()`, `assertValidation()`, `writeAndParse()` helpers

### Running Tests

```bash
# Unit tests only (default)
bun test

# Watch mode for development
bun test:watch

# Integration tests
bun test:integration

# System tests
bun test:system

# All tests with coverage
bun test:coverage
```

## Development Workflow

### Pre-Commit Checklist

Before committing, ensure:
1. `bun run lint` passes with zero warnings
2. `bun run typecheck` passes
3. `bun run test` passes
4. `bun run duplication-check` passes (**MUST pass - see Critical Duplication Policy above**)
5. All files formatted correctly (enforced by .editorconfig)

Pre-commit hooks via Husky will enforce these automatically.

**IMPORTANT**: If `duplication-check` fails, refactor to eliminate duplication. Never update the baseline without explicit permission.

### Adding New Packages

1. Create directory: `packages/my-package/`
2. Add package.json (see existing packages for reference)
3. Add tsconfig.json extending `../../tsconfig.base.json`
4. Add to root `tsconfig.json` references
5. Create src/, test/ directories
6. Add README.md with usage examples
7. Run `bun install` to link workspace dependencies

### Adding Utilities (utils package)

1. Identify real need from another package (don't add speculatively)
2. Add utility to `utils` package
3. Add tests for the utility
4. Document usage in utils README

### Adding Schemas

1. Define schema with Zod in `src/schemas/[name].ts`
2. Export TypeScript type using `z.infer<typeof Schema>`
3. Generate JSON Schema using `zod-to-json-schema` in build
4. Commit both `.ts` and `.schema.json` files to git

### Adding CLI Commands

1. Use Commander.js for command structure in `cli` package
2. Keep commands focused and composable
3. Orchestrate other packages (don't duplicate logic)
4. Provide clear help text and examples
5. Handle errors gracefully with user-friendly messages

### Code Review Standards

- Follow Clean Code principles (DRY, SOLID, KISS)
- No SonarQube "code smells" or vulnerabilities
- All code must have tests (aim for >80% coverage)
- Document public APIs with JSDoc comments
- Commit messages follow conventional commits format

## Build & Publish

### Building

```bash
# Build all packages
bun run build

# Clean build
bun run build:clean
```

### Publishing (when ready)

Packages are published to npm with:
- Automatic version management
- Changelog generation
- GitHub releases
- npm provenance

Release tools will be added when packages are ready for publication.

## CI/CD

GitHub Actions runs on every push/PR:
- Matrix: Node 22/24 × Ubuntu/Windows
- Validation via vibe-validate
- All checks must pass before merge

## Architecture Principles

See [docs/architecture.md](docs/architecture.md) for complete details:

1. **Clear Package Boundaries** - Single, well-defined purpose per package
2. **Progressive Dependencies** - utils → resources → rag/claude-skills → cli
3. **Start Minimal, Evolve As Needed** - Build when needed, not speculatively
4. **Schemas Co-located, Utilities Shared** - Each package owns its schemas, utils provides validation
5. **Link Integrity is General** - Not Claude-specific, useful for any markdown project

## Enterprise Software Development Best Practices

Apply these industry-standard practices regardless of what this monorepo is used for.

### Core Principles (You Already Know These)

Follow these established patterns:
- **SOLID Principles**: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion
- **DRY**: Don't Repeat Yourself - extract to shared packages in monorepo context
- **TDD**: Test-Driven Development - Red-Green-Refactor cycle
- **Clean Code**: Robert C. Martin's principles
- **KISS**: Keep It Simple, Stupid
- **YAGNI**: You Aren't Gonna Need It

### Monorepo-Specific DRY Application

When you see duplication across packages:
1. Extract to shared utilities package (utils, or create new shared-* package)
2. Use constants objects for configuration
3. Share TypeScript types via dedicated types in schemas
4. Extract reusable build logic to helper functions

Wait for 3+ instances before extracting (avoid premature abstraction).

### Error Handling Patterns

Use these approaches:
- **Typed Errors**: Custom error classes (ValidationError, NotFoundError, etc.)
- **Result Types**: `Result<T, E>` for expected failures (see functional programming patterns)
- **Fail Fast**: Validate inputs early, throw immediately on invalid state
- **Zod Validation**: Use Zod's `.safeParse()` for runtime validation with typed errors

### Code Quality Standards

**TypeScript**:
- No `any` in production code (use `unknown` if truly dynamic)
- Explicit return types on all functions
- Use type guards for narrowing
- Prefer Zod schemas over manual type guards for runtime validation

**Testing**:
- TDD for business logic
- Test error paths (don't just test happy path)
- Use descriptive test names: `should [behavior] when [condition]`

**Documentation**:
- JSDoc for public APIs with @param, @returns, @example
- Inline comments explain WHY, not WHAT
- README per package: purpose, installation, quick start, API
- Document Zod schemas with `.describe()` for auto-generated JSON Schema descriptions

### Code Review Checklist

- [ ] No `console.log` in production (use proper logging)
- [ ] No hardcoded secrets
- [ ] No `@ts-ignore` without explanation
- [ ] No `any` without justification
- [ ] Tests exist and cover edge cases
- [ ] Cross-platform compatible (paths, line endings)
- [ ] DRY: no duplication that should be extracted
- [ ] Zod schemas have `.describe()` for documentation
- [ ] CLI commands have clear help text

### Technical Debt Management

**Duplication Management - ZERO TOLERANCE**:
- **Goal**: Maintain 0 duplicates in `.github/.jscpd-baseline.json`
- **Policy**: See "CRITICAL: Code Duplication Policy" section above
- **For AI assistants**: NEVER update baseline without explicit user permission
- **Workflow**: When duplication is detected → refactor to eliminate → re-run check
- **Rationale**: Baseline exists to track progress towards zero, not to accept new duplication

Tools available:
- `bun run duplication-check` - Verify no new duplication (run this)
- `bun run duplication-update-baseline` - Update baseline (REQUIRES USER PERMISSION)

**TODO Format**:
```typescript
// TODO(username, YYYY-MM-DD): Reason and context
```

### Monorepo-Specific Patterns

- **Package Boundaries**: Each package independently useful, avoid circular deps
- **Shared Code**: Use utils package, version carefully (breaking changes affect all consumers)
- **Build Order**: Respect dependency graph, use TypeScript project references
- **Testing**: Test packages in isolation + integration between packages

## Development Tools Package

All tools are TypeScript (not shell scripts) for cross-platform compatibility:

Located in `packages/dev-tools/src/`:
- `common.ts` - Shared utilities (safeExecSync, logging, etc.)
- `duplication-check.ts` - jscpd wrapper
- `jscpd-check-new.ts` - Smart duplication detection
- `jscpd-update-baseline.ts` - Update duplication baseline
- `bump-version.ts` - Version management for monorepo
- `pre-publish-check.ts` - Pre-publish validation
- `determine-publish-tags.ts` - npm dist-tag determination
- `run-in-packages.ts` - Run commands across all workspace packages

Custom ESLint rules in `packages/dev-tools/eslint-local-rules/`.

Tools follow same quality standards as packages (linted, typed, tested).

## Custom ESLint Rules - Agentic Code Safety Pattern

**Critical for AI-Heavy Development**: When working with agentic code (Claude, Cursor, Copilot), AI can easily reintroduce unsafe patterns that were previously fixed. Custom ESLint rules provide automatic guardrails that catch these issues during development.

### The Pattern: Identify → Create Rule → Never Repeat

**When you identify a dangerous pattern that was fixed:**
1. **Document why it's dangerous** (security, cross-platform, performance)
2. **Create a custom ESLint rule** in `packages/dev-tools/eslint-local-rules/`
3. **The pattern can never be reintroduced** - ESLint catches it automatically

This is "good overkill" - prevents technical debt from accumulating through AI-assisted development.

### Current Rules

Located in `packages/dev-tools/eslint-local-rules/`:

- **`no-child-process-execSync`** - Enforces `safeExecSync()` instead of raw `execSync()`
  - Why: `execSync()` uses shell interpreter → command injection risk
  - Why: `safeExecSync()` uses `which` pattern + no shell → cross-platform + secure
  - **Auto-fix**: Replaces `execSync` with `safeExecSync` and adds import

### Creating New Rules

When you identify a dangerous pattern (security, platform-specific, error-prone):

1. **Use the factory pattern** - See `eslint-rule-factory.cjs`
2. **Create rule file** in `packages/dev-tools/eslint-local-rules/`:

```javascript
// no-fs-unlinkSync.cjs
const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'unlinkSync',
  unsafeModule: 'node:fs',
  safeFn: 'safeUnlinkSync',
  safeModule: './common.js',
  message: 'Use safeUnlinkSync() for better error handling and cross-platform compatibility',
  exemptFile: 'common.ts', // Where the safe version is implemented
});
```

3. **Add to `index.js`**:
```javascript
export default {
  rules: {
    'no-child-process-execSync': require('./no-child-process-execSync.cjs'),
    'no-fs-unlinkSync': require('./no-fs-unlinkSync.cjs'), // New rule
  },
};
```

4. **Enable in `eslint.config.js`**:
```javascript
rules: {
  'local/no-child-process-execSync': 'error',
  'local/no-fs-unlinkSync': 'error', // New rule
}
```

### Why This Matters for Agentic Development

Without custom rules:
- ❌ AI reintroduces `execSync()` → security vulnerability
- ❌ AI uses `os.tmpdir()` → Windows path issues
- ❌ Manual code review catches it → time wasted, issue deployed

With custom rules:
- ✅ AI writes code → ESLint catches violation immediately
- ✅ Auto-fix available → AI or dev applies fix instantly
- ✅ Pattern enforced forever → never have to think about it again

**Best Practice**: Every time you fix a dangerous pattern, ask yourself: "Should this be a custom ESLint rule?" If yes, create it immediately.

## Questions?

- [Architecture](./docs/architecture.md) - Package structure and evolution plan
- [Getting Started](./docs/getting-started.md) - Detailed setup guide
- [Documentation](./docs/README.md) - Full documentation index
- vibe-validate docs: https://github.com/jdutton/vibe-validate
- ESLint config: `eslint.config.js` (heavily documented)
- CI workflow: `.github/workflows/validate.yml`

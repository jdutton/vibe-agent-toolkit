# Project Development Guidelines

This document provides guidance for AI assistants and developers working on vibe-agent-toolkit.

## Project Purpose

The vibe-agent-toolkit is a modular toolkit for building, testing, and deploying portable AI agents that work across various LLMs, frameworks, and deployment targets.

See [docs/architecture/README.md](docs/architecture/README.md) for detailed package architecture and evolution plan.

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

### TypeScript Monorepo Build System

**Critical: Use `tsc --build` for all TypeScript compilation.** This is the standard TypeScript solution for monorepos with dependencies between packages.

#### Why `tsc --build`?

TypeScript's `--build` mode (project references) provides:
- **Dependency Order**: Automatically builds packages in the correct order based on `references` in tsconfig.json
- **Incremental Builds**: Only rebuilds packages that changed (uses `.tsbuildinfo` files)
- **Type Safety**: TypeScript validates cross-package imports at build time
- **Standard Solution**: This is TypeScript's official monorepo build approach

Without `--build`, builds fail on clean checkouts because dependent packages try to import from unbuilt packages.

#### Required Configuration

Every package **must** have `composite: true` in its tsconfig.json:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [
    { "path": "../utils" }
  ]
}
```

The `references` array tells TypeScript which packages this package depends on.

#### Build Scripts

```bash
# Standard build (respects dependency order)
bun run build

# Clean build (removes all build artifacts and rebuilds)
bun run build:clean

# Type check without emitting files (fast)
bun run typecheck
```

These scripts map to:
- `build`: `tsc --build && cd packages/agent-schema && bun run generate:schemas`
- `build:clean`: `tsc --build --clean && tsc --build && cd packages/agent-schema && bun run generate:schemas`
- `typecheck`: `tsc --build --dry --force`

#### How It Works

1. **Root tsconfig.json** lists all packages in `references`:
   ```json
   {
     "files": [],
     "references": [
       { "path": "./packages/utils" },
       { "path": "./packages/resources" },
       { "path": "./packages/rag" },
       // ... etc
     ]
   }
   ```

2. **Each package tsconfig.json** declares its dependencies:
   ```json
   {
     "references": [
       { "path": "../utils" },
       { "path": "../resources" }
     ]
   }
   ```

3. **`tsc --build`** walks the dependency graph and builds packages in order:
   - Builds `utils` (no dependencies)
   - Builds `resources` (depends on `utils`)
   - Builds `rag` (depends on `utils` and `resources`)
   - etc.

#### Adding New Packages

When creating a new package:
1. Add `"composite": true` to its tsconfig.json
2. Add `references` for packages it depends on
3. Add the package to root tsconfig.json `references` array
4. Run `bun install` to update workspace links

#### Troubleshooting

**"Cannot find module '@vibe-agent-toolkit/utils'" during build**:
- Missing `references` in tsconfig.json
- Package not built yet (run `bun run build:clean`)

**"Project references may not form a circular dependency"**:
- Check for circular imports between packages
- Packages must form a directed acyclic graph (DAG)

#### Workspace Protocol for Internal Dependencies

**Critical: Use `workspace:*` for all internal package dependencies.**

Internal dependencies in package.json must use the workspace protocol, **not specific version numbers**:

```json
{
  "dependencies": {
    "@vibe-agent-toolkit/utils": "workspace:*",
    "@vibe-agent-toolkit/resources": "workspace:*"
  }
}
```

**Why `workspace:*`?**

1. **CI Compatibility**: `bun install` in CI uses local workspace packages, not npm
2. **Auto-Resolution**: Publishing workflow runs `resolve-workspace-deps` to replace `workspace:*` with actual versions before `npm publish`
3. **Single Source of Truth**: Version is managed by `bump-version` script, not individual package.json files

**Without `workspace:*`**, CI builds fail because `bun install` tries to fetch packages from npm that don't exist yet:

```bash
# ❌ WRONG - CI tries to fetch from npm
"@vibe-agent-toolkit/utils": "0.1.0-rc.2"

# ✅ CORRECT - CI uses local workspace
"@vibe-agent-toolkit/utils": "workspace:*"
```

**Publishing Workflow**:
1. Developer commits code with `workspace:*` in package.json
2. Developer runs `bump-version` to create git tag (workspace:* unchanged)
3. GitHub Actions workflow triggers on tag:
   - `bun install` uses local workspace packages
   - `build` compiles all packages
   - `resolve-workspace-deps` replaces `workspace:*` with actual version
   - `npm publish` publishes with resolved dependencies
4. Published packages on npm have actual version numbers (e.g., "0.1.0-rc.7")
5. Workspace files in git remain unchanged with `workspace:*`

**Why not use `bun publish`?** Bun automatically replaces `workspace:*`, but doesn't support `--provenance` flag needed for supply chain security. We use `npm publish` with manual resolution instead.

**Fixing Incorrect Dependencies**:

If dependencies get out of sync (e.g., after manual edits), run:

```bash
bun run fix-workspace-deps
bun install
```

This ensures all internal dependencies use `workspace:*` protocol.

**For AI assistants**: When adding new internal dependencies, ALWAYS use `workspace:*`. Never use specific version numbers for @vibe-agent-toolkit packages.

**Build succeeds but types are wrong**:
- Delete `.tsbuildinfo` files: `tsc --build --clean`
- Rebuild: `bun run build:clean`

#### Why Not Custom Scripts?

We previously used a custom `run-in-packages.ts` script to run builds. This had problems:
- ❌ Didn't respect dependency order → failed on clean builds
- ❌ Required custom code to maintain
- ❌ Slower (no incremental builds)
- ❌ Not standard TypeScript

Using `tsc --build`:
- ✅ Respects dependency order automatically
- ✅ Zero custom code to maintain
- ✅ Faster with incremental builds
- ✅ Standard TypeScript solution

**Rule**: Never manually run `tsc` in individual packages. Always use `tsc --build` from the root.

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

### Test Fixtures Convention

Test data for system/integration tests belongs in `packages/X/test/test-fixtures/` directories. These fixtures are committed to git (needed for CI) but excluded from resource validation scanning. Use this for real-world test data like cloned plugin installations, not for simple unit test mocks.

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

**CRITICAL**: See [docs/writing-tests.md](docs/writing-tests.md) for comprehensive testing guidance.

**You MUST follow the testing guide when writing ANY tests.** Code duplication in tests will block commits and PR merges.

### Quick Rules

1. **Always extract test helpers early** - After writing 2-3 similar tests, create a `setupXTestSuite()` helper
2. **Use `toForwardSlash()` from `@vibe-agent-toolkit/utils`** - For cross-platform path comparisons on Windows/Unix (production and tests)
3. **Run `bun run duplication-check`** - Before every commit (CI will fail if duplication detected)
4. **Zero tolerance for duplication** - Refactor to eliminate, never update the baseline

### Test Types

| Type | Location | Command | Speed |
|------|----------|---------|-------|
| Unit | `test/*.test.ts` | `bun run test:unit` | < 100ms |
| Integration | `test/integration/*.integration.test.ts` | `bun run test:integration` | < 5s |
| System | `test/system/*.system.test.ts` | `bun run test:system` | < 30s |

### The Test Suite Helper Pattern (Required)

**After writing 2-3 similar describe blocks**, extract a suite helper:

```typescript
// test/test-helpers.ts
export function setupMyTestSuite(testPrefix: string) {
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

// my-module.test.ts
const suite = setupMyTestSuite('my-test-');

describe('Feature A', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should work', () => {
    // Use suite.tempDir, suite.registry
  });
});
```

**Why this matters:**
- ❌ **Without helper**: 8-10 lines duplicated per describe block → 41-62% duplication
- ✅ **With helper**: 2 lines per describe block → 0% duplication

See [docs/writing-tests.md](docs/writing-tests.md) for:
- Complete suite helper examples (resources, RAG, CLI)
- Factory function patterns
- Assertion helper patterns
- Cross-platform path handling
- When to extract (the 2-3 rule)
- Anti-patterns to avoid

### Running Tests

**CRITICAL: Do NOT use `bun test` in this repository.** It runs tests incorrectly and will fail.

**Why `bun test` doesn't work:**
- `bun test` runs vitest but ignores `vitest.config.ts`
- This causes system tests to run together with unit/integration tests
- Tests interfere with each other when run in a single process
- Results in false failures despite tests being properly isolated

**Use these commands instead:**

```bash
# Recommended: Full validation (what CI uses)
vv validate

# Or run test suites individually:
bun run test:unit          # Unit tests only
bun run test:watch         # Watch mode for development
bun run test:integration   # Integration tests only
bun run test:system        # System tests only (e2e)
bun run test:coverage      # All tests with coverage report
```

**For AI assistants:** Never suggest `bun test`. Always use `vv validate` or `bun run test:*` commands.

## Development Workflow

### MANDATORY Steps for ANY Code Change

**CRITICAL**: After fixing errors, ALWAYS run `bun run validate` again before asking to commit (cache makes it instant if correct, catches side effects if wrong).

**For AI assistants**: This workflow is non-negotiable. Follow it exactly for every code change, no matter how small.

1. **Create feature branch** (never work on main)
   ```bash
   git checkout -b feat/feature-name
   ```

2. **Make changes** (batch related work together - don't commit single lines)

3. **Run validation loop** (repeat until passes):
   ```bash
   bun run validate
   ```
   - Fix all errors reported
   - Run `bun run validate` again (catches side effects)
   - Continue until validation passes with zero errors

4. **Ask user permission** (ONLY after final validation passes)
   - Present what changed
   - Show validation passed
   - Wait for approval

5. **Commit with proper format**
   ```bash
   git add -A
   git commit -m "type(scope): description"
   ```
   - Follow conventional commits format
   - Pre-commit hooks will enforce validation again

6. **Push to remote**
   ```bash
   git push origin feat/feature-name
   ```

**Why this matters:**
- `bun run validate` uses vibe-validate (vv) which orchestrates all checks intelligently
- vv caches results - instant if nothing changed, full validation if side effects detected
- Pre-commit hooks enforce these checks, but you must run them BEFORE asking to commit
- Running validate after each fix catches cascading failures early

**CRITICAL - Do NOT use `bun test`**: This repository uses `bun run validate` as the authoritative test suite. Direct `bun test` has known issues with parallel execution. Always use `bun run validate` which runs tests through vibe-validate orchestration.

### Pre-Commit Checklist

Before committing, ensure:
1. `bun run lint` passes with zero warnings
2. `bun run typecheck` passes
3. `vv validate` passes (or `bun run test:unit && bun run test:integration && bun run test:system`)
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

## Publishing & Version Management

### Unified Versioning

**CRITICAL**: All packages in this monorepo share the same version. When any package changes, all packages are bumped together. This ensures compatibility and simplifies dependency management.

Current packages (11 published, 1 private):
- @vibe-agent-toolkit/agent-schema
- @vibe-agent-toolkit/utils
- @vibe-agent-toolkit/discovery
- @vibe-agent-toolkit/resources
- @vibe-agent-toolkit/rag
- @vibe-agent-toolkit/rag-lancedb
- @vibe-agent-toolkit/agent-config
- @vibe-agent-toolkit/runtime-claude-skills
- @vibe-agent-toolkit/cli
- vibe-agent-toolkit (umbrella package)
- @vibe-agent-toolkit/vat-development-agents
- @vibe-agent-toolkit/dev-tools (PRIVATE - not published)

### Version Bump Workflow

**Always use the `bump-version` script:**

```bash
# Explicit version
bun run bump-version 0.2.0-rc.1

# Semantic increment
bun run bump-version patch    # 0.1.0 → 0.1.1
bun run bump-version minor    # 0.1.0 → 0.2.0
bun run bump-version major    # 0.1.0 → 1.0.0
```

The script updates all 11 publishable packages atomically.

### CHANGELOG.md Format

**CRITICAL - Read This Carefully:**

CHANGELOG.md uses a strict format. **RC/prerelease versions NEVER get their own section.**

```markdown
## [Unreleased]

### Added
- New feature descriptions here

### Changed
- Change descriptions here

### Fixed
- Bug fix descriptions here

## [0.1.0] - 2026-01-15

### Added
- Previous release features...
```

**Rules:**
- **RC versions (0.1.0-rc.1, 0.1.0-rc.2, etc.)**: Changes stay in `[Unreleased]` section
- **Stable versions (0.1.0, 0.2.0, etc.)**: Move `[Unreleased]` content to new `## [X.Y.Z] - YYYY-MM-DD` section
- **NEVER create sections like `## [0.1.0-rc.1]`** - these will break the release process

**For AI assistants:** Never ask about creating CHANGELOG sections for RC versions. They don't exist.

### Publishing Process (Automated)

**CRITICAL**: Publishing is automated via GitHub Actions. **DO NOT manually publish** unless automation fails.

**Normal Release Workflow:**

1. **Update CHANGELOG.md** (if needed)
   - **RC releases**: Ensure changes are documented in `[Unreleased]` section
   - **Stable releases**: Move `[Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`

2. **Bump version**:
   ```bash
   bun run bump-version 0.1.0-rc.1  # For RC
   bun run bump-version 0.1.0       # For stable
   ```

3. **Build and verify**:
   ```bash
   bun run build
   bun run validate-version
   ```

4. **Commit and tag**:
   ```bash
   git add -A && git commit -m "chore: Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. **Monitor GitHub Actions**:
   - Visit: https://github.com/jdutton/vibe-agent-toolkit/actions
   - Workflow automatically publishes to npm

### Publishing Behavior

**RC versions** (e.g., `v0.1.0-rc.1`):
- Publish to `@next` tag
- NO GitHub release
- CHANGELOG stays in `[Unreleased]`
- Use for: risky changes, pre-release testing

**Stable versions** (e.g., `v0.1.0`):
- Publish to `@latest` tag
- Also update `@next` tag (if newest)
- Create GitHub release with changelog
- Move CHANGELOG `[Unreleased]` → `[Version]`

### Manual Publishing (Fallback Only)

**Use only if automated publishing fails:**

```bash
# Ensure versions are correct
bun run bump-version <version>

# Build all packages
bun run build

# Run pre-publish checks
bun run pre-publish-check

# Publish with rollback safety
bun run publish-with-rollback <version>
```

### CLI Wrapper Behavior

The `vat` command uses smart wrapper with context detection:

**Dev Mode** (in this repo):
- Uses: `packages/cli/dist/bin.js`
- Shows version: `0.1.0-rc.1-dev`

**Local Install** (project has @vibe-agent-toolkit/cli):
- Uses: `node_modules/@vibe-agent-toolkit/cli/dist/bin.js`
- Shows version: project's version

**Global Install** (fallback):
- Uses: globally installed version
- Shows version: global version

**Installation:**
```bash
npm install -g @vibe-agent-toolkit/cli    # Just CLI
npm install -g vibe-agent-toolkit          # Everything
```

### Package Publishing Order

Packages are published in dependency order:

1. agent-schema, utils (parallel - no deps)
2. discovery, resources (parallel - depend on utils)
3. rag (depends on resources, utils)
4. rag-lancedb, agent-config (parallel)
5. runtime-claude-skills
6. cli
7. vat-development-agents
8. vibe-agent-toolkit (umbrella - published last)

### Rollback Safety

Publishing uses rollback protection:
- Tracks progress in `.publish-manifest.json`
- On failure: attempts `npm unpublish --force`
- Fallback: `npm deprecate` with warning message
- Use RC testing to minimize stable release failures

### Building

```bash
# Build all packages
bun run build

# Clean build
bun run build:clean
```

## CI/CD

GitHub Actions runs on every push/PR:
- Matrix: Node 22/24 × Ubuntu/Windows
- Validation via vibe-validate
- All checks must pass before merge

## Architecture Principles

See [docs/architecture/README.md](docs/architecture/README.md) for complete details:

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

- [Architecture](./docs/architecture/README.md) - Package structure and evolution plan
- [Getting Started](./docs/getting-started.md) - Detailed setup guide
- [Documentation](./docs/README.md) - Full documentation index
- vibe-validate docs: https://github.com/jdutton/vibe-validate
- ESLint config: `eslint.config.js` (heavily documented)
- CI workflow: `.github/workflows/validate.yml`

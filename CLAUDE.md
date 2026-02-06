# Project Development Guidelines

This document provides guidance for AI assistants and developers working on vibe-agent-toolkit.

## Project Purpose

The vibe-agent-toolkit is a modular toolkit for building, testing, and deploying portable AI agents that work across various LLMs, frameworks, and deployment targets.

See [docs/architecture/README.md](docs/architecture/README.md) for detailed package architecture and evolution plan.

## ⚠️ CRITICAL: Pre-1.0 Development Policy

**BACKWARD COMPATIBILITY IS A BUG DURING v0.1.x**

While this project is in v0.1.x (pre-1.0):
- ❌ **DO NOT** add backward compatibility layers
- ❌ **DO NOT** create deprecation wrappers or shims
- ❌ **DO NOT** re-export types for "convenience"
- ❌ **DO NOT** maintain old APIs alongside new ones
- ✅ **DO** make breaking changes freely to improve the API
- ✅ **DO** remove old code completely when replacing it
- ✅ **DO** force consumers to update (it's pre-1.0!)

**Rationale**: Pre-1.0 is the time to iterate rapidly and find the right abstractions. Backward compatibility adds complexity, maintenance burden, and prevents us from fixing design mistakes. Users expect breaking changes in v0.x releases.

**After v1.0**: We'll follow semantic versioning strictly with proper deprecation cycles.

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

**Example**: See `packages/resources/src/schemas/metadata.ts` for reference implementation.

### JSON Schema Validation vs Zod

**Use Zod for**: All TypeScript validation, internal schemas, runtime type safety
**Use AJV for**: Validating arbitrary user-provided JSON Schemas (e.g., frontmatter validation)

Why:
- Zod provides TypeScript types + runtime validation for our code
- AJV validates data against standard JSON Schema files (what users provide)
- Each tool has a specific purpose

**Location**: `packages/resources/src/frontmatter-validator.ts` (only place using AJV)

**Pattern**: When users need to validate their data:
- Users provide JSON Schema file (industry standard)
- We use AJV to validate their data against their schema
- We use Zod for our own internal validation needs

### Zod Version Compatibility (CRITICAL)

**VAT supports both Zod v3.25.0+ and v4.0.0+ via duck typing.**

**The Problem**: When your code uses `instanceof` to check Zod types, it **breaks** when library and user Zod versions differ:

```typescript
// ❌ WRONG - Fails when user has Zod v4, library has v3
import { z } from 'zod';
if (zodType instanceof z.ZodString) {
  // Never executes across version boundaries!
}
```

**The Solution**: Use duck typing via `_def.typeName`:

```typescript
// ✅ CORRECT - Works across all Zod versions
import { getZodTypeName, ZodTypeNames } from '@vibe-agent-toolkit/utils';

const typeName = getZodTypeName(zodType);
if (typeName === ZodTypeNames.STRING) {
  // Always works!
}
```

**When to Use Duck Typing**:
- ✅ Introspecting user-provided Zod schemas (custom metadata, agent configs, etc.)
- ✅ Runtime type detection for serialization/deserialization
- ✅ Building SQL filters, validation logic, or any code that inspects schema structure
- ❌ NOT needed for simple `.parse()` or `.safeParse()` validation

**Available Utilities** (`@vibe-agent-toolkit/utils`):
- `getZodTypeName(zodType)` - Extract type name safely
- `isZodType(zodType, ZodTypeNames.STRING)` - Check type
- `unwrapZodType(zodType)` - Unwrap optional/nullable
- `ZodTypeNames` - Constants for all Zod types

**Full Documentation**: [docs/zod-compatibility.md](docs/zod-compatibility.md)

**Real-World Impact**: PR #34 fixed metadata filtering that returned 0 results when user's Zod v4 met library's Zod v3.

### Frontmatter Validation

Resources package parses and stores YAML frontmatter from markdown files. Users can optionally validate frontmatter against JSON Schemas.

**Common Use Case**: Define minimum required fields, allow extras

Most projects have files (README.md, etc.) without frontmatter - this is fine. Validation only enforces requirements when frontmatter is present.

**Schema Design Pattern**:
- Use `"required": [...]` for must-have fields
- Omit or set `"additionalProperties": true` to allow custom fields
- Files without frontmatter: No error unless schema requires fields

**Example Usage**:
```bash
# Parse frontmatter, report YAML errors only
vat resources validate docs/

# Validate against schema
vat resources validate docs/ --frontmatter-schema schema.json
```

**Example Schema** (knowledge base pattern):
```json
{
  "type": "object",
  "required": ["title", "description"],
  "properties": {
    "title": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "category": { "enum": ["guide", "reference", "tutorial", "api"] },
    "keywords": { "type": "array", "items": { "type": "string" } },
    "source_url": { "type": "string", "format": "uri" }
  }
}
```

### CLI Development

**Commander.js for Command-Line Interface**
- Use Commander.js for all CLI commands and argument parsing
- Provides consistent, well-documented CLI patterns
- Supports subcommands, options, help text, and validation
- Industry standard with excellent TypeScript support

**Example**: See `packages/cli/src/index.ts` for reference implementation.

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

**Critical: Use `tsc --build` for all TypeScript compilation.** This is TypeScript's standard monorepo solution.

**Quick rules:**
- Every package needs `"composite": true` in tsconfig.json
- Use `workspace:*` for all internal dependencies
- Commands: `bun run build`, `bun run build:clean`, `bun run typecheck`

See [docs/build-system.md](docs/build-system.md) for configuration details, troubleshooting, and workspace protocol rationale.

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

Large test data for system/integration tests should be stored as compressed archives to avoid SonarQube analyzing third-party code:

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

See [docs/publishing.md](docs/publishing.md) for complete publishing workflow, versioning, and rollback procedures.

**Quick Reference:**
- Use `bun run bump-version <version>` for all version changes
- All packages share same version (unified versioning)
- RC versions stay in `[Unreleased]` section of CHANGELOG
- Publishing is automated via GitHub Actions
- Commands: `bun run build`, `bun run build:clean`

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

Follow standard practices: SOLID, DRY, TDD, Clean Code, KISS, YAGNI.

See [docs/best-practices.md](docs/best-practices.md) for detailed patterns, error handling, code review checklists, and technical debt management.

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

**For AI-Heavy Development**: Create custom ESLint rules for dangerous patterns to prevent AI from reintroducing them.

**Current rules:** `no-child-process-execSync` (enforces `safeExecSync()`)

See [docs/custom-eslint-rules.md](docs/custom-eslint-rules.md) for pattern details and how to create new rules.

## Demo Guidelines

**CRITICAL: All demos MUST use runtime adapters, never direct agent execution.**

Demos must support ALL compatible runtimes (Vercel, OpenAI, LangChain, Claude Agent SDK).

See [docs/demo-guidelines.md](docs/demo-guidelines.md) for adapter patterns and file organization.

**Example:** `packages/vat-example-cat-agents/examples/conversational-demo.ts`

## Structured Output Patterns

See [docs/structured-outputs.md](docs/structured-outputs.md) for pattern comparison and examples.

**Quick insight**: Don't force JSON on every conversational turn. Use two-phase pattern for chatbots.

## Questions?

- [Architecture](./docs/architecture/README.md) - Package structure and evolution plan
- [Getting Started](./docs/getting-started.md) - Detailed setup guide
- [Documentation](./docs/README.md) - Full documentation index
- [Build System](./docs/build-system.md) - TypeScript monorepo build configuration
- [Publishing](./docs/publishing.md) - Version management and publishing workflow
- [Best Practices](./docs/best-practices.md) - Enterprise development standards
- [Custom ESLint Rules](./docs/custom-eslint-rules.md) - Agentic code safety patterns
- [Demo Guidelines](./docs/demo-guidelines.md) - Multi-runtime demo requirements
- vibe-validate docs: https://github.com/jdutton/vibe-validate
- ESLint config: `eslint.config.js` (heavily documented)
- CI workflow: `.github/workflows/validate.yml`

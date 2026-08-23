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

🚫 **Hand-maintained version constants are PROHIBITED** — no `const CACHE_VERSION = 1`, no `SCHEMA_VERSION`, no `*_REVISION` deciding whether stored data is still valid: a number someone must remember to bump is not a contract, so derive it (a digest of the schema's own shape, as `parseFactsShapeSource()` does) or invalidate explicitly. This extends to version *labels* we emit in our own output — VAT ships no `schema:`/`vat.*/v1alpha` discriminator for a consumer to read; under pre-1.0 the package version is the only contract.

### Skill Distribution Architecture

Skills, config, and packaging each have a distinct role. These boundaries are intentional:

| Surface | Role | Owns |
|---------|------|------|
| **SKILL.md frontmatter** | Portable skill metadata | Skill identity, description, triggers — standard schema, never VAT-specific fields |
| **vibe-agent-toolkit.config.yaml** | VAT source of truth | All VAT-specific config — discovery globs, packaging, `publish` flag, plugin assignment |
| **package.json `vat.skills`** | npm packaging hint | Declares which skills ship in this npm package — validated by `vat verify`, never used as input for build |

**Key rules:**
- `vat verify` drives validation from config.yaml discovery, checking package.json as a suspect
- `publish: false` in `skills.config.<name>` opts a skill out of the **distribution-consistency**
  checks — the `package.json` `vat.skills` and plugin-membership cross-checks in `consistency-check`
  (default: `true`). It does **not** exempt the skill from build-time packaging validation: a
  `publish: false` skill is still discovered, built, and held to every packaging rule, and its
  errors still fail the build. Packaging correctness is not conditional on shipping.
- Error messages always reference the config mechanism so developers discover the fix from the error
- No VAT-specific fields in SKILL.md frontmatter — skills are portable artifacts

### Resource Collections and Per-Directory Schema Validation

For per-directory frontmatter schema validation (multiple document types, each with its own JSON Schema), see [docs/guides/collection-validation.md](docs/guides/collection-validation.md).

### Asset References — The Canonical Pattern for Config-Supplied File References

When a VAT config field accepts "where is this file?" — a schema path, a template path, any analogous resource — the value flows through `resolveAssetReference(specifier, baseDir)` from `@vibe-agent-toolkit/utils`. This is non-negotiable.

The helper supports both filesystem paths (relative to `baseDir`, or absolute) and npm bare specifiers (`@scope/pkg/subpath` or `pkg/subpath`) honoring the target package's `exports` map. Bare specifiers let consumers reference resources published as npm packages without hardcoding the package's internal layout.

**Existing call sites (templates for new ones):**

- `packages/resources/src/resource-registry.ts` — `validateAgainstCollectionSchema` (collection `frontmatterSchema`)
- `packages/agent-skills/src/skill-packager.ts` — schema path resolution during packaging
- `packages/agent-skills/src/skill-source/sources/path-source.ts` — filesystem skill source location
- `packages/agent-skills/src/skill-source/sources/npm-source.ts` — npm skill source location
- `packages/cli/src/commands/doctor.ts` — `checkSchemaFiles` (doctor schema existence checks)
- `packages/cli/src/commands/resources/validate.ts` — `loadSchema` (`--frontmatter-schema` flag)

**When adding a new config-supplied file reference, route through `resolveAssetReference` from day one.** Don't write a parallel path-only resolver and plan to consolidate later — the consolidation never happens.

**Where this does NOT apply:**

- Markdown URI-references (RFC 3986 — `format: "uri-reference"` walker stays standards-conformant; no bare-specifier resolution there)
- Dynamic JS imports (use `dynamicImportPath()` from utils)
- `node_modules` enumeration walks (different concern: listing, not resolving a known specifier)
- CJS interop shims

### Package-Specific Guidelines

**utils package**:
- No dependencies on other internal packages
- Add utilities only when needed by other packages (not speculatively)
- Avoid creating string/array/object helpers without real use cases
- Example: cross-platform process spawning, schema validation utilities
- May have external npm dependencies (Zod, etc.)
- `safePath.join()`, `safePath.resolve()`, `safePath.relative()` — cross-platform path wrappers that always return forward slashes. ESLint rules (`no-path-join`, `no-path-resolve`, `no-path-relative`) enforce their use over raw `node:path` functions. Import from `@vibe-agent-toolkit/utils`.

**resources, rag, agent-skills packages**:
- Depend on `utils` for shared functionality
- Define their own schemas using Zod
- Export both TypeScript types and JSON schemas
- Keep schemas in `src/schemas/` directory

**cli package**:
- Uses Commander.js for all command parsing
- Orchestrates other packages (don't duplicate logic)
- User-facing entry point for the toolkit

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
│   ├── resources/    # Resource parsing & validation
│   ├── rag/          # Document chunking & embeddings
│   ├── agent-skills/ # Agent skill packaging
│   ├── cli/          # Command-line interface
│   └── dev-tools/    # Build and development tools (private)
├── docs/             # Documentation
├── .github/          # CI/CD workflows
└── [config files]    # Root-level configuration
```

(25 packages ship today; this tree shows the core set — see `packages/` for the full list.)

### Test Fixtures Convention

**CRITICAL: Never use gitignored directory names (`dist/`, `node_modules/`, `coverage/`, `build/`) in committed test fixtures.** Files committed under these names silently disappear in CI (clean clone) while appearing to work locally. Store committed artifact sources under a non-gitignored name (e.g., `build-artifacts/`) and have test `beforeAll` copy them to `tempDir/dist/` to simulate a real build step. See [docs/writing-tests.md](docs/writing-tests.md) for fixture-storage conventions (compressed archives, extraction, examples).

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

- **Test Coverage**: Currently enforced at 70% (statements, branches, functions, lines). Goal: 80%+. See [Test Pyramid and Coverage](#test-pyramid-and-coverage) for details.
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

### Test Pyramid and Coverage

Follow the standard test pyramid: **unit > integration > system**.

| Type | Location | Command | Speed | Coverage? |
|------|----------|---------|-------|-----------|
| Unit | `test/*.test.ts` | `bun run test:unit` | < 100ms | **Yes** |
| Integration | `test/integration/*.integration.test.ts` | `bun run test:integration` | < 5s | No |
| System | `test/system/*.system.test.ts` | `bun run test:system` | < 30s | No |

**Only unit tests are coverage-instrumented.** If Codecov flags low patch coverage, add unit tests.

**When to write unit tests**: Pure logic, data transformations, algorithms, schema validation, anything testable without I/O. These should be the bulk of your tests.

**When to write integration tests**: Wiring between real components — database queries, file system operations, multi-module workflows. Verify the glue, not the logic.

**Design implication**: Extract pure logic into standalone functions so it can be unit tested. Keep I/O orchestration thin and test it via integration tests.

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
bun run test:coverage      # Unit tests with coverage report
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

### Subagent-Driven Execution: Batch the Work, Validate ONCE at the End

**This section governs how to run multi-task plans via the `superpowers:subagent-driven-development` skill (the preferred execution method in this repo).** It overrides the per-task "commit at each boundary" rhythm that skill assumes, because of how this repo's gates are wired:

- **`git commit` triggers `bun run validate` via the Husky pre-commit hook, which takes ~3.5–4 minutes and requires the ENTIRE tree to be perfect** (lint, typecheck, unit + integration + system tests, zero duplication). A mid-refactor tree is *never* perfect, so a per-task commit either blocks for 4 minutes or fails outright.
- Therefore: **do NOT commit per task or per phase. Do NOT run `bun run validate` mid-flight.** Batch all tasks/phases into one uncommitted working tree, then run `bun run validate` exactly once when everything is stable, fix what it surfaces, and commit at the very end (in as few commits as the change logically needs).

**Guidance to embed in every implementer/fixer subagent prompt:**

> Verify your change with the fast, isolated signal only:
> 1. **ESLint the files you changed** — `bunx eslint <changed files> --max-warnings=0`.
> 2. **Run only the isolated unit test(s) for the thing you changed** — `bun run test:unit -- <name-substring>` (Vitest filters by filename) or `bunx vitest run <path/to/file.test.ts>`.
>
> Do NOT run `bun run validate`, `bun run test:system`, or `bun run test:integration` — they are slow and will not pass on a partially-migrated tree. Do NOT use `bun test`. Do NOT commit — leave all changes uncommitted; the orchestrator commits once at the end after a single full `bun run validate`.

**Why:** the per-change feedback loop must stay fast (seconds, not minutes) for subagent iteration to be worthwhile; the expensive whole-tree gate is meaningful only once, on a stable tree. See [Critical Duplication Policy](#critical-code-duplication-policy) — the single end-of-run `validate` is also where duplication is caught, so each "move/rename" task must delete the original in the same task (never leave a copy that a later task removes).

### Pre-Commit Checklist

Before committing, ensure:
1. `bun run lint` passes with zero warnings
2. `bun run typecheck` passes
3. `vv validate` passes (or `bun run test:unit && bun run test:integration && bun run test:system`)
4. `bun run duplication-check` passes (**MUST pass - see Critical Duplication Policy above**)
5. All files formatted correctly (enforced by .editorconfig)

Pre-commit hooks via Husky will enforce these automatically.

**IMPORTANT**: If `duplication-check` fails, refactor to eliminate duplication. Never update the baseline without explicit permission.

### Pre-Pull-Request Checklist (MANDATORY)

**Before creating a pull request, you MUST complete these steps:**

1. **Update CHANGELOG.md** — Add an entry under `## [Unreleased]` describing the change. Follow the existing format (see previous entries for style). This is not optional — every PR must have a changelog entry.

2. **Ask about version bump** — Ask the developer: *"Would you like to bump the version or create an RC for this change?"*
   - If yes: run `bun run bump-version <version>` (e.g., `0.1.16-rc.5`) and commit the version bump
   - For **stable** versions, `bump-version` auto-stamps CHANGELOG.md (moves `[Unreleased]` content under a new `## [X.Y.Z] - date` heading)
   - If no: proceed with just the changelog update
   - RC versions (e.g., `0.1.16-rc.5`) stay in the `[Unreleased]` section — they are NOT given their own version heading

3. **Run `bun run validate`** one final time after the changelog/version changes to ensure nothing broke

**For AI assistants:** This is a hard gate. Do NOT create a PR without updating the changelog and asking about the version bump first. Forgetting this creates extra work for the maintainer.

### Pre-Release Checklist (MANDATORY — before tagging)

**After the PR is merged to main, ALWAYS run the pre-release check BEFORE creating any version tag:**

1. **Run `bun run pre-release`** — Confirms CHANGELOG is stamped, no stale tags on remote, marketplace dry-run passes, and version section has content.
2. **Only after pre-release passes:** Tag: `git tag v{version}`
3. **Push:** `git push origin main v{version}`

**Why this matters:** CI publish is triggered by the tag push. If CHANGELOG isn't stamped or artifacts aren't built, the publish fails and you have to delete the tag and re-do it. `bun run pre-release` catches all of these issues locally before you create the tag.

**For AI assistants:** Never suggest tagging without running `bun run pre-release` first. This is non-negotiable.

### Running vat CLI During Development

Run vat commands from the repo root via `bun run vat <command> <args>` — workspace bin linking is unreliable across package managers (Bun/npm/pnpm) in monorepos, so avoid `bunx`/`npx` here. See [packages/cli/CLAUDE.md](packages/cli/CLAUDE.md) for package build script invocation and skill-resolution mechanics.

**Three "validate"-flavored commands — don't conflate them:**

| Command | What it is | When to run |
|---|---|---|
| `bun run validate` | This repo's **vibe-validate orchestrator** — lint, typecheck, unit/integration/system tests, duplication. The full local CI gate. **Not** a vat subcommand. | Before every commit (the pre-commit hook runs it too). |
| `vat validate` | A **vat CLI command** — runs the *source-level* validators the project's config declares (resources + skills). Never builds. | Pre-commit / CI-before-build on a project that adopts vat. |
| `vat verify` | A **vat CLI command** — validates the *built* `dist/` artifacts (adds marketplace + consistency). | After `vat build`, before publish. |

So when this repo's docs say "run `bun run validate`," that's the orchestrator, not the `vat validate` CLI subcommand. `vat validate` ⊂ `vat verify` in scope; both are vat product commands, distinct from the repo's own `bun run validate` gate.

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
- All code must have tests (see [Code Quality Thresholds](#code-quality-thresholds) for coverage targets)
- Document public APIs with JSDoc comments
- Commit messages follow conventional commits format

## Publishing & Version Management

See [docs/publishing.md](docs/publishing.md) for complete publishing workflow, versioning, and rollback procedures.

**Quick Reference:**
- Use `bun run bump-version <version>` for all version changes (stable bumps auto-stamp CHANGELOG)
- All packages share same version (unified versioning)
- RC versions stay in `[Unreleased]` section of CHANGELOG
- **ALWAYS run `bun run pre-release` before tagging** — validates CHANGELOG, tag, and marketplace
- Publishing is triggered by pushing a git tag: `git tag vX.Y.Z && git push origin main vX.Y.Z`
- GitHub Actions then auto-publishes to npm and creates the GitHub release
- Commands: `bun run build`, `bun run build:clean`

### Licensing Conventions

Use the correct license field for the package's intended distribution:

| Package type | `"license"` value | Also set | Files to add |
|---|---|---|---|
| Open source (MIT, Apache, etc.) | `"MIT"` | — | `LICENSE` |
| Proprietary/enterprise internal | `"SEE LICENSE IN LICENSE"` | `"private": true` | `LICENSE` |
| Not yet licensed | `"UNLICENSED"` | `"private": true` | — |

**Standard enterprise proprietary LICENSE template** (for `private: true` packages owned by an organization):

```
Copyright (c) [YEAR] [Organization Name]. All rights reserved.

This software is proprietary to [Organization Name] and is made available
solely for use by authorized personnel and contractors under applicable
confidentiality obligations. Redistribution, modification, or use outside
this scope requires written consent from [Organization Name].
```

`"UNLICENSED"` signals "the author forgot to add a license" to npm tooling — do NOT use it for intentionally proprietary packages.

## CI/CD

GitHub Actions runs on every push/PR:
- Matrix: Node 22/24 × Ubuntu/Windows
- Validation via vibe-validate
- All checks must pass before merge

## Architecture Principles

See [docs/architecture/README.md](docs/architecture/README.md) for complete details:

1. **Clear Package Boundaries** - Single, well-defined purpose per package
2. **Progressive Dependencies** - utils → resources → rag/agent-skills → cli
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

Tools follow same quality standards as packages (linted, typed, tested).

## Custom ESLint Rules - Agentic Code Safety Pattern

Custom ESLint rules for dangerous AI-generated patterns live in `packages/utils/eslint/` and ship publicly on the `@vibe-agent-toolkit/utils/eslint` subpath. See [docs/custom-eslint-rules.md](docs/custom-eslint-rules.md) for how to add a rule, and [packages/utils/eslint/README.md](packages/utils/eslint/README.md) for the full rule table.

## Demo Guidelines

**CRITICAL: All demos MUST use runtime adapters, never direct agent execution.**

Demos must support ALL compatible runtimes (Vercel, OpenAI, LangChain, Claude Agent SDK).

See [docs/demo-guidelines.md](docs/demo-guidelines.md) for adapter patterns and file organization.

**Example:** `packages/vat-example-cat-agents/examples/conversational-demo.ts`

## Structured Output Patterns

See [docs/structured-outputs.md](docs/structured-outputs.md) for pattern comparison and examples.

**Quick insight**: Don't force JSON on every conversational turn. Use two-phase pattern for chatbots.

## Agent-Facing Skills (in this repo)

VAT ships a plugin of skills for agents working on VAT itself. They live at `packages/vat-development-agents/resources/skills/` and publish as the `vat-development-agents` plugin. **When a task matches one of the descriptions below, load the skill before acting** — the repo-level docs (`docs/`) are reference material; these skills are the procedural runbooks.

| Skill file | When to use |
|---|---|
| `SKILL.md` (router, name `vibe-agent-toolkit`) | Any VAT work — routes to the sub-skills below |
| `vat-adoption-and-configuration.md` | New project setup, `vibe-agent-toolkit.config.yaml` orientation, repo structure, vibe-validate integration, npm postinstall |
| `vat-skill-authoring.md` | Authoring SKILL.md files: frontmatter, body structure, references, packagingOptions, validation overrides |
| `vat-agent-authoring.md` | TypeScript portable agents: archetypes, `agent.yaml`, result envelopes, orchestration, runtime adapters |
| `vat-audit.md` | Running `vat audit`, interpreting `--compat` output, `--exclude` noise filtering, CI usage |
| `vat-knowledge-resources.md` | Resource collections, per-directory frontmatter schemas, `vat resources validate` |
| `vat-skill-distribution.md` | `vat build`, `vat verify`, plugin/marketplace config, npm publishing with postinstall |
| `vat-rag.md` | `vat rag index/query`, native embedding providers, vector store, extension points |
| `vat-skill-review.md` | Pre-publication review rubric, validation-code reference, `vat skill review` CLI |
| `vat-skill-testing.md` | Running `vat skill test run`/`configure`, friction triage, isolation/auth model, security ack |
| `vat-enterprise-org.md` | Anthropic Admin API: org users, cost/usage, workspace skills, `ANTHROPIC_ADMIN_API_KEY` |
| `coherence-audit.md` | Auditing a subsystem for internal CONSISTENCY rather than for bugs: does every lane implement one contract, does a status/report tell the truth, is a green test suite structurally blind, is a claim about another vendor still true |

**For AI assistants**: If you're asked a question about VAT skill authoring, audit output, distribution, or publishing and you haven't invoked the matching skill, you're probably about to give a shallower answer than you could. Invoke first.

## Contributor Reference Docs

Material for developers working on VAT itself (not for users of VAT) lives under `docs/contributing/`:

- [vat-debugging.md](docs/contributing/vat-debugging.md) — reproducing VAT bugs, `VAT_ROOT_DIR` adopter testing, failing-test-first fixes before landing changes
- [vat-install-architecture.md](docs/contributing/vat-install-architecture.md) — design landscape for VAT's install/uninstall surfaces; read before proposing new install methods
- [command-lane-table.md](docs/contributing/command-lane-table.md) — which of the 66 commands enumerate the filesystem, through which of the three entry points, and which three only do so by spawning child processes; read before changing enumeration or the crawl routes
- [packages/lab/README.md](packages/lab/README.md) — the **quality lab**: a separate CLI that reports on a project and compares along one of three axes (which project, which version of it, which vat build). Read before adding any dev/QA/profiling verb — it owns that scope, and its [scope doc](packages/lab/docs/scope.md) decides what belongs there versus in `vat`

**⚠️ Measuring anything? The lab is the instrument — do not hand-roll a probe.** The trigger is
**taking a measurement**, not adding a verb: "why is this slow", "how many files does it touch",
"did this change regress", "how does it behave on a big adopter tree" all route here *first*.
`vat-lab <facet> run <subject>` and `vat-lab <facet> compare <a> <b>` already exist, and
`DEFAULT_MEASURED_COMMANDS` is explicitly "not a closed set" — a caller measuring something else
passes its own specs.

**If the lab cannot see the code you want to measure, that is the finding.** Do not route around it
with a throwaway script: a hand-rolled probe measures once, is never reviewed, and dies with the
session — and a wrong one reports a confident number, which is worse than no number
([[measurement-that-did-not-run]], [[fixtures-that-cannot-distinguish]]). Extend the instrument, or
say plainly that the code is unreachable from it. Code no instrument can reach is code whose
regressions nobody will catch — that is a merge concern, not a tooling inconvenience.
- [plugin-distribution-findings.md](docs/contributing/plugin-distribution-findings.md) — running evidence log behind VAT's plugin-shape rules (what's DOCUMENTED vs merely OBSERVED), the silent hosted-sync divergence class, and a "rules NOT to add" list; read before proposing or promoting any plugin-shape rule

## External Documentation Cache

Cached copies of external guidance (e.g., Anthropic's skill-authoring best-practices doc) live under [`docs/external/`](docs/external/), each naming its source URL and fetch date in its preamble. See [`.claude/rules/external-doc-cache-refresh.md`](.claude/rules/external-doc-cache-refresh.md) for the refresh policy.

## Questions?

- [Architecture](./docs/architecture/README.md) - Package structure, evolution plan, and cross-cutting architectural concerns (the directory's CLAUDE.md pulls in its README)
- [Getting Started](./docs/getting-started.md) - Detailed setup guide
- [Documentation](./docs/README.md) - Full documentation index (the directory's CLAUDE.md pulls in its README)
- [Build System](./docs/build-system.md) - TypeScript monorepo build configuration
- [Publishing](./docs/publishing.md) - Version management and publishing workflow
- [Best Practices](./docs/best-practices.md) - Enterprise development standards
- [Custom ESLint Rules](./docs/custom-eslint-rules.md) - Agentic code safety patterns
- [Demo Guidelines](./docs/demo-guidelines.md) - Multi-runtime demo requirements
- vibe-validate docs: https://github.com/jdutton/vibe-validate
- ESLint config: `eslint.config.js` (heavily documented)
- CI workflow: `.github/workflows/validate.yml`

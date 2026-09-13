# Documentation

Welcome to the Vibe Agent Toolkit documentation.

## Getting Started

- **[Getting Started Guide](./getting-started.md)** - Set up your development environment and start building agents
- **[Main README](../README.md)** - Overview of the toolkit and quick reference

## Development

- **[CLAUDE.md](../CLAUDE.md)** - The rules for working in this repo, each tagged with its enforcer
- **[Writing Tests](./writing-tests.md)** - Test pyramid, helpers, fixtures, per-tier budgets, duplication avoidance
- **[Build System](./build-system.md)** - `tsc --build`, composite projects, workspace protocol
- **[Best Practices](./best-practices.md)** - Engineering standards, approved libraries, error handling
- **[Custom ESLint Rules](./custom-eslint-rules.md)** - The `local/` rule pack and how to add a rule
- **[Adding Runtime Adapters](./adding-runtime-adapters.md)** - Best practices for creating new runtime adapters
- **[Demo Guidelines](./demo-guidelines.md)** - Every demo runs through a runtime adapter
- **[Publishing Guide](./publishing.md)** - Version bumps, tagging, npm publishing, licensing conventions

## Contributing to VAT itself

Material for people working on VAT, not for people using it — [`contributing/`](./contributing/):

- **[Content Routing](./contributing/content-routing.md)** - Where a new statement belongs (root CLAUDE.md, a rule file, a doc, a docstring, or deleted)
- **[Traps](./contributing/traps.md)** - Failures that look like something else: the tell and the remedy, one entry each
- **[Extending the Monorepo](./contributing/extending-the-monorepo.md)** - Adding a package, a utility, a schema, a CLI command
- **[No Version Constants](./contributing/no-version-constants.md)** - Why a hand-bumped integer never decides data validity, and what replaces it
- **[Command → Enumeration Lane](./contributing/command-lane-table.md)** - Which of the 72 commands walk the filesystem, through which entry point
- **[Debugging VAT](./contributing/vat-debugging.md)** - Reproducing bugs, `VAT_ROOT_DIR` adopter testing, failing-test-first fixes
- **[Install Architecture](./contributing/vat-install-architecture.md)** - Design landscape for install/uninstall surfaces
- **[linkAuth Engine](./contributing/vat-linkauth-contributing.md)** - Working on authenticated external-link resolution
- **[Plugin Distribution Findings](./contributing/plugin-distribution-findings.md)** - Evidence log behind the plugin-shape rules (DOCUMENTED vs OBSERVED)
- **[Baseline Control Adopter Response](./contributing/baseline-control-adopter-response.md)** - The `vat skill test --baseline` control-arm contamination record
- **[Cowork Driver Spike](./contributing/cowork-driver-spike.md)** - Closed spike report on driving Claude Cowork from the skill-test harness

## Validation & Quality Framework

VAT is opinionated about skill and plugin quality. Three docs articulate what we believe, what we flag, and how we decide:

- **[Skill Quality & Compatibility — VAT's Stance](./skill-quality-and-compatibility.md)** — What VAT believes about skill structure, packaging, and runtime compatibility. Foundation for every `defaultSeverity`.
- **[Validation Codes](./validation-codes.md)** — Every code VAT emits, default severities, and configuration syntax (`validation.severity` / `validation.allow`).
- **[Validation Rule Design](./validation-rule-design.md)** — How VAT decides what to flag; rule-addition and severity-default policy.

See also: [Skill Packaging Shapes](./architecture/skill-packaging.md) for the artifact shape terminology.

## Concepts

- **[Roots and Config](./concepts/roots-and-config.md)** - Canonical definitions for roots, project root, and config discovery
- **[Knowledge Interop Formats](./concepts/knowledge-interop-formats.md)** - OKF and ARD: what a knowledge bundle is, and how agents discover published resources

## Guides

- **[Collection Validation](./guides/collection-validation.md)** - Per-collection frontmatter validation with JSON Schemas
- **[Distributing VAT Skills](./guides/distributing-vat-skills.md)** - Orientation for publishing skills as an npm package; the runbook is the `vat-skill-distribution` skill
- **[Marketplace Distribution](./guides/marketplace-distribution.md)** - Publishing a Claude plugin marketplace branch
- **[Skill Files and Routing](./guides/skill-files-and-routing.md)** - How file types route into packaged-skill subdirectories
- **[Agent Skills Best Practices](./guides/agent-skills-best-practices.md)** - Authoring guidance for SKILL.md
- **[Package-Based Schema References](./guides/package-based-schema-references.md)** - Referencing schemas published in npm packages
- **[RAG Usage Guide](./guides/rag-usage-guide.md)** - Using the RAG package for semantic search
- **[Resource Compiler](./guides/resource-compiler/README.md)** - Compiling markdown to TypeScript for type-safe content packages
- **[Embedding Providers](./embedding-providers.md)** - How embedding providers work and creating custom providers

## Configuration

- **[ESLint Config](../eslint.config.js)** - Strict linting rules (heavily documented)
- **[TypeScript Config](../tsconfig.base.json)** - Base TypeScript configuration
- **[Vitest Configs](../vitest.config.ts)** - Test configurations (unit, integration, system)
- **[vibe-validate Config](../vibe-validate.config.yaml)** - Validation orchestration

## Example Packages

- **[Utils Package](../packages/utils/README.md)** - Shared utilities (path-utils, file-crawler, safe-exec)
- **[Resources Package](../packages/resources/README.md)** - Resource registry and link validation

## Development Tools

All development tools are TypeScript under `packages/dev-tools/src/` (never shell scripts); the
root `package.json` `scripts` block is the index of what runs them. The list in the root
[`CLAUDE.md`](../CLAUDE.md#where-the-rest-lives) is generated from the directory.

## Design Specifications & Research

Design records, including for work that is approved but not yet built. They are committed so a
design survives the worktree it was written in.

- **[Result Envelope Design](./result-envelope-design.md)** — the complete specification for VAT
  agent result envelopes: error constants, observability fields, and retry semantics.
- **[Skill-Test Eval Runner (2026-06-24)](./research/2026-06-24-skill-test-eval-runner-design.md)**
  — the approved tiered/parallel/cacheable eval-runner design, still to be executed; it carries
  forward into [multi-runtime skill testing](./research/2026-06-25-multi-runtime-skill-testing-direction.md).
- **[Claude Plugin Loader Semantics (2026-05-03)](./research/2026-05-03-claude-plugin-loader-semantics.md)**
  — measured behaviour of the plugin loader.
- **[Compat Empirical Harness v2 (2026-05-23)](./research/2026-05-23-compat-empirical-harness-v2-design.md)**
  — design for the empirical compatibility harness.
- **[State Persistence Patterns](./research/state-persistence-patterns.md)** — approaches to
  session and conversation state.

## External Resources

- [Bun Documentation](https://bun.sh/docs)
- [Vitest Documentation](https://vitest.dev/)
- [vibe-validate](https://github.com/jdutton/vibe-validate)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [ESLint Rules](https://eslint.org/docs/latest/rules/)

## Quick Reference

### Common Commands

```bash
# Development
bun install               # Install dependencies
bun run build             # Build all packages
bun run lint              # Lint code
bun run typecheck         # Type checking

# Testing (do NOT use 'bun test' directly)
bun run validate          # Full validation — the gate (vv validate is the same binary)
bun run test:unit         # Unit tests only
bun run test:watch        # Watch mode for development
bun run test:integration  # Integration tests
bun run test:system       # System tests

# Quality Checks
bun run duplication-check  # Check for code duplication
bun run test:coverage      # Unit tests with coverage report
```

Never `bun test` — it ignores `vitest.config.ts` and runs every tier in one process.

### File Locations

- **Packages**: `packages/*/`
- **Development Tools**: `packages/dev-tools/`
- **Docs**: `docs/`
- **CI/CD**: `.github/workflows/`
- **Config**: Root directory

## Where to start

[CLAUDE.md](../CLAUDE.md) holds the rules; [`contributing/`](./contributing/) holds the how and the why for people changing VAT itself; the [architecture index](./architecture/README.md) holds the shape.

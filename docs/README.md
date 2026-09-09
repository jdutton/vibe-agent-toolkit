# Documentation

Welcome to the Vibe Agent Toolkit documentation.

## Getting Started

- **[Getting Started Guide](./getting-started.md)** - Set up your development environment and start building agents
- **[Main README](../README.md)** - Overview of the toolkit and quick reference

## Development

- **[CLAUDE.md](../CLAUDE.md)** - Comprehensive development guidelines, testing conventions, and code standards
- **[Adding Runtime Adapters](./adding-runtime-adapters.md)** - Best practices for creating new runtime adapters
- **[Publishing Guide](./publishing.md)** - How to prepare and publish packages to npm

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
- **[Writing Tests](./writing-tests.md)** - Test conventions, helpers, and duplication avoidance
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

All development tools are in the `packages/dev-tools/src/` directory:
- `common.ts` - Shared utilities for tools
- `duplication-check.ts` - Code duplication detection
- `jscpd-check-new.ts` - Smart duplication checking with baseline
- `jscpd-update-baseline.ts` - Update duplication baseline

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
vv validate               # Full validation (recommended)
bun run test:unit         # Unit tests only
bun run test:watch        # Watch mode for development
bun run test:integration  # Integration tests
bun run test:system       # System tests

# Quality Checks
bun run validate     # Run full validation
bun run pre-commit   # Pre-commit checks
bun run duplication-check  # Check for code duplication

# Testing
bun test                    # Unit tests
bun test:integration        # Integration tests
bun test:system            # System tests
bun run test:coverage      # Coverage report
```

### File Locations

- **Packages**: `packages/*/`
- **Development Tools**: `packages/dev-tools/`
- **Docs**: `docs/`
- **CI/CD**: `.github/workflows/`
- **Config**: Root directory

## Contributing

See [CLAUDE.md](../CLAUDE.md) for comprehensive development guidelines, code standards, and testing conventions.

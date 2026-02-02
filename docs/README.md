# Documentation

Welcome to the Vibe Agent Toolkit documentation.

## Getting Started

- **[Getting Started Guide](./getting-started.md)** - Set up your development environment and start building agents
- **[Main README](../README.md)** - Overview of the toolkit and quick reference

## Development

- **[CLAUDE.md](../CLAUDE.md)** - Comprehensive development guidelines, testing conventions, and code standards
- **[Adding Runtime Adapters](./adding-runtime-adapters.md)** - Best practices for creating new runtime adapters
- **[Publishing Guide](./publishing.md)** - How to prepare and publish packages to npm

## Guides

- **[Collection Validation](./guides/collection-validation.md)** - Per-collection frontmatter validation with JSON Schemas
- **[Writing Tests](./writing-tests.md)** - Test conventions, helpers, and duplication avoidance
- **[RAG Usage Guide](./guides/rag-usage-guide.md)** - Using the RAG package for semantic search

## Configuration

- **[ESLint Config](../eslint.config.js)** - Strict linting rules (heavily documented)
- **[TypeScript Config](../tsconfig.base.json)** - Base TypeScript configuration
- **[Vitest Configs](../vitest.config.ts)** - Test configurations (unit, integration, system)
- **[vibe-validate Config](../vibe-validate.config.yaml)** - Validation orchestration

## Example Packages

- **[Utils Package](../packages/utils/)** - Shared utilities (path-utils, file-crawler, safe-exec)
- **[Resources Package](../packages/resources/)** - Resource registry and link validation

## Development Tools

All development tools are in the `packages/dev-tools/src/` directory:
- `common.ts` - Shared utilities for tools
- `duplication-check.ts` - Code duplication detection
- `jscpd-check-new.ts` - Smart duplication checking with baseline
- `jscpd-update-baseline.ts` - Update duplication baseline

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

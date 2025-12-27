# Documentation

Welcome to the TypeScript Monorepo Template documentation.

## Getting Started

- **[Getting Started Guide](./getting-started.md)** - Set up your development environment and create your first package
- **[Main README](../README.md)** - Overview of the template and quick reference

## Development

- **[CLAUDE.md](../CLAUDE.md)** - Comprehensive development guidelines, testing conventions, and code standards
- **[Publishing Guide](./publishing.md)** - How to prepare and publish packages to npm

## Configuration

- **[ESLint Config](../eslint.config.js)** - Strict linting rules (heavily documented)
- **[TypeScript Config](../tsconfig.base.json)** - Base TypeScript configuration
- **[Vitest Configs](../vitest.config.ts)** - Test configurations (unit, integration, system)
- **[vibe-validate Config](../vibe-validate.config.yaml)** - Validation orchestration

## Examples

- **[Example Package](../packages/example-utils/)** - Reference implementation demonstrating patterns

## Tools

All development tools are in the `tools/` directory:
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
bun install          # Install dependencies
bun run build        # Build all packages
bun test             # Run unit tests
bun test:watch       # Watch mode
bun run lint         # Lint code
bun run typecheck    # Type checking

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
- **Tools**: `tools/`
- **Docs**: `docs/`
- **CI/CD**: `.github/workflows/`
- **Config**: Root directory

## Contributing

See [Main README](../README.md#contributing) for contribution guidelines.

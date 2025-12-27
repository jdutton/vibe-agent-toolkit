# Getting Started with TypeScript Monorepo Template

This guide will help you set up and start developing with this template.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Bun** (latest version): [Install Bun](https://bun.sh/docs/installation)
- **Node.js** 22 or 24: [Install Node.js](https://nodejs.org/)
- **Git**: [Install Git](https://git-scm.com/downloads)

## Initial Setup

### 1. Clone and Install

```bash
# Clone your repository (or create from template)
git clone https://github.com/yourusername/your-project.git
cd your-project

# Install dependencies
bun install
```

### 2. Verify Installation

```bash
# Build all packages
bun run build

# Run tests
bun test

# Run linting
bun run lint

# Run type checking
bun run typecheck
```

If all commands pass, you're ready to start developing!

## Development Workflow

### Day-to-Day Development

```bash
# Start development with watch mode
bun test:watch

# In another terminal, make changes to your code
# Tests will automatically re-run

# When ready to commit:
git add .
git commit -m "feat: add new feature"
# Pre-commit hooks will run automatically
```

### Creating Your First Package

1. **Remove the example package** (if you don't need it):

```bash
rm -rf packages/example-utils
```

2. **Create your package**:

```bash
mkdir -p packages/my-package/src packages/my-package/test
```

3. **Copy package template files**:

See [Adding a New Package](../README.md#adding-a-new-package) in the main README.

4. **Update root tsconfig.json**:

Edit `tsconfig.json` to include your new package in the `references` array.

5. **Install and build**:

```bash
bun install
bun run build
```

### Writing Tests

#### Unit Tests

Create `*.test.ts` files alongside your source code or in `test/` directory:

```typescript
// packages/my-package/src/utils.test.ts
import { describe, expect, it } from 'vitest';
import { myFunction } from './utils.js';

describe('myFunction', () => {
  it('should do something', () => {
    expect(myFunction('input')).toBe('expected');
  });
});
```

#### Integration Tests

Create `*.integration.test.ts` files in `test/integration/`:

```typescript
// packages/my-package/test/integration/workflow.integration.test.ts
import { describe, expect, it } from 'vitest';

describe('Workflow Integration', () => {
  it('should complete end-to-end workflow', () => {
    // Test multiple modules working together
  });
});
```

#### System Tests

Create `*.system.test.ts` files in `test/system/`:

```typescript
// packages/my-package/test/system/e2e.system.test.ts
import { describe, expect, it } from 'vitest';

describe('E2E System Test', () => {
  it('should work with real services', () => {
    // Test complete system with real dependencies
  });
});
```

### Running Validation

Before pushing code:

```bash
# Run full validation (like CI)
bun run validate
```

This runs:
1. TypeScript type checking
2. ESLint (strict)
3. Code duplication check
4. Build
5. Tests
6. Coverage report

## Common Tasks

### Adding a Dependency

```bash
# Add to workspace root
bun add -D some-dev-dependency

# Add to a specific package
cd packages/my-package
bun add some-dependency

# Or from root:
bun add some-dependency --filter @your-org/my-package
```

### Updating Dependencies

```bash
# Update all dependencies
bun update

# Check for outdated packages
bun outdated
```

### Debugging Tests

```bash
# Run a specific test file
bun test packages/my-package/test/mytest.test.ts

# Run with verbose output
bun test --reporter=verbose

# Run tests matching a pattern
bun test --grep "my test pattern"
```

### Fixing Linting Issues

```bash
# Auto-fix linting issues
bun run lint:fix

# Check specific files
bunx eslint packages/my-package/src/myfile.ts
```

### Managing Code Duplication

```bash
# Check for new duplication
bun run duplication-check

# Update baseline after refactoring
bun run duplication-update-baseline
```

## IDE Setup

### VS Code

Recommended extensions:
- ESLint
- EditorConfig for VS Code
- Vitest
- TypeScript + JavaScript

Settings will be automatically applied from `.editorconfig`.

### Other IDEs

This template uses `.editorconfig` which is supported by most modern IDEs:
- IntelliJ IDEA / WebStorm
- Sublime Text
- Atom
- And many more

## Troubleshooting

### Build Errors

```bash
# Clean build
bun run build:clean

# Remove all node_modules and reinstall
bun run clean
bun install
```

### Test Failures

```bash
# Run tests with more detail
bun test --reporter=verbose

# Update snapshots if needed
bun test -u
```

### Pre-commit Hook Issues

```bash
# Reinstall hooks
rm -rf .husky
bun install

# Make hook executable
chmod +x .husky/pre-commit
```

### Bun Installation Issues

If bun commands fail:

```bash
# Reinstall bun
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
```

## Next Steps

- Read [CLAUDE.md](../CLAUDE.md) for detailed development guidelines
- Review the [example package](../packages/example-utils/) for patterns
- Check out [vibe-validate documentation](https://github.com/jdutton/vibe-validate)
- Set up your CI/CD pipeline on GitHub
- Enable Codecov for your repository (see README.md for setup instructions)

## Getting Help

- Check existing documentation in `docs/`
- Review the example package implementation
- Read inline comments in configuration files
- Open an issue on GitHub for bugs or questions

Happy coding! 🚀

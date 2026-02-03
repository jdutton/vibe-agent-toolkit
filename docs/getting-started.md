# Getting Started with Vibe Agent Toolkit

This guide will help you set up and start developing portable AI agents with the toolkit.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Bun** (latest version): [Install Bun](https://bun.sh/docs/installation)
- **Node.js** 22 or 24: [Install Node.js](https://nodejs.org/)
- **Git**: [Install Git](https://git-scm.com/downloads)

## Initial Setup

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/jdutton/vibe-agent-toolkit.git
cd vibe-agent-toolkit

# Install dependencies
bun install
```

### 2. Verify Installation

```bash
# Build all packages
bun run build

# Run tests (do NOT use 'bun test' - use commands below)
vv validate            # Full validation (recommended)
# OR: bun run test:unit  # Unit tests only

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
bun run test:watch

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

3. **Add package configuration**:

Create `package.json`, `tsconfig.json` (with `composite: true`), and add to root `tsconfig.json` references. See [CLAUDE.md](../CLAUDE.md) Development Workflow section for complete details.

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

**Note:** Do NOT use `bun test` directly - use the commands below instead.

```bash
# Run a specific test file
bunx vitest packages/my-package/test/mytest.test.ts

# Run with verbose output
bun run test:unit --reporter=verbose

# Run tests matching a pattern
bun run test:unit --grep "my test pattern"
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

The project uses `.editorconfig` which is supported by most modern IDEs:
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
bun run test:unit --reporter=verbose

# Update snapshots if needed
bunx vitest -u
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

## Working with Claude Skills

### Auditing Skills

Validate Claude Skills for quality and compatibility:

```bash
# Audit a single skill
vat agent audit my-skill/SKILL.md

# Audit all skills in a directory
vat agent audit skills/ --recursive

# View detailed validation errors
vat agent audit my-skill/SKILL.md --debug
```

The audit command checks for:
- Required frontmatter fields (name, description)
- Naming conventions (lowercase, hyphens, no reserved words)
- Description length (max 1024 characters)
- Link integrity (broken links, invalid paths)
- Console compatibility (tool availability)

See [Audit Command Documentation](./cli/audit.md) for complete validation rules.

### Importing Skills

Convert Claude Skills to VAT agent format:

```bash
# Import skill to agent.yaml
vat agent import my-skill/SKILL.md

# Import with custom output path
vat agent import my-skill/SKILL.md --output my-agent/agent.yaml

# Force overwrite existing agent.yaml
vat agent import my-skill/SKILL.md --force
```

Typical workflow:

```bash
# 1. Create or edit SKILL.md
vim my-skill/SKILL.md

# 2. Validate before import
vat agent audit my-skill/SKILL.md

# 3. Import to VAT format
vat agent import my-skill/SKILL.md

# 4. Use VAT tooling
cd my-skill
vat test
vat package
```

See [Import Command Documentation](./cli/import.md) for more details.

## Next Steps

- Read [CLAUDE.md](../CLAUDE.md) for detailed development guidelines
- Review [Claude Skills Best Practices](./guides/claude-skills-best-practices.md)
- Review the [utils package](../packages/utils/) for reference patterns
- Check out [vibe-validate documentation](https://github.com/jdutton/vibe-validate)
- Set up your CI/CD pipeline on GitHub
- Enable Codecov for your repository (see README.md for setup instructions)

## Getting Help

- Check existing documentation in `docs/`
- Review the example package implementation
- Read inline comments in configuration files
- Open an issue on GitHub for bugs or questions

Happy coding! 🚀

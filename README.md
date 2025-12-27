# TypeScript Monorepo Template

[![CI](https://github.com/jdutton/ts-monorepo-template/actions/workflows/validate.yml/badge.svg)](https://github.com/jdutton/ts-monorepo-template/actions) [![codecov](https://codecov.io/gh/jdutton/ts-monorepo-template/branch/main/graph/badge.svg)](https://codecov.io/gh/jdutton/ts-monorepo-template) [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=jdutton_ts-monorepo-template&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=jdutton_ts-monorepo-template) [![Node](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-ready TypeScript monorepo template with strict linting, comprehensive testing, and quality controls built-in.

## Features

- 🚀 **Bun** - Fast package manager and runtime
- 📦 **Monorepo** - Workspace-based package management
- 🔒 **TypeScript** - Strict type checking with composite projects
- ✅ **Vitest** - Fast unit, integration, and system testing
- 🔍 **ESLint** - Maximum strictness with sonarjs, unicorn, and security plugins
- 📊 **Code Coverage** - 80% minimum threshold with Codecov integration
- 🔄 **Code Duplication** - Baseline approach with jscpd
- 🎯 **vibe-validate** - Git-aware validation orchestration
- 🔧 **Cross-Platform** - Tested on Windows, macOS, and Linux
- 🤖 **CI/CD** - GitHub Actions with Node 22/24 matrix testing
- 📝 **Pre-commit Hooks** - Husky integration for quality gates

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (latest version)
- Node.js 22 or 24
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/jdutton/ts-monorepo-template.git
cd ts-monorepo-template

# Install dependencies
bun install

# Build all packages
bun run build
```

### Development

```bash
# Run tests
bun test

# Run tests in watch mode
bun test:watch

# Lint code
bun run lint

# Type check
bun run typecheck

# Run full validation (like CI)
bun run validate
```

## Project Structure

```
ts-monorepo-template/
├── packages/              # Published packages
│   └── example-utils/    # Example package (replace with your packages)
│       ├── src/          # Source code
│       ├── test/         # Tests
│       ├── package.json
│       └── tsconfig.json
├── tools/                # Development tools (TypeScript)
│   ├── common.ts         # Shared utilities
│   ├── duplication-check.ts
│   ├── jscpd-check-new.ts
│   └── jscpd-update-baseline.ts
├── docs/                 # Documentation
├── .github/              # CI/CD workflows
│   └── workflows/
│       └── validate.yml  # Validation pipeline
├── eslint.config.js      # ESLint configuration (strict!)
├── vitest.config.ts      # Unit test configuration
├── vitest.integration.config.ts  # Integration test config
├── vitest.system.config.ts       # System test config
├── tsconfig.json         # Root TypeScript config
├── tsconfig.base.json    # Base config for packages
├── vibe-validate.config.yaml  # Validation orchestration
├── package.json          # Root package.json
├── CLAUDE.md            # AI assistant guidelines
└── README.md            # This file
```

## Adding a New Package

1. **Create the package directory:**

```bash
mkdir -p packages/my-package/src packages/my-package/test
```

2. **Create `packages/my-package/package.json`:**

```json
{
  "name": "@your-org/my-package",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
```

3. **Create `packages/my-package/tsconfig.json`:**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

4. **Add to root `tsconfig.json` references:**

```json
{
  "references": [
    { "path": "./packages/example-utils" },
    { "path": "./packages/my-package" }  // Add this
  ]
}
```

5. **Create source and tests:**

```bash
# Create your source files
touch packages/my-package/src/index.ts

# Create tests
touch packages/my-package/test/index.test.ts
```

6. **Install and build:**

```bash
bun install
bun run build
```

## Testing Strategy

### Test Types

The template supports three levels of testing:

#### Unit Tests (`*.test.ts`)
- Test individual functions/classes
- Fast execution (< 100ms)
- Mock external dependencies
- Run with: `bun test`

#### Integration Tests (`*.integration.test.ts`)
- Test multiple modules together
- May use real dependencies
- Medium execution (< 5s)
- Run with: `bun test:integration`

#### System Tests (`*.system.test.ts`)
- End-to-end workflows
- Real external services
- Longer execution (< 30s)
- Run with: `bun test:system`

### Test File Organization

```
packages/my-package/
├── src/
│   ├── utils.ts
│   └── utils.test.ts              # Unit tests (co-located)
└── test/
    ├── api.test.ts                # Unit tests
    ├── integration/
    │   └── workflow.integration.test.ts
    └── system/
        └── e2e.system.test.ts
```

## Quality Standards

### ESLint

This template enforces strict linting rules:

- **Zero warnings policy**: `--max-warnings=0`
- **SonarJS**: Catches code smells and bugs
- **Unicorn**: Modern JavaScript patterns
- **Security**: Prevents common vulnerabilities
- **Import organization**: Alphabetical with groups

All code (src, tests, tools) is held to the same standards.

### Code Coverage

Minimum thresholds enforced:
- Statements: 80%
- Branches: 80%
- Functions: 80%
- Lines: 80%

### Code Duplication

Uses jscpd with a baseline approach:
- Existing duplication is baselined
- New duplication blocks commits
- Update baseline: `bun run duplication-update-baseline`

### TypeScript

Strict mode enabled with additional checks:
- `noUncheckedIndexedAccess`
- `noImplicitOverride`
- `exactOptionalPropertyTypes`

## Validation Pipeline

The template uses [vibe-validate](https://github.com/jdutton/vibe-validate) for git-aware validation:

```bash
# Run all validation checks
bun run validate

# Pre-commit check (fast)
bun run pre-commit
```

Validation runs:
1. TypeScript type checking
2. ESLint (strict)
3. Code duplication check
4. Build
5. Unit tests
6. Integration tests (optional)
7. Coverage report
8. System tests (optional)

## CI/CD

GitHub Actions workflows run on every push/PR:

### Validation Pipeline
- **Matrix Testing**: Node 22/24 × Ubuntu/Windows
- **Full Validation**: All checks must pass
- **Parallel Execution**: Faster feedback
- See `.github/workflows/validate.yml`

### Coverage Reporting
- **Codecov Integration**: Automatic coverage upload
- **80% Threshold**: Project and patch coverage targets
- **PR Comments**: Coverage diff on pull requests
- See `.github/workflows/coverage.yml`

#### Setting up Codecov

1. Sign up at [codecov.io](https://codecov.io) with your GitHub account
2. Enable your repository
3. Add `CODECOV_TOKEN` to GitHub repository secrets
4. Coverage reports will be uploaded automatically on push/PR
5. Update badge URLs in README.md with your repository details

## Pre-commit Hooks

Husky is configured to run validation before commits:

```bash
# Install hooks
bun install  # Runs automatically via "prepare" script

# Manually run pre-commit checks
bun run pre-commit
```

## Publishing Packages

When you're ready to publish to npm:

1. Update package versions
2. Build packages: `bun run build`
3. Test thoroughly: `bun run validate`
4. Publish: `npm publish` (or create publish scripts)

## Customization

### Changing the Organization Scope

Replace `@ts-monorepo-template` with your org name:

```bash
# Update package names in:
# - packages/*/package.json
# - Import statements
```

### Adjusting Quality Thresholds

Edit these files:
- `vitest.config.ts` - Coverage thresholds
- `eslint.config.js` - Linting rules
- `vibe-validate.config.yaml` - Validation steps

### Adding Tools

Add scripts to `tools/` directory:
- Use TypeScript (cross-platform)
- Import from `tools/common.ts`
- Add to package.json scripts

## Validating the Template

The template includes an example package to validate everything works:

```bash
# Run all validation checks
bun run validate

# See full validation checklist
cat docs/template-validation.md
```

The example package (`packages/example-utils/`) has 100% test coverage and demonstrates all patterns. **Delete it** when you start your own project.

## Learn More

- [CLAUDE.md](./CLAUDE.md) - Detailed development guidelines
- [Template Validation](./docs/template-validation.md) - Validate the template setup
- [Bun Documentation](https://bun.sh/docs)
- [Vitest Documentation](https://vitest.dev/)
- [vibe-validate](https://github.com/jdutton/vibe-validate)
- [TypeScript](https://www.typescriptlang.org/)

## License

MIT - see [LICENSE](./LICENSE) file

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `bun run validate` to ensure quality
5. Submit a pull request

---

**Built with ❤️ using Bun, TypeScript, and modern tooling**

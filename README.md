# Vibe Agent Toolkit

[![CI](https://github.com/jdutton/vibe-agent-toolkit/actions/workflows/validate.yml/badge.svg)](https://github.com/jdutton/vibe-agent-toolkit/actions) [![codecov](https://codecov.io/gh/jdutton/vibe-agent-toolkit/branch/main/graph/badge.svg)](https://codecov.io/gh/jdutton/vibe-agent-toolkit) [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=jdutton_vibe-agent-toolkit&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=jdutton_vibe-agent-toolkit) [![Node](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A toolkit for testing and packaging portable AI agents that work across various LLMs, frameworks, deployment targets, and orchestrators.

## Features

### Agent Development
- 🤖 **Multi-LLM Support** - Build agents that work with Claude, GPT, and other LLMs
- 🔌 **Framework Agnostic** - Support for various agent frameworks
- 📦 **Portable Packaging** - Deploy across different orchestrators and platforms
- ✅ **Agent Testing** - Comprehensive testing for agent behaviors and interactions
- 🔍 **Claude Skills Validation** - Audit skills for quality, compatibility, and best practices
- 🩺 **Environment Diagnostics** - Doctor command checks setup and health

### Skills Distribution
- 📦 **VAT Distribution Standard** - Package-based distribution for skills, agents, and tools
- 🔨 **Build Infrastructure** - `vat skills build` creates distributable skill packages
- ⬇️ **Smart Installation** - Install skills from npm, local directories, or zip files
- 📋 **Registry Tracking** - Track installed skills for updates and management
- 🎯 **Multi-Artifact Support** - Distribute skills, agents, pure functions, and runtimes together

**Install skills:**
```bash
vat skills install npm:@vibe-agent-toolkit/vat-example-cat-agents
vat skills install ./path/to/local/package
vat skills list --installed
```

See [Distributing VAT Skills Guide](./docs/guides/distributing-vat-skills.md) for creating your own distributable packages.

### Plugin & Marketplace Audit

Comprehensive validation for Claude plugins, marketplaces, and configurations:

```bash
# Audit user-level Claude plugins
vat audit --user

# Audit specific plugin
vat audit ./my-plugin

# Recursive scan for all resources
vat audit ./resources --recursive
```

**Features:**
- Auto-detects resource type (plugin, marketplace, skill, registry)
- Schema validation using Zod
- Cache staleness detection using checksums
- Hierarchical output showing relationships
- Cross-platform support

See [Audit Documentation](packages/cli/docs/audit.md) for complete reference.

### Development Infrastructure
- 🚀 **Bun** - Fast package manager and runtime
- 📦 **Monorepo** - Workspace-based package management for agent components
- 🔒 **TypeScript** - Strict type checking with composite projects
- ✅ **Vitest** - Fast unit, integration, and system testing
- 🔍 **ESLint** - Maximum strictness with sonarjs, unicorn, and security plugins
- 📊 **Code Coverage** - 80% minimum threshold with Codecov integration
- 🎯 **vibe-validate** - Git-aware validation orchestration
- 🔧 **Cross-Platform** - Tested on Windows, macOS, and Linux
- 🤖 **CI/CD** - GitHub Actions with Node 22/24 matrix testing

## Quick Start

### CLI Installation

Install the CLI globally:

```bash
npm install -g vibe-agent-toolkit
```

Scan and validate markdown resources:

```bash
vat resources scan docs/
vat resources validate docs/
```

Audit and import Claude Skills:

```bash
vat agent audit my-skill/SKILL.md
vat agent import my-skill/SKILL.md
```

Diagnose project setup:

```bash
vat doctor
```

See [CLI Reference](./packages/cli/docs/) for complete documentation (or run `vat --help --verbose`).

### Development Setup

**Prerequisites:**
- [Bun](https://bun.sh/) (latest version)
- Node.js 22 or 24
- Git

**Installation:**

```bash
# Clone the repository
git clone https://github.com/jdutton/vibe-agent-toolkit.git
cd vibe-agent-toolkit

# Install dependencies
bun install

# Build all packages
bun run build
```

### Development

```bash
# Run full validation (recommended)
bunx vv validate

# Or run test suites individually:
bun run test:unit          # Unit tests only
bun run test:watch         # Watch mode for development
bun run test:integration   # Integration tests
bun run test:system        # System/e2e tests

# Lint code
bun run lint

# Type check
bun run typecheck

# Validate all markdown links (dogfooding)
bun run validate-links
```

### 🔗 Dogfooding: Link Validation

This project uses its own `@vibe-agent-toolkit/resources` package to validate all markdown links in the repository. This ensures our documentation stays accurate and all links remain valid.

**Run link validation:**
```bash
bun run validate-links
```

**What it checks:**
- ✅ All local file links (relative paths to other markdown files)
- ✅ All heading anchor links (links to sections within files)
- ℹ️  External URLs are noted but not validated
- 🚫 Test fixtures with intentionally broken links are excluded

**Runs automatically in CI/CD** as part of the System Tests phase, ensuring broken links are caught before merge.

### External URL Validation

Optionally validate external URLs with caching:

```bash
vat resources validate docs/ --check-external-urls
```

See [External URL Validation](docs/external-url-validation.md) for details.

## Project Structure

```
vibe-agent-toolkit/
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

The toolkit supports three levels of testing:

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

The toolkit enforces strict linting rules:

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

The toolkit uses [vibe-validate](https://github.com/jdutton/vibe-validate) for git-aware validation:

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

Replace `@vibe-agent-toolkit` with your org name:

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

Add scripts to `packages/dev-tools/src/` directory:
- Use TypeScript (cross-platform)
- Import from `common.ts`
- Add to package.json scripts

## Validation

The project includes comprehensive validation checks:

```bash
# Run all validation checks
bun run validate

# Run pre-commit checks
bun run pre-commit
```

The example package (`packages/example-utils/`) demonstrates testing patterns and will be replaced with agent-specific packages.

## Learn More

- [Getting Started](./docs/getting-started.md) - Detailed setup guide
- [Documentation](./docs/README.md) - Full documentation index
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

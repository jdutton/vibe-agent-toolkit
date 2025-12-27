# Publishing Packages

This guide covers how to prepare and publish packages from this monorepo to npm.

## Prerequisites

- npm account with appropriate publishing permissions
- Two-factor authentication (2FA) enabled on npm account
- Access to the npm organization (if using scoped packages)
- All tests passing and code validated

## Preparing for Publication

### 1. Update Package Metadata

Edit each package's `package.json`:

```json
{
  "name": "@your-org/package-name",
  "version": "1.0.0",
  "description": "Clear description of what this package does",
  "keywords": ["relevant", "search", "terms"],
  "author": "Your Name <your.email@example.com>",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/your-repo.git",
    "directory": "packages/package-name"
  },
  "bugs": {
    "url": "https://github.com/yourusername/your-repo/issues"
  },
  "homepage": "https://github.com/yourusername/your-repo#readme",
  "publishConfig": {
    "access": "public"
  }
}
```

### 2. Write Package README

Each package should have its own `README.md`:

```markdown
# @your-org/package-name

Brief description

## Installation

\`\`\`bash
npm install @your-org/package-name
\`\`\`

## Usage

\`\`\`typescript
import { something } from '@your-org/package-name';
\`\`\`

## API

[Document your public API]

## License

MIT
```

### 3. Verify Build Output

```bash
# Build all packages
bun run build

# Check that dist/ folders contain expected files
ls -la packages/*/dist/
```

### 4. Run Full Validation

```bash
# Run all quality checks
bun run validate

# Ensure coverage meets thresholds
bun run test:coverage
```

## Publishing Process

### Manual Publishing (Quick Start)

For initial publications or one-off releases:

```bash
# Login to npm
npm login

# Build packages
bun run build

# Publish a single package
cd packages/your-package
npm publish

# Or with specific tag
npm publish --tag beta
```

### Publishing All Packages

To publish all packages at once, you can use bun's workspace filtering:

```bash
# Build all packages
bun run build

# Publish all (from each package directory)
for dir in packages/*; do
  if [ -d "$dir" ]; then
    cd "$dir"
    npm publish
    cd ../..
  fi
done
```

## Version Management

### Semantic Versioning

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes
- **MINOR** (1.0.0 → 1.1.0): New features, backward compatible
- **PATCH** (1.0.0 → 1.0.1): Bug fixes, backward compatible

### Updating Versions

Update versions in each package's `package.json`:

```bash
# Manually edit package.json files
# Or use a version management tool (see below)
```

## Creating Publishing Tools

Based on vibe-validate patterns, you can create these tools in `tools/`:

### 1. Version Bump Tool (`tools/bump-version.ts`)

Automatically update versions across all packages:

```typescript
#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processWorkspacePackages, log, PROJECT_ROOT } from './common.js';

const versionType = process.argv[2]; // patch, minor, major

if (!['patch', 'minor', 'major'].includes(versionType)) {
  console.error('Usage: bump-version.ts [patch|minor|major]');
  process.exit(1);
}

// Implementation here
```

### 2. Pre-Publish Check (`tools/pre-publish-check.ts`)

Verify packages are ready to publish:

```typescript
#!/usr/bin/env tsx
// Check:
// - All tests pass
// - No uncommitted changes
// - Versions are consistent
// - Build outputs exist
// - README files present
```

### 3. Publish All Tool (`tools/publish-all.ts`)

Publish all packages with safety checks:

```typescript
#!/usr/bin/env tsx
// - Run pre-publish checks
// - Build all packages
// - Publish in dependency order
// - Handle failures gracefully
// - Create git tags
```

### 4. Verify Published Packages (`tools/verify-npm-packages.ts`)

Verify packages are installable after publishing:

```typescript
#!/usr/bin/env tsx
// - Check package exists on npm
// - Verify version is correct
// - Test installation in temp directory
// - Verify exports work correctly
```

## npm dist-tags

Use tags to manage different release channels:

```bash
# Publish as latest (default)
npm publish

# Publish as beta
npm publish --tag beta

# Publish as next
npm publish --tag next

# Update tag later
npm dist-tag add @your-org/package@1.2.3 latest
```

## Automated Publishing with CI/CD

### GitHub Actions Workflow

Create `.github/workflows/publish.yml`:

```yaml
name: Publish Packages

on:
  push:
    tags:
      - 'v*.*.*'

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write  # For npm provenance
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: bun install

      - name: Build packages
        run: bun run build

      - name: Run tests
        run: bun test

      - name: Publish to npm
        run: |
          # Add your publishing logic here
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Setting up npm Token

1. Create npm token: `npm token create`
2. Add to GitHub Secrets as `NPM_TOKEN`
3. Ensure token has publish permissions

## Release Process

### 1. Prepare Release

```bash
# Create a release branch
git checkout -b release/v1.0.0

# Update versions
# Update CHANGELOG.md
# Update documentation

# Commit changes
git commit -m "chore: prepare release v1.0.0"
```

### 2. Create Pull Request

- Create PR from release branch to main
- Ensure all CI checks pass
- Get code review approval

### 3. Merge and Tag

```bash
# Merge to main
git checkout main
git merge release/v1.0.0

# Create tag
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

### 4. Publish

If using automated CI/CD, the tag push will trigger publishing. Otherwise:

```bash
# Build and publish manually
bun run build
# Run publishing tools
```

### 5. Create GitHub Release

- Go to GitHub Releases
- Create release from tag
- Add release notes from CHANGELOG.md
- Attach any relevant files

## Troubleshooting

### Package Not Found

If published package isn't found:
- Wait 5-10 minutes for npm registry propagation
- Check package name is correct
- Verify `publishConfig.access: "public"` for scoped packages

### Version Conflicts

If version already exists:
- Bump version number
- Use `npm unpublish` within 72 hours (use carefully!)

### Authentication Issues

```bash
# Re-login to npm
npm logout
npm login

# Verify authentication
npm whoami
```

### Dry Run

Test publishing without actually publishing:

```bash
npm publish --dry-run
```

## Best Practices

1. **Always test before publishing**
   - Run full validation
   - Test in a real project first

2. **Use semantic versioning**
   - Breaking changes = major version
   - New features = minor version
   - Bug fixes = patch version

3. **Document changes**
   - Keep CHANGELOG.md updated
   - Write clear commit messages

4. **Tag releases**
   - Tag after publishing
   - Use annotated tags (`git tag -a`)

5. **Enable npm provenance**
   - Publish from CI/CD
   - Use `--provenance` flag

6. **Monitor after publishing**
   - Check package page on npm
   - Test installation
   - Monitor issue reports

## Resources

- [npm Publishing Documentation](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [Semantic Versioning](https://semver.org/)
- [npm Provenance](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Packages](https://docs.github.com/en/packages)

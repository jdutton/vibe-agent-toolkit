---
title: Publishing TypeScript Resource Packages
description: Complete guide for creating and publishing npm packages of compiled markdown resources
category: guide
tags: [resource-compiler, typescript, npm, publishing, packaging]
audience: intermediate
---

# Publishing TypeScript Resource Packages

Create reusable npm packages of markdown content with full TypeScript type safety.

---

## What This Guide Covers

- Setting up a resource package project
- Package structure and configuration
- Build scripts and automation
- Including both compiled and original markdown
- Publishing to npm
- Versioning and changelog management
- CI/CD automation
- Best practices for maintainers

**Audience:** Package creators (ProjectX) who want to distribute markdown resources as npm modules.

---

## Prerequisites

- Node.js 18+ and npm/bun
- Basic TypeScript knowledge
- npm account for publishing
- Understanding of [resource compilation basics](./compiling-markdown-to-typescript.md)

---

## Project Structure

```
your-knowledge-base/
├── resources/              # Source markdown (you author these)
│   ├── prompts/
│   │   ├── system.md
│   │   └── user.md
│   └── docs/
│       └── guide.md
├── generated/              # Generated JS/TS (from compile command)
│   └── resources/
│       ├── prompts/
│       │   ├── system.js
│       │   ├── system.d.ts
│       │   ├── user.js
│       │   └── user.d.ts
│       └── docs/
│           ├── guide.js
│           └── guide.d.ts
├── scripts/
│   └── post-build.ts      # Copies generated files to dist
├── src/                    # Optional TypeScript code
│   └── index.ts           # Re-exports for convenience
├── dist/                   # Build output (published to npm)
│   ├── src/               # Compiled TypeScript
│   ├── generated/         # Copied compiled resources
│   └── resources/         # Copied original markdown
├── package.json
├── tsconfig.json
├── README.md
└── CHANGELOG.md
```

**Key directories:**
- `resources/` - Author markdown here
- `generated/` - Compiled output (gitignored)
- `dist/` - Final package output (published to npm)
- `scripts/` - Build automation scripts

---

## Step-by-Step Setup

### 1. Initialize Project

```bash
mkdir my-knowledge-base
cd my-knowledge-base
npm init -y
git init
```

### 2. Install Dependencies

```bash
# Resource compiler (dev dependency)
npm install -D @vibe-agent-toolkit/resource-compiler

# TypeScript tooling (dev dependencies)
npm install -D typescript @types/node

# Optional: utility dependencies
npm install -D tsup  # Or your preferred build tool
```

### 3. Configure package.json

```json
{
  "name": "@acme/knowledge-base",
  "version": "1.0.0",
  "description": "Shared knowledge base and prompt library",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "generate:resources": "vat-compile-resources compile resources/ generated/resources/",
    "build:code": "tsc",
    "build:copy": "node scripts/post-build.js",
    "build": "npm run generate:resources && npm run build:code && npm run build:copy",
    "clean": "rm -rf dist generated",
    "prepublishOnly": "npm run build",
    "watch": "vat-compile-resources compile resources/ generated/resources/ --watch"
  },
  "files": [
    "dist",
    "README.md",
    "CHANGELOG.md"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./generated/*": "./dist/generated/*",
    "./resources/*": "./dist/resources/*"
  },
  "keywords": [
    "prompts",
    "knowledge-base",
    "typescript",
    "markdown",
    "ai",
    "agents"
  ],
  "author": "Your Name",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/your-org/knowledge-base.git"
  },
  "devDependencies": {
    "@vibe-agent-toolkit/resource-compiler": "^0.1.13",
    "typescript": "^5.3.3",
    "@types/node": "^20.11.5"
  }
}
```

**Key fields:**
- `type: "module"` - Use ES modules
- `files` - Include only `dist/` in npm package
- `exports` - Expose both generated and original markdown
- `prepublishOnly` - Auto-build before publishing

### 4. Configure TypeScript

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "generated"]
}
```

### 5. Create Post-Build Script

```typescript
// scripts/post-build.ts
import { createPostBuildScript } from '@vibe-agent-toolkit/resource-compiler/utils';
import { cpSync } from 'node:fs';

// Copy compiled resources (generated .js/.d.ts files)
createPostBuildScript({
  generatedDir: 'generated',
  distDir: 'dist',
  verbose: true,
});

// Copy original markdown files
cpSync('resources', 'dist/resources', { recursive: true });
console.log('✓ Copied original markdown to dist/resources/');

console.log('\n✅ Build complete! Package ready for publishing.');
```

**Cross-platform note:** Uses Node.js built-in `cpSync()` which works on Windows, macOS, and Linux.

### 6. Create .gitignore

```gitignore
# Build output
dist/
generated/

# Dependencies
node_modules/

# Logs
*.log
npm-debug.log*

# Environment
.env
.env.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
```

**Important:** Gitignore `generated/` since it's generated during build. Commit `resources/` (source markdown).

---

## Creating Markdown Resources

### Example: Prompt Library

```markdown
<!-- resources/prompts/system.md -->
---
title: System Prompts
version: 1.0
purpose: Core system instructions for AI agents
modelHints:
  - claude-3
  - gpt-4
lastUpdated: 2024-02-15
---

# System Prompts

## Technical Assistant

You are a technical assistant helping engineers solve problems.
Focus on clarity, accuracy, and practical solutions.

Provide code examples when relevant.

## Code Reviewer

You are reviewing code for quality, security, and maintainability.
Provide constructive feedback with specific examples.

Focus on:
- Security vulnerabilities
- Performance issues
- Maintainability concerns
- Best practices

## Debugger

You are helping developers debug code issues.
Think step-by-step through the problem.

Ask clarifying questions before jumping to solutions.
```

### Example: Documentation

```markdown
<!-- resources/docs/architecture.md -->
---
title: System Architecture
category: documentation
tags: [architecture, system-design, infrastructure]
lastUpdated: 2024-02-15
---

# System Architecture

## Overview

Our system follows a microservices architecture with event-driven communication.

## Components

### API Gateway

Handles all external requests and routes to appropriate services.

- Rate limiting
- Authentication
- Request validation

### User Service

Manages user accounts and authentication.

### Data Processing Pipeline

Handles batch data processing with the following stages:
1. Ingestion
2. Validation
3. Transformation
4. Storage
```

---

## Optional: Index File for Convenience

Create an index file to re-export resources for easier imports:

```typescript
// src/index.ts
// Re-export compiled resources for convenience
export * as SystemPrompts from '../generated/resources/prompts/system.js';
export * as UserPrompts from '../generated/resources/prompts/user.js';
export * as Architecture from '../generated/resources/docs/architecture.js';

// Optional: Helper types
export type { Fragment, FragmentName } from '@vibe-agent-toolkit/resource-compiler';

// Optional: Metadata about package
export const packageInfo = {
  name: '@acme/knowledge-base',
  version: '1.0.0',
  collections: ['prompts', 'docs'] as const,
} as const;
```

---

## Including Both Formats

### Why Include Both?

| Format | Use Case | Benefits |
|--------|----------|----------|
| **Compiled** (`.js` + `.d.ts`) | Type-safe imports in code | IDE autocomplete, type checking, fast runtime |
| **Original** (`.md`) | RAG systems, documentation, custom processing | Flexibility, transparency, human-readable |

### Implementation

The post-build script copies both:

```typescript
// Copy compiled JavaScript/TypeScript
createPostBuildScript({
  generatedDir: 'generated',
  distDir: 'dist',
  verbose: true,
});

// Copy original markdown
cpSync('resources', 'dist/resources', { recursive: true });
```

### Result in Published Package

```
dist/
├── generated/           # For type-safe imports
│   └── resources/
│       └── prompts/
│           ├── system.js
│           └── system.d.ts
└── resources/           # For flexibility and transparency
    └── prompts/
        └── system.md
```

Consumers can choose which format to use:

```typescript
// Type-safe compiled version
import * as Prompts from '@acme/kb/generated/resources/prompts/system.js';

// Original markdown for RAG or custom processing
import { readFileSync } from 'node:fs';
const path = require.resolve('@acme/kb/resources/prompts/system.md');
const markdown = readFileSync(path, 'utf-8');
```

---

## Building and Testing Locally

### Build the Package

```bash
npm run build
```

This runs:
1. `generate:resources` - Compile markdown to JavaScript/TypeScript
2. `build:code` - Compile TypeScript code (if you have any in `src/`)
3. `build:copy` - Copy generated resources and original markdown to `dist/`

### Verify Output Structure

```bash
ls -R dist/

# Should show:
# dist/generated/resources/prompts/*.js
# dist/generated/resources/prompts/*.d.ts
# dist/resources/prompts/*.md
# dist/index.js (if you created src/index.ts)
# dist/index.d.ts
```

### Test Locally with npm pack

```bash
# Create a tarball (like npm publish would)
npm pack

# This creates @acme-knowledge-base-1.0.0.tgz
# Inspect contents:
tar -tzf @acme-knowledge-base-1.0.0.tgz
```

### Test Installation in Another Project

```bash
# In another project directory
npm install /path/to/@acme-knowledge-base-1.0.0.tgz

# Or use npm link for development
cd /path/to/knowledge-base
npm link

cd /path/to/consumer-project
npm link @acme/knowledge-base
```

---

## Publishing to npm

### First-Time Setup

1. **Create npm account:** https://www.npmjs.com/signup

2. **Login to npm:**
   ```bash
   npm login
   ```

3. **Choose scope (optional):**
   - Unscoped: `knowledge-base`
   - Scoped (recommended): `@acme/knowledge-base`

   Scoped packages can be free (public) or private (paid).

### Publishing

```bash
# Dry run (see what would be published)
npm publish --dry-run

# Publish public package
npm publish --access public

# Publish scoped package (default is private, so specify public)
npm publish --access public
```

**The `prepublishOnly` script ensures `npm run build` runs automatically before publishing.**

### Publishing Workflow

```bash
# 1. Make changes to markdown
vim resources/prompts/system.md

# 2. Commit changes
git add resources/
git commit -m "feat: add new code reviewer prompt"

# 3. Bump version (updates package.json and creates git tag)
npm version patch  # or minor, major

# 4. Push to git
git push && git push --tags

# 5. Publish to npm
npm publish --access public
```

---

## Versioning Strategy

### Semantic Versioning for Content

Use semver for content packages:

- **Major (2.0.0)** - Breaking changes to structure or frontmatter schema
  - Removing fragments
  - Changing fragment names
  - Changing frontmatter structure
  - Incompatible API changes

- **Minor (1.1.0)** - New resources or fragments added
  - New markdown files
  - New H2 sections (fragments)
  - New optional frontmatter fields
  - Backward-compatible additions

- **Patch (1.0.1)** - Content fixes, typos, clarifications
  - Fixing typos
  - Clarifying existing content
  - Updating examples
  - Non-breaking improvements

### Version Bumping

```bash
# Patch: 1.0.0 → 1.0.1
npm version patch -m "fix: correct typo in system prompt"

# Minor: 1.0.1 → 1.1.0
npm version minor -m "feat: add new debugging prompt"

# Major: 1.1.0 → 2.0.0
npm version major -m "BREAKING: rename fragments to match new convention"
```

---

## Changelog Management

### CHANGELOG.md Format

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New features that haven't been released yet

## [1.1.0] - 2024-02-15

### Added
- New "data-analyst" system prompt for analytics work
- Email template for incident reports in `templates/emails/incident.md`

### Changed
- Updated "technical-assistant" prompt with clearer instructions
- Improved API documentation in `docs/api-reference.md` with more examples

### Fixed
- Typos in onboarding guide
- Incorrect fragment name in code-review prompt

## [1.0.0] - 2024-02-01

### Added
- Initial release with system prompts
- Documentation for architecture and API
- Email templates for welcome and reset flows

[Unreleased]: https://github.com/acme/kb/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/acme/kb/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/acme/kb/releases/tag/v1.0.0
```

---

## README for Published Package

### Essential Sections

```markdown
# @acme/knowledge-base

> Shared knowledge base and prompt library with TypeScript type safety

## Installation

```bash
npm install @acme/knowledge-base
```

## What's Included

- **Prompts**: 15 system prompts for various agent roles
- **Templates**: 8 email/Slack message templates
- **Docs**: 12 internal documentation pages

## Usage

### Type-Safe Compiled Resources

```typescript
import * as SystemPrompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

// Full TypeScript support
console.log(SystemPrompts.meta.title);
console.log(SystemPrompts.fragments.technicalAssistant.text);
```

### Original Markdown (for RAG, custom processing)

```typescript
import { readFileSync } from 'node:fs';

const path = require.resolve('@acme/knowledge-base/resources/docs/architecture.md');
const markdown = readFileSync(path, 'utf-8');
```

## Collections

| Collection | Files | Purpose |
|------------|-------|---------|
| `prompts/` | 15 | System prompts for AI agents |
| `templates/` | 8 | Email and Slack message templates |
| `docs/` | 12 | Internal documentation and guides |

## Available Prompts

- `technicalAssistant` - Helps engineers solve technical problems
- `codeReviewer` - Reviews code for quality and security
- `debugger` - Assists with debugging code issues
- ... (list all available fragments)

## Versioning

This package follows semantic versioning:
- **Major**: Breaking changes to structure or API
- **Minor**: New resources or fragments added
- **Patch**: Content fixes and clarifications

## License

MIT
```

---

## CI/CD Automation

### GitHub Actions for Publishing

```yaml
# .github/workflows/publish.yml
name: Publish Package

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write  # For provenance

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Build package
        run: npm run build

      - name: Publish to npm
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Validation Workflow

```yaml
# .github/workflows/validate.yml
name: Validate

on:
  push:
    branches: [main]
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Check package contents
        run: npm pack --dry-run
```

---

## Best Practices

### 1. Directory Organization

```
resources/
├── prompts/        # Group by type
│   ├── system.md
│   ├── user.md
│   └── examples.md
├── templates/      # Logical collections
│   ├── email.md
│   └── slack.md
└── docs/           # Documentation
    ├── architecture.md
    └── api.md
```

### 2. Frontmatter Consistency

Define a schema and validate it:

```typescript
// scripts/validate-frontmatter.ts
import { z } from 'zod';
import { glob } from 'glob';
import matter from 'gray-matter';
import { readFileSync } from 'node:fs';

const PromptMetadataSchema = z.object({
  title: z.string(),
  version: z.number(),
  purpose: z.string().optional(),
  modelHints: z.array(z.string()).optional(),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const files = await glob('resources/**/*.md');

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  const { data } = matter(content);

  try {
    PromptMetadataSchema.parse(data);
  } catch (error) {
    console.error(`❌ Invalid frontmatter in ${file}:`, error);
    process.exit(1);
  }
}

console.log('✓ All frontmatter is valid');
```

Add to build:
```json
{
  "scripts": {
    "validate:frontmatter": "tsx scripts/validate-frontmatter.ts",
    "build": "npm run validate:frontmatter && npm run generate:resources && ..."
  }
}
```

### 3. Testing

```typescript
// test/package.test.ts
import { describe, it, expect } from 'vitest';
import * as SystemPrompts from '../dist/generated/resources/prompts/system.js';

describe('Published Package', () => {
  it('exports valid frontmatter', () => {
    expect(SystemPrompts.meta).toBeDefined();
    expect(SystemPrompts.meta.title).toBe('System Prompts');
    expect(SystemPrompts.meta.version).toBe(1.0);
  });

  it('exports all expected fragments', () => {
    expect(SystemPrompts.fragments.technicalAssistant).toBeDefined();
    expect(SystemPrompts.fragments.codeReviewer).toBeDefined();
  });

  it('fragments have correct structure', () => {
    const fragment = SystemPrompts.fragments.technicalAssistant;
    expect(fragment).toHaveProperty('header');
    expect(fragment).toHaveProperty('body');
    expect(fragment).toHaveProperty('text');
    expect(fragment.body.length).toBeGreaterThan(0);
  });
});
```

### 4. Documentation

- **README.md**: Clear usage examples
- **CHANGELOG.md**: Track all changes
- **Examples**: Include example usage in repo
- **TypeDoc**: Generate API docs from TypeScript declarations

### 5. Security

```json
{
  "scripts": {
    "audit": "npm audit",
    "prepublishOnly": "npm audit --audit-level=moderate && npm run build"
  }
}
```

---

## Troubleshooting

### Issue: Generated files not included in package

**Solution:** Verify `package.json` files field includes `dist`:

```json
{
  "files": ["dist"]
}
```

Run `npm pack --dry-run` to see what would be included.

### Issue: TypeScript can't find modules

**Solution:** Check `package.json` exports and make sure paths are correct:

```json
{
  "exports": {
    "./generated/*": "./dist/generated/*",
    "./resources/*": "./dist/resources/*"
  }
}
```

### Issue: Build fails on CI but works locally

**Solution:** Ensure all dependencies are production dependencies, not just devDependencies. The resource-compiler should be a devDependency since it's only needed for building.

---

## Next Steps

### For Package Consumers
Read [Consuming TypeScript Resources](./consuming-packages.md) to learn how consumers will use your package.

### For Specific Use Cases
- **AI agent prompts?** → [Building Agent Prompt Libraries](./use-cases/agent-prompt-libraries.md)
- **RAG knowledge bases?** → [Creating RAG Knowledge Bases](./use-cases/rag-knowledge-bases.md)
- **Template systems?** → [Template System Patterns](./use-cases/template-systems.md)

### Advanced Topics
Read [Advanced Patterns](./use-cases/advanced-patterns.md) for:
- Multi-collection packages
- Versioned collections
- Typed metadata schemas
- Dynamic discovery

---

## See Also

- [Overview: Compiling Markdown to TypeScript](./compiling-markdown-to-typescript.md)
- [Consuming TypeScript Resources](./consuming-packages.md)
- [Guide Index](./README.md)

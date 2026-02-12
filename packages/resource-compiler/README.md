# @vibe-agent-toolkit/resource-compiler

> Compile markdown resources to TypeScript with full IDE support

## Status

🚧 **Under Development** - Phase 1: Core Compiler (v0.2.0)

## Overview

The resource compiler transforms markdown files into TypeScript modules with:

- **Type-safe imports**: Import `.md` files directly in TypeScript
- **Fragment extraction**: H2 headings become typed properties
- **IDE support**: Autocomplete, go-to-definition, hover tooltips
- **Frontmatter parsing**: YAML metadata becomes typed objects

## Installation

```bash
npm install -D @vibe-agent-toolkit/resource-compiler
```

## Use Cases

### Local Development
Use the compiler to import markdown files directly in your TypeScript projects with full IDE support.

### Publishing Packages
Create reusable npm packages of markdown content (prompts, documentation, knowledge bases) that other projects can consume with full type safety.

**📚 See the [TypeScript Resource Compiler Guides](../../docs/guides/resource-compiler/README.md)** for complete documentation on compiling, publishing, and consuming markdown resource packages.

## Quick Start

### 1. Create a Markdown File

```markdown
<!-- src/prompts/system.md -->
---
title: System Prompts
version: 1.0
---

# System Prompts

## Welcome

You are a helpful AI assistant.

## Farewell

Thank you for using our system.
```

### 2. Compile to TypeScript

```bash
# Compile markdown files
npx vat-compile-resources compile src/prompts dist/prompts

# Or generate type declarations only
npx vat-compile-resources generate-types src/prompts
```

### 3. Import in TypeScript

```typescript
import prompts from './prompts/system.md';

// Type-safe access to frontmatter
console.log(prompts.meta.title);        // "System Prompts"
console.log(prompts.meta.version);      // 1.0

// Access full markdown text
console.log(prompts.text);

// Access specific fragments (H2 sections)
console.log(prompts.fragments.welcome.text);
console.log(prompts.fragments.farewell.body);

// Get all fragment names (type-safe)
const names: ('welcome' | 'farewell')[] = ['welcome', 'farewell'];
```

## Build Integration

When using the `compile` command, you generate JavaScript modules in a separate `generated/` directory. To ensure these modules are available at runtime, you need to copy them to your build output directory.

### Why Copy Generated Resources?

TypeScript's type-checker needs to resolve imports **during compilation**. Your source files import from the `generated/` directory:

```typescript
// src/agent.ts
import * as Core from '../generated/resources/core.js';
```

When TypeScript compiles to `dist/`, it only copies compiled TypeScript files - not the generated JavaScript resources. You must copy `generated/` to `dist/` separately.

### Recommended Pattern

**Directory structure:**
```
your-package/
├── resources/            # Source markdown (author these)
│   └── prompts/
│       └── core.md
├── generated/            # Generated JS/TS (from compile command)
│   └── resources/
│       └── prompts/
│           ├── core.js
│           └── core.d.ts
├── src/                  # Your TypeScript source
│   └── agent.ts
└── dist/                 # Build output
    ├── src/              # Compiled TypeScript
    │   └── agent.js
    └── generated/        # Copied resources (post-build step)
        └── resources/
```

**Build flow:**
1. `compile` resources → `generated/`
2. TypeScript compilation → `dist/src/`
3. Copy `generated/` → `dist/generated/`

### Method 1: Using the Provided Utility (Recommended)

Create a post-build script using the provided cross-platform utility:

```typescript
// scripts/post-build.ts
import { createPostBuildScript } from '@vibe-agent-toolkit/resource-compiler/utils';

createPostBuildScript({
  generatedDir: 'generated',
  distDir: 'dist',
  verbose: true,
});
```

Update `package.json`:

```json
{
  "scripts": {
    "generate:resources": "vat-compile-resources compile resources/ generated/resources/",
    "build": "npm run generate:resources && tsc && node scripts/post-build.js"
  }
}
```

### Method 2: Manual Copy (Custom Logic)

For more control, use the `copyResources` utility directly:

```typescript
// scripts/post-build.ts
import { copyResources } from '@vibe-agent-toolkit/resource-compiler/utils';

copyResources({
  sourceDir: 'generated',
  targetDir: 'dist/generated',
  verbose: true,
});

// Add custom logic here
console.log('Build complete!');
```

### Method 3: Build Tool Integration

Integrate with your build tool (Vite, Rollup, etc.):

```typescript
// vite.config.ts
import { copyResources } from '@vibe-agent-toolkit/resource-compiler/utils';

export default {
  plugins: [
    {
      name: 'copy-resources',
      closeBundle() {
        copyResources({
          sourceDir: 'generated',
          targetDir: 'dist/generated',
        });
      },
    },
  ],
};
```

### Cross-Platform Considerations

**❌ Don't use shell commands:**
```json
"build": "tsc && cp -r generated dist/"  // Unix only!
```

**✅ Use Node.js APIs:**
```typescript
import { cpSync } from 'node:fs';
cpSync('generated', 'dist/generated', { recursive: true });
```

The provided utilities use Node's built-in `cpSync()` which works on Windows, macOS, and Linux.

### Alternative: Co-located Generation (Not Recommended)

You could generate `.md.js` files alongside `.md` files:

```
resources/
  ├── core.md
  ├── core.md.js      # Generated - clutters source directory
  └── core.md.d.ts    # Generated - clutters source directory
```

**Why we don't recommend this:**
- ❌ Clutters your clean markdown directory with generated files
- ❌ Makes `.gitignore` patterns more complex
- ❌ Harder to clean generated files

**Use a separate `generated/` directory instead** - it keeps source files clean and makes the build process explicit.

## Documentation

### CLI Commands

#### `compile` - Compile Markdown to JavaScript/TypeScript

Compiles markdown files to JavaScript modules and TypeScript declarations.

```bash
npx vat-compile-resources compile <input> <output> [options]
```

**Arguments:**
- `<input>` - Input directory containing markdown files
- `<output>` - Output directory for compiled files

**Options:**
- `-p, --pattern <pattern>` - Glob pattern for markdown files (default: `**/*.md`)
- `-v, --verbose` - Enable verbose logging
- `-w, --watch` - Watch mode for automatic recompilation

**Example:**

```bash
# Compile all markdown files
npx vat-compile-resources compile src/prompts dist/prompts

# Compile with custom pattern
npx vat-compile-resources compile src docs --pattern "guides/**/*.md"

# Watch mode
npx vat-compile-resources compile src dist --watch
```

#### `generate-types` - Generate .md.d.ts Declaration Files

Generates TypeScript declaration files (`.md.d.ts`) alongside markdown files for use with the TypeScript transformer.

```bash
npx vat-compile-resources generate-types <input> [options]
```

**Arguments:**
- `<input>` - Input directory containing markdown files

**Options:**
- `-p, --pattern <pattern>` - Glob pattern for markdown files (default: `**/*.md`)
- `-v, --verbose` - Enable verbose logging

**Example:**

```bash
# Generate declarations for all markdown files
npx vat-compile-resources generate-types src/prompts

# Generate with custom pattern
npx vat-compile-resources generate-types docs --pattern "**/*.md"
```

### TypeScript Transformer

The TypeScript transformer enables direct `.md` imports in TypeScript without pre-compilation.

#### Setup with ts-patch

1. Install dependencies:

```bash
npm install -D @vibe-agent-toolkit/resource-compiler ts-patch typescript
```

2. Update `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "transform": "@vibe-agent-toolkit/resource-compiler/transformer"
      }
    ]
  }
}
```

3. Patch TypeScript:

```bash
npx ts-patch install
```

4. Generate type declarations:

```bash
npx vat-compile-resources generate-types src/
```

5. Import markdown files:

```typescript
import prompts from './prompts/system.md';

console.log(prompts.text);
console.log(prompts.fragments.welcome.text);
```

#### How It Works

1. **Generate Declarations**: `generate-types` creates `.md.d.ts` files alongside your markdown files
2. **Transform Imports**: The transformer detects `.md` imports and inlines the compiled resource
3. **Type Safety**: TypeScript uses `.md.d.ts` files to provide autocomplete and type checking

#### Import Styles

The transformer supports all TypeScript import styles:

```typescript
// Default import
import doc from './doc.md';

// Namespace import
import * as doc from './doc.md';

// Named imports
import { text, fragments, meta } from './doc.md';
```

### API Reference

#### Exported Types

```typescript
// From compiled markdown
export interface Fragment {
  readonly header: string;  // H2 heading with ##
  readonly body: string;    // Content below heading
  readonly text: string;    // header + body
}

export const meta: Record<string, unknown>;  // Frontmatter
export const text: string;                   // Full markdown text
export const fragments: Record<string, Fragment>;  // H2 sections
export type FragmentName = keyof typeof fragments;
```

#### Compiler API

```typescript
import { compileMarkdownResources } from '@vibe-agent-toolkit/resource-compiler/compiler';

const results = await compileMarkdownResources({
  inputDir: 'src/prompts',
  outputDir: 'dist/prompts',
  pattern: '**/*.md',
  verbose: true,
});

// Each result contains:
interface CompileResult {
  sourcePath: string;
  jsPath: string;
  dtsPath: string;
  success: boolean;
  error?: string;
}
```

#### Transformer API

```typescript
import { createTransformer } from '@vibe-agent-toolkit/resource-compiler/transformer';
import ts from 'typescript';

const transformer = createTransformer({
  verbose: true,
});

// Use with TypeScript compiler API
const result = program.emit(
  undefined,
  undefined,
  undefined,
  undefined,
  { before: [transformer] }
);
```

#### Build Utilities API

```typescript
import { copyResources, createPostBuildScript } from '@vibe-agent-toolkit/resource-compiler/utils';

// Copy resources with options
copyResources({
  sourceDir: 'generated',
  targetDir: 'dist/generated',
  verbose: true,
});

// Create a complete post-build script
createPostBuildScript({
  generatedDir: 'generated',
  distDir: 'dist',
  verbose: true,
});
```

**Options:**

```typescript
interface CopyResourcesOptions {
  sourceDir: string;   // Source directory with generated files
  targetDir: string;   // Target directory in dist
  verbose?: boolean;   // Enable logging (default: false)
}
```

**Throws:**
- Error if source directory doesn't exist
- Error if copy operation fails

### Language Service Plugin

Coming soon - TypeScript language service plugin for enhanced IDE support.

## Development

See the implementation plan for development details.

## License

MIT

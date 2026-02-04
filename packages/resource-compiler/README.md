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

### Language Service Plugin

Coming soon - TypeScript language service plugin for enhanced IDE support.

## Development

See the implementation plan for development details.

## License

MIT

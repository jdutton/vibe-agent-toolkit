---
title: API Reference
version: 1.0
audience: developers
---

# API Reference

Complete API documentation for the resource compiler.

## Installation

Install the package using your preferred package manager:

```bash
npm install @vibe-agent-toolkit/resource-compiler
# or
bun add @vibe-agent-toolkit/resource-compiler
```

## Basic Usage

Import and use the compiler in your project:

```typescript
import { compileMarkdownResources } from '@vibe-agent-toolkit/resource-compiler';

const results = await compileMarkdownResources({
  inputDir: './resources',
  outputDir: './dist/resources',
  pattern: '**/*.md',
  verbose: true,
});
```

## Configuration Options

The compiler accepts the following configuration options:

- `inputDir` (required): Directory containing markdown files
- `outputDir` (required): Directory for compiled output
- `pattern` (optional): Glob pattern for file matching (default: `**/*.md`)
- `verbose` (optional): Enable detailed logging (default: `false`)

## Return Value

Returns an array of `CompileResult` objects with the following properties:

- `sourcePath`: Path to the original markdown file
- `jsPath`: Path to the generated JavaScript file
- `dtsPath`: Path to the generated TypeScript declarations
- `success`: Boolean indicating compilation success
- `error`: Error message if compilation failed (optional)

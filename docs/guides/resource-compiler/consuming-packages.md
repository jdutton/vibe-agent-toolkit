---
title: Consuming TypeScript Resources
description: Guide for installing and using published TypeScript resource packages
category: guide
tags: [resource-compiler, typescript, npm, consuming, integration]
audience: intermediate
---

# Consuming TypeScript Resources

Install and use published markdown resource packages with full TypeScript type safety.

---

## What This Guide Covers

- Installing resource packages
- Type-safe importing patterns
- Accessing compiled resources (fragments, metadata)
- Using original markdown for flexibility
- Re-exporting strategies
- Integration with TypeScript projects
- Common patterns and examples

**Audience:** Package consumers (ProjectY) who want to use published resource packages.

---

## Prerequisites

- Node.js 18+ and npm/bun
- Basic TypeScript knowledge
- Understanding of [resource compilation basics](./compiling-markdown-to-typescript.md)

---

## Installation

### Install from npm

```bash
npm install @acme/knowledge-base
```

### Install Specific Version

```bash
# Exact version
npm install @acme/knowledge-base@1.2.3

# Version range (recommended)
npm install @acme/knowledge-base@^1.2.0

# Latest pre-release
npm install @acme/knowledge-base@next
```

### Add to package.json

```json
{
  "dependencies": {
    "@acme/knowledge-base": "^1.2.0"
  }
}
```

---

## Type-Safe Compiled Resources

### Basic Import

```typescript
import * as SystemPrompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

// Access metadata (frontmatter)
console.log(SystemPrompts.meta.title);        // "System Prompts"
console.log(SystemPrompts.meta.version);      // 1.0

// Access full markdown text
console.log(SystemPrompts.text);

// Access fragments (H2 sections)
console.log(SystemPrompts.fragments.technicalAssistant);
console.log(SystemPrompts.fragments.codeReviewer.text);
```

### Fragment Structure

Each fragment has three properties:

```typescript
interface Fragment {
  readonly header: string;  // H2 heading with ##
  readonly body: string;    // Content below heading
  readonly text: string;    // header + body
}

// Example usage:
const fragment = SystemPrompts.fragments.technicalAssistant;

console.log(fragment.header);  // "## Technical Assistant"
console.log(fragment.body);    // "You are a technical assistant..."
console.log(fragment.text);    // "## Technical Assistant\n\nYou are..."
```

### Type-Safe Fragment Names

Fragment names are typed as string literals:

```typescript
// ✅ Type-safe - TypeScript knows available fragments
const fragment = SystemPrompts.fragments.technicalAssistant;

// ✅ Get all fragment names (type-safe)
type FragmentNames = keyof typeof SystemPrompts.fragments;
const names: FragmentNames[] = ['technicalAssistant', 'codeReviewer'];

// ❌ TypeScript error - fragment doesn't exist
const invalid = SystemPrompts.fragments.nonExistent;
```

### Iterating Over Fragments

```typescript
// Iterate over all fragments
for (const [name, fragment] of Object.entries(SystemPrompts.fragments)) {
  console.log(`${name}: ${fragment.header}`);
}

// Get fragment names as array
const fragmentNames = Object.keys(SystemPrompts.fragments);
console.log(fragmentNames); // ['technicalAssistant', 'codeReviewer', ...]

// Map over fragments
const allHeaders = Object.values(SystemPrompts.fragments)
  .map(f => f.header);
```

---

## Accessing Original Markdown

### Why Use Original Markdown?

- **Custom chunking** - Different chunking strategies for RAG
- **Custom parsing** - Extract specific patterns or structures
- **Human reading** - Display raw markdown in documentation UI
- **Debugging** - See the source content
- **Alternative tools** - Use other markdown processors

### Reading Original Markdown

```typescript
import { readFileSync } from 'node:fs';

// Resolve the markdown file path
const mdPath = require.resolve('@acme/knowledge-base/resources/prompts/system.md');

// Read the file
const markdown = readFileSync(mdPath, 'utf-8');

console.log(markdown); // Full markdown content
```

### For RAG Systems

```typescript
import { readFileSync } from 'node:fs';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

// Load original markdown
const mdPath = require.resolve('@acme/knowledge-base/resources/docs/architecture.md');
const content = readFileSync(mdPath, 'utf-8');

// Custom chunking strategy
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
});

const chunks = await splitter.splitText(content);
console.log(`Created ${chunks.length} chunks`);
```

### For Documentation Display

```typescript
import { readFileSync } from 'node:fs';
import { marked } from 'marked';

function renderMarkdown(resourcePath: string): string {
  const content = readFileSync(resourcePath, 'utf-8');
  return marked(content);
}

// Use in React/Vue/etc
const html = renderMarkdown(
  require.resolve('@acme/kb/resources/docs/guide.md')
);
```

---

## Re-Exporting Strategies

### Centralized Knowledge Module

Create a single import point for all resources:

```typescript
// src/knowledge/index.ts
export * as SystemPrompts from '@acme/knowledge-base/generated/resources/prompts/system.js';
export * as UserPrompts from '@acme/knowledge-base/generated/resources/prompts/user.js';
export * as Docs from '@acme/knowledge-base/generated/resources/docs/architecture.js';

// Now consumers use:
// import { SystemPrompts, Docs } from './knowledge';
```

### Typed Re-Exports

```typescript
// src/knowledge/index.ts
import * as SystemPromptsRaw from '@acme/knowledge-base/generated/resources/prompts/system.js';
import * as DocsRaw from '@acme/knowledge-base/generated/resources/docs/architecture.js';

// Re-export with clearer names
export const Prompts = {
  System: SystemPromptsRaw,
  // Add more as needed
};

export const Documentation = {
  Architecture: DocsRaw,
  // Add more as needed
};

// Usage:
// import { Prompts, Documentation } from './knowledge';
// Prompts.System.fragments.technicalAssistant
```

### Selective Re-Exports

```typescript
// src/prompts.ts
import * as SystemPrompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

// Re-export only specific fragments
export const technicalAssistant = SystemPrompts.fragments.technicalAssistant.body;
export const codeReviewer = SystemPrompts.fragments.codeReviewer.body;
export const debugger = SystemPrompts.fragments.debugger.body;

// Usage:
// import { technicalAssistant, codeReviewer } from './prompts';
```

---

## Integration Patterns

### With AI SDKs

```typescript
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';
import { Anthropic } from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function chat(userMessage: string) {
  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    system: Prompts.fragments.technicalAssistant.body,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text;
}
```

### With Configuration Files

```typescript
// config/agents.ts
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

export const agentConfig = {
  technical: {
    name: 'Technical Assistant',
    systemPrompt: Prompts.fragments.technicalAssistant.body,
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 2048,
  },
  reviewer: {
    name: 'Code Reviewer',
    systemPrompt: Prompts.fragments.codeReviewer.body,
    model: 'gpt-4-turbo',
    maxTokens: 1024,
  },
};
```

### With Environment-Specific Resources

```typescript
import * as PromptsV1 from '@acme/prompts/generated/resources/v1/system.js';
import * as PromptsV2 from '@acme/prompts/generated/resources/v2/system.js';

const Prompts = process.env.USE_V2_PROMPTS === 'true' ? PromptsV2 : PromptsV1;

// Use Prompts.fragments... (version determined by environment)
```

---

## Common Usage Patterns

### 1. Dynamic Fragment Selection

```typescript
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

function getPromptForRole(role: keyof typeof Prompts.fragments): string {
  return Prompts.fragments[role].body;
}

// Usage:
const prompt = getPromptForRole('technicalAssistant');
```

### 2. Fragment Existence Check

```typescript
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

function hasFragment(name: string): name is keyof typeof Prompts.fragments {
  return name in Prompts.fragments;
}

// Usage:
if (hasFragment(userInput)) {
  const fragment = Prompts.fragments[userInput];
  console.log(fragment.text);
}
```

### 3. Metadata-Driven Logic

```typescript
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

// Use metadata for conditional logic
if (Prompts.meta.version >= 2.0) {
  // Use new features
} else {
  // Fallback for older versions
}

// Use model hints from metadata
const preferredModel = Prompts.meta.modelHints?.[0] || 'claude-3-sonnet';
```

### 4. Combining Multiple Resources

```typescript
import * as Base from '@acme/kb/generated/resources/prompts/base.js';
import * as Domain from '@acme/kb/generated/resources/prompts/domains.js';

function buildPrompt(baseRole: string, domainArea: string): string {
  const basePrompt = Base.fragments[baseRole]?.body || '';
  const domainPrompt = Domain.fragments[domainArea]?.body || '';

  return `${basePrompt}\n\n## Domain Expertise\n\n${domainPrompt}`;
}

// Usage:
const prompt = buildPrompt('technicalAssistant', 'cloudInfrastructure');
```

### 5. Validation Helper

```typescript
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

function validateFragment(fragment: unknown): fragment is typeof Prompts.fragments[keyof typeof Prompts.fragments] {
  return (
    typeof fragment === 'object' &&
    fragment !== null &&
    'header' in fragment &&
    'body' in fragment &&
    'text' in fragment
  );
}
```

---

## TypeScript Integration

### Typed Imports in tsconfig.json

```json
{
  "compilerOptions": {
    "types": ["@acme/knowledge-base"],
    "moduleResolution": "NodeNext"
  }
}
```

### Type-Only Imports

```typescript
import type { Fragment, FragmentName } from '@vibe-agent-toolkit/resource-compiler';
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

type PromptFragment = typeof Prompts.fragments[keyof typeof Prompts.fragments];
type PromptName = keyof typeof Prompts.fragments;
```

### Creating Wrapper Types

```typescript
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

// Create a type for your specific use case
export type AgentPrompt = {
  name: string;
  fragment: typeof Prompts.fragments[keyof typeof Prompts.fragments];
  modelHint: string;
};

export function createAgentPrompt(
  name: keyof typeof Prompts.fragments
): AgentPrompt {
  return {
    name,
    fragment: Prompts.fragments[name],
    modelHint: Prompts.meta.modelHints?.[0] || 'claude-3',
  };
}
```

---

## Version Management

### Pinning Versions

```json
{
  "dependencies": {
    "@acme/knowledge-base": "1.2.3"  // Exact version
  }
}
```

**Use when:**
- You need reproducible builds
- Breaking changes would affect your app
- Testing specific version behavior

### Using Ranges

```json
{
  "dependencies": {
    "@acme/knowledge-base": "^1.2.0"  // Minor and patch updates
  }
}
```

**Use when:**
- You want automatic bug fixes
- You trust the publisher's semver
- You want new fragments without manual updates

### Checking Installed Version

```typescript
import * as Prompts from '@acme/knowledge-base/generated/resources/prompts/system.js';

console.log(`Package version: ${Prompts.meta.version}`);

// Version-based feature detection
if (typeof Prompts.meta.version === 'number' && Prompts.meta.version >= 2.0) {
  // Use v2 features
}
```

---

## Troubleshooting

### Issue: Module not found

**Error:**
```
Cannot find module '@acme/knowledge-base/generated/resources/prompts/system.js'
```

**Solutions:**
1. Verify package is installed: `npm list @acme/knowledge-base`
2. Check import path matches package exports in publisher's `package.json`
3. Ensure `.js` extension is included in import

### Issue: Type errors with fragments

**Error:**
```
Property 'technicalAssistant' does not exist on type '{}'
```

**Solutions:**
1. Check TypeScript can resolve types: `tsc --traceResolution`
2. Verify `node_modules/@acme/knowledge-base/dist/generated/resources/prompts/system.d.ts` exists
3. Clear TypeScript cache: `rm -rf node_modules/.cache/typescript`

### Issue: Cannot resolve markdown file

**Error:**
```
Cannot find module '@acme/knowledge-base/resources/prompts/system.md'
```

**Solutions:**
1. Check if publisher includes original markdown (some packages only include compiled)
2. Verify path: `ls node_modules/@acme/knowledge-base/dist/resources/`
3. Contact publisher if markdown is missing

---

## Best Practices

### 1. Use Centralized Imports

```typescript
// ✅ Good - centralized
// src/knowledge/index.ts
export * as Prompts from '@acme/kb/generated/resources/prompts/system.js';

// src/agent.ts
import { Prompts } from './knowledge';
```

```typescript
// ❌ Avoid - scattered imports
import * as Prompts from '@acme/kb/generated/resources/prompts/system.js';
```

### 2. Type Your Usage

```typescript
// ✅ Good - typed
import * as Prompts from '@acme/kb/generated/resources/prompts/system.js';

type PromptName = keyof typeof Prompts.fragments;

function getPrompt(name: PromptName): string {
  return Prompts.fragments[name].body;
}
```

### 3. Handle Missing Fragments

```typescript
// ✅ Good - defensive
function getFragment(name: string) {
  if (name in Prompts.fragments) {
    return Prompts.fragments[name as keyof typeof Prompts.fragments];
  }
  throw new Error(`Fragment '${name}' not found`);
}
```

### 4. Cache Expensive Operations

```typescript
// ✅ Good - cache markdown reading
const markdownCache = new Map<string, string>();

function getMarkdown(resourcePath: string): string {
  if (!markdownCache.has(resourcePath)) {
    markdownCache.set(
      resourcePath,
      readFileSync(resourcePath, 'utf-8')
    );
  }
  return markdownCache.get(resourcePath)!;
}
```

---

## Next Steps

### For Specific Use Cases
- **Building AI agents?** → [Building Agent Prompt Libraries](./use-cases/agent-prompt-libraries.md)
- **Creating RAG systems?** → [Creating RAG Knowledge Bases](./use-cases/rag-knowledge-bases.md)
- **Building templates?** → [Template System Patterns](./use-cases/template-systems.md)

### Advanced Topics
Read [Advanced Patterns](./use-cases/advanced-patterns.md) for:
- Multi-collection packages
- Dynamic discovery
- Runtime validation

---

## See Also

- [Overview: Compiling Markdown to TypeScript](./compiling-markdown-to-typescript.md)
- [Publishing TypeScript Resource Packages](./publishing-packages.md)
- [Guide Index](./README.md)

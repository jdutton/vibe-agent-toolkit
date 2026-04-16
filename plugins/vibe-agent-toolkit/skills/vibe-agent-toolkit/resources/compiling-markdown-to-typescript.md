---
title: Compiling Markdown to TypeScript
description: Overview of markdown-to-TypeScript compilation, benefits, and workflows
category: guide
tags: [resource-compiler, typescript, markdown, overview]
audience: beginner
---

# Compiling Markdown to TypeScript

Transform markdown files into TypeScript modules with full type safety and IDE support.

---

## What This Guide Covers

- What markdown-to-TypeScript compilation is
- Why you would use it
- How the compilation process works
- Complete workflow overview
- When to use compiled resources vs alternatives

---

## What is Resource Compilation?

The `@vibe-agent-toolkit/resource-compiler` transforms markdown files into TypeScript modules that can be imported directly in your code with full IDE support.

### Input: Markdown File

```markdown
<!-- prompts/system.md -->
---
title: System Prompts
version: 1.0
---

# System Prompts

## Technical Assistant

You are a technical assistant helping engineers solve problems.

## Code Reviewer

You are reviewing code for quality and maintainability.
```

### Output: TypeScript Module

```typescript
// Generated: prompts/system.js + system.d.ts
export const meta = {
  title: "System Prompts",
  version: 1.0
};

export const text = "# System Prompts\n\n## Technical Assistant\n...";

export const fragments = {
  technicalAssistant: {
    header: "## Technical Assistant",
    body: "You are a technical assistant...",
    text: "## Technical Assistant\n\nYou are..."
  },
  codeReviewer: {
    header: "## Code Reviewer",
    body: "You are reviewing code...",
    text: "## Code Reviewer\n\nYou are..."
  }
};

export type FragmentName = "technicalAssistant" | "codeReviewer";
```

### Usage: Type-Safe Import

```typescript
import * as Prompts from './prompts/system.js';

// Full IDE support!
console.log(Prompts.meta.title);                        // "System Prompts"
console.log(Prompts.fragments.technicalAssistant.text); // Full fragment
console.log(Prompts.fragments.codeReviewer.body);       // Body only
```

---

## Why Use Resource Compilation?

### 1. Type Safety

**Without compilation:**
```typescript
// ❌ Runtime errors, no autocomplete
const prompt = fs.readFileSync('./prompt.md', 'utf-8');
const sections = prompt.split('##'); // Fragile parsing
```

**With compilation:**
```typescript
// ✅ Full type safety and IDE support
import * as Prompts from './prompts/system.js';
const prompt = Prompts.fragments.technicalAssistant.text; // Autocomplete!
```

### 2. Structured Access

**Without compilation:**
```typescript
// ❌ Manual parsing, error-prone
const content = readFileSync('doc.md', 'utf-8');
const sections = content.split(/^## /m);
const intro = sections.find(s => s.startsWith('Introduction'));
```

**With compilation:**
```typescript
// ✅ Direct property access
import * as Docs from './docs/guide.js';
const intro = Docs.fragments.introduction.text;
```

### 3. Frontmatter as Typed Objects

**Without compilation:**
```typescript
// ❌ String parsing with type issues
const parsed = matter(readFileSync('doc.md', 'utf-8'));
const version = parsed.data.version as number; // Manual typing
```

**With compilation:**
```typescript
// ✅ Typed metadata
import * as Docs from './docs/guide.js';
const version: number = Docs.meta.version; // Type-safe!
```

### 4. Version Control & Distribution

**Without compilation:**
- Copy markdown files manually
- Risk inconsistent versions
- No dependency management

**With compilation:**
```bash
# ✅ Use npm for versioning and distribution
npm install @acme/prompts@^2.1.0
```

---

## How It Works

### Compilation Process

```
┌────────────────────┐
│ Source Markdown    │
│ (with frontmatter) │
└──────┬─────────────┘
       │
       │ Parse
       ↓
┌────────────────────┐
│ Abstract Syntax    │
│ Tree (AST)         │
└──────┬─────────────┘
       │
       │ Extract
       ↓
┌────────────────────┐
│ • Frontmatter      │
│ • H2 Fragments     │
│ • Full Text        │
└──────┬─────────────┘
       │
       │ Generate
       ↓
┌────────────────────┐
│ • JavaScript (ES6) │
│ • TypeScript .d.ts │
└────────────────────┘
```

### Fragment Extraction

The compiler automatically extracts H2 sections as fragments:

```markdown
## Introduction
This is the intro.

## Setup
This is the setup section.
```

Becomes:

```typescript
export const fragments = {
  introduction: {
    header: "## Introduction",
    body: "This is the intro.",
    text: "## Introduction\n\nThis is the intro."
  },
  setup: {
    header: "## Setup",
    body: "This is the setup section.",
    text: "## Setup\n\nThis is the setup section."
  }
};
```

### Slug Generation

Fragment names are slugified from H2 headings:

| Heading | Fragment Name |
|---------|---------------|
| `## Technical Assistant` | `technicalAssistant` |
| `## API Reference` | `apiReference` |
| `## Getting Started` | `gettingStarted` |
| `## OAuth 2.0 Flow` | `oauth20Flow` |

---

## Complete Workflow

### Local Development Workflow

```
┌─────────────────────────────────────────────┐
│ 1. Write Markdown                           │
│    resources/prompts/system.md              │
└──────────────┬──────────────────────────────┘
               │
               │ vat-compile-resources compile
               ↓
┌─────────────────────────────────────────────┐
│ 2. Generated TypeScript                     │
│    generated/resources/prompts/system.js    │
│    generated/resources/prompts/system.d.ts  │
└──────────────┬──────────────────────────────┘
               │
               │ import in code
               ↓
┌─────────────────────────────────────────────┐
│ 3. Use in Application                       │
│    src/agent.ts                             │
│    import * as P from '../generated/...'    │
└─────────────────────────────────────────────┘
```

### Package Distribution Workflow

```
┌────────────────────────────────────────────────┐
│ ProjectX: Create Package                      │
│                                                │
│ 1. Write markdown in resources/               │
│ 2. Compile → generated/                       │
│ 3. Build TypeScript → dist/                   │
│ 4. Copy generated/ → dist/generated/          │
│ 5. Copy resources/ → dist/resources/          │
│ 6. npm publish                                │
└────────────┬───────────────────────────────────┘
             │
             │ npm install @acme/knowledge-base
             ↓
┌────────────────────────────────────────────────┐
│ ProjectY: Consume Package                     │
│                                                │
│ 1. npm install @acme/knowledge-base           │
│ 2. import * as KB from '@acme/kb/generated/...'│
│ 3. Use KB.fragments.* in code                 │
│ 4. Or use original markdown for RAG/custom    │
└────────────────────────────────────────────────┘
```

---

## When to Use Compiled Resources

### ✅ Great For

**AI Agent Prompts**
- Store prompts in version-controlled markdown
- Type-safe access to prompt fragments
- Dynamic composition at runtime

**Knowledge Bases for RAG**
- Package documentation as npm modules
- Support both compiled and custom chunking
- Version control your knowledge

**Template Systems**
- Multi-language content (i18n)
- Dynamic email/notification generation
- Type-safe template access

**Shared Documentation**
- Distribute docs across projects
- Consistent content with versioning
- Type-safe references

### ❌ Not Ideal For

**Static Site Generation**
- Use SSG tools like Docusaurus, VitePress
- Compiled resources add unnecessary build complexity

**Simple File Reading**
- If you only need to read one markdown file once
- Direct `fs.readFile()` is simpler

**Highly Dynamic Content**
- Content changes frequently at runtime
- Database or CMS is better suited

**Binary/Media Assets**
- Images, videos, audio files
- Use standard asset bundling instead

---

## Quick Example

### 1. Install

```bash
npm install -D @vibe-agent-toolkit/resource-compiler
```

### 2. Create Markdown

```markdown
<!-- resources/prompts.md -->
---
title: AI Prompts
version: 1.0
---

# AI Prompts

## Helper

You are a friendly AI assistant.

## Expert

You are a technical expert.
```

### 3. Compile

```bash
npx vat-compile-resources compile resources/ generated/
```

### 4. Import and Use

```typescript
import * as Prompts from './generated/prompts.js';

console.log(Prompts.meta.title);                // "AI Prompts"
console.log(Prompts.fragments.helper.text);     // Full helper section
console.log(Prompts.fragments.expert.body);     // Expert prompt body

// Type-safe fragment names
const names: Array<keyof typeof Prompts.fragments> = ['helper', 'expert'];
```

---

## Compilation Options

### CLI Commands

```bash
# Compile all markdown to JavaScript + TypeScript
npx vat-compile-resources compile resources/ generated/

# Generate type declarations only (for TypeScript transformer)
npx vat-compile-resources generate-types resources/

# Watch mode (auto-recompile on changes)
npx vat-compile-resources compile resources/ generated/ --watch

# Verbose output
npx vat-compile-resources compile resources/ generated/ --verbose

# Custom glob pattern
npx vat-compile-resources compile src/ dist/ --pattern "docs/**/*.md"
```

### Programmatic API

```typescript
import { compileMarkdownResources } from '@vibe-agent-toolkit/resource-compiler/compiler';

const results = await compileMarkdownResources({
  inputDir: 'resources',
  outputDir: 'generated',
  pattern: '**/*.md',
  verbose: true,
});

results.forEach(result => {
  console.log(`✓ Compiled ${result.sourcePath} → ${result.jsPath}`);
});
```

---

## Two Compilation Modes

### 1. Pre-Compilation (Recommended)

Compile markdown to JavaScript during build:

```json
{
  "scripts": {
    "generate": "vat-compile-resources compile resources/ generated/",
    "build": "npm run generate && tsc"
  }
}
```

**Pros:**
- Fast runtime (no compilation overhead)
- Works with any bundler
- Easy to debug (inspect generated .js files)

**Cons:**
- Extra build step
- Generated files need to be copied to dist

### 2. TypeScript Transformer (Advanced)

Transform `.md` imports during TypeScript compilation:

```typescript
// tsconfig.json
{
  "compilerOptions": {
    "plugins": [{
      "transform": "@vibe-agent-toolkit/resource-compiler/transformer"
    }]
  }
}

// Import markdown directly
import * as Doc from './doc.md';
```

**Pros:**
- No build step for resources
- Direct markdown imports

**Cons:**
- Requires ts-patch
- Slower TypeScript compilation
- More complex setup

**Recommendation:** Use pre-compilation for most projects.

---

## Next Steps

### For Package Publishers
Read [Publishing TypeScript Resource Packages]() to learn how to:
- Set up package structure
- Configure build scripts
- Publish to npm
- Include both compiled and original markdown

### For Package Consumers
Read [Consuming TypeScript Resources]() to learn how to:
- Install and import packages
- Use type-safe compiled resources
- Access original markdown for flexibility
- Integrate with your project

### For Specific Use Cases
- **Building AI agents?** → [Building Agent Prompt Libraries]()
- **Creating RAG systems?** → [Creating RAG Knowledge Bases]()
- **Building templates?** → [Template System Patterns]()

---

## See Also

- [Resource Compiler README]() - Package documentation
- [Publishing Packages]() - Create and publish resource packages
- [Consuming Packages]() - Use published packages
- [Guide Index]() - All resource compiler guides

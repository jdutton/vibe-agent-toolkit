---
title: TypeScript Resource Compiler Guides
description: Complete documentation for compiling markdown to TypeScript and building reusable content packages
category: reference
tags: [resource-compiler, typescript, markdown, packaging, npm]
audience: beginner
---

# TypeScript Resource Compiler Guides

This directory contains comprehensive guides for using `@vibe-agent-toolkit/resource-compiler` to compile markdown files to TypeScript and distribute them as npm packages.

---

## What is Resource Compilation?

The resource compiler transforms markdown files into TypeScript modules with:
- **Type-safe imports** - Import `.md` files directly with full IDE support
- **Fragment extraction** - H2 headings become typed properties
- **Frontmatter parsing** - YAML metadata becomes typed objects
- **npm distribution** - Package and version your content like code

---

## Quick Decision Tree

**What do you want to do?**

### 📚 Learn About Resource Compilation
→ Start with [**Overview: Compiling Markdown to TypeScript**](./compiling-markdown-to-typescript.md)
  - Understand what resource compilation is
  - See workflow diagrams
  - Quick example
  - Decide if it's right for you

### 📦 Create a Package (Publisher)
→ Read [**Publishing TypeScript Resource Packages**](./publishing-packages.md)
  - Set up your package structure
  - Configure build scripts
  - Publish to npm
  - Best practices for maintainers

### 🔌 Use a Package (Consumer)
→ Read [**Consuming TypeScript Resources**](./consuming-packages.md)
  - Install and import packages
  - Type-safe access patterns
  - Use original markdown for flexibility
  - Integration with your project

### 🤖 Build AI Agents
→ Read [**Building Agent Prompt Libraries**](./use-cases/agent-prompt-libraries.md)
  - Prompt composition patterns
  - Multi-agent systems
  - Dynamic fragment selection
  - Testing strategies

### 🔍 Create RAG Systems
→ Read [**Creating RAG Knowledge Bases**](./use-cases/rag-knowledge-bases.md)
  - Semantic search patterns
  - Chunking strategies
  - Vector database integration
  - Fragment-based RAG

### 📝 Build Template Systems
→ Read [**Template System Patterns**](./use-cases/template-systems.md)
  - Dynamic content generation
  - Multi-language support
  - Email/notification templates
  - Variable substitution

### 🚀 Advanced Topics
→ Read [**Advanced Patterns**](./use-cases/advanced-patterns.md)
  - Multi-collection packages
  - Versioned collections
  - Typed metadata schemas
  - Dynamic discovery

---

## All Guides

### Core Guides

| Guide | Audience | Description |
|-------|----------|-------------|
| [**Overview**](./compiling-markdown-to-typescript.md) | Everyone | What resource compilation is and why to use it |
| [**Publishing**](./publishing-packages.md) | Package creators | Complete workflow for creating and publishing packages |
| [**Consuming**](./consuming-packages.md) | Package users | How to install and use published packages |

### Use Case Guides

| Guide | Audience | Description |
|-------|----------|-------------|
| [**Agent Prompts**](./use-cases/agent-prompt-libraries.md) | AI developers | Building prompt libraries for agents |
| [**RAG Systems**](./use-cases/rag-knowledge-bases.md) | RAG builders | Creating searchable knowledge bases |
| [**Templates**](./use-cases/template-systems.md) | Template developers | Dynamic content and i18n patterns |
| [**Advanced**](./use-cases/advanced-patterns.md) | Advanced users | Multi-collection, versioning, typed schemas |

---

## Learning Path

### For Beginners
1. Read the [Overview](./compiling-markdown-to-typescript.md)
2. Try the [Publishing Guide](./publishing-packages.md) to create your first package
3. Read the [Consuming Guide](./consuming-packages.md) to understand usage

### For Package Publishers
1. Read [Publishing Packages](./publishing-packages.md)
2. Choose relevant use case guides:
   - [Agent Prompts](./use-cases/agent-prompt-libraries.md) for AI prompts
   - [RAG Knowledge Bases](./use-cases/rag-knowledge-bases.md) for documentation
   - [Templates](./use-cases/template-systems.md) for content generation
3. Explore [Advanced Patterns](./use-cases/advanced-patterns.md) when needed

### For Package Consumers
1. Read [Consuming Packages](./consuming-packages.md)
2. Read use case guide relevant to your needs
3. Reference [Advanced Patterns](./use-cases/advanced-patterns.md) for complex scenarios

---

## Common Use Cases

### Prompt Libraries for AI Agents
You're building AI agents and want to:
- ✅ Store prompts in markdown for easy editing
- ✅ Version control your prompts
- ✅ Share prompts across projects with type safety
- ✅ Dynamically compose prompts at runtime

**Read:** [Building Agent Prompt Libraries](./use-cases/agent-prompt-libraries.md)

### Knowledge Bases for RAG
You're building a RAG system and want to:
- ✅ Package documentation as npm modules
- ✅ Support both fragment-based and custom chunking
- ✅ Integrate with vector databases
- ✅ Version your knowledge base content

**Read:** [Creating RAG Knowledge Bases](./use-cases/rag-knowledge-bases.md)

### Template Systems
You're building a content generation system and want to:
- ✅ Store templates in markdown
- ✅ Support multiple languages (i18n)
- ✅ Generate emails, notifications, or documents
- ✅ Version control your templates

**Read:** [Template System Patterns](./use-cases/template-systems.md)

### Multi-Project Content Sharing
You have multiple projects that need:
- ✅ Consistent messaging across applications
- ✅ Shared documentation or help content
- ✅ Centralized prompt management
- ✅ Type-safe content imports

**Read:** [Publishing Packages](./publishing-packages.md) + [Consuming Packages](./consuming-packages.md)

---

## Quick Reference

### Installation
```bash
npm install -D @vibe-agent-toolkit/resource-compiler
```

### Compile Markdown
```bash
npx vat-compile-resources compile resources/ generated/resources/
```

### Import in TypeScript
```typescript
import * as Prompts from './generated/resources/prompts/system.js';

console.log(Prompts.fragments.welcome.text);
console.log(Prompts.meta.title);
```

---

## Related Documentation

- [Resource Compiler Package README](../../../packages/resource-compiler/README.md)
- [VAT Documentation Index](../../README.md)
- [Getting Started Guide](../../getting-started.md)

---

## Questions?

- **Issues:** [GitHub Issues](https://github.com/jdutton/vibe-agent-toolkit/issues)
- **Discussions:** [GitHub Discussions](https://github.com/jdutton/vibe-agent-toolkit/discussions)

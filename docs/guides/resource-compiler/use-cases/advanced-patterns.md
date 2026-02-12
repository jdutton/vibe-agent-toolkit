---
title: Advanced Resource Compiler Patterns
description: Advanced techniques for multi-collection packages, versioned resources, and typed schemas
category: guide
tags: [resource-compiler, advanced, multi-collection, versioning, schemas]
audience: advanced
---

# Advanced Resource Compiler Patterns

Advanced techniques for building sophisticated resource packages with multi-collection support, versioning, and typed schemas.

---

## What This Guide Covers

- Multi-collection packages
- Versioned collections (v1, v2 side-by-side)
- Typed metadata schemas with Zod
- Dynamic collection discovery
- Runtime validation helpers
- Documentation site generation
- Monorepo patterns

**Audience:** Advanced users building complex resource packages.

---

## Multi-Collection Packages

### Organizing Collections

```
your-package/
├── resources/
│   ├── prompts/        # Collection 1
│   │   ├── system.md
│   │   └── user.md
│   ├── templates/      # Collection 2
│   │   ├── email.md
│   │   └── slack.md
│   ├── docs/           # Collection 3
│   │   ├── api.md
│   │   └── guides.md
│   └── examples/       # Collection 4
│       └── code.md
```

### Index with Collection Exports

```typescript
// src/index.ts
// Prompts collection
export * as SystemPrompts from '../generated/resources/prompts/system.js';
export * as UserPrompts from '../generated/resources/prompts/user.js';

// Templates collection
export * as EmailTemplates from '../generated/resources/templates/email.js';
export * as SlackTemplates from '../generated/resources/templates/slack.js';

// Docs collection
export * as APIDocs from '../generated/resources/docs/api.js';
export * as Guides from '../generated/resources/docs/guides.js';

// Examples collection
export * as CodeExamples from '../generated/resources/examples/code.js';

// Collection metadata
export const collections = {
  prompts: ['system', 'user'],
  templates: ['email', 'slack'],
  docs: ['api', 'guides'],
  examples: ['code'],
} as const;

export type CollectionName = keyof typeof collections;
export type ResourceName<T extends CollectionName> = (typeof collections)[T][number];
```

### Dynamic Collection Loading

```typescript
import * as SystemPrompts from '@acme/kb/generated/resources/prompts/system.js';
import * as UserPrompts from '@acme/kb/generated/resources/prompts/user.js';
import * as EmailTemplates from '@acme/kb/generated/resources/templates/email.js';

const resourceMap = {
  'prompts/system': SystemPrompts,
  'prompts/user': UserPrompts,
  'templates/email': EmailTemplates,
  // ... more
};

function getResource(collectionPath: string) {
  return resourceMap[collectionPath as keyof typeof resourceMap];
}

// Usage
const prompts = getResource('prompts/system');
console.log(prompts.fragments);
```

---

## Versioned Collections

### Side-by-Side Versions

```
resources/
├── v1/
│   ├── prompts/
│   │   └── system.md
│   └── templates/
│       └── email.md
└── v2/
    ├── prompts/
    │   └── system.md
    └── templates/
        └── email.md
```

### Version Selection

```typescript
// src/index.ts
export * as PromptsV1 from '../generated/resources/v1/prompts/system.js';
export * as PromptsV2 from '../generated/resources/v2/prompts/system.js';

export * as TemplatesV1 from '../generated/resources/v1/templates/email.js';
export * as TemplatesV2 from '../generated/resources/v2/templates/email.js';

// Version resolver
export function getPrompts(version: 1 | 2 = 2) {
  return version === 1 ? PromptsV1 : PromptsV2;
}

export function getTemplates(version: 1 | 2 = 2) {
  return version === 1 ? TemplatesV1 : TemplatesV2;
}
```

### Runtime Version Detection

```typescript
import * as PromptsV1 from '@acme/kb/generated/resources/v1/prompts/system.js';
import * as PromptsV2 from '@acme/kb/generated/resources/v2/prompts/system.js';

interface VersionedResource {
  version: number;
  fragments: Record<string, any>;
  meta: Record<string, any>;
}

function selectVersion(
  userVersion: number,
  resources: Record<number, VersionedResource>
): VersionedResource {
  // Find highest version <= userVersion
  const availableVersions = Object.keys(resources)
    .map(Number)
    .sort((a, b) => b - a);

  for (const v of availableVersions) {
    if (v <= userVersion) {
      return resources[v];
    }
  }

  // Fallback to oldest version
  return resources[availableVersions[availableVersions.length - 1]];
}

// Usage
const resources = {
  1: PromptsV1,
  2: PromptsV2,
};

const prompts = selectVersion(1, resources);  // Gets V1
const latest = selectVersion(999, resources); // Gets V2 (latest)
```

### Migration Helpers

```typescript
interface MigrationResult {
  success: boolean;
  warnings: string[];
  data: any;
}

function migrateFromV1ToV2(v1Data: typeof PromptsV1): MigrationResult {
  const warnings: string[] = [];

  // Check for removed fragments
  const v1Fragments = Object.keys(v1Data.fragments);
  const v2Fragments = Object.keys(PromptsV2.fragments);

  const removed = v1Fragments.filter(f => !v2Fragments.includes(f));
  if (removed.length > 0) {
    warnings.push(`Removed fragments in V2: ${removed.join(', ')}`);
  }

  // Check for renamed fragments
  const renamedMap: Record<string, string> = {
    oldName: 'newName',
    // Add mappings
  };

  const migratedData = { ...v1Data };

  for (const [oldName, newName] of Object.entries(renamedMap)) {
    if (oldName in v1Data.fragments) {
      warnings.push(`Fragment '${oldName}' renamed to '${newName}' in V2`);
    }
  }

  return {
    success: warnings.length === 0,
    warnings,
    data: migratedData,
  };
}
```

---

## Typed Metadata Schemas

### Defining Metadata Schema with Zod

```typescript
// src/schemas/metadata.ts
import { z } from 'zod';

export const BaseMetadataSchema = z.object({
  title: z.string(),
  version: z.number(),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  author: z.string().optional(),
});

export const PromptMetadataSchema = BaseMetadataSchema.extend({
  category: z.enum(['system', 'user', 'assistant']),
  modelHints: z.array(z.enum(['claude-3', 'gpt-4', 'gemini'])).optional(),
  complexity: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
});

export const TemplateMetadataSchema = BaseMetadataSchema.extend({
  category: z.enum(['email', 'slack', 'sms', 'push']),
  requiredVariables: z.array(z.string()),
  optionalVariables: z.array(z.string()).optional(),
  estimatedLength: z.number().optional(),
});

export type BaseMetadata = z.infer<typeof BaseMetadataSchema>;
export type PromptMetadata = z.infer<typeof PromptMetadataSchema>;
export type TemplateMetadata = z.infer<typeof TemplateMetadataSchema>;
```

### Validating Metadata at Build Time

```typescript
// scripts/validate-metadata.ts
import { glob } from 'glob';
import matter from 'gray-matter';
import { readFileSync } from 'node:fs';
import { PromptMetadataSchema, TemplateMetadataSchema } from '../src/schemas/metadata';

const schemaMap = {
  'prompts': PromptMetadataSchema,
  'templates': TemplateMetadataSchema,
};

async function validateAllMetadata() {
  let errors = 0;

  for (const [collection, schema] of Object.entries(schemaMap)) {
    const files = await glob(`resources/${collection}/**/*.md`);

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const { data } = matter(content);

      try {
        schema.parse(data);
        console.log(`✓ ${file}`);
      } catch (error) {
        console.error(`❌ ${file}:`, error);
        errors++;
      }
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} validation error(s) found`);
    process.exit(1);
  }

  console.log('\n✅ All metadata is valid');
}

validateAllMetadata();
```

### Runtime Metadata Validation

```typescript
import * as Prompts from '@acme/kb/generated/resources/prompts/system.js';
import { PromptMetadataSchema } from '@acme/kb/schemas/metadata';

function validateMetadata<T>(
  meta: unknown,
  schema: z.ZodSchema<T>
): T | null {
  try {
    return schema.parse(meta);
  } catch (error) {
    console.error('Metadata validation failed:', error);
    return null;
  }
}

// Usage
const validMeta = validateMetadata(Prompts.meta, PromptMetadataSchema);

if (validMeta) {
  console.log('Model hints:', validMeta.modelHints);
  console.log('Complexity:', validMeta.complexity);
}
```

---

## Dynamic Collection Discovery

### Exporting Collection Metadata

```typescript
// src/index.ts (generated during build)
import * as SystemPrompts from '../generated/resources/prompts/system.js';
import * as EmailTemplates from '../generated/resources/templates/email.js';
import * as APIDocs from '../generated/resources/docs/api.js';

export const packageMetadata = {
  name: '@acme/knowledge-base',
  version: '1.0.0',
  collections: {
    prompts: {
      resources: ['system', 'user'],
      count: 2,
    },
    templates: {
      resources: ['email', 'slack'],
      count: 2,
    },
    docs: {
      resources: ['api', 'guides'],
      count: 2,
    },
  },
  totalResources: 6,
  totalFragments: 42,
} as const;

export type CollectionName = keyof typeof packageMetadata.collections;
export type ResourceName<T extends CollectionName> =
  (typeof packageMetadata.collections)[T]['resources'][number];
```

### Discovery API

```typescript
// src/discovery.ts
export interface ResourceInfo {
  collection: string;
  name: string;
  fragmentCount: number;
  metadata: Record<string, unknown>;
}

export function discoverResources(): ResourceInfo[] {
  return [
    {
      collection: 'prompts',
      name: 'system',
      fragmentCount: Object.keys(SystemPrompts.fragments).length,
      metadata: SystemPrompts.meta,
    },
    {
      collection: 'templates',
      name: 'email',
      fragmentCount: Object.keys(EmailTemplates.fragments).length,
      metadata: EmailTemplates.meta,
    },
    // ... more
  ];
}

export function findResourcesByTag(tag: string): ResourceInfo[] {
  return discoverResources().filter(r =>
    (r.metadata.tags as string[])?.includes(tag)
  );
}

export function findResourcesByCategory(category: string): ResourceInfo[] {
  return discoverResources().filter(r =>
    r.metadata.category === category
  );
}
```

---

## Runtime Validation Helpers

### Fragment Existence Checking

```typescript
export function hasFragment<T extends Record<string, any>>(
  resource: { fragments: T },
  name: string
): name is keyof T {
  return name in resource.fragments;
}

// Usage
if (hasFragment(SystemPrompts, userInput)) {
  const fragment = SystemPrompts.fragments[userInput];  // Type-safe
  console.log(fragment.text);
}
```

### Safe Fragment Access

```typescript
export function getFragment<T extends Record<string, any>>(
  resource: { fragments: T },
  name: string
): T[keyof T] | null {
  if (name in resource.fragments) {
    return resource.fragments[name as keyof T];
  }
  return null;
}

// Usage with default
const fragment = getFragment(SystemPrompts, userInput) ??
  SystemPrompts.fragments.default;
```

### Fragment Listing

```typescript
export function getAllFragmentNames<T extends Record<string, any>>(
  resource: { fragments: T }
): Array<keyof T> {
  return Object.keys(resource.fragments) as Array<keyof T>;
}

// Usage
const names = getAllFragmentNames(SystemPrompts);
console.log('Available prompts:', names);
```

### Type Guards

```typescript
import type { Fragment } from '@vibe-agent-toolkit/resource-compiler';

export function isValidFragment(obj: unknown): obj is Fragment {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'header' in obj &&
    'body' in obj &&
    'text' in obj &&
    typeof (obj as any).header === 'string' &&
    typeof (obj as any).body === 'string' &&
    typeof (obj as any).text === 'string'
  );
}

// Usage
const maybeFragment = someData;
if (isValidFragment(maybeFragment)) {
  console.log(maybeFragment.text);  // Type-safe
}
```

---

## Documentation Site Generation

### Static Site from Resources

```typescript
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { marked } from 'marked';
import * as Docs from '@acme/kb/generated/resources/docs.js';

interface PageData {
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

function generateDocSite() {
  mkdirSync('dist/docs', { recursive: true });

  // Get all markdown files
  const resourcesDir = require.resolve('@acme/kb/resources/docs').replace(/[^/]+$/, '');
  const files = readdirSync(resourcesDir).filter(f => f.endsWith('.md'));

  const pages: PageData[] = [];

  for (const file of files) {
    const content = readFileSync(`${resourcesDir}/${file}`, 'utf-8');
    const html = marked(content);

    const pageName = file.replace('.md', '');
    const compiledResource = Docs.fragments[pageName as keyof typeof Docs.fragments];

    pages.push({
      title: compiledResource?.header.replace('## ', '') || pageName,
      content: html,
      metadata: Docs.meta,
    });

    const page = generatePage({
      title: pages[pages.length - 1].title,
      content: html,
      navigation: generateNav(files),
    });

    writeFileSync(`dist/docs/${file.replace('.md', '.html')}`, page);
  }

  generateIndex(pages);
}

function generatePage(data: { title: string; content: string; navigation: string }): string {
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>${data.title}</title>
    <style>
      body { font-family: system-ui; max-width: 800px; margin: 0 auto; padding: 2rem; }
      nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #ccc; }
      nav a { margin-right: 1rem; }
    </style>
  </head>
  <body>
    <nav>${data.navigation}</nav>
    <main>${data.content}</main>
  </body>
</html>
  `;
}

function generateNav(files: string[]): string {
  return files
    .map(f => {
      const name = f.replace('.md', '');
      const title = name.replace(/-/g, ' ');
      return `<a href="${name}.html">${title}</a>`;
    })
    .join(' | ');
}

function generateIndex(pages: PageData[]) {
  const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>Documentation</title>
  </head>
  <body>
    <h1>Documentation</h1>
    <ul>
      ${pages.map(p => `<li><a href="${p.title.toLowerCase()}.html">${p.title}</a></li>`).join('\n')}
    </ul>
  </body>
</html>
  `;

  writeFileSync('dist/docs/index.html', html);
}
```

### Search Index Generation

```typescript
import * as AllDocs from '@acme/kb/generated/resources/docs.js';

interface SearchDocument {
  id: string;
  title: string;
  content: string;
  url: string;
  metadata: Record<string, unknown>;
}

function buildSearchIndex(): SearchDocument[] {
  const documents: SearchDocument[] = [];

  for (const [name, fragment] of Object.entries(AllDocs.fragments)) {
    documents.push({
      id: name,
      title: fragment.header.replace('## ', ''),
      content: fragment.body,
      url: `/docs/${name}`,
      metadata: {
        section: name,
        ...AllDocs.meta,
      },
    });
  }

  return documents;
}

// Export for search tool (Algolia, Typesense, MeiliSearch)
const searchIndex = buildSearchIndex();
writeFileSync('dist/search-index.json', JSON.stringify(searchIndex, null, 2));
```

---

## Monorepo Patterns

### Shared Resource Packages

```
monorepo/
├── packages/
│   ├── shared-resources/       # Resource package
│   │   ├── resources/
│   │   ├── package.json
│   │   └── ...
│   ├── frontend-app/           # Consumer
│   │   ├── package.json
│   │   └── src/
│   └── backend-api/            # Consumer
│       ├── package.json
│       └── src/
└── package.json
```

### Workspace Dependencies

```json
// packages/frontend-app/package.json
{
  "name": "@acme/frontend-app",
  "dependencies": {
    "@acme/shared-resources": "workspace:*"
  }
}

// packages/backend-api/package.json
{
  "name": "@acme/backend-api",
  "dependencies": {
    "@acme/shared-resources": "workspace:*"
  }
}
```

### Local Development

```json
// packages/shared-resources/package.json
{
  "scripts": {
    "dev": "vat-compile-resources compile resources/ generated/ --watch",
    "build": "npm run generate:resources && tsc",
    "generate:resources": "vat-compile-resources compile resources/ generated/resources/"
  }
}
```

---

## Best Practices

### 1. Clear Collection Boundaries

- Group related resources together
- Use consistent naming within collections
- Document collection purposes

### 2. Semantic Versioning for Collections

- Major: Breaking changes to structure
- Minor: New resources added
- Patch: Content updates

### 3. Metadata Validation in CI

```yaml
# .github/workflows/validate.yml
- name: Validate metadata
  run: npm run validate:metadata
```

### 4. Type Safety Everywhere

```typescript
// ✅ Good: Type-safe access
type PromptName = keyof typeof Prompts.fragments;

// ❌ Avoid: String indexing
const prompt = Prompts.fragments['someString' as any];
```

### 5. Documentation as Code

- Generate docs from compiled resources
- Keep examples in sync with actual resources
- Version docs alongside resources

---

## Next Steps

- [Building Agent Prompt Libraries](./agent-prompt-libraries.md) - For AI agent prompts
- [Creating RAG Knowledge Bases](./rag-knowledge-bases.md) - For documentation search
- [Template System Patterns](./template-systems.md) - For content generation

---

## See Also

- [Overview: Compiling Markdown to TypeScript](../compiling-markdown-to-typescript.md)
- [Publishing Packages](../publishing-packages.md)
- [Consuming Packages](../consuming-packages.md)
- [Guide Index](../README.md)

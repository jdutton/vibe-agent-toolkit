# @vibe-agent-toolkit/resources

Markdown resource parsing, validation, and link integrity checking for AI agent toolkits.

## Features

- **Parse markdown files** - Extract links, headings, and metadata using unified/remark
- **Validate link integrity** - Check local file links, anchor links, and detect broken references
- **Track resource collections** - Manage multiple markdown files with automatic ID generation
- **Resolve cross-references** - Link resources together and track dependencies
- **Query capabilities** - Find resources by path, ID, or glob patterns
- **GitHub Flavored Markdown** - Full support for GFM including tables, task lists, and autolinks

## Installation

```bash
bun add @vibe-agent-toolkit/resources
```

## Quick Start

```typescript
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

// Create registry
const registry = new ResourceRegistry();

// Add single resource
await registry.addResource('./README.md');

// Crawl directory for all markdown files
await registry.crawl({
  baseDir: './docs',
  include: ['**/*.md'],
  exclude: ['**/node_modules/**']
});

// Validate all links
const result = await registry.validate();
console.log(`Validated ${result.totalLinks} links in ${result.totalResources} files`);
console.log(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
console.log(`Errors: ${result.errorCount}, Warnings: ${result.warningCount}`);

// Show any issues
for (const issue of result.issues) {
  console.log(`${issue.severity.toUpperCase()}: ${issue.message}`);
  if (issue.line) console.log(`  at ${issue.resourcePath}:${issue.line}`);
}
```

## API Reference

### ResourceRegistry

Main class for managing collections of markdown resources.

#### Constructor

```typescript
new ResourceRegistry(options?: ResourceRegistryOptions)
```

**Options:**
- `validateOnAdd?: boolean` - Validate resources immediately when added (default: `false`)

#### Methods

##### addResource(filePath: string): Promise<ResourceMetadata>

Add a single markdown file to the registry.

```typescript
const resource = await registry.addResource('./docs/guide.md');
console.log(`Added ${resource.id} with ${resource.links.length} links`);
```

**Parameters:**
- `filePath` - Path to markdown file (relative or absolute)

**Returns:** Parsed resource metadata

**Throws:** Error if file cannot be read or parsed

##### addResources(filePaths: string[]): Promise<ResourceMetadata[]>

Add multiple markdown files in parallel.

```typescript
const resources = await registry.addResources([
  './README.md',
  './docs/api.md',
  './docs/guide.md'
]);
```

##### crawl(options: CrawlOptions): Promise<ResourceMetadata[]>

Crawl a directory and add all matching markdown files.

```typescript
const resources = await registry.crawl({
  baseDir: './docs',
  include: ['**/*.md'],              // Glob patterns (default: ['**/*.md'])
  exclude: ['**/node_modules/**'],   // Exclude patterns (default: node_modules, .git, dist)
  followSymlinks: false              // Follow symbolic links (default: false)
});
```

**Options:**
- `baseDir` (required) - Base directory to crawl
- `include` - Include glob patterns (default: `['**/*.md']`)
- `exclude` - Exclude glob patterns (default: `['**/node_modules/**', '**/.git/**', '**/dist/**']`)
- `followSymlinks` - Follow symbolic links (default: `false`)

##### validate(): Promise<ValidationResult>

Validate all links in all resources.

```typescript
const result = await registry.validate();

console.log(`Resources: ${result.totalResources}`);
console.log(`Links: ${result.totalLinks}`);
console.log(`Errors: ${result.errorCount}`);
console.log(`Warnings: ${result.warningCount}`);
console.log(`Info: ${result.infoCount}`);
console.log(`Passed: ${result.passed}`);
console.log(`Duration: ${result.durationMs}ms`);

// Links by type
for (const [type, count] of Object.entries(result.linksByType)) {
  console.log(`  ${type}: ${count}`);
}

// Issues
for (const issue of result.issues) {
  console.log(`[${issue.severity}] ${issue.message}`);
}
```

**Returns:** Complete validation results with issues and statistics

**Validation rules:**
- `local_file` links - File must exist, anchor must be valid if present
- `anchor` links - Heading must exist in current file
- `external` links - Not validated (returns info level issue)
- `email` links - Valid by default
- `unknown` links - Returns warning

##### resolveLinks(): void

Resolve cross-references between resources in the registry.

For each `local_file` link, sets the `resolvedId` property to the target resource's ID if it exists in the registry.

```typescript
registry.resolveLinks();

const resource = registry.getResource('./README.md');
for (const link of resource.links) {
  if (link.type === 'local_file' && link.resolvedId) {
    console.log(`Link to ${link.href} resolves to resource: ${link.resolvedId}`);
  }
}
```

##### getResource(filePath: string): ResourceMetadata | undefined

Get a resource by its file path.

```typescript
const resource = registry.getResource('./docs/guide.md');
if (resource) {
  console.log(`Found: ${resource.id}`);
}
```

##### getResourceById(id: string): ResourceMetadata | undefined

Get a resource by its ID.

```typescript
const resource = registry.getResourceById('readme');
```

**Note:** IDs are auto-generated from file names (e.g., `README.md` becomes `readme`, `User Guide.md` becomes `user-guide`).

##### getAllResources(): ResourceMetadata[]

Get all resources in the registry.

```typescript
const allResources = registry.getAllResources();
console.log(`Total: ${allResources.length}`);
```

##### getResourcesByPattern(pattern: string): ResourceMetadata[]

Get resources matching a glob pattern.

```typescript
// Get all docs
const docs = registry.getResourcesByPattern('**/docs/**');

// Get all READMEs
const readmes = registry.getResourcesByPattern('**/README.md');

// Get specific directory
const guides = registry.getResourcesByPattern('docs/guides/**');
```

##### getStats(): RegistryStats

Get statistics about resources in the registry.

```typescript
const stats = registry.getStats();
console.log(`Resources: ${stats.totalResources}`);
console.log(`Links: ${stats.totalLinks}`);
console.log(`Local file links: ${stats.linksByType.local_file}`);
console.log(`External links: ${stats.linksByType.external}`);
```

**Returns:**
```typescript
interface RegistryStats {
  totalResources: number;
  totalLinks: number;
  linksByType: Record<string, number>;
}
```

##### clear(): void

Clear all resources from the registry.

```typescript
registry.clear();
console.log(registry.getAllResources().length); // 0
```

## Type Definitions

### ResourceMetadata

Complete metadata for a markdown resource.

```typescript
interface ResourceMetadata {
  id: string;                        // Unique identifier (auto-generated from file name)
  filePath: string;                  // Absolute path to file
  links: ResourceLink[];             // All links found in the resource
  headings: HeadingNode[];           // Document table of contents (top-level only, nested via children)
  sizeBytes: number;                 // File size in bytes
  estimatedTokenCount: number;       // Estimated tokens for LLM context (~1 token per 4 chars)
  modifiedAt: Date;                  // Last modified timestamp
}
```

### ResourceLink

Represents a link found in a markdown resource.

```typescript
interface ResourceLink {
  text: string;                      // Link text displayed to users
  href: string;                      // Raw href attribute from markdown
  type: LinkType;                    // Classified link type
  line?: number;                     // Line number in source file
  resolvedPath?: string;             // Absolute file path (for local_file links)
  anchorTarget?: string;             // Target heading slug (for anchor links)
  resolvedId?: string;               // Resolved resource ID (for local_file links, set by resolveLinks())
}
```

### LinkType

Type of link found in markdown.

```typescript
type LinkType = 'local_file' | 'anchor' | 'external' | 'email' | 'unknown';
```

- `local_file` - Link to a local file (relative or absolute path)
- `anchor` - Link to a heading anchor (e.g., `#heading-slug`)
- `external` - HTTP/HTTPS URL to external resource
- `email` - Mailto link
- `unknown` - Unclassified link type

### HeadingNode

Represents a heading node in the document's table of contents.

```typescript
interface HeadingNode {
  level: number;                     // Heading level (1-6)
  text: string;                      // Raw text content
  slug: string;                      // GitHub-style slug for anchor links (lowercase, hyphenated)
  line?: number;                     // Line number in source file
  children?: HeadingNode[];          // Nested child headings
}
```

**Note:** The headings array contains only top-level headings. Child headings are nested under their parents via the `children` property, forming a recursive tree structure.

### ValidationResult

Complete results from validating a collection of resources.

```typescript
interface ValidationResult {
  totalResources: number;            // Total resources validated
  totalLinks: number;                // Total links found
  linksByType: Record<string, number>; // Count of links by type
  issues: ValidationIssue[];         // All validation issues
  errorCount: number;                // Number of error-level issues
  warningCount: number;              // Number of warning-level issues
  infoCount: number;                 // Number of info-level issues
  passed: boolean;                   // True if errorCount === 0
  durationMs: number;                // Validation duration in milliseconds
  timestamp: Date;                   // When validation was performed
}
```

### ValidationIssue

A single validation issue found during link validation.

```typescript
interface ValidationIssue {
  severity: ValidationSeverity;      // Issue severity level
  resourcePath: string;              // Absolute path to the resource containing the issue
  line?: number;                     // Line number where the issue occurs
  type: string;                      // Issue type identifier (e.g., 'broken_file', 'broken_anchor')
  link: string;                      // The problematic link
  message: string;                   // Human-readable description
  suggestion?: string;               // Optional suggestion for fixing
}
```

### ValidationSeverity

```typescript
type ValidationSeverity = 'error' | 'warning' | 'info';
```

- `error` - Critical issue that should block usage (e.g., broken file link)
- `warning` - Non-critical issue that should be addressed (e.g., questionable link format)
- `info` - Informational message (e.g., external URL not validated)

## Schemas

All types are backed by Zod schemas for runtime validation. You can import schemas for advanced use cases:

```typescript
import {
  ResourceMetadataSchema,
  ResourceLinkSchema,
  ValidationResultSchema
} from '@vibe-agent-toolkit/resources';

// Runtime validation
const result = ResourceMetadataSchema.safeParse(data);
if (result.success) {
  console.log('Valid resource:', result.data);
}

// Convert to JSON Schema
import { zodToJsonSchema } from 'zod-to-json-schema';
const jsonSchema = zodToJsonSchema(ResourceMetadataSchema);
```

## Advanced Usage

### Parse Individual Files

For advanced use cases, you can use the `parseMarkdown` function directly:

```typescript
import { parseMarkdown } from '@vibe-agent-toolkit/resources';

const result = await parseMarkdown('./document.md');
console.log('Links:', result.links);
console.log('Headings:', result.headings);
console.log('Content:', result.content);
console.log('Size:', result.sizeBytes);
console.log('Estimated tokens:', result.estimatedTokenCount);
```

### Query Patterns

```typescript
// Find all documentation
const docs = registry.getResourcesByPattern('**/docs/**/*.md');

// Find all READMEs
const readmes = registry.getResourcesByPattern('**/README.md');

// Find specific subdirectory
const apiDocs = registry.getResourcesByPattern('docs/api/**/*.md');

// Complex patterns
const guides = registry.getResourcesByPattern('**/+(guide|tutorial)*.md');
```

### Handle Validation Errors

```typescript
const result = await registry.validate();

// Filter by severity
const errors = result.issues.filter(i => i.severity === 'error');
const warnings = result.issues.filter(i => i.severity === 'warning');

// Group by resource
const issuesByResource = new Map<string, ValidationIssue[]>();
for (const issue of result.issues) {
  const issues = issuesByResource.get(issue.resourcePath) ?? [];
  issues.push(issue);
  issuesByResource.set(issue.resourcePath, issues);
}

// Show summary
for (const [path, issues] of issuesByResource) {
  console.log(`\n${path}:`);
  for (const issue of issues) {
    console.log(`  [${issue.severity}] Line ${issue.line}: ${issue.message}`);
  }
}
```

### Validate on Add

Enable strict validation mode to fail fast on broken links:

```typescript
const registry = new ResourceRegistry({ validateOnAdd: true });

try {
  await registry.addResource('./docs/broken.md');
} catch (error) {
  console.error('Validation failed:', error.message);
}
```

## Examples

### Validate Project Documentation

```typescript
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

async function validateDocs() {
  const registry = new ResourceRegistry();

  // Crawl all markdown in project
  await registry.crawl({
    baseDir: process.cwd(),
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**']
  });

  // Validate
  const result = await registry.validate();

  if (!result.passed) {
    console.error(`\nValidation failed with ${result.errorCount} errors\n`);

    for (const issue of result.issues.filter(i => i.severity === 'error')) {
      console.error(`${issue.resourcePath}:${issue.line ?? '?'}`);
      console.error(`  ${issue.message}`);
      if (issue.suggestion) {
        console.error(`  Suggestion: ${issue.suggestion}`);
      }
    }

    process.exit(1);
  }

  console.log(`✓ All links valid (${result.totalLinks} links in ${result.totalResources} files)`);
}

validateDocs();
```

### Build Resource Graph

```typescript
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

async function buildGraph() {
  const registry = new ResourceRegistry();
  await registry.crawl({ baseDir: './docs' });

  // Resolve all cross-references
  registry.resolveLinks();

  // Build dependency graph
  const graph = new Map<string, Set<string>>();

  for (const resource of registry.getAllResources()) {
    const deps = new Set<string>();

    for (const link of resource.links) {
      if (link.type === 'local_file' && link.resolvedId) {
        deps.add(link.resolvedId);
      }
    }

    graph.set(resource.id, deps);
  }

  // Show dependencies
  for (const [id, deps] of graph) {
    if (deps.size > 0) {
      console.log(`${id} depends on: ${[...deps].join(', ')}`);
    }
  }
}

buildGraph();
```

### Generate Link Report

```typescript
async function linkReport() {
  const registry = new ResourceRegistry();
  await registry.crawl({ baseDir: './docs' });

  const result = await registry.validate();

  // Statistics
  console.log('Link Statistics:');
  console.log(`  Total: ${result.totalLinks}`);
  for (const [type, count] of Object.entries(result.linksByType)) {
    const percentage = ((count / result.totalLinks) * 100).toFixed(1);
    console.log(`  ${type}: ${count} (${percentage}%)`);
  }

  // External links
  console.log('\nExternal Links:');
  for (const resource of registry.getAllResources()) {
    const externalLinks = resource.links.filter(l => l.type === 'external');
    if (externalLinks.length > 0) {
      console.log(`\n${resource.filePath}:`);
      for (const link of externalLinks) {
        console.log(`  - ${link.href}`);
      }
    }
  }
}

linkReport();
```

## How It Works

1. **Parsing** - Uses [unified](https://unifiedjs.com/) and [remark](https://remark.js.org/) to parse markdown into an AST (Abstract Syntax Tree)
2. **Link Extraction** - Traverses AST to find all links (regular, reference-style, autolinks)
3. **Heading Extraction** - Builds a hierarchical tree of headings with GitHub-style slugs
4. **Link Classification** - Classifies links as local_file, anchor, external, email, or unknown
5. **Validation** - Checks file existence, anchor validity, and cross-references
6. **Resolution** - Maps local_file links to resource IDs for dependency tracking

## Link Types

### Local File Links

```markdown
[Guide](./guide.md)
[API](../api/README.md)
[Doc with anchor](./doc.md#section)
```

Validated by checking:
- File exists on filesystem
- If anchor present, heading exists in target file

### Anchor Links

```markdown
[Section](#section-name)
[Heading](#heading-slug)
```

Validated by checking:
- Heading with matching slug exists in current file
- Slugs are GitHub-style (lowercase, hyphenated)

### External Links

```markdown
[Google](https://google.com)
[Docs](https://example.com/docs)
```

Not validated (returns info level issue). External URL validation is planned for future releases.

### Email Links

```markdown
[Contact](mailto:user@example.com)
```

Valid by default.

## Platform Support

- Cross-platform (Windows, macOS, Linux)
- Node.js 18+ (ESM only)
- Bun 1.0+

## Dependencies

- [unified](https://unifiedjs.com/) - Markdown processing framework
- [remark-parse](https://github.com/remarkjs/remark/tree/main/packages/remark-parse) - Markdown parser
- [remark-gfm](https://github.com/remarkjs/remark-gfm) - GitHub Flavored Markdown support
- [remark-frontmatter](https://github.com/remarkjs/remark-frontmatter) - Front matter support (future use)
- [unist-util-visit](https://github.com/syntax-tree/unist-util-visit) - AST traversal
- [picomatch](https://github.com/micromatch/picomatch) - Glob pattern matching
- [zod](https://zod.dev/) - Schema validation

## Related Packages

- [@vibe-agent-toolkit/utils](../utils) - Core shared utilities

## Future Enhancements

Planned features for future releases:

- Front matter parsing (title, description, tags)
- ID override via front matter
- External URL validation (opt-in HTTP HEAD requests)
- Circular reference detection
- Link rewriting for bundling resources
- Performance optimization for large projects
- Integration with tiktoken for accurate token counting

## Documentation

- [Project Documentation](../../docs)
- [Architecture](../../docs/architecture/README.md)

## License

MIT

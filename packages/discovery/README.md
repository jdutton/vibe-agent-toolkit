# @vibe-agent-toolkit/discovery

Intelligent file discovery for VAT agents, skills, and resources.

## Overview

The discovery package provides tools for finding and identifying agent-related files in local directories. It detects file formats, respects gitignore rules, and enables pattern-based filtering for intelligent file discovery.

## Features

- **Format Detection** - Automatically identify Claude Skills, VAT agents, and markdown resources
- **Gitignore Awareness** - Skip build outputs and ignored files by default
- **Pattern Filtering** - Include/exclude files using glob patterns
- **Recursive Scanning** - Deep directory traversal with symlink control
- **Type-Safe Results** - Full TypeScript types for all operations

## Installation

```bash
npm install @vibe-agent-toolkit/discovery
```

## Quick Start

### Detect File Format

```typescript
import { detectFormat } from '@vibe-agent-toolkit/discovery';

const format = detectFormat('/path/to/SKILL.md');
// Returns: 'claude-skill' | 'vat-agent' | 'markdown' | 'unknown'
```

### Scan Directory

```typescript
import { scan } from '@vibe-agent-toolkit/discovery';

const summary = await scan({
  path: './agents',
  recursive: true,
});

console.log(`Found ${summary.totalScanned} files`);
console.log(`Claude Skills: ${summary.byFormat['claude-skill']}`);
console.log(`VAT Agents: ${summary.byFormat['vat-agent']}`);
```

### Filter by Pattern

```typescript
import { scan, createPatternFilter } from '@vibe-agent-toolkit/discovery';

const summary = await scan({
  path: './docs',
  include: ['**/*.md'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  recursive: true,
});

// Filter results manually
const filter = createPatternFilter({
  include: ['**/*.md'],
  exclude: ['**/test/**'],
});

const filtered = summary.results.filter(result =>
  filter.matches(result.relativePath)
);
```

## API Reference

### detectFormat(path: string): DetectedFormat

Detect the format of a file based on its name and location.

**Returns:**
- `'claude-skill'` - SKILL.md file
- `'vat-agent'` - Directory containing agent.yaml
- `'markdown'` - .md file (resource)
- `'unknown'` - Other file types

**Example:**
```typescript
detectFormat('/path/to/SKILL.md')        // 'claude-skill'
detectFormat('/path/to/agent.yaml')      // 'vat-agent'
detectFormat('/path/to/guide.md')        // 'markdown'
detectFormat('/path/to/script.js')       // 'unknown'
```

### scan(options: ScanOptions): Promise<ScanSummary>

Scan a directory for agent-related files.

**Options:**
```typescript
interface ScanOptions {
  path: string;              // Directory or file to scan
  recursive?: boolean;       // Scan subdirectories (default: false)
  include?: string[];        // Glob patterns to include
  exclude?: string[];        // Glob patterns to exclude
  followSymlinks?: boolean;  // Follow symbolic links (default: false)
}
```

**Returns:**
```typescript
interface ScanSummary {
  results: ScanResult[];           // All discovered files
  totalScanned: number;            // Total files found
  byFormat: Record<DetectedFormat, number>;  // Count by format
  sourceFiles: ScanResult[];       // Non-gitignored files
  buildOutputs: ScanResult[];      // Gitignored files
}

interface ScanResult {
  path: string;              // Absolute path
  format: DetectedFormat;    // Detected format
  isGitIgnored: boolean;     // Is file gitignored
  relativePath: string;      // Relative path from scan root
}
```

**Example:**
```typescript
const summary = await scan({
  path: './agents',
  recursive: true,
  include: ['**/*.md'],
  exclude: ['**/node_modules/**'],
});

// Access results
for (const result of summary.sourceFiles) {
  console.log(`${result.relativePath}: ${result.format}`);
}
```

### createPatternFilter(options): PatternFilter

Create a reusable pattern filter for matching file paths.

**Options:**
```typescript
interface PatternFilterOptions {
  include?: string[];   // Glob patterns to include
  exclude?: string[];   // Glob patterns to exclude
}
```

**Returns:**
```typescript
interface PatternFilter {
  matches(path: string): boolean;
}
```

**Example:**
```typescript
const filter = createPatternFilter({
  include: ['**/*.md'],
  exclude: ['**/test/**', '**/node_modules/**'],
});

if (filter.matches('docs/guide.md')) {
  console.log('File matches filter');
}
```

## Usage Examples

### Find All Claude Skills

```typescript
import { scan } from '@vibe-agent-toolkit/discovery';

const summary = await scan({
  path: './skills',
  recursive: true,
});

const skills = summary.results.filter(
  result => result.format === 'claude-skill'
);

console.log(`Found ${skills.length} Claude Skills:`);
for (const skill of skills) {
  console.log(`  - ${skill.relativePath}`);
}
```

### Scan with Custom Patterns

```typescript
import { scan } from '@vibe-agent-toolkit/discovery';

const summary = await scan({
  path: './docs',
  recursive: true,
  include: ['**/*.md'],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/__tests__/**',
  ],
});

console.log(`Found ${summary.sourceFiles.length} markdown files`);
```

### Separate Source Files from Build Outputs

```typescript
import { scan } from '@vibe-agent-toolkit/discovery';

const summary = await scan({
  path: './project',
  recursive: true,
});

console.log('Source files:');
for (const file of summary.sourceFiles) {
  console.log(`  ${file.relativePath}`);
}

console.log('\nBuild outputs (ignored):');
for (const file of summary.buildOutputs) {
  console.log(`  ${file.relativePath}`);
}
```

### Filter After Scanning

```typescript
import { scan, createPatternFilter } from '@vibe-agent-toolkit/discovery';

// Scan everything
const summary = await scan({
  path: './agents',
  recursive: true,
});

// Create multiple filters for different purposes
const skillsFilter = createPatternFilter({
  include: ['**/SKILL.md'],
});

const docsFilter = createPatternFilter({
  include: ['**/*.md'],
  exclude: ['**/SKILL.md'],
});

const skills = summary.results.filter(r =>
  skillsFilter.matches(r.relativePath)
);

const docs = summary.results.filter(r =>
  docsFilter.matches(r.relativePath)
);

console.log(`Skills: ${skills.length}, Docs: ${docs.length}`);
```

## Architecture

The discovery package is organized into three main components:

### Detectors

**Format Detector** (`detectors/format-detector.ts`)
- Identifies file formats based on filenames and paths
- Used by scanner to classify discovered files
- Stateless, pure function for easy testing

### Scanners

**Local Scanner** (`scanners/local-scanner.ts`)
- Scans local file system for agent-related files
- Respects gitignore rules automatically
- Supports recursive traversal and symlink handling
- Returns structured scan summaries

### Filters

**Pattern Filter** (`filters/pattern-filter.ts`)
- Matches file paths against glob patterns
- Supports include/exclude logic
- Reusable for manual filtering after scanning

## Design Principles

### 1. Gitignore Awareness

The scanner automatically detects gitignored files using the `isGitIgnored` utility from `@vibe-agent-toolkit/utils`. This prevents processing build outputs, dependencies, or temporary files.

### 2. Format Detection

Format detection is based on conventions:
- **Claude Skills** - Files named SKILL.md
- **VAT Agents** - Directories containing agent.yaml
- **Markdown** - Files with .md extension
- **Unknown** - Everything else

### 3. Pattern Flexibility

Both include and exclude patterns are supported:
- **Include** - Only process matching files
- **Exclude** - Skip matching files
- **Combined** - Apply includes first, then excludes

### 4. Separation of Concerns

- **Detection** - What is this file?
- **Scanning** - Find all files
- **Filtering** - Which files should I process?

Each component is independent and testable.

## Integration

### Used by CLI Commands

The discovery package powers these CLI commands:

- `vat agent audit` - Finds SKILL.md files to validate
- `vat resources scan` - Discovers markdown resources
- `vat resources validate` - Finds files to check for broken links

### Used by Runtime Packages

Runtime packages use discovery for:
- Finding skill dependencies
- Locating reference files
- Building resource inventories

## Error Handling

The discovery package uses standard error handling:

```typescript
try {
  const summary = await scan({ path: './invalid-path' });
} catch (error) {
  if (error instanceof Error) {
    console.error(`Scan failed: ${error.message}`);
  }
}
```

Common errors:
- **ENOENT** - Path does not exist
- **EACCES** - Permission denied
- **ENOTDIR** - Path is not a directory (when recursive)

## Performance Considerations

### Scan Optimization

- **Gitignore check** - Cached per directory to avoid repeated git calls
- **Pattern matching** - Uses efficient glob libraries (minimatch)
- **Symlink handling** - Optional to prevent cycles

### Large Repositories

For large repositories:
1. Use specific include patterns to narrow scope
2. Exclude large directories (node_modules, dist, etc.)
3. Disable recursive scanning when appropriate
4. Consider scanning in batches

## Cross-Platform Compatibility

The discovery package is fully cross-platform:
- Uses `node:path` for path operations
- Handles Windows and Unix path separators
- Tests run on Windows, macOS, and Linux

## Testing

The package includes comprehensive tests:
- **Unit tests** - Format detection, pattern matching
- **Integration tests** - Scanning with real file system
- **System tests** - End-to-end workflows

Run tests:
```bash
bun run test:unit
bun run test:integration
```

## Related Packages

- [`@vibe-agent-toolkit/utils`](../utils/README.md) - Provides `isGitIgnored` utility
- [`@vibe-agent-toolkit/agent-skills`](../agent-skills/README.md) - Uses discovery for skill validation
- [`@vibe-agent-toolkit/cli`](../cli/README.md) - CLI commands built on discovery

## License

MIT

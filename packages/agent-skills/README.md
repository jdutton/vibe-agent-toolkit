# @vibe-agent-toolkit/agent-skills

Build, validate, and import Agent Skills for Claude Desktop, Claude Code, and VAT agents.

## Overview

This package provides runtime support for Agent Skills including:
- **Validation** - Audit Agent Skills for quality and compatibility
- **Import/Export** - Convert between SKILL.md and agent.yaml formats
- **Building** - Package VAT agents as Agent Skills
- **Frontmatter Parsing** - Extract and validate Agent Skills frontmatter

## Features

- **Skill Validation** - Comprehensive validation against Agent Skills specification
- **Format Conversion** - Import SKILL.md to agent.yaml (and vice versa)
- **Build Pipeline** - Generate SKILL.md from agent manifests
- **Schema Validation** - Zod-based frontmatter validation with TypeScript types
- **Link Integrity** - Validate all markdown links and references
- **Console Compatibility** - Detect tool usage incompatible with console mode

## Installation

```bash
npm install @vibe-agent-toolkit/agent-skills
```

## Quick Start

### Validate an Agent Skill

```typescript
import { validateSkill } from '@vibe-agent-toolkit/agent-skills';

const result = await validateSkill({
  skillPath: './my-skill/SKILL.md',
});

if (result.status === 'error') {
  console.error('Validation failed:');
  for (const issue of result.issues) {
    console.error(`  [${issue.code}] ${issue.message}`);
  }
}
```

### Import SKILL.md to agent.yaml

```typescript
import { importSkillToAgent } from '@vibe-agent-toolkit/agent-skills';

const result = await importSkillToAgent({
  skillPath: './my-skill/SKILL.md',
  outputPath: './my-agent/agent.yaml', // Optional
  force: false, // Optional
});

if (result.success) {
  console.log(`Imported to: ${result.agentPath}`);
} else {
  console.error(`Import failed: ${result.error}`);
}
```

### Build Agent Skill from VAT Agent

```typescript
import { buildAgentSkill } from '@vibe-agent-toolkit/agent-skills';

await buildAgentSkill({
  agentPath: './my-agent',
  outputPath: './dist/skills/my-agent',
});
```

## API Reference

### validateSkill(options): Promise<ValidationResult>

Validate an Agent Skill (SKILL.md) for quality and compatibility.

**Options:**
```typescript
interface ValidateOptions {
  skillPath: string;         // Path to SKILL.md
  rootDir?: string;          // Root directory for resolving links
  isVATGenerated?: boolean;  // Treat as VAT-generated (stricter validation)
}
```

**Returns:**
```typescript
interface ValidationResult {
  path: string;                       // Path to skill file
  type: 'agent-skill' | 'vat-agent'; // Detected type
  status: 'success' | 'warning' | 'error';
  summary: string;                    // Human-readable summary
  issues: ValidationIssue[];          // All validation issues
  metadata?: {                        // Extracted metadata
    name?: string;
    description?: string;
    lineCount?: number;
  };
}

interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: IssueCode;              // Machine-readable code
  message: string;              // Human-readable message
  location?: string;            // File:line location
  fix?: string;                 // Suggested fix
}
```

**Example:**
```typescript
const result = await validateSkill({
  skillPath: './my-skill/SKILL.md',
  rootDir: './my-skill',
});

console.log(`Status: ${result.status}`);
console.log(`Summary: ${result.summary}`);

// Check for specific error types
const nameErrors = result.issues.filter(
  i => i.code === 'SKILL_NAME_INVALID'
);

if (nameErrors.length > 0) {
  console.error('Name validation failed');
}
```

### Validation Rules

The validator checks for:

#### Critical Errors (Blocking)

**Frontmatter Errors:**
- `SKILL_MISSING_FRONTMATTER` - No YAML frontmatter found
- `SKILL_MISSING_NAME` - Required "name" field missing
- `SKILL_MISSING_DESCRIPTION` - Required "description" field missing
- `SKILL_NAME_INVALID` - Name doesn't match pattern: `^[a-z0-9]+(-[a-z0-9]+)*$`
- `SKILL_NAME_RESERVED_WORD` - Name contains "claude" or "anthropic"
- `SKILL_NAME_XML_TAGS` - Name contains < or > characters
- `SKILL_DESCRIPTION_TOO_LONG` - Description exceeds 1024 characters
- `SKILL_DESCRIPTION_EMPTY` - Description is empty or whitespace-only
- `SKILL_DESCRIPTION_XML_TAGS` - Description contains < or > characters

**Link Errors:**
- `LINK_INTEGRITY_BROKEN` - Link points to non-existent file
- `PATH_STYLE_WINDOWS` - Link uses Windows backslashes (\)

#### Warnings (Non-Blocking)

- `SKILL_TOO_LONG` - Skill exceeds 5000 lines
- `SKILL_CONSOLE_INCOMPATIBLE` - References Write, Edit, Bash, or NotebookEdit tools

See [Best Practices Guide](../../docs/guides/agent-skills-best-practices.md) for detailed guidance.

### importSkillToAgent(options): Promise<ImportResult>

Convert an Agent Skill (SKILL.md) to VAT agent format (agent.yaml).

**Options:**
```typescript
interface ImportOptions {
  skillPath: string;      // Path to SKILL.md
  outputPath?: string;    // Custom output path (default: same dir as SKILL.md)
  force?: boolean;        // Overwrite existing agent.yaml (default: false)
}
```

**Returns:**
```typescript
type ImportResult =
  | { success: true; agentPath: string }
  | { success: false; error: string };
```

**Example:**
```typescript
// Basic import
const result = await importSkillToAgent({
  skillPath: './my-skill/SKILL.md',
});

// Custom output path
const result = await importSkillToAgent({
  skillPath: './my-skill/SKILL.md',
  outputPath: './agents/my-agent/agent.yaml',
});

// Force overwrite
const result = await importSkillToAgent({
  skillPath: './my-skill/SKILL.md',
  force: true,
});

if (!result.success) {
  console.error(`Import failed: ${result.error}`);
  process.exit(1);
}
```

**What Gets Converted:**

| SKILL.md Field | agent.yaml Field | Notes |
|----------------|------------------|-------|
| `name` | `metadata.name` | Required |
| `description` | `metadata.description` | Required |
| `metadata.version` | `metadata.version` | Defaults to "0.1.0" |
| `metadata.tags` | `metadata.tags` | Optional |
| `license` | `metadata.license` | Optional |
| `compatibility` | `spec.compatibility` | Optional |

The generated agent.yaml will have:
```yaml
metadata:
  name: skill-name
  description: Skill description
  version: 1.0.0
spec:
  runtime: claude-skills
```

### buildAgentSkill(options): Promise<BuildResult>

Build an Agent Skill from a VAT agent manifest.

**Options:**
```typescript
interface BuildOptions {
  agentPath: string;    // Path to agent directory or manifest
  outputPath: string;   // Where to write skill bundle
}
```

**Returns:**
```typescript
interface BuildResult {
  outputPath: string;   // Path to generated SKILL.md
  metadata: {
    name: string;
    description: string;
    version: string;
  };
}
```

**Example:**
```typescript
const result = await buildAgentSkill({
  agentPath: './my-agent',
  outputPath: './dist/skills/my-agent',
});

console.log(`Built skill: ${result.outputPath}`);
console.log(`Version: ${result.metadata.version}`);
```

### Frontmatter Schemas

#### AgentSkillFrontmatterSchema

Strict schema for console-compatible Agent Skills:

```typescript
import { AgentSkillFrontmatterSchema } from '@vibe-agent-toolkit/agent-skills';
import { z } from 'zod';

const frontmatter = {
  name: 'my-skill',
  description: 'Does something useful',
  compatibility: 'Requires Node.js 18+',
};

const result = AgentSkillFrontmatterSchema.safeParse(frontmatter);
if (result.success) {
  // TypeScript type: AgentSkillFrontmatter
  const validated = result.data;
}
```

**Required Fields:**
- `name` - Skill identifier (lowercase, hyphens, max 64 chars)
- `description` - What skill does (max 1024 chars)

**Optional Fields:**
- `license` - License identifier
- `compatibility` - Environment requirements (max 500 chars)
- `metadata` - Additional properties (Record<string, string>)
- `allowed-tools` - Pre-approved tools (experimental)

#### VATAgentSkillFrontmatterSchema

Extended schema for VAT-generated skills:

```typescript
import { VATAgentSkillFrontmatterSchema } from '@vibe-agent-toolkit/agent-skills';

const frontmatter = {
  name: 'my-skill',
  description: 'Does something useful',
  metadata: {
    version: '1.0.0',   // Required for VAT skills
    tags: ['utility', 'data'],
  },
};

const result = VATAgentSkillFrontmatterSchema.safeParse(frontmatter);
```

**Additional Requirements:**
- `metadata.version` - Semantic version (required for VAT)

### parseFrontmatter(content): ParseResult

Parse YAML frontmatter from SKILL.md content.

**Example:**
```typescript
import { parseFrontmatter } from '@vibe-agent-toolkit/agent-skills';
import * as fs from 'node:fs';

const content = fs.readFileSync('./SKILL.md', 'utf-8');
const result = parseFrontmatter(content);

if (result.success) {
  console.log('Frontmatter:', result.frontmatter);
  console.log('Body:', result.body);
} else {
  console.error('Parse error:', result.error);
}
```

## Usage Examples

### Validate Before Import

```typescript
import {
  validateSkill,
  importSkillToAgent
} from '@vibe-agent-toolkit/agent-skills';

// Validate first
const validation = await validateSkill({
  skillPath: './my-skill/SKILL.md',
});

if (validation.status === 'error') {
  console.error('Validation failed, cannot import');
  process.exit(1);
}

// Import if validation passes
const importResult = await importSkillToAgent({
  skillPath: './my-skill/SKILL.md',
});

if (importResult.success) {
  console.log(`Imported to: ${importResult.agentPath}`);
}
```

### Batch Validation

```typescript
import { validateSkill } from '@vibe-agent-toolkit/agent-skills';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function validateAllSkills(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      try {
        const result = await validateSkill({ skillPath });
        results.push({ skill: entry.name, result });
      } catch (error) {
        console.error(`Error validating ${entry.name}:`, error);
      }
    }
  }

  return results;
}

const results = await validateAllSkills('./skills');
const failed = results.filter(r => r.result.status === 'error');

console.log(`Validated ${results.length} skills`);
console.log(`Failed: ${failed.length}`);
```

### Custom Validation Logic

```typescript
import { validateSkill } from '@vibe-agent-toolkit/agent-skills';

const result = await validateSkill({
  skillPath: './my-skill/SKILL.md',
});

// Filter by severity
const errors = result.issues.filter(i => i.severity === 'error');
const warnings = result.issues.filter(i => i.severity === 'warning');

// Group by error code
const byCode = result.issues.reduce((acc, issue) => {
  if (!acc[issue.code]) acc[issue.code] = [];
  acc[issue.code].push(issue);
  return acc;
}, {} as Record<string, typeof result.issues>);

// Check for specific issues
const hasLinkErrors = result.issues.some(
  i => i.code === 'LINK_INTEGRITY_BROKEN'
);

if (hasLinkErrors) {
  console.error('Fix broken links before proceeding');
}
```

## Integration

### CLI Integration

This package powers these CLI commands:
- `vat agent audit` - Validates skills using `validateSkill()`
- `vat agent import` - Imports skills using `importSkillToAgent()`

See [CLI Documentation](../../docs/cli/audit.md) for command usage.

### CI/CD Integration

```typescript
// ci-validate.ts
import { validateSkill } from '@vibe-agent-toolkit/agent-skills';
import * as fs from 'node:fs/promises';

async function validateInCI() {
  const files = await fs.readdir('./skills', { recursive: true });
  const skills = files.filter(f => f.endsWith('SKILL.md'));

  let hasErrors = false;

  for (const skill of skills) {
    const result = await validateSkill({
      skillPath: `./skills/${skill}`,
    });

    if (result.status === 'error') {
      console.error(`❌ ${skill}:`);
      for (const issue of result.issues) {
        if (issue.severity === 'error') {
          console.error(`  ${issue.message}`);
        }
      }
      hasErrors = true;
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log('✅ All skills validated successfully');
}

validateInCI();
```

## TypeScript Types

The package exports all types for TypeScript users:

```typescript
import type {
  ValidateOptions,
  ValidationResult,
  ValidationIssue,
  IssueCode,
  IssueSeverity,
  AgentSkillFrontmatter,
  VATAgentSkillFrontmatter,
  ImportOptions,
  ImportResult,
  BuildOptions,
  BuildResult,
} from '@vibe-agent-toolkit/agent-skills';
```

## Error Handling

All async functions use standard Promise rejection for errors:

```typescript
try {
  const result = await validateSkill({
    skillPath: './invalid-path/SKILL.md',
  });
} catch (error) {
  if (error instanceof Error) {
    console.error(`Validation error: ${error.message}`);
  }
}
```

Validation errors are returned in the `ValidationResult` object, not thrown:

```typescript
const result = await validateSkill({ skillPath: './skill/SKILL.md' });

// result.status will be 'error', not thrown
if (result.status === 'error') {
  // Handle validation failures
}
```

## Performance

### Validation Performance

Validation is optimized for:
- **Fast parsing** - Efficient YAML frontmatter extraction
- **Cached git checks** - Gitignore status cached per directory
- **Parallel validation** - Validate multiple skills concurrently

Typical performance:
- Single skill: ~10-50ms
- 10 skills: ~100-200ms (parallel)
- 100 skills: ~1-2s (parallel)

### Memory Usage

Memory usage is proportional to skill size:
- Small skill (<100KB): ~2MB
- Medium skill (500KB): ~5MB
- Large skill (2MB): ~10MB

For large-scale validation, validate in batches to control memory.

## Cross-Platform Compatibility

The package is fully cross-platform:
- **Path handling** - Uses `node:path` for Windows/Unix compatibility
- **Line endings** - Handles CRLF and LF correctly
- **File system** - Works with case-sensitive and case-insensitive file systems

Tested on:
- Windows 10/11
- macOS (Apple Silicon and Intel)
- Linux (Ubuntu, Debian, Alpine)

## Related Packages

- [`@vibe-agent-toolkit/discovery`](../discovery/README.md) - File discovery for skills
- [`@vibe-agent-toolkit/cli`](../cli/README.md) - CLI commands using this package
- [`@vibe-agent-toolkit/utils`](../utils/README.md) - Shared utilities

## Related Documentation

- [Audit Command](../../docs/cli/audit.md) - CLI validation command
- [Import Command](../../docs/cli/import.md) - CLI import command
- [Agent Skills Best Practices](../../docs/guides/agent-skills-best-practices.md) - Comprehensive guide
- [Agent Skills Specification](https://agentskills.io/specification) - Official spec

## Testing

The package includes comprehensive tests:

```bash
# Unit tests
bun run test:unit

# Integration tests
bun run test:integration

# Watch mode
bun run test:watch
```

## License

MIT

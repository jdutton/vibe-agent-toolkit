# @vibe-agent-toolkit/discovery

Intelligent file discovery for VAT agents and Claude Skills.

## Features

- **Format Detection** - Detects SKILL.md, agent.yaml, and markdown resources by filename
- **Git Awareness** - Distinguishes source files from build outputs using .gitignore
- **Pattern Filtering** - Include/exclude patterns using glob syntax
- **Local & Remote** - Supports local filesystem (GitHub coming soon)

## Usage

```typescript
import { scan } from '@vibe-agent-toolkit/discovery';

const results = await scan({
  path: './my-project',
  recursive: true,
  exclude: ['node_modules', 'dist'],
});

console.log(results.sourceFiles); // Only source files
```

## Architecture

Discovery is "dumb" by design:
- ✅ File scanning and format detection (by filename only)
- ❌ No parsing or validation (domain packages handle that)
- ❌ No dependencies on domain packages (utils only)

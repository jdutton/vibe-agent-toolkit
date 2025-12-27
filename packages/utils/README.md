# @vibe-agent-toolkit/utils

Core shared utilities with no dependencies on other packages.

## Philosophy

This package provides utilities that are needed by multiple packages in the toolkit. Utilities are **added as real needs arise**, not speculatively.

If you need a utility function and multiple packages would benefit from it, add it here. Otherwise, keep it local to the package that needs it.

## Installation

```bash
bun add @vibe-agent-toolkit/utils
```

## Usage

```typescript
import { /* utilities will be added here */ } from '@vibe-agent-toolkit/utils';
```

## Current Utilities

Currently minimal - utilities will be added as needed by other packages.

Future additions may include:
- Schema validation utilities (Zod helpers, JSON Schema conversion)
- Cross-platform helpers (process spawning, file operations)
- Common type guards and assertions

## License

MIT

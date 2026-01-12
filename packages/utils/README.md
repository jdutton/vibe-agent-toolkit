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
import {
  safeExecSync,
  toForwardSlash,
  crawlDirectory,
  isGitIgnored,
  getGitRootDir,
  setupTestTempDir,
} from '@vibe-agent-toolkit/utils';
```

## Available Utilities

### Process Spawning
- `safeExecSync()` - Cross-platform secure command execution without shell

### Path Utilities
- `toForwardSlash()` - Convert paths to forward slashes (Windows/Unix compatibility)
- `getRelativePath()` - Get relative path between two absolute paths
- `normalizeFilePath()` - Normalize file paths for consistent comparisons

### File System
- `crawlDirectory()` - Recursively crawl directories with pattern filtering
- `readFileContent()` - Read file content with encoding detection

### Git Integration
- `isGitIgnored()` - Check if file is gitignored (cached per directory)
- `getGitRootDir()` - Find git repository root directory
- `ensureGitRepository()` - Verify current directory is in a git repo

### Test Helpers
- `setupTestTempDir()` - Create temp directory for tests with cleanup

## License

MIT

# Utils Package Guidelines

## Path Functions: Forward-Slash Standard

As of v0.1.24, all path functions in `@vibe-agent-toolkit/utils` follow a consistent separator convention.

### Forward-slash functions (for string operations, display, comparisons, Map keys, globs)

These always return forward slashes on all platforms:

| Function | Purpose |
|---|---|
| `safePath.join()` | Like `path.join()` but forward slashes |
| `safePath.resolve()` | Like `path.resolve()` but forward slashes |
| `safePath.relative()` | Like `path.relative()` but forward slashes |
| `toAbsolutePath()` | Resolve relative to base dir, forward slashes |
| `getRelativePath()` | Relative path between two files, forward slashes |
| `toForwardSlash()` | Explicit converter for any path string |

### OS-native functions (for filesystem identity and 8.3 short name resolution)

These return OS-native separators (backslashes on Windows) because they use `realpathSync.native()`:

| Function | Purpose |
|---|---|
| `normalizePath()` | Resolve 8.3 short names, return real path |
| `normalizedTmpdir()` | Temp dir with short names resolved |
| `mkdirSyncReal()` | Create dir and return real path |

If you need forward slashes from these, wrap with `toForwardSlash()`.

### ESLint enforcement

Raw `path.join()`, `path.resolve()`, and `path.relative()` are banned by ESLint rules (`no-path-join`, `no-path-resolve`, `no-path-relative`). Use `safePath.*` instead. The implementation file `path-utils.ts` is exempt.

### When adding new path functions

- Default to returning forward slashes
- Document the separator convention in `@returns` JSDoc (visible in LSP tooltips)
- Only use OS-native separators when interfacing with `realpathSync` for filesystem identity

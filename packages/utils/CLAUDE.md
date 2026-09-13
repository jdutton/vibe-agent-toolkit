# Utils Package Guidelines

## Package rules

- `utils` is layer 0: it depends on no other internal package (external npm dependencies such as
  Zod are fine).
- Add a utility only when another package needs it now — never speculatively, and no string/array/
  object helpers without a concrete caller. Examples of the right kind: cross-platform process
  spawning, schema validation helpers, path helpers.
- Every addition gets a test and a line in `README.md`; the barrel surface is pinned by
  `test/barrel-exports.test.ts`, so exporting it is a deliberate diff.
- Custom ESLint rules live in `eslint/` and ship on the `@vibe-agent-toolkit/utils/eslint` subpath —
  see `docs/custom-eslint-rules.md` for how to add one.

## Path Functions: Forward-Slash Standard

All path functions in `@vibe-agent-toolkit/utils` follow one separator convention.

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

Raw `path.join()`, `path.resolve()`, and `path.relative()` are banned by the `local/no-raw-node-path` ESLint rule (its `functions` option table maps each to its `safePath.*` replacement and carries the autofix). Use `safePath.*` instead. The implementation files are exempt: `path-core.ts` (which holds the pure `safePath` definitions) and `path-utils.ts` (the filesystem-touching helpers), plus `path-utils.test.ts`, which tests platform-native behavior.

### When adding new path functions

- Default to returning forward slashes
- Document the separator convention in `@returns` JSDoc (visible in LSP tooltips)
- Only use OS-native separators when interfacing with `realpathSync` for filesystem identity

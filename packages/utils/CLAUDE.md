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
| `toForwardSlash()` | Converter for a NATIVE path (fs, `path.*`, git output) |
| `toForwardSlashAnyPlatform()` | Converter for AUTHOR-WRITTEN text (hrefs, globs, config values, CLI args, archive entry names) |

### A backslash is a separator only on Windows

On POSIX `\` is a legal filename character: `docs/x\y.md` is ONE file. So the two converters differ
on purpose (not enforced — which one a site needs is the author's call):

- `toForwardSlash()` converts only where the host separator is `\` (win32) and is the identity on
  POSIX. Every `safePath.*` helper goes through it, so a real `a\b.md` keeps its name and
  `joinUnderRoot(root, 'x\\..\\..\\s')` stays under `root` on POSIX (one filename, not a climb).
- `toForwardSlashAnyPlatform()` converts every `\` on every host. Use it for text an author typed
  that may carry Windows spellings wherever VAT runs, and for containment guards that must refuse
  `..\x` everywhere (`hasParentTraversalSegment` uses it). Never use it on a path read from the
  filesystem or git — it would invent a phantom `docs/x/` directory.

A test that feeds a Windows-spelled string to `toForwardSlash`/`safePath` is only meaningful on
win32 — gate it with `it.skipIf(path.sep !== '\\')` or use `toForwardSlashAnyPlatform`.

### OS-native functions (for filesystem identity and 8.3 short name resolution)

These return OS-native separators (backslashes on Windows) because they use `realpathSync.native()`:

| Function | Purpose |
|---|---|
| `normalizePath()` | Resolve 8.3 short names, return real path |
| `normalizedTmpdir()` | Temp dir with short names resolved |
| `mkdirSyncReal()` | Create dir and return real path |

If you need forward slashes from these, wrap with `toForwardSlash()`.

### ESLint enforcement

Raw `path.join()`, `path.resolve()`, and `path.relative()` are banned by the `local/no-raw-node-path` ESLint rule (its `functions` option table maps each to its `safePath.*` replacement and carries the autofix). Use `safePath.*` instead. `local/no-manual-path-normalize` autofixes `split(path.sep).join('/')` to `toForwardSlash()` and a literal-backslash `split('\\').join('/')` / `replaceAll('\\', '/')` / `replace(/\\/g, '/')` to `toForwardSlashAnyPlatform()` (behaviour-preserving; switch a native-path site to `toForwardSlash()` by hand). The implementation files are exempt: `path-core.ts` (which holds the pure `safePath` definitions) and `path-utils.ts` (the filesystem-touching helpers), plus `path-utils.test.ts`, which tests platform-native behavior.

### When adding new path functions

- Default to returning forward slashes
- Document the separator convention in `@returns` JSDoc (visible in LSP tooltips)
- Only use OS-native separators when interfacing with `realpathSync` for filesystem identity

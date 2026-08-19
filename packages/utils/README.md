# @vibe-agent-toolkit/utils

Cross-platform primitives for Node tooling that has to run correctly on both Windows and Linux — safe command execution, hardened process spawning, path normalization, and git introspection.

Projects building skills and agent tooling with the vibe-agent-toolkit write exactly this kind of Node code and hit exactly these platform potholes: `.cmd` shims that need a shell on Windows, 8.3 short paths from `tmpdir()`, backslash-versus-forward-slash comparisons, and `import()` of an absolute path failing on Windows without a `file://` URL. This package is the shared answer.

**Node-only.** Requires Node >= 22. See [Runtime support](#runtime-support).

## Installation

```bash
bun add @vibe-agent-toolkit/utils
```

## Import narrowly

Every area has its own subpath. Import the one you need.

The package sets `"sideEffects": false`, so a modern bundler will tree-shake unused code out of the `.` barrel — importing `safePath` from `.` and from `./path` produce near-identical bundles. **Subpaths are not primarily a size optimization.** What they control is what your build has to *resolve* and what your module graph *reaches*: the `.` barrel reaches `yaml`, `handlebars`, and `node:fs` no matter what you destructure from it, so it cannot be bundled for a browser target and requires every dependency to be installed. A narrow entry reaches only what it needs.

The last two columns are the ones that matter when choosing. **"Resolves with zero deps installed?"** is the sharper of the two: it separates an entry that is merely *heavy* from one that is *unbuildable* in an environment where the package's third-party dependencies are absent or unresolvable.

| Subpath | Contents | Node builtins reached | Third-party | Resolves with zero deps installed? |
|---|---|---|---|---|
| `./path` | `safePath`, `toForwardSlash`, `toNfc`, `isAbsolutePath`, `isAbsoluteAnyPlatform`, `hasParentTraversalSegment`, `toAbsolutePath`, `getRelativePath`, `issueLocation` | `path` only | — | **yes** |
| `./text` | `decodeTextContent` — the one bytes-to-text seam: BOM-announced UTF-8/UTF-16LE/UTF-16BE/UTF-32LE/UTF-32BE, BOM stripped, UTF-8 assumed otherwise | **none** | — | **yes** |
| `./zod` | `ZodTypeNames`, `getZodTypeName`, `isZodType`, `unwrapZodType`, `isZodOptional`, `isZodNullable` | **none** | — | **yes** |
| `./glob` | `isGlob`, static base extraction, magic remainder | `path` only | — | **yes** |
| `./fs` | `normalizePath`, `normalizedTmpdir`, `mkdirSyncReal`, `resolveFromImportMeta`, `dynamicImportPath`, `copyDirectory`, `fillSiblingNames`, `classifyFilenameCaseFrom`, `FsLookupCache`, `readTextContent`, `readTextContentSync` | `fs`, `fs/promises`, `os`, `path`, `url` | — | **yes** |
| `./testing` | `getTestOutputDir`, `getTestOutputBase`, `setupAsyncTempDirSuite`, `setupSyncTempDirSuite` | `crypto`, `fs`, `fs/promises`, `os`, `path`, `url` | — | **yes** |
| `./asset` | `resolveAssetReference` — paths and npm bare specifiers | `fs`, `module`, `os`, `path`, `url` | — | **yes** |
| `./yaml` | `updateYamlIn`, `verifyConfinedYamlEdit` — byte-surgical YAML edits | **none** | `yaml` | no — needs `yaml` |
| `./template` | `renderTemplate` — cached Handlebars | **none** | `handlebars` | no — needs `handlebars` |
| `./process` | `safeExecSync`, `safeExecResult`, `safeExecFromString`, `isToolAvailable`, `getToolVersion`, `hasShellSyntax`, `CommandExecutionError`, `spawnHardened`, `shouldUseShell`, `windowsShellQuote`, `buildWindowsShellLine`, `resolveShellCommandToken`, `isPathLike`, `makeStdioBlocking`, `describeStdioBlocking` | `child_process`, `path` | `which` | no — needs `which` |
| `./git` | `gitFindRoot`, `gitLsFiles`, `isGitIgnored`, `loadGitignoreRules`, `GitTracker`, `parseGitUrl`, `isGitUrl`, `nonInteractiveGitOverrides` | `child_process`, `fs`, `os`, `path`, `url` | `ignore`, `which` | no — needs `which`, `ignore` |
| `./crawl` | `crawlDirectory`, `crawlDirectorySync`, `NEVER_CRAWL_GLOBS`, `BUILD_OUTPUT_GLOBS` | `child_process`, `fs`, `os`, `path`, `url` | `picomatch`, `which` | no — needs `picomatch`, `which` |
| `./project` | `findProjectRoot`, `findConfigFile`, `findNodeWorkspaceRoot`, `resetProjectRootCaches` | `fs`, `path` | — | **yes** |
| `./eslint` | the 22 ESLint rules that enforce everything above — see [ESLint rules](#eslint-rules--vibe-agent-toolkitutilseslint) | **none** | — | **yes** |
| `.` | every runtime entry above (not `./eslint`) | all of the above, plus `stream` | `handlebars`, `ignore`, `picomatch`, `which`, `yaml` | no — needs all of them |
| `./package.json` | the manifest itself, for version reporting and resolution assertions | — | — | **yes** |

Note `./zod` reaches nothing at all: it detects Zod types by duck-typing `_def.typeName` rather than importing Zod, which is exactly why it works across Zod v3 and v4.

`./crawl` is the only *subpath* that reaches `picomatch` (the `.` barrel also reaches it, via linkAuth's host-pattern matching), and it is deliberately *not* folded into `./glob` — `./glob` is guarded as portable (`node:path`, no third-party), and directory crawling would break both halves of that guarantee.

```typescript
// Reaches node:path and nothing else
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils/path';
import { safeExecSync, spawnHardened } from '@vibe-agent-toolkit/utils/process';

// Reaches yaml, handlebars, and node:fs regardless of what you destructure
import { safePath } from '@vibe-agent-toolkit/utils';
```

`./package.json` is exported as well, so `require('@vibe-agent-toolkit/utils/package.json')` (or a `with { type: 'json' }` import) works for version reporting and "which build am I on?" resolution assertions instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Consumers who prefer a single seam over direct dependencies can re-export the subpaths they want from their own internal module. That pattern works well — just wrap the subpaths rather than the `.` barrel, or the narrowing is lost.

## Runtime support

This package targets **Node >= 22** and is not published for browsers. Most entry points reach `node:fs`, `node:child_process`, or `node:os`.

A guard test in `test/subpath-purity.test.ts` walks each entry's transitive source graph and enforces **both** of the table's last two columns:

- **Third-party reach** — the "Resolves with zero deps installed?" column. Every entry's expected third-party set is asserted exactly, so every **yes** row above is a tested claim rather than a documented intention, and adding a dependency to any entry is a deliberate, reviewed edit.
- **Builtin reach** — five entries are held to a stricter contract still: `./zod`, `./yaml`, `./template` reach **no Node builtin at all**, and `./path`, `./glob` reach **`node:path` and nothing else** — the one builtin every bundler shims.

That is an enforced invariant, not a browser-support commitment: there are no browser export conditions and no browser test lane. The guard exists so the property can't regress silently — it fails loudly if it cannot resolve a module, so it can't pass vacuously; `test/fixtures/dangling-import/` exercises that failure so the guarantee is demonstrated, not just claimed. If you add a new entry, add it to that test or nothing protects it.

`./eslint` is hand-written CommonJS rather than compiled TypeScript, so that walker cannot see it; `test/eslint/subpath-purity.test.ts` holds it to the same contract by walking its `require()` graph instead — no builtin, no third-party, and in particular never `eslint` itself.

## Available Utilities

### Zod Type Introspection (Version-Agnostic)

**Purpose**: Runtime Zod type detection that works across Zod v3 and v4.

Uses duck typing via `_def.typeName` instead of `instanceof` checks, which fail when library and user Zod versions differ. Essential for libraries that accept user-provided Zod schemas.

**Quick Example**:
```typescript
import { getZodTypeName, isZodType, ZodTypeNames } from '@vibe-agent-toolkit/utils/zod';
import { z } from 'zod';

const schema = z.string().optional();

// Get type name (works with Zod v3 or v4)
const typeName = getZodTypeName(schema);
console.log(typeName); // 'ZodOptional'

// Check if matches expected type
if (isZodType(schema, ZodTypeNames.STRING)) {
  console.log('String type!');
}
```

**Available Functions**:
- `getZodTypeName(zodType)` - Extract `_def.typeName` safely
- `isZodType(zodType, typeName)` - Check if type matches expected name
- `unwrapZodType(zodType)` - Unwrap optional/nullable to get inner type
- `isZodOptional(zodType)` - Check if type is optional
- `isZodNullable(zodType)` - Check if type is nullable

**Available Constants** (`ZodTypeNames`):
```typescript
STRING, NUMBER, BOOLEAN, ARRAY, OBJECT, ENUM,
OPTIONAL, NULLABLE, DATE, BIGINT, NATIVENUM,
UNION, INTERSECTION, TUPLE, RECORD, MAP, SET,
FUNCTION, LAZY, PROMISE, and more...
```

**See**: [docs/zod-compatibility.md](https://github.com/jdutton/vibe-agent-toolkit/blob/main/docs/zod-compatibility.md) for the complete guide

**Peer Dependency**: Requires `zod ^3.25.0 || ^4.0.0`

---

### Path strings — `@vibe-agent-toolkit/utils/path`

These always return forward slashes on every platform, so they are safe for comparisons, `Map` keys, globs, and display.

- `safePath.join()` / `.resolve()` / `.relative()` - forward-slash equivalents of the `node:path` functions
- `toForwardSlash()` - explicit converter for any path string
- `toNfc()` - Unicode-NFC normalizer for filename **comparison keys** (see the warning below)
- `toAbsolutePath()` - resolve a path relative to a base directory
- `getRelativePath()` - relative path between two absolute paths
- `isAbsolutePath()` / `isAbsoluteAnyPlatform()` - absolute-path predicates
- `hasParentTraversalSegment()` - detect `..` segments before using a caller-supplied path
- `issueLocation()` - format a `file:line`-style location relative to a project root

⚠️ **`toNfc()` produces a comparison key, never a path to open.** The same visible filename has two
Unicode encodings — precomposed NFC (`é` = `U+00E9`) and decomposed NFD (`e` + `U+0301`). They are
different strings, so `===`, `toLowerCase()`, `Map.get()` and `Set.has()` all call them different,
and `readdir` returns whichever form is on disk (commonly decomposed on macOS) while a markdown link
typed in an editor carries the composed one. Normalize wherever two such strings are **compared** —
a `Map` key derived from enumeration and queried from link text, a basename checked against a
directory listing. Do **not** normalize a path on its way to `fs.*`: macOS would not notice (its
lookup is normalization-insensitive), but on Linux the two forms are different byte sequences naming
different files, so opening the normalized form of a decomposed filename fails outright. That is why
this is a separate helper rather than something `safePath.resolve()` does.

### Filesystem — `@vibe-agent-toolkit/utils/fs`

These return **OS-native** separators, because they resolve real filesystem identity via `realpathSync.native()` (which is what resolves Windows 8.3 short names). Wrap with `toForwardSlash()` if you need forward slashes.

⚠️ **`normalizePath()` has an input-dependent split personality.** It lives on `./fs` (rather than `./path`) for the right reason — it calls `realpathSync.native()` — but which of two different things it does depends on its argument: given a single *relative* path it is pure string work, equivalent to `path.normalize`, touching no filesystem; given anything else it resolves to absolute and performs a filesystem `realpath`, so it follows symlinks, resolves 8.3 short names, and — when the path does not exist — silently falls back to the merely-resolved path. Two semantics under one name: check which case you are in before relying on either.

- `normalizePath()` - resolve 8.3 short names and return the real path (see the warning above)
- `normalizedTmpdir()` - `os.tmpdir()` with short names resolved
- `mkdirSyncReal()` - create a directory and return its real path
- `resolveFromImportMeta()` - resolve paths relative to an `import.meta.url`
- `dynamicImportPath()` - `import()` an absolute path (works on Windows, which rejects bare absolute paths)
- `copyDirectory()`
- `fillSiblingNames(filePaths, fsCache)` - pass 1 of the case-exact existence check: list the parent
  directory of every path, de-duplicated by directory and issued concurrently. The only I/O in the pair
- `classifyFilenameCaseFrom(table, filePath)` - pass 2: pure judgement against the table pass 1 returned,
  reporting the entry actually on disk when only the case differs. Fill **once** over the whole set and
  then judge each path — a fill per path reinstates the serialized `readdir` this shape removes
- `FsLookupCache` - per-run memo for `realpath`/`readdir`, sharing in-flight promises. Construct one per
  validation run and let it die with the run — never a module-level singleton, or a long-lived process
  answers from a stale directory listing.

### Processes — `@vibe-agent-toolkit/utils/process`

- `safeExecSync()` / `safeExecResult()` / `safeExecFromString()` - cross-platform command execution with no shell injection
- `spawnHardened()` - async spawn with streaming stdio and correct Windows `.cmd`/`.bat` launching
- `shouldUseShell()` / `windowsShellQuote()` / `buildWindowsShellLine()` - Windows shell-invocation helpers
- `isToolAvailable()` / `getToolVersion()` / `hasShellSyntax()`
- `makeStdioBlocking()` - stop `process.exit()` truncating output in a published bin

### Git — `@vibe-agent-toolkit/utils/git`

- `gitFindRoot()` - find the repository root from a starting directory
- `gitLsFiles()` - enumerate tracked files
- `isGitIgnored()` - check whether a path is gitignored (outside a repository it answers from the filesystem, spawning nothing)
- `loadGitignoreRules()` - load a repository's ignore rules
- `GitTracker` - cached tracked-file lookups for repeated checks
- `parseGitUrl()` / `isGitUrl()` - recognize and decompose git URLs, including `owner/repo` shorthand and `#ref:subpath` fragments
- `nonInteractiveGitOverrides()` - env and `git -c` overrides that stop a clone blocking on a credential prompt

**One root finder, on purpose.** `gitFindRoot()` is the only one in the package. There used to be a second name, `findGitRoot()`, whose entire body was `return gitFindRoot(startDir)`; two names for one function guarantees half of all callers pick each. Keeping it off this entry was not enough — it stayed on the `.` barrel, so both names were still one import away — so it has been removed outright. Replace any `findGitRoot(` with `gitFindRoot(`; the behavior is identical.

### Test helpers — `@vibe-agent-toolkit/utils/testing`

- `setupAsyncTempDirSuite()` / `setupSyncTempDirSuite()` - per-suite temp directories with cleanup
- `getTestOutputDir()` / `getTestOutputBase()` - isolated test output paths

### Project roots — `@vibe-agent-toolkit/utils` (barrel only)

- `findProjectRoot()` - the VAT project root: nearest `vibe-agent-toolkit.config.yaml`, else nearest `.git/`, else `null`
- `findConfigFile()` / `findNodeWorkspaceRoot()` - the narrower individual probes
- `resetProjectRootCaches()` - invalidate the module-level walk-up cache (long-lived processes and tests that mutate fixtures)

These are CLI-boundary functions: inner libraries should take a root as a parameter rather than discovering one. They return `string | null` with no internal fallback, so a caller with no root has to decide one rather than silently landing on an absolute path.

**These four are VAT-shaped — read this before reaching for them.** `findProjectRoot()` looks for `vibe-agent-toolkit.config.yaml` and then `.git/`; if your repo's notion of "root" is a `pnpm-workspace.yaml`, a `turbo.json`, or a lockfile, that ladder is not your ladder — and for a *published* package, keying anything on `.git/` is a bug, since it will not be there at install time. `findNodeWorkspaceRoot()` is narrower still: it needs a `package.json` carrying a `"workspaces"` key, which pnpm and Bun workspaces do not have. `findConfigFile()` hardcodes VAT's config filename. If you want a git root, take `gitFindRoot()` from [`./git`](#git--vibe-agent-toolkitutilsgit); if you want your own marker, a six-line walk-up is more honest than a helper whose ladder you have to work around.

They are nonetheless on their own [`./project`](#import-narrowly) entry rather than the barrel alone. The entry was briefly withdrawn on the grounds that the functions fit few repos — which is true, and is what the paragraph above says — but that answered the wrong question. What decides whether an *entry* exists is how heavy the only remaining door is: barrel-only, these four cost `handlebars`, `yaml`, `picomatch`, `ignore` and `which` to reach, while their own code imports nothing but `node:fs` and `node:path`. Publishing the entry is not a claim that the ladder fits you — only that finding out shouldn't cost five dependencies.

### Directory crawling — `@vibe-agent-toolkit/utils/crawl`

- `crawlDirectory()` / `crawlDirectorySync()` - gitignore-aware directory walks
- `NEVER_CRAWL_GLOBS` / `BUILD_OUTPUT_GLOBS` - the standard exclusion sets

Glob *pattern inspection* is a separate entry, `./glob`, and stays that way: `./glob` is dependency-free and reaches only `node:path`, whereas crawling reaches the filesystem, `git`, and `picomatch`.

### ESLint rules — `@vibe-agent-toolkit/utils/eslint`

A safety helper is only as good as its enforcement: `safePath.join()` prevents a class of Windows bug precisely once — the moment someone writes `path.join()` instead, the helper's existence has bought nothing. So the 21 rules that direct code to these helpers ship with them, on their own subpath:

```js
// eslint.config.js
import vat from '@vibe-agent-toolkit/utils/eslint';

export default [
  vat.configs.recommended,
];
```

`configs.recommended` registers the rules under the `@vibe-agent-toolkit` namespace and turns on the cross-platform safety core (18 of the 21 — three rules are opt-in). Most rules auto-fix, and every message names the replacement and the subpath it lives on. Rules that ban a primitive take an `exemptFiles` option naming the file that implements *your* wrapper; there are deliberately no built-in exemptions.

**[Full rule table, severities, and exemption semantics →](./eslint/README.md)**

Requires ESLint 9+ (flat config). `eslint` is an **optional** peer dependency and adds nothing to the entries above: an ESLint plugin is data, not code that runs — the rule modules export plain objects and none of them `require('eslint')` — so this subpath reaches no Node builtin and no third-party package at all, and installing `utils` for `safePath.join()` alone pulls in nothing extra.

Shipping them here rather than as a separate `eslint-plugin` package is deliberate: one install, one version, and no way for a rule to name a helper signature the installed `utils` no longer has.

## License

MIT

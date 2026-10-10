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

The package sets `"sideEffects": false`, so a modern bundler will tree-shake unused code out of the `.` barrel — importing `safePath` from `.` and from `./path` produce near-identical bundles. **Subpaths are not primarily a size optimization.** What they control is what your build has to *resolve* and what your module graph *reaches*. A narrow entry reaches only what it needs.

**The `.` barrel reaches no third-party package at all.** Every domain that carries a dependency — directly or transitively — is a subpath: `./crawl`, `./git`, `./process`, `./skill-test`, `./yaml`. That is asserted by equality in `test/subpath-purity.test.ts`, so the barrel cannot silently regain one. It still reaches `node:fs` and friends, so it is Node-only; what it does not do is make a consumer of `safePath` install a template engine.

The last two columns are the ones that matter when choosing. **"Resolves with zero deps installed?"** is the sharper of the two: it separates an entry that is merely *heavy* from one that is *unbuildable* in an environment where the package's third-party dependencies are absent or unresolvable.

| Subpath | Contents | Node builtins reached | Third-party | Resolves with zero deps installed? |
|---|---|---|---|---|
| `./path` | `safePath`, `toForwardSlash`, `toForwardSlashAnyPlatform`, `toNfc`, `isAbsolutePath`, `isAbsoluteAnyPlatform`, `hasParentTraversalSegment`, `relativeEscapesRoot`, `isSingleFsSegment`, `toAbsolutePath`, `getRelativePath`, `issueLocation` | `path` only | — | **yes** |
| `./text` | `decodeTextContent` — the one bytes-to-text seam: BOM-announced UTF-8/UTF-16LE/UTF-16BE/UTF-32LE/UTF-32BE, BOM stripped, UTF-8 assumed otherwise; reports the encoding, whether it was a BOM fact or an assumption, and how many U+FFFD the decode substituted. `TextTooLargeError` (`TEXT_TOO_LARGE`) when the engine refuses a string that long | **none** | — | **yes** |
| `./zod` | `ZodTypeNames`, `getZodTypeName`, `isZodType`, `unwrapZodType`, `isZodOptional`, `isZodNullable` | **none** | — | **yes** |
| `./glob` | `isGlob`, static base extraction, magic remainder | `path` only | — | **yes** |
| `./fs` | `normalizePath`, `normalizedTmpdir`, `mkdirSyncReal`, `resolveFromImportMeta`, `dynamicImportPath`, `fillPathSpellings`, `pathSpellingFrom`, `DirectorySpellingIndex`, `spellingWalkRoot`, `fillRealpaths`, `realpathFrom`, `FsLookupCache`, `readTextContent`, `readTextContentSync`, `readDecodableBytes` (refuses a file past `MAX_DECODABLE_BYTES` by `fstat`, before reading it), `exceedsDecodableLength`, `MAX_DECODABLE_BYTES`, `TextTooLargeError` | `buffer`, `fs`, `fs/promises`, `os`, `path`, `url`, `util` | — | **yes** |
| `./testing` | `getTestOutputDir`, `getTestOutputBase`, `setupAsyncTempDirSuite`, `setupSyncTempDirSuite`, `removeScratchDir`, `createTempDir`, `removeTempDir`, `tempDirTracker`, `scratchTmpdirEnv`, `registerScratchTmpdir`, `CANNOT_DENY_READS`, `tmpdirFoldsCase`, `buildHostileTree`, `HOSTILE_NAMES`, `installFaultFs`, `injectedErrnoError`, `faultRuleOf`, `faultFsSpecOf`, `snapshotTree`, `diffSnapshots`, `subtree`, `symlinkCapability`, `createSymlink`, `createSymlinkAsync` | `crypto`, `fs`, `fs/promises`, `module`, `os`, `path`, `url` | — | **yes** |
| `./asset` | `resolveAssetReference` — paths and npm bare specifiers | `fs`, `module`, `os`, `path`, `url` | — | **yes** |
| `./yaml` | `updateYamlIn`, `verifyConfinedYamlEdit` — byte-surgical YAML edits | **none** | `yaml` | no — needs `yaml` |
| `./process` | `safeExecSync`, `safeExecResult`, `safeExecFromString`, `isToolAvailable`, `getToolVersion`, `hasShellSyntax`, `CommandExecutionError`, `spawnHardened`, `shouldUseShell`, `windowsShellQuote`, `buildWindowsShellLine`, `resolveShellCommandToken`, `isPathLike`, `makeStdioBlocking`, `describeStdioBlocking` | `child_process`, `path` | `@vibe-validate/git`, `which` | no — needs both |
| `./git` | `runGit`, `runGitOrThrow`, `gitFindRoot`, `gitLsFiles`, `gitLsOthers`, `isGitIgnored`, `loadGitignoreRules`, `GitTracker`, `gitTreeSnapshot`, `peekGitTreeSnapshot`, `withGitSnapshotCache`, `parseGitUrl`, `isGitUrl`, `nonInteractiveGitOverrides` | `async_hooks`, `fs`, `fs/promises`, `os`, `path`, `url` | `@vibe-validate/git`, `ignore` | no — needs both |
| `./crawl` | `crawlDirectory`, `crawlDirectorySync`, `crawlPathFilter`, `NEVER_CRAWL_GLOBS`, `BUILD_OUTPUT_GLOBS` | `fs`, `os`, `path`, `url` | `@vibe-validate/git`, `picomatch` | no — needs both |
| `./skill-test` | `spawnHeadlessClaude`, `assembleClaudeArgs`, `killAllActiveClaudeChildren`, `resolveAuth`, `probeAuthStatus`, `AuthPreflightError`, `applyDeclaredEnv`, `buildForwardedEnv`, `formatForwardedEnvLine`, `isProtectedName`, `protectedEnvNames`, `parseStreamJsonTranscript`, `detectInvocationFromTranscript` | `child_process`, `path`, `stream` | `@vibe-validate/git`, `which` | no — needs both |
| `./project` | `findProjectRoot`, `findConfigFile`, `findNodeWorkspaceRoot`, `resetProjectRootCaches` | `fs`, `fs/promises`, `os`, `path`, `url` | — | **yes** |
| `./eslint` | the 22 ESLint rules that enforce everything above — see [ESLint rules](#eslint-rules--vibe-agent-toolkitutilseslint) | **none** | — | **yes** |
| `.` | the dependency-free entries above — path, text, fs, asset, project, testing, zod, glob, plus the crawl-timing seam | `async_hooks`, `crypto`, `fs`, `fs/promises`, `module`, `os`, `path`, `url`, `util` | — | **yes** |
| `./package.json` | the manifest itself, for version reporting and resolution assertions | — | — | **yes** |

Note `./zod` reaches nothing at all: it detects Zod types by duck-typing `_def.typeName` rather than importing Zod, which is exactly why it works across Zod v3 and v4.

`./crawl` is the only entry that reaches `picomatch`, and it is deliberately *not* folded into `./glob` — `./glob` is guarded as portable (`node:path`, no third-party), and directory crawling would break both halves of that guarantee.

`./skill-test` declares no dependency of its own; it is a separate entry because of what it *reaches*. Spawning a headless agent goes through `./process`, which costs `which` and — because `safeExecSync` refuses the `git` binary and delegates — `@vibe-validate/git`. Reachability is the criterion, not the import a module happens to write.

`./git` is the only published route to `runGit`. `safeExecSync` and `safeExecResult` on `./process` refuse `git` outright and point here, so a caller that wants git gets the scrubbed environment by construction rather than by remembering to ask.

```typescript
// Reaches node:path and nothing else
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils/path';

// Reaches `which` and @vibe-validate/git — a real install cost, so it is its own entry
import { safeExecSync, spawnHardened } from '@vibe-agent-toolkit/utils/process';

// Reaches node builtins only — no third-party package, whatever you destructure
import { safePath } from '@vibe-agent-toolkit/utils';
```

`./package.json` is exported as well, so `require('@vibe-agent-toolkit/utils/package.json')` (or a `with { type: 'json' }` import) works for version reporting and "which build am I on?" resolution assertions instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Consumers who prefer a single seam over direct dependencies can re-export the subpaths they want from their own internal module. That pattern works well — just wrap the subpaths rather than the `.` barrel, or the narrowing is lost.

## Runtime support

This package targets **Node >= 22** and is not published for browsers. Most entry points reach `node:fs`, `node:child_process`, or `node:os`.

A guard test in `test/subpath-purity.test.ts` walks each entry's transitive source graph and enforces **both** of the table's last two columns:

- **Third-party reach** — the "Resolves with zero deps installed?" column. Every entry's expected third-party set is asserted exactly, so every **yes** row above is a tested claim rather than a documented intention, and adding a dependency to any entry is a deliberate, reviewed edit. The `.` row asserts `[]`, which is the load-bearing one: a dependency arriving on the barrel — through any module it exports, at any depth — reddens that assertion, and the fix is a new subpath rather than a longer expected list.
- **Builtin reach** — five entries are held to a stricter contract still: `./zod`, `./yaml`, `./text` reach **no Node builtin at all**, and `./path`, `./glob` reach **`node:path` and nothing else** — the one builtin every bundler shims.

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
- `toForwardSlash()` - converter for a NATIVE path (fs, `path.*`, git output): converts only where the host separator is a backslash (win32); on POSIX a backslash is a filename character and is kept
- `toForwardSlashAnyPlatform()` - converter for AUTHOR-WRITTEN text (hrefs, globs, config values, CLI arguments, archive entry names): converts every backslash on every host. Never for a path read from disk — on POSIX it would turn the one file `docs/x\y.md` into a phantom `docs/x/y.md`
- `toNfc()` - Unicode-NFC normalizer for filename **comparison keys** (see the warning below)
- `toAbsolutePath()` - resolve a path relative to a base directory
- `getRelativePath()` - relative path between two absolute paths
- `isAbsolutePath()` / `isAbsoluteAnyPlatform()` - absolute-path predicates
- `hasParentTraversalSegment()` - detect `..` segments before using a caller-supplied path
- `relativeEscapesRoot()` - classify a root-relative path (`safePath.relative(root, p)`) as escaping the root: `..`, `../x`, or an absolute answer (Windows cross-drive). Lexical, for identities and reports; a sink asks `isUnderRoot()` instead
- `isSingleFsSegment()` - true when a caller-supplied NAME can only ever be one entry directly under whatever it is joined to (no separators, not `.`/`..`, no NUL, no drive spelling). `..cache` passes; `../victim` does not
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
- `isUnderRoot(root, candidate)` - the containment verdict a delete/copy/uninstall sink asks, answered by the filesystem: `'inside'` (a strict descendant, realpath-judged), `'outside'` (including the root itself and any symlink that leaves it), or `'absent'` (nothing there yet, and creating it would land inside). Both sides are canonicalized from their deepest existing ancestor, so a root reached through a symlink still contains its members; a refused path throws rather than reading as absent
- `direntKind(entry)` - what a `Dirent` itself is: `'file' | 'directory' | 'symlink' | 'other'` — the link question asked first, for walks that must not follow (a delete, a size count)
- `direntKindFollowing(dir, entry)` / `direntKindFollowingSync()` - what a `Dirent` resolves to, one `stat` for a link: `'file' | 'directory' | 'dangling' | 'other'` — for walks over a trusted tree where a link is how the entry got there. Both exist because `isFile()` and `isDirectory()` are BOTH false for a symlink, so a walk that tests only those drops every link silently (`local/dirent-type-needs-symlink-check` refuses that shape)
- `fillPathSpellings(requests, fsCache)` - pass 1 of the case-exact existence check: walk each
  `{ referrer, target }` from the deepest directory the two share, listing every directory on the way
  down exactly once. The only I/O in the pair
- `pathSpellingFrom(table, referrer, target)` - pass 2: pure judgement against the table pass 1
  returned, reporting the path as disk spells it when the asked-for spelling differs only by case or
  by Unicode normalization. Fill **once** over the whole set and then judge each reference — a fill
  per reference reinstates the serialized `readdir` this shape removes.
  ⚠️ It judges **every component**, not just the basename: judging only the last one hands each
  directory component back to the host filesystem's own folding, so a link that resolves on
  macOS/APFS 404s on a case-sensitive filesystem — and a basename-only correction still leaves the
  author with a broken path
- `DirectorySpellingIndex` / `spellingWalkRoot(referrer, target)` - the index the pair walks over, and
  the root it walks from, for a caller that cannot enumerate its targets up front
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
- `createTempDir()` / `createTempDirAsync()` / `removeTempDir()` / `tempDirTracker()` - the per-call temp-directory primitives; `removeTempDir` refuses, by name, anything not inside the host tmpdir as the filesystem sees it
- `scratchTmpdirEnv(prefix)` - `{ enter, leave, current }`: make a fresh scratch THE temp directory (`TMPDIR` / `TEMP` / `TMP`) for one test and restore it after — the DESTRUCTIVE-CODE guard for any test that reaches a disposal path, spawned children included. Framework-free: register `enter` / `leave` with the runner's hooks; `registerScratchTmpdir(prefix, { beforeEach, afterEach })` does the registering
- `CANNOT_DENY_READS` / `PERMISSIONS_ENFORCED` - whether a `chmod 000` denies anything on this host (Windows and uid 0 read everything); route through `skip()` so the skip is visible
- `tmpdirFoldsCase()` - whether the OS temp dir's filesystem folds letter case (probed once, not inferred from the platform); gate a case-alias fixture on it
- `NODE_EXECUTABLE` / `gitExecutable()` / `resolveExecutable(name)` / `findExecutable(name)` (`undefined` instead of a throw, for a test that skips without the tool) / `executableCandidates(name, platform, pathext)` - absolute paths for the binaries a fixture spawns: the running node, and `git` found by walking `PATH` once for the first regular executable file (`PATHEXT` names on Windows) and cached. A fixture spawns these instead of a bare `'git'` or `'node'`, so no writable directory on `PATH` decides what runs.
- `buildHostileTree(base)` / `hostileTreePerTest(prefix)` / `HOSTILE_NAMES` - the one hostile fixture every sink is tested against: a root with a member, a `..`-named member, a symlink pointing out, one pointing in, a dangling one, an alias link to the root, an unreadable directory, a 200-character name, plus a sibling `victim/secret.txt` outside the root; and the table of names (`../victim`, `..`, `.`, `''`, `/victim`, `C:\victim`, a NUL byte, …) a sink must refuse. Fields the host cannot build are `null`
- `installFaultFs({ within, faults, rewrites })` / `injectedErrnoError()` - an in-process fs fault injector: patches `node:fs`, `fs.promises` and `FileHandle.prototype` (then `syncBuiltinESMExports`) so a named import, node-tar, adm-zip and write streams are all reached; fails the nth matching call under `within` with a chosen errno (`ENOSPC`, `EACCES`, ...) and can rewrite `stat` results (`ino: 0`, case aliasing). Install BEFORE opening a handle; `cpSync` and native recursive `rmSync` can be failed as a call but not per file inside. `await session.settled()` before `restore()`: a caller's promise can settle while fs work it started goes on (Node's `rm` rejects on its first failed child and leaves the siblings running), and that work would otherwise run under the next session
- `INJECTED_ERRNOS` - every errno the injector can raise; each has a class in the fs-fault table (a unit test pins it).
- `faultRuleOf(spec)` / `faultFsSpecOf(json)` and `dist/testing/fault-fs-preload.js` - the injector for a SPAWNED process: `node --import <utils>/dist/testing/fault-fs-preload.js <bin> ...` reads `VAT_FAULT_FS` (`{"within", "faults": [{"family", "op", "pathIncludes", "nth", "errno"}]}`) and installs those faults before the program loads; a spec matches a path by substring, since a predicate cannot cross a process boundary. The preload is never re-exported from `./testing` (importing it IS the installation)
- `snapshotTree(root, { rewrites, keyPrefix })` / `diffSnapshots(a, b)` / `subtree(s, prefix)` - a comparable picture of a directory tree (kind, mode, sha256, link target) and a diff that names every difference; never follows a link, never opens a special file, fails loudly on an unreadable directory. `rewrites` normalise text (a per-case root, a timestamp) or, with `rewriteBytes`, a binary file (an archive's entry times) before hashing so two runs in different roots compare equal
- `getTestOutputDir()` / `getTestOutputBase()` - isolated test output paths
- `symlinkCapability()` - probes once (memoized per process) whether this host can create symlinks (Windows needs Developer Mode or `SeCreateSymbolicLinkPrivilege`), returning a `SymlinkCapability` token or `null`
- `createSymlink()` / `createSymlinkAsync()` - the sanctioned way to create a symlink in test code; both require a `SymlinkCapability` from `symlinkCapability()`, so a test cannot reach the raw syscall without first proving the host supports it (or explicitly skipping via vitest's `skip()`)

### Project roots — `@vibe-agent-toolkit/utils` (barrel only)

- `findProjectRoot()` - the VAT project root: nearest `vibe-agent-toolkit.config.yaml`, else nearest `.git/`, else `null`
- `findConfigFile()` / `findNodeWorkspaceRoot()` - the narrower individual probes
- `resetProjectRootCaches()` - invalidate the module-level walk-up cache (long-lived processes and tests that mutate fixtures)

These are CLI-boundary functions: inner libraries should take a root as a parameter rather than discovering one. They return `string | null` with no internal fallback, so a caller with no root has to decide one rather than silently landing on an absolute path.

**These four are VAT-shaped — read this before reaching for them.** `findProjectRoot()` looks for `vibe-agent-toolkit.config.yaml` and then `.git/`; if your repo's notion of "root" is a `pnpm-workspace.yaml`, a `turbo.json`, or a lockfile, that ladder is not your ladder — and for a *published* package, keying anything on `.git/` is a bug, since it will not be there at install time. `findNodeWorkspaceRoot()` is narrower still: it needs a `package.json` carrying a `"workspaces"` key, which pnpm and Bun workspaces do not have. `findConfigFile()` hardcodes VAT's config filename. If you want a git root, take `gitFindRoot()` from [`./git`](#git--vibe-agent-toolkitutilsgit); if you want your own marker, a six-line walk-up is more honest than a helper whose ladder you have to work around.

They are nonetheless on their own [`./project`](#import-narrowly) entry rather than the barrel alone. The entry was briefly withdrawn on the grounds that the functions fit few repos — which is true, and is what the paragraph above says — but that answered the wrong question. What decides whether an *entry* exists is how heavy the only remaining door is, and barrel-only these four once cost five third-party packages to reach while their own code imports nothing but `node:fs` and `node:path`. Publishing the entry is not a claim that the ladder fits you — only that finding out shouldn't cost a dependency graph. The barrel is dependency-free now, which is that same rule applied everywhere rather than a reason to fold `./project` back in.

### Ordered and bounded async iteration — `@vibe-agent-toolkit/utils` (barrel only)

- `forEachInOrder(items, fn)` / `mapInOrder(items, fn)` - run `fn` one item at a time, each call starting after the previous settles; the first rejection stops the run and later items never start. For when order is the contract: ordered writes, first-refusal-wins errors, a shared memo or sink, a report whose order is its meaning.
- `everyInOrder(items, fn)` - `Array#every`, in order and awaited: stops at the first `false`. The idiom for a loop that used to `break`.
- `mapWithConcurrency(items, fn, limit = FS_CONCURRENCY)` - `Promise.all`-shaped with at most `limit` calls in flight, results in input order. For independent work over a population-sized list, where a bare `Promise.all` would open a descriptor per item.
- `mapConcurrentFailingInOrder(items, fn)` - `mapWithConcurrency`, but every call settles and the rejection of the EARLIEST item by position is rethrown — the error a sequential loop would have raised, for independent read-only work.
- `promised(work)` - `work()` as a promise: its value resolves, a synchronous throw rejects. `Promise.try` for a Promise-shaped API over a synchronous body, until the Node floor has it.

These replace `await` inside a loop, which the repo's ESLint config refuses (`no-await-in-loop`, mirroring Sonar S9382). None is written with `async` or a loop.

### Errors — `@vibe-agent-toolkit/utils` (barrel only)

- `VatError` - the base of every error VAT throws on purpose: `new VatError(code, message, { cause })`. `code` is a stable `SCREAMING_SNAKE` identity a catch block dispatches on; `name` is taken from the subclass.
- `isVatError(error, code?)` - the dispatch predicate. Reads a `Symbol.for('vat.error')` brand plus `code`, never the prototype chain, so a `dist` copy of a class still matches a `src` instance. A foreign error carrying a `code` (every `node:fs` errno) answers `false`.
- `fsFaultOf(error)` / `classifyFsFault(error, { side, action, origin?, shapeFromSource? })` / `withFsFault` / `withFsFaultSync` / `fsBoundary(roots)` - the one errno classifier. `fsFaultOf` walks `cause` (bounded) and answers `{ errno, faultClass, path, dest, syscall }` for a filesystem errno, `undefined` for anything else. `classifyFsFault` returns an `FsFaultError` (code `FS_FAULT`, with `side`, `faultClass`, `errno`, `path`, `origin`, `action`) and passes a non-fs error or an existing `VatError` through untouched. Classes: `absent`, `refused`, `exhausted`, `wrong-type`, `occupied`, `busy`, `unsupported` (EROFS included), `device`. `fsBoundary({ source, destination, environment })` decides the side from the path the OS named, not from the wrapper; `shapeFromSource` attributes a layout fault (`isLayoutFault`: the `wrong-type` and `occupied` classes, and `ENOTDIR` — a file in the way) of a write whose layout an input decided to `source`; every other fault keeps its side. The side x class -> refusal table lives in `schema`, not here. `isFsFaultError(error)` dispatches by brand.
- `requireConfirmedAbsent(entry, absentError, ctx, { follows })` - believe a probe's "nothing there" (`ENOENT` / `ENOTDIR`) only when the parent's listing agrees: an entry it lists (a link excepted only for a probe that `follows` links, which sees through to a missing target; never for an `lstat`) means the probe's answer was a fault, thrown classified on `ctx`; a parent that cannot be listed throws too. A registry read or a destination probe must never read a refused entry as empty or free.
- `pathPresent(path, mode, side, absence)` - the one presence predicate: `false` only for an absence (the classifier's `absent` class); every other errno is thrown as an `FsFaultError` on `side` (origin `content`). Both choices are the caller's and neither has a default. `mode`: `'entry'` (`lstat`: a dangling link is there — ask before writing) or `'follow'` (`stat`: a dangling link is absent — ask before reading). `absence`: `'confirmed'` (believed only once the parent's listing agrees, via `requireConfirmedAbsent`; a contradicted one is thrown — for a place about to be written, the run's own output, or a part of a package whose absence means "go on without it") or `'probe'` (the probe's word — for a caller that refuses or skips an absent path in its own words). Replaces `existsSync`, which answers `false` for an `EACCES` parent too (`local/no-existssync`).
- `isCapacityFault({ faultClass })` - whether a fault is the machine or the filesystem giving out (`exhausted`, `busy`, `unsupported`, `device`): never the input's content or layout, and the one to report first among several failures of one operation (an archive extraction whose entries fail after the disk filled). `fsBoundary(...).classify(error, action, fallback)` classifies an error already caught, for a catch that must first decide whether it is a filesystem fault at all.
- `isLayoutFault({ faultClass, errno })` / `isFileInTheWayError(error)` - whether a write's fault is one an input's layout decided (the only kind `shapeFromSource` moves to `source`), for a consumer judging a promoted fault, such as the CLI fault matrix's I8; `ENOTDIR` alone, a file in the way.
- `FS_SIDES` / `SOURCE_ORIGINS` - every `FsSide` (`source`, `destination`, `environment`) and every `SourceOrigin` (`argument`, `config`, `content`), as `const` tuples the two types derive from: for a consumer that keys a table by them, such as the schema refusal table's drift test.
- `FS_FAULT_ERRNOS_BY_CLASS` - the classifier's own table, class to errnos: what a check of anything that lists them (the docs' errno table) reads, so it is the same on every host — `os.constants.errno` is the HOST's list (Windows has no `EDQUOT` or `ESTALE`).
- Single-errno questions, the only home of an errno literal: `isPathAbsentError`, `isNoSuchEntryError` (`ENOENT` alone, for a site where a path component that is a file must stay loud), `isAlreadyExistsError`, `isLinkLoopError`, `isInvalidArgumentError`, `isNotARegularFileError`, `isWouldBlockError`, `isTimedOutError` (`ETIMEDOUT`: a spawn given a `timeout` ran out of time), `isProcessGoneError`, `isSymlinkUnsupportedError`, `isRenameContentionError` (`EPERM`/`EBUSY`/`EACCES`: a rename racing a scanner). Whether an error is a filesystem fault at all is `fsFaultOf(e) !== undefined`.
- `prefixMessageOnce(error, prefix)` - prefix a message in place, once per error object — for a seam a retried item passes through more than once, without re-reading the message to find out.
- `PathEscapesRootError` (on `./path` too) - what `safePath.joinUnderRoot` throws; recognise it with `isVatError(error, PathEscapesRootError.code)`.

Never dispatch on `error.message` — the repo's ESLint config refuses `.message.includes(…)` and friends under `packages/*/src`. Prose is for humans and changes when it is improved; a code changes only when the meaning does.

### Entry identity — `@vibe-agent-toolkit/utils` (barrel only)

- `sameEntry(a, b)` - `'same' | 'different' | 'unknown'`: are two paths ONE entry on disk (case aliasing on APFS/NTFS, a link and its target, two links to one target)? Judged by a `bigint` `lstat` `dev:ino` (plus a link's target `stat`), or by an NFC-lowercased real path where the filesystem reports `ino` 0. An entry the OS refuses to examine is `unknown`, never `different`; an absent entry is `different`.
- `isInsideByIdentity(child, ancestor)` - `'inside' | 'outside' | 'unknown'`: does some directory above `child` (which need not exist) answer `sameEntry` to `ancestor`? Strict: an entry is not inside itself.
- `entryIdentities(entry, side)` - the `Identity[]` an entry answers to (`{ id }` or `{ foldedRealPath }`; `[]` when absent). Throws an `FsFaultError` on the `side` the caller names (`FsSide`) when the OS refuses to examine the entry.

### Readable-tree proof and copy — `@vibe-agent-toolkit/utils` (barrel only)

One walk serves both, so the proof and the copy can never disagree. Its options (`TreeWalkOptions`): `links` (`LinkPolicy`) — `'follow-contained'` takes a link as what it points at, inside the root only (a link out throws `CopyLinkEscapesSourceError`, `COPY_LINK_ESCAPES_SOURCE`; a link back into the walk throws `DirectoryWalkRevisitedError`, `DIRECTORY_WALK_REVISITED`), `'preserve'` keeps a link as a link and never examines its target — and an optional `filter(relative)` whose excluded entries are never stat'ed, opened or listed. The one special-file policy: a named pipe, socket or device (or a link to one, or one swapped in after the listing — each file is judged by `fstat` on the handle that is then read) is refused unopened as an `FsFaultError` of class `wrong-type` (`EFTYPE`).

- `proveTreeReadable(root, { links, filter?, side })` - before a verb writes anything, list every directory and open every file of the directory it is about to read (a root that is not a directory is refused by its listing, `ENOTDIR`, as `copyTree` refuses it); the first refusal, in listing order, is an `FsFaultError` on the `side` the caller names (`ProveTreeReadableOptions`), origin `content`, naming the entry.
- `copyTree(source, root, relative, { links, filter?, side, onto })` - copy the directory `source` to `relative` under `root` (`''`: onto `root` itself) by that walk, each file from the handle the walk judged, with its mode; each directory gets its source's mode `| 0o700`, so a read-only source never becomes a copy nothing can fill or remove. Takes the proof's options (`ProveTreeReadableOptions`): a read the OS refuses is a classified fault on the `side` the caller names, as the proof's are; a write failure is the raw errno, for the caller's boundary to classify. `root` is a directory the caller made or its user named: made with its parents when absent, adopted when a real directory, and `EEXIST` when a link (to a directory included) or a file stands AT it; what is ABOVE it is the caller's and is followed, unexamined. Every directory between `root` and the copy must be a real one (made when absent): a link or a file there is a `source` fault (`occupied`) naming it. So a copy INTO a tree that holds copied content — links kept — names that tree's root, and is then never made through one of them.
- `copyRegularFile(source, root, relative, { side, reading, existing, writing })` - copy ONE regular file to `relative` under `root`, as `copyTree` copies one: opened without blocking and judged by `fstat` on that handle (a special file refused unread), its bytes from that handle, its mode kept. The copy is made as `writeFileUnder` makes a file, through the same code: real directories only (made when absent), an exclusive create, bytes and mode set on that handle — never through a link; `existing` decides a regular file already there. A refused read is a classified fault on `side` (origin `content`) whose action reads `read <reading>`; an entry in the copy's way is a `source` fault (`occupied`) naming it; any other write failure is the raw errno. The one single-file copy (`copyFile` is banned by `local/no-destructive-fs`).
- `readRegularFile(path)` - a file's bytes through a handle opened without blocking: `EFTYPE` for a special file, `EISDIR` for a directory, raw for the caller to classify.
- `FollowedWalk` - the cycle guard every other following walk holds, built with the side its tree is on (`new FollowedWalk(side)`; a refused realpath in `enter` is an `FsFaultError` there): `enter(dir)` on the root and each directory recursed into; a directory reached again under a second spelling (a link back into the tree) throws `DirectoryWalkRevisitedError` instead of recursing until the path length runs out.

### Tree changes: plan, then apply — `@vibe-agent-toolkit/utils` (barrel only)

Every recursive remove, rename or copy of a destination goes through these two calls. A verb describes what it wants as `TreeChange`s — `replace` (a `TreeFill`: `copy` from a source with a link policy and filter, `write` into the empty staged directory with its declared `reads`, or `link` to a target), `replace-file` (its `FileContents`: bytes, or a function called when the file is staged — after every earlier change of the plan has staged, so an archive of a tree the plan stages is a change of that plan) or `remove` (with an optional `keepIfSameAs`) — each with an `Ownership` of what is there (`must-be-free`, `force`, `vat-made` with a `recognise` returning an `OwnershipVerdict`, `vat-state`) and a `label`.

- `planTreeChanges(changes)` - takes every destination in its canonical spelling (`safePath.resolve`) and decides every change with no side effect, into a `TreePlan` of `PlannedChange`s (`existing`: `EntryKind`; `action`: `PlannedAction` — `create`, `replace`, `remove`, `keep` or `subsumed`, with a `reason`). A remove aliased (by `sameEntry`, never by name) to a replace or an earlier remove, or inside another change's destination, is `subsumed`; a remove whose `keepIfSameAs` names an entry `same` or `unknown` to it is kept, and so is every remove that holds (or cannot be proven not to hold) a kept entry. A destination whose `lstat` answers absent is believed only when its parent's listing agrees (`requireConfirmedAbsent`). Any other two active changes over one tree are refused `TREE_DESTS_OVERLAP` — the calling verb's defect (by identity; by spelling where the outer destination is absent). `unknown` identity is never a refusal (an `ino`-0 filesystem answers it for every pair). Refusals, coded: `TREE_DEST_OCCUPIED` (`must-be-free` over anything but an empty directory), `TREE_DEST_NOT_OWNED` (`vat-made` disowned, with the recogniser's reason), `TREE_DEST_HOLDS_SOURCE` / `TREE_SOURCE_HOLDS_DEST` (a copy source, or a `write` fill's `reads`, that is or lies inside the destination, or holds it). Every `copy` source is proven readable on the fill's declared `side` (required: an input, VAT's staging, or a copy already in user state). `plan.describe()` is the dry run: one `<action> <label> <dest> [(reason)]` line per change.
- `applyTreePlan(plan, { afterSwap? })` - stage every new entry beside its destination, park every previous one (`.<base>.vat-staged-<random>.previous`), swap, run `afterSwap`, then remove what was parked. A failure before finalize rolls back so every destination is byte-equal to before (a case-aliased directory back under its on-disk spelling); a parked entry is never deleted on a failure path, and one that cannot be put back makes the error `TREE_ROLLBACK_INCOMPLETE` — `TreeRollbackIncompleteError` (`cause`: the failure; `parked`: where each is; `stranded`: each `TreeRollbackStranded` destination), the one shape of that code, which a caller undoing its own `afterSwap` writes throws too. The primitive's own faults are `FsFaultError`s on side `destination` (a copy source's read stays `source`); a `write` fill's raw errno is `destination` only when it names a path under the destination's parent — an input the callback read is rethrown raw, for the verb's boundary. A thrown failure is never mutated: what a failure path could not clean up (a staged entry, a parent it made, a replaced tree beside a failed remove) is recorded beside it — `suppressedFaultsOf`. A parked replaced tree that cannot be removed is a `TreeChangeWarning` coded `TREE_CLEANUP_INCOMPLETE` in `ApplyResult.warnings`; for a `remove` it is a thrown `destination` fault naming the parked path. Removal makes a read-only tree owner-writable first.
- `applyTreePlanOrLeftover(plan, { afterSwap? })` - `applyTreePlan` for a verb that reports a change it finished even when what it parked could not then be deleted (an uninstall, a clear): a failure before the commit (every swap made, `afterSwap` run) rolled back and is thrown; one after it is returned as `ApplyOutcome.leftover` (a `destination` fault naming the parked entry), never thrown.
- `renameFileAtomic(from, to)` - one rename (a file or a tree); under win32 `EPERM` / `EBUSY` / `EACCES` is retried up to 6 tries, backoff 50·2ⁿ ms. Raw errno out.
- `writeFileUnder(root, relative, contents, { existing, writing })` - write a file VAT composes into a tree it is building (one whose source may have shipped links) without ever writing over or through what is there: each directory component must be a real directory, the file is created exclusively; `existing: 'replace'` removes a regular file of that name first (remove, then create — not one step: a create that then fails leaves no file, and its raw errno), a link or directory always refuses (`FsFaultError`, side `source`, origin `content`, class `occupied`, naming the entry). `copyRegularFile` is built on it.
- `makeDirectoryUnder(root, relative, writing)` - the directory half of `writeFileUnder`: make `relative` under a tree VAT is building, component by component, adopting real directories and refusing a link or file standing where one goes (a recursive `mkdir` would follow the link out of the tree).
- `requireTestScratch(root, what)` / `TEST_USER_STATE_UNDER` - the fail-closed guard every resolver of user state under the home directory passes its root through: throws when a test process named the tree user state may be in (the shared vitest setup does, in every tier) and `root` is outside it. Unset, it does nothing.
- `replaceFile(dest, contents)` - write a temp beside `dest`, then `renameFileAtomic` over it: a failed write leaves `dest` byte-equal. Keeps the file's mode, and refuses a file a write in place would be refused on (a read-only one) before writing anything — the rename alone would replace it; writes through a link, which stays a link. Raw errno out.
- `withTempDir(prefix, work)` / `disposeTempDir(dir)` - a fresh directory under `normalizedTmpdir()`, always disposed of; the work's error is rethrown unchanged, a disposal failure recorded beside it (`suppressedFaultsOf`). When the work SUCCEEDED nothing is thrown: it returns `TempDirOutcome { value, leftover }` — `leftover` required, `undefined` when the directory went, else the `environment` fault naming the directory, for the verb to report as the one `TREE_CLEANUP_INCOMPLETE` warning beside its finished work. `disposeTempDir` answers `undefined` when gone, else that same leftover fault — and refuses (`TEMP_DIR_OUTSIDE_TMPDIR`, a defect, nothing touched) any directory not strictly under the temp directory, since it makes a read-only tree writable before deleting it.
- `disposeTempDirAfterFailure(dir, failure)` - for a temp directory handed back on success and removed only when the work failed: disposes of it and records a disposal fault beside `failure` (`suppressedFaultsOf`), never thrown in its place; the same `TEMP_DIR_OUTSIDE_TMPDIR` refusal as `disposeTempDir`.
- `recordSuppressedFault(error, fault)` - record `fault` (a leftover found while `error` was being handled) beside `error`, off its cause chain, for `suppressedFaultsOf` to read back; a thrown non-object gets a `process.emitWarning` instead.
- `suppressedFaultsOf(error)` - the faults recorded against a thrown error, and against every error on its cause chain (bounded, cycle-safe), while each was being handled — a leftover the failure path could not remove — so a wrapper thrown in the failure's place (a rollback-incomplete error, a verb's re-wrap) still carries them. Recorded beside the error, never on its cause chain, so never its classification; a thrown non-object gets a `process.emitWarning` instead. The CLI publishes each as a `TREE_CLEANUP_INCOMPLETE` warning naming the leftover.
- `isTreeChangeResidue(name)` - whether a directory entry is the primitive's own staged, parked or discarded entry, which a listing beside a destination must skip.
- `isParkedTreeEntry(name)` - whether a directory entry is a parked previous entry (`….vat-staged-<random>.previous`): the residue a sweep may remove, since a staged entry may be another process's change in flight.

### Directory crawling — `@vibe-agent-toolkit/utils/crawl`

- `crawlDirectory()` / `crawlDirectorySync()` - gitignore-aware directory walks
- `NEVER_CRAWL_GLOBS` / `BUILD_OUTPUT_GLOBS` - the standard exclusion sets
- `UnreadablePolicy` - the REQUIRED `unreadable` option on every crawl (and on `gitLsFiles` /
  `gitLsOthers` under `./git`): `{ refuse: { root, remedy, side } }` throws `DirectoryListingRefusedError`
  with an adopter-facing, root-relative sentence when a directory cannot be listed — coded `FS_FAULT`
  and carrying the classified fault (on `side`) as its `cause`. A crawl's required `outputs` — the trees
  the calling verb writes, `[]` for none — is the one declaration of which side a fault is on: a
  directory that is an output, lies inside one or holds one (the base of a project a build writes
  into included) is the destination's, any other is on `side` (`settleCrawlRefusal`, for a caller
  that settles a crawl's refusals itself; `onCrawlOutput(path, outputs)`, for a verb that reads a tree
  it may itself have written earlier in the run — `vat build`'s plugin phase reading `dist/skills` —
  and must ask the same declaration which side that tree is on);
  `{ degrade: (refusal) => … }` keeps walking and hands the gap to you to report. There is no
  default — a shorter list nothing can tell from a complete one is the failure this option exists
  to prevent, so the caller states which answer is honest for its lane, and an omitted policy is
  refused up front by name.
- `rootListingRefusal(error, dir)` - for a caller that asks whether a scan ROOT exists before
  walking it: the `DirectoryRefusal` a failed `stat`/`readdir` of `dir` stands for, or `undefined`
  when it is simply absent (`ENOENT`/`ENOTDIR`) — never `existsSync`, which calls an untraversable
  parent absent.

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

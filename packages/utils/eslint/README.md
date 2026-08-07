# `@vibe-agent-toolkit/utils/eslint`

ESLint rules that enforce the cross-platform and agentic-code safety helpers in the rest of [`@vibe-agent-toolkit/utils`](https://www.npmjs.com/package/@vibe-agent-toolkit/utils).

Twenty-one rules, all of them derived from a bug that actually shipped: `os.tmpdir()` returning an 8.3 short path on a Windows CI runner, `path.join()` producing backslashes that then failed a string comparison, `await import(absolutePath)` throwing on Windows without a `file://` URL, `execSync()` interpolating a caller-controlled string into a shell. Most auto-fix.

## Installation

```bash
bun add @vibe-agent-toolkit/utils
```

There is no separate plugin package: the rules are a subpath of the package whose helpers they enforce, so the two can never drift to different versions. Requires ESLint 9+ (flat config) and Node >= 22.

`eslint` is an **optional** peer dependency, and this subpath adds no dependency to the others. An ESLint plugin is data, not code that runs — every rule module here exports a plain object and none of them `require('eslint')` — so installing `utils` for `safePath.join()` alone pulls in nothing extra and warns about nothing.

## Usage

```js
// eslint.config.js
import vat from '@vibe-agent-toolkit/utils/eslint';

export default [
  vat.configs.recommended,
];
```

`configs.recommended` registers the plugin under the `@vibe-agent-toolkit` namespace and enables the **cross-platform safety core** — 18 of the 21 rules, most at `error` and three at `warn` (see [Severities](#severities)). The other three are opt-in; the [rule tables](#rules) mark each rule's `recommended` severity, and `—` means not in `recommended`.

To pick rules yourself, register the plugin and name them:

```js
import vat from '@vibe-agent-toolkit/utils/eslint';

export default [
  {
    files: ['**/*.{ts,tsx,js,cjs,mjs}'],
    plugins: { '@vibe-agent-toolkit': vat },
    rules: {
      '@vibe-agent-toolkit/no-path-join': 'error',
      '@vibe-agent-toolkit/no-os-tmpdir': 'error',
    },
  },
];
```

### Exempting the file that implements the wrapper

A rule that bans `os.tmpdir()` has to let *something* call it — the file that implements your `normalizedTmpdir()`. That file's path is a fact about your repo, so the plugin ships **no** built-in exemptions; you declare them:

```js
'@vibe-agent-toolkit/no-os-tmpdir': ['error', { exemptFiles: ['src/paths.ts'] }],
'@vibe-agent-toolkit/no-path-join': ['error', { exemptFiles: [
  'src/paths.ts',
  'test/paths.test.ts',   // asserts the platform-native behavior the wrapper hides
] }],
```

Paths are repo-relative and matched at a **path-segment boundary**, never as a substring: declaring `src/paths.ts` does not exempt `tools/hooks/paths.ts`, `src/my-paths.ts`, or `src/paths.ts.bak`. (It used to be a substring check. A private `tools/hooks/path-utils.ts` full of raw `tmpdir()` calls linted clean for months.) Matching is separator-agnostic, so the same list works on Windows.

The match is anchored at the **end** of the path, so a declaration is a suffix: `src/paths.ts` also exempts `packages/anything/src/paths.ts`. Name enough leading segments to be unambiguous in your tree (this repo declares `packages/utils/src/path-utils.ts`, not `path-utils.ts`).

The option **replaces** any default rather than merging with it, and unknown option keys are a config error — a typo'd `exemptFile` must fail loudly rather than quietly exempt nothing.

The rules taking `exemptFiles` are `no-path-join`, `no-path-resolve`, `no-path-relative`, `no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync`, `no-child-process-execSync`, and `no-fs-promises-cp`.

## Rules

The "use instead" column names the `@vibe-agent-toolkit/utils` subpath the replacement lives on; ✓ marks an auto-fix. The **`recommended`** column is the severity `configs.recommended` assigns — `—` means the rule is **not** in `recommended` and must be enabled explicitly.

### Path handling

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-path-join` | `path.join()` | `safePath.join()` | `/path` | ✓ | `warn` |
| `no-path-resolve` | `path.resolve()` | `safePath.resolve()` | `/path` | ✓ | `warn` |
| `no-path-relative` | `path.relative()` | `safePath.relative()` | `/path` | ✓ | `warn` |
| `no-path-startswith` | `path.startsWith()` on a raw path | `toForwardSlash()` first | `/path` | | `error` |
| `no-hardcoded-path-split` | `split('/')` / `split('\\')` on a path | `path.basename()`, or `toForwardSlash()` first | `/path` | | `error` |
| `no-path-sep-in-strings` | `path.sep` embedded in a string literal | `toForwardSlash()` | `/path` | | `error` |
| `no-manual-path-normalize` | hand-rolled `.replace(/\\/g, '/')` | `toForwardSlash()` | `/path` | ✓ | `error` |
| `no-path-operations-in-comparisons` | raw `path.*()` results in string comparisons | wrap in `toForwardSlash()` | `/path` | | `error` |
| `no-unsafe-root-join` | `safePath.join(someRoot, x)` where `x` can escape | `safePath.joinUnderRoot()` | `/path` | | — |

### Filesystem and process

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-os-tmpdir` | `os.tmpdir()` (8.3 short names on Windows) | `normalizedTmpdir()` | `/fs` | ✓ | `error` |
| `no-fs-realpathSync` | `fs.realpathSync()` | `normalizePath()` | `/fs` | ✓ | `error` |
| `no-fs-mkdirSync` | `fs.mkdirSync()` | `mkdirSyncReal()` | `/fs` | ✓ | `error` |
| `no-fs-promises-cp` | `cp()` from `node:fs/promises` (drops nested files on Node 22) | `cpSync()` from `node:fs` | — | ✓ | `error` |
| `no-child-process-execSync` | `child_process.execSync()` | `safeExecSync()` | `/process` | ✓ | `error` |
| `no-unix-shell-commands` | `tar`, `grep`, `rm`, `echo`, … spawned directly | Node APIs, or a portable script fixture | — | | `error` |

### URLs and dynamic imports

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-url-pathname-for-fs` | `new URL(x, import.meta.url).pathname` as a filesystem path | `resolveFromImportMeta()` / `fileURLToPath()` | `/fs` | | `error` |
| `no-bare-dynamic-import-path` | `await import(absolutePath)` | `dynamicImportPath()` / `pathToFileURL(p).href` | `/fs` | | `error` |
| `no-file-url-string-concat` | `` `file://${p}` `` | `pathToFileURL(p).href` | — | | `error` |

### Code and test hygiene

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `prefer-startswith-over-regex` | `/^foo/.test(s)` | `s.startsWith('foo')` | — | | `error` |
| `no-test-scoped-functions` | helper functions declared inside `describe`/`it` | module scope | — | | — |
| `require-justified-skip` | unannotated `it.skip`/`it.todo`, tautological assertions, empty test bodies | a `SKIP(#123): reason` annotation, or a real assertion | — | | — |

### What `recommended` deliberately leaves out

Three rules ship without riding in `recommended`, for two different reasons.

**Test-style opinions** — `no-test-scoped-functions` (where a helper may be declared) and `require-justified-skip` (the annotation grammar for a disabled test). Neither is a portability or correctness fact, and installing this package for `safePath.join()` should not also import someone else's test conventions. Both are worth turning on deliberately.

**Unsound, pending a rewrite** — `no-unsafe-root-join`. It keys on whether an identifier's *name* ends in `root` rather than on whether any segment is caller-controlled, which makes it noisy and blind at the same time. Measured against 4,670 files of real adopter source: 108 findings, none autofixable. Verified behaviour:

```js
safePath.join(repoRoot, 'docs', 'product')  // FIRES — all literals, nothing can escape
safePath.resolve(packageRoot, '..', '..')   // FIRES — escaping is the intent; the fix breaks it
safePath.join(repoRoot)                     // FIRES — one argument, no segment at all
safePath.join(base, userInput)              // SILENT — the shape it exists to catch
```

A rule that misses its own target does not belong in a config named `recommended` at any severity: a safety core that cries wolf teaches people to ignore it, and that costs you the true positives too. It still ships, and it still earns `error` when scoped to directories where a path escape is a security boundary — which is how this repo uses it, on its skill-test staging code. It will return to `recommended` when it keys on taint rather than on naming.

Enable any of the three by naming it:

```js
import vat from '@vibe-agent-toolkit/utils/eslint';

export default [
  vat.configs.recommended,
  {
    rules: {
      '@vibe-agent-toolkit/no-test-scoped-functions': 'error',
      '@vibe-agent-toolkit/require-justified-skip': 'error',
    },
  },
  {
    // Scope it to where an escape is a security boundary, not repo-wide.
    files: ['src/staging/**/*.ts'],
    rules: { '@vibe-agent-toolkit/no-unsafe-root-join': 'error' },
  },
];
```

### Severities

Within `recommended`, `error` is the default; three rules are `warn`:

- **`no-path-join`, `no-path-resolve`, `no-path-relative`** — by far the highest-churn rules; they fire on every raw `node:path` call in an existing codebase. Measured on a 4,670-file adopter tree: 3,963 + 372 + 1 findings, **every one of them autofixable**. `warn` lets a project run `--fix` and burn the list down incrementally instead of blocking CI on day one.

Raise all three to `error` once the backlog is clear. That is what this repo does.

The criterion for `warn` is **migration volume**, not how real the finding is — a rule whose findings we doubted would be out of `recommended` entirely, not demoted. Everything at `error` either prevents a bug or moves a static-analysis finding left of a merge.

## Why custom rules

A cross-platform safety helper is only as good as its enforcement. `safePath.join()` prevents a class of Windows bug precisely once — the moment someone writes `path.join()` instead, the helper's existence has bought nothing. Publishing the API without the lint rule ships half a product: the fix is available, and nothing directs anyone to it.

What these rules buy is *when* you find out. Without them, a raw `os.tmpdir()` is found by a Windows CI job — a different machine, twenty minutes later, on someone else's push, with a failure message about a path that doesn't obviously relate to the line that caused it. With them, it is a red squiggle under the call, on the author's machine, with the replacement named in the message and usually applied by `--fix`. The bug never leaves the editor. That is the whole argument, and it is why the rules are written to name the replacement rather than merely to forbid the primitive.

The second reason is agentic. When most code in a repo is written by an LLM, a convention that lives only in a style guide or a CLAUDE.md gets re-violated constantly — the model is confident, `path.join` is what it saw a million times in training, and the guidance was three thousand tokens back. A lint rule is feedback the model receives at the moment it is wrong, which is the only moment it can act on. Treat rules as the durable form of any convention you'd otherwise repeat in a prompt.

Most projects will want rules the ones here don't cover, for invariants only that project has: a deprecated internal API, a logging call that must carry a request ID, a module boundary nothing may import across. These rules are readable, small, and built on two shared factories plus a segment-anchored path matcher — copy the shape. `eslint-rule-factory.cjs` handles "ban function X from module Y, suggest Z, fix the import"; `exempt-path-matcher.cjs` handles the exemption question every such rule eventually asks, and is worth reading before you write `filename.includes(...)`.

## License

MIT

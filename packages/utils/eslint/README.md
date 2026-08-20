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

`configs.recommended` registers the plugin under the `@vibe-agent-toolkit` namespace and enables the **cross-platform safety core** — 18 of the 22 rules, most at `error` and three at `warn` (see [Severities](#severities)). The other four are opt-in; the [rule tables](#rules) mark each rule's `recommended` severity, and `—` means not in `recommended`.

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

Taken to its limit, a **bare filename with no `/` exempts that filename everywhere in the repo** — including files added later by someone who never read the config. The rules report that as `unanchoredExemptFile` rather than letting it pass, because it is the same repo-wide hole the segment-boundary matching exists to close. `./paths.ts` is the same hole with a slash in it, so the check runs on the normalized entry, not the raw string.

The option **replaces** any default rather than merging with it, and unknown option keys are a config error — a typo'd `exemptFile` must fail loudly rather than quietly exempt nothing.

The rules taking `exemptFiles` are `no-path-join`, `no-path-resolve`, `no-path-relative`, `no-os-tmpdir`, `no-fs-mkdirSync`, `no-fs-realpathSync`, `no-child-process-execSync`, and `no-fs-promises-cp`.

## Rules

The "use instead" column names the `@vibe-agent-toolkit/utils` subpath the replacement lives on; ✓ marks an auto-fix. The **`recommended`** column is the severity `configs.recommended` assigns — `—` means the rule is **not** in `recommended` and must be enabled explicitly.

**The auto-fix writes the import to the subpath in that column**, not to the barrel — `--fix` on a raw `path.join()` inserts `import { safePath } from '@vibe-agent-toolkit/utils/path'`. A file that already reaches the helper through the barrel keeps its existing import and only has the call rewritten: adding a second binding of the same name is a `SyntaxError`, not a redundant import.

### Pointing the fix at your own re-export seam — `safeModule`

If your repo re-exports these helpers through its own module, the defaults above are wrong for you, and not merely stylistically: in a workspace with isolated `node_modules` (pnpm, Yarn PnP), an import of a package the receiving package does not declare **fails to resolve**. One adopter measured 620 files across 52 such packages. Point the rule at the module that resolves where the fix lands:

```js
'@vibe-agent-toolkit/no-path-join':  ['warn',  { safeModule: '@acme/dev-tools/paths' }],
'@vibe-agent-toolkit/no-os-tmpdir':  ['error', { safeModule: '@acme/dev-tools/fs' }],
```

It is **per-rule**, not one shared `settings` key, because a seam need not split its symbols the way this package does — an adopter whose narrow entry carried `normalizedTmpdir()` but not `safePath` needed the two rules pointed at different modules, which a single key cannot express. Note the two lines above therefore name *different* modules. It composes with `exemptFiles`, and it changes the error message as well as the fix, so the advice never names a module you don't use. Every rule that names a module accepts it, including the ones that only advise and never fix.

> **Point each rule at a module that exports the symbol *that rule writes*, not merely one that resolves.** This is the failure mode worth spending a minute on, because it is the quiet one. A `safeModule` that doesn't resolve fails loudly and immediately. A `safeModule` that resolves but lacks the symbol passes every resolution check — including an explicit `import()` probe — and then throws `Cannot read properties of undefined` at each call site, once per fixed file. Aim `no-path-join` at an entry without `safePath` and you get a green `--fix`, a green install, and thousands of latent `TypeError`s. The rules cannot check this for you: verifying it would mean resolving and importing your module from inside the linter, which is neither its job nor reliable from wherever ESLint happens to be running.

Two ways your target can be wrong, which surface differently: `ERR_MODULE_NOT_FOUND` means the receiving package doesn't declare it at all, while `ERR_PACKAGE_PATH_NOT_EXPORTED` means it does — but the version resolved *at that location* doesn't export the subpath. In a monorepo mid-upgrade those differ, so the question is never "does the package declare it" but "does the resolved version there export it."

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

The member-call rules here check the **receiver**, not just the method name, so `env.tmpdir()` on some unrelated object is not a finding — and the namespace they check for can be bound by a static `import * as os`, by `const os = require('node:os')`, or by `const os = await import('node:os')`. The fix replaces the whole callee (`os.tmpdir()` → `normalizedTmpdir()`), which is correct however the binding was made. Matching the method name alone was the earlier behaviour and it produced `os.normalizedTmpdir()` — a method that does not exist, compiles, and throws.

### URLs and dynamic imports

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-url-pathname-for-fs` | `new URL(x, import.meta.url).pathname` as a filesystem path | `resolveFromImportMeta()` / `fileURLToPath()` | `/fs` | | `error` |
| `no-bare-dynamic-import-path` | `await import(absolutePath)` | `dynamicImportPath()` / `pathToFileURL(p).href` | `/fs` | | `error` |
| `no-file-url-string-concat` | `` `file://${p}` `` | `pathToFileURL(p).href` | — | | `error` |

### Content decoding

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-raw-text-decode` | `buf.toString('utf-8')`, `new TextDecoder(…)`, `readFile(p, 'utf-8')` | one project-owned decoding seam | — | | — |

`buf.toString('utf-8')` ignores every byte-order mark and cannot express UTF-16BE at all — Node's `Buffer` has no such encoding. A UTF-16 document therefore decodes to NUL-interleaved mojibake, and whatever sniffs for binary content downstream believes it. PowerShell 5.1's `Out-File` and `>` write UTF-16LE by default, so this is a Windows-authored file, not an exotic one.

This rule has no wrapper to point at, because the seam is yours: write one decoder, name it with `safeModule`, and exempt its own file with `exemptFiles`. Put the decoder at the **bottom** of your dependency arrow — a seam in a leaf package cannot be imported by the primitive packages the rule also lints, and those files would then have no legal way to comply.

**Not every `'utf-8'` read is a content read**, and this is the distinction that decides whether the rule survives. Three categories:

1. **A document you did not write** — an adopter's markdown, config, schema, `.gitignore`, `package.json`. The encoding must be **discovered**. This is the rule's target.
2. **An artifact your project wrote** — its own cache entry, its own published asset. The encoding was **chosen at the write**; reading it back the same way is a closed loop.
3. **Bytes that were never a file** — subprocess stdout, an HTTP body, a Buffer you built. The **producer's contract** decides.

Static analysis cannot tell them apart, so the rule reports all three and you settle 2 and 3 at the call site with a one-line `eslint-disable-next-line` that **names the writer or the producer**:

```js
// eslint-disable-next-line @vibe-agent-toolkit/no-raw-text-decode -- subprocess stdout; producer is the credential helper spawned above
const out = result.stdout.toString('utf8');
```

That gives a reviewer a falsifiable test: a justification that cannot name who wrote the bytes is a category-1 call wearing a disable comment. Do not settle these by adding paths to `exemptFiles` — that list is for the seam's own implementation file.

```js
{
  files: ['src/corpus/**/*.ts'],
  rules: {
    '@vibe-agent-toolkit/no-raw-text-decode': ['error', {
      safeModule: '@my-org/resources',
      exemptFiles: ['src/corpus/text-content.ts'],
    }],
  },
}
```

Only a string **literal** encoding triggers it. `buf.toString(enc)` is deliberately not reported: without type information it is indistinguishable from `n.toString(radix)`, and `readFile(p, cb)` from `readFile(p, encoding)`.

### Build correctness

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-self-package-import` | importing the enclosing package by its own name | a relative path to the defining module | — | | — (needs `packageName`) |

A file inside `packages/foo` that writes `import … from '@scope/foo'` resolves out through `node_modules` to its own `package.json`, whose `types` point at `./dist/index.d.ts` — a file the compiler is in the middle of producing. It works only by a TypeScript courtesy: while `dist` **is** the running project's output path, that declaration is recognised as the project's own output and the import is redirected back to `src`, so it resolves with no `dist/` on disk.

Change `outDir` — to a staging directory that makes emit atomic, say — and the redirect is gone, tsc looks for a literal `dist/index.d.ts`, and a tree that has never been built has none:

```
error TS2307: Cannot find module '@scope/foo' or its corresponding type declarations.
```

The knock-on `TS2339`s land wherever a local type extended one of the now-unresolved imports, which is what makes it read as a type bug in code nobody touched.

It is latent by construction, and worse, **it is invisible to any tree that has built before**: a stale `dist/` satisfies the literal lookup, so the build passes by typechecking against the *previous* build's declarations. In a monorepo whose worktrees live inside the main checkout, resolution walks up past the worktree and satisfies it from the *parent checkout's* `dist/`. Both are green locally and red in CI, which is the only genuinely pristine tree. Lint is the only stage that sees it on the author's machine.

### Code and test hygiene

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `prefer-startswith-over-regex` | `/^foo/.test(s)`, `` /^\*glob/.test(s) ``, `const RE = /^foo/; RE.test(s)` | `s.startsWith('foo')` | — | | `error` |
| `no-test-scoped-functions` | helper functions declared inside `describe`/`it` | module scope | — | | — |
| `require-justified-skip` | unannotated `it.skip`/`it.todo`, tautological assertions, empty test bodies | a `SKIP(#123): reason` annotation, or a real assertion | — | | — |

### What `recommended` deliberately leaves out

Five rules ship without riding in `recommended`, for four different reasons.

**Test-style opinions** — `no-test-scoped-functions` (where a helper may be declared) and `require-justified-skip` (the annotation grammar for a disabled test). Neither is a portability or correctness fact, and installing this package for `safePath.join()` should not also import someone else's test conventions. Both are worth turning on deliberately.

**Unsound, pending a rewrite** — `no-unsafe-root-join`. It keys on whether an identifier's *name* ends in `root` rather than on whether any segment is caller-controlled, which makes it noisy and blind at the same time. Measured against 4,670 files of real adopter source: 108 findings, none autofixable. Verified behaviour:

```js
safePath.join(repoRoot, 'docs', 'product')  // FIRES — all literals, nothing can escape
safePath.resolve(packageRoot, '..', '..')   // FIRES — escaping is the intent; the fix breaks it
safePath.join(repoRoot)                     // FIRES — one argument, no segment at all
safePath.join(base, userInput)              // SILENT — the shape it exists to catch
```

A rule that misses its own target does not belong in a config named `recommended` at any severity: a safety core that cries wolf teaches people to ignore it, and that costs you the true positives too. It still ships, and it still earns `error` when scoped to directories where a path escape is a security boundary — which is how this repo uses it, on its skill-test staging code. It will return to `recommended` when it keys on taint rather than on naming.

**No wrapper to point at** — `no-raw-text-decode`. Every other rule in this pack names a replacement this package publishes; this one names a decoding seam that only exists once *you* write it. Shipped in `recommended`, its every message would read "use `decodeTextContent()` from your content-decoding module", which is advice nobody can follow. Turn it on with `safeModule` and `exemptFiles` set, as shown above.

**Needs an option, and only in the directories you compile** — `no-self-package-import`. The import it bans is a genuine build-breaker with no style opinion in it, but the rule cannot discover on its own which package a file is in: reading `package.json` would mean `require('node:fs')`, and every module on this subpath is plain data that requires *nothing* — not `eslint`, not a third-party package, not even a Node builtin. That is what keeps `eslint` an optional peer dependency and lets these rules ship as a subpath of a runtime package rather than as one of their own. So the caller names the package. The caller is a config file, which already runs in full Node and can read every manifest it likes:

```js
import { readFileSync, readdirSync } from 'node:fs';

export default readdirSync('packages').flatMap((dir) => {
  const { name } = JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8'));
  return [{
    files: [`packages/${dir}/src/**/*.ts`],
    rules: { '@vibe-agent-toolkit/no-self-package-import': ['error', { packageName: name }] },
  }];
});
```

Scope it to the sources you **compile**. Test and example trees — normally excluded from the build — import their own package by name **on purpose**, to exercise the public entry point exactly as a consumer does. This repo has ~10 such imports, every one of them correct.

Enable any of the five by naming it:

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
    // Scope it to the code that reads files whose encoding you do not choose.
    files: ['src/corpus/**/*.ts'],
    rules: {
      '@vibe-agent-toolkit/no-raw-text-decode': ['error', {
        safeModule: '@my-org/resources',
        exemptFiles: ['src/corpus/text-content.ts'],
      }],
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

### Running `--fix` over a large backlog

Every rule that rewrites a call *and* edits imports fixes **all** of a file's call sites in a single pass, and `packages/utils/test/eslint/rules.test.ts` holds each of them to that: it runs `--fix` to its fixpoint and then asks `no-undef` whether the result still binds every identifier.

That test exists because the answer used to be no. ESLint merges the fixes one `fix()` yields into a **single range spanning `min..max`**, and applies only non-overlapping ranges per pass — so a fix touching both the import and its own call site spanned everything in between, N call sites produced N nested ranges, and ESLint kept one. The rule then went quiet, because the import specifier its detection keyed on was what had just been removed. `--fix` reached a stable fixpoint over source that no longer compiles and exited clean; you found out at `tsc`. An adopter measured **146 files left with a dangling reference** across one ~4,900-site sweep, worst single file 75 unrewritten calls.

`eslint-disable` interacts with this in a way worth knowing about, because it is not obvious and it took an adversarial run to find. ESLint invokes a rule's `fix()` **before** the disable filter discards the problem, so a suppressed report still consumes any once-per-file edit its rule was holding. Where that edit is an import *insert*, the rules either re-emit it from every report or carry a repair leg that recognises the orphaned call and supplies the missing import on the next pass — so a disabled call site costs an extra pass, not a broken file. Where it is an import *removal*, the removal is latched and simply goes away with the discarded report, leaving an unused import for `no-unused-vars` to point at rather than a call with nothing behind it. `exemptFiles` remains the supported way to opt a whole file out.

Two more things a fixer here will not do: delete a `type`-only, aliased, or re-exported specifier (removing a re-exported one produced output that did not parse), and insert an import *between* a leading `eslint-disable-next-line` and the statement it protects, which would silently revoke the suppression.

#### The binding left behind

`path.join(a, b)` becomes `safePath.join(a, b)`, and when that was the file's last `path.*` reference the `import path from 'node:path'` is left bound to nothing. That is not a dangling reference, so the `no-undef` fixpoint check above is blind to it — and the same adopter measured **536 errors surviving a converged `--fix` across 232 files** (289 `no-unused-vars`, 247 `sonarjs/unused-import`), every one of them this. In a repo gating at `--max-warnings=0`, `--fix` output that does not lint clean is not a finished migration.

So the rules now report it themselves, as a separate `deadUnsafeImport` finding on the import line with its own fix. Being its own finding is the point: it shows up in lint output and you can `eslint-disable` it, rather than a call rewrite quietly taking a declaration with it.

Deliberately narrow:

- **A closed list of modules** — `node:path`, `node:os`, `node:fs`, `node:fs/promises`, `node:child_process` and their bare spellings. All Node builtins, all side-effect-free with certainty decided when the rule was written. This is *not* a general unused-import rule and will not become one; for blanket cleanup, `eslint-plugin-unused-imports` already exists and already autofixes.
- **Only in a file this rule migrated** — the safe symbol must be bound AND the rule's own replacement must actually be called in the file (`safePath.join(…)`, `normalizedTmpdir()`, `toForwardSlash(…)`). "The safe symbol is in scope" alone is not evidence: `safePath` arrives for reasons that have nothing to do with a call this pack consumed, and an import that was dead already — dead before the pack ever ran — was then deleted as though this fixer had orphaned it. A dead import in a file this pack never touched is somebody else's business.
- **Only whole declarations, only with zero references left** — evaluated against the source as it stands on that pass, so the removal always lands *after* the rewrite that consumed the last reference, never speculatively beside it. A partially-dead declaration (`import path, { sep }` with `sep` still live) is left alone, as are bare `import 'node:path'` side-effect imports and anything carrying a `type` specifier.

This cannot be delegated: `@typescript-eslint/no-unused-vars` declares `meta.fixable: 'code'` but emits only a **suggestion** for an unused import, and `--fix` never applies suggestions; `sonarjs/unused-import` declares no fixer at all. Verified with both enabled alongside these rules in one `verifyAndFix` — the import survived. Those rules abstain for a good reason, since removing an import can change behaviour; a rule that *created* the orphan knows it just consumed the last reference and knows the module, so it can act where a generic rule cannot.

## Why custom rules

A cross-platform safety helper is only as good as its enforcement. `safePath.join()` prevents a class of Windows bug precisely once — the moment someone writes `path.join()` instead, the helper's existence has bought nothing. Publishing the API without the lint rule ships half a product: the fix is available, and nothing directs anyone to it.

What these rules buy is *when* you find out. Without them, a raw `os.tmpdir()` is found by a Windows CI job — a different machine, twenty minutes later, on someone else's push, with a failure message about a path that doesn't obviously relate to the line that caused it. With them, it is a red squiggle under the call, on the author's machine, with the replacement named in the message and usually applied by `--fix`. The bug never leaves the editor. That is the whole argument, and it is why the rules are written to name the replacement rather than merely to forbid the primitive.

The second reason is agentic. When most code in a repo is written by an LLM, a convention that lives only in a style guide or a CLAUDE.md gets re-violated constantly — the model is confident, `path.join` is what it saw a million times in training, and the guidance was three thousand tokens back. A lint rule is feedback the model receives at the moment it is wrong, which is the only moment it can act on. Treat rules as the durable form of any convention you'd otherwise repeat in a prompt.

Most projects will want rules the ones here don't cover, for invariants only that project has: a deprecated internal API, a logging call that must carry a request ID, a module boundary nothing may import across. These rules are readable, small, and built on two shared factories plus a segment-anchored path matcher — copy the shape. `eslint-rule-factory.cjs` handles "ban function X from module Y, suggest Z, fix the import"; `exempt-path-matcher.cjs` handles the exemption question every such rule eventually asks, and is worth reading before you write `filename.includes(...)`.

## License

MIT

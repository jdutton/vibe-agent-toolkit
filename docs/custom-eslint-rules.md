# Custom ESLint Rules - Agentic Code Safety Pattern

## Overview

**Critical for AI-Heavy Development**: When working with agentic code (Claude, Cursor, Copilot), AI can easily reintroduce unsafe patterns that were previously fixed. Custom ESLint rules provide automatic guardrails that catch these issues during development.

## The Pattern: Identify → Create Rule → Never Repeat

**When you identify a dangerous pattern that was fixed:**
1. **Document why it's dangerous** (security, cross-platform, performance)
2. **Create a custom ESLint rule** in `packages/utils/eslint/rules/`
3. **The pattern can never be reintroduced** - ESLint catches it automatically

This is "good overkill" - prevents technical debt from accumulating through AI-assisted development.

## Where the rules live

Source: `packages/utils/eslint/rules/`. They **ship** on the
[`@vibe-agent-toolkit/utils/eslint`](../packages/utils/eslint/README.md) subpath — this repo
consumes them by that same public specifier, like any other adopter (root `eslint.config.js` imports
it), so a change here is a change to a public API. That README is the adopter-facing view — what
each rule bans, the remedy, and the reasoning behind every rule that is not in `recommended`; this
doc is the contributor view.

They live inside `utils` rather than in a plugin package of their own because an ESLint plugin is
*data*: every rule module exports a plain object and none of them `require('eslint')`. So the pack
adds nothing to the twelve runtime subpaths, `eslint` can be an **optional** peer dependency, and
the rules can never be installed at a different version from the helpers whose signatures they name.
Anything you add here inherits that contract — `test/eslint/subpath-purity.test.ts` fails the build
on the first `require()` of anything outside `eslint/` from a rule module. (The entry point
`index.cjs` is the one exception: it reads `node:fs` and `node:path` to list the directory, and the
same test pins that to exactly those two builtins.)

Two things follow from being published:

- **No rule may bake in a repo-specific exemption path.** `packages/utils/src/path-utils.ts` is a
  fact about *this* repo; as a default it would be a silent hole at that path in every other one.
  Exemptions are a rule **option** (`{ exemptFiles: [...] }`), and this repo passes its own in
  `eslint.config.js`.
- **The plugin is registered under the `local` namespace here**, not the conventional
  `@vibe-agent-toolkit` one, because every `eslint-disable-next-line local/…` directive in the tree
  is keyed on it — renaming turns each one into a no-op suppression while the tree still lints
  clean. Adopters get `@vibe-agent-toolkit/…` from `configs.recommended`. Flat config lets the
  namespace be any key, so it is a local alias, not part of the published contract. ESLint 9
  defaults `reportUnusedDisableDirectives` to `warn` and this repo lints with `--max-warnings=0`,
  so if the alias ever stops resolving, every such directive surfaces as dead and fails CI rather
  than passing silently. That pair of settings is the mechanism; there is deliberately no count of
  directives written here — the last three counts this paragraph carried were all wrong within
  weeks. `packages/utils/test/eslint/directive-ratchet.test.ts` holds the per-rule ceiling instead.

## The manifest is the directory

There is no list of rules to register in. `index.cjs` lists `eslint/rules/*.cjs` and registers
every module that exports a `meta` object, keyed by its basename; factories and helpers
(`eslint-rule-factory.cjs`, `no-command-direct-factory.cjs`, `exempt-path-matcher.cjs`,
`safe-import.cjs`, `dead-import.cjs`) export no `meta` and are skipped. Each rule declares its own
place in `configs.recommended` and its own row in the table below through `meta.docs`:

| `meta.docs` field | Required | Meaning |
|---|---|---|
| `description` | yes | One sentence; what the rule reports |
| `recommended` | yes | `true` to ride in `configs.recommended` |
| `recommendedSeverity` | when `recommended` | `'error'` or `'warn'` — the severity `recommended` assigns |
| `category` | no | Section of the table (`Path handling`, `Filesystem and process`, …); unknown categories sort last |
| `bans` / `useInstead` / `subpath` | no | The table's columns; `bans` falls back to `description` |

A rule that is not recommended states why in a comment beside its `recommended: false` — that
comment is the durable record, and the README's "What `recommended` deliberately leaves out"
summarises it.

## Current Rules

Generated from `meta.docs` by `bun run generate:eslint-rules-doc` (in `packages/utils`);
`test/eslint/rule-manifest.test.ts` fails when this block drifts from the rules. Edit the rule,
then regenerate — never the table.

<!-- gen:eslint-rules -->
34 rules; 7 auto-fix. `configs.recommended` enables 17 of them (15 at `error`, 2 at `warn`); `—` in the last column means the rule ships but must be enabled by name.

#### Path handling

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-hardcoded-path-split` | `split('/')` / `split('\\')` on a path | `path.basename()`, or `toForwardSlash()` first | `/path` |  | `error` |
| `no-manual-path-normalize` | hand-rolled `.replace(/\\/g, '/')` | `toForwardSlash()` | `/path` | ✓ | `error` |
| `no-path-operations-in-comparisons` | raw `path.*()` results in string comparisons | wrap in `toForwardSlash()` | `/path` |  | `error` |
| `no-path-sep-in-strings` | `path.sep` embedded in a string literal | `toForwardSlash()` | `/path` |  | `error` |
| `no-path-startswith` | `path.startsWith()` on a raw path | `toForwardSlash()` first | `/path` |  | `error` |
| `no-raw-node-path` | `path.join()`, `path.resolve()`, `path.relative()` | `safePath.join()` / `.resolve()` / `.relative()` | `/path` | ✓ | `warn` |
| `no-unsafe-root-join` | `safePath.join(someRoot, x)` where `x` can escape | `safePath.joinUnderRoot()` | `/path` |  | — |

#### Filesystem and process

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-bare-symlink-in-tests` | unguarded `fs.symlinkSync()` / `fs.promises.symlink()` | in tests: `createSymlink(cap, …)` / `createSymlinkAsync(cap, …)`; in shipped code: a win32 junction, or a `catch` naming the privilege | `/testing` |  | — |
| `no-child-process-execSync` | `child_process.execSync()` | `safeExecSync()` | `/process` | ✓ | `error` |
| `no-fs-mkdirSync` | `fs.mkdirSync()` | `mkdirSyncReal()` | `/fs` | ✓ | `error` |
| `no-fs-promises-cp` | `cp()` from `node:fs/promises` (drops nested files on Node 22) | `cpSync()` from `node:fs` | — | ✓ | `error` |
| `no-fs-realpathSync` | `fs.realpathSync()` | `normalizePath()` | `/fs` | ✓ | `error` |
| `no-os-tmpdir` | `os.tmpdir()` (8.3 short names on Windows) | `normalizedTmpdir()` | `/fs` | ✓ | `error` |
| `no-unix-shell-commands` | `tar`, `grep`, `rm`, `echo`, … spawned directly | Node APIs, or a portable script fixture | — |  | `error` |

#### URLs and dynamic imports

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-bare-dynamic-import-path` | `await import(absolutePath)` | `dynamicImportPath()` / `pathToFileURL(p).href` | `/fs` |  | `error` |
| `no-file-url-string-concat` | `` `file://${p}` `` | `pathToFileURL(p).href` | — |  | `error` |
| `no-url-pathname-for-fs` | `new URL(x, import.meta.url).pathname` as a filesystem path | `resolveFromImportMeta()` / `fileURLToPath()` | `/fs` |  | `error` |

#### Entrypoint guards

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-fragile-entrypoint-guard` | `import.meta.main`; `import.meta.url === pathToFileURL(process.argv[1]).href`; `fileURLToPath(import.meta.url) === process.argv[1]` | `isEntrypoint(import.meta.url)` | `/process` |  | — |

#### Process control

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-process-exit-in-phase` | `process.exit()` inside a function named `…Phase` | return the exit code from the phase; only the command wrapper exits | — |  | — |

#### Error handling

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-blind-catch` | a `catch` that neither reads its error nor throws | narrow on the error and rethrow the rest, or carry it into the result | — |  | `warn` |

#### Content decoding

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-raw-text-decode` | `buf.toString('utf-8')`, `new TextDecoder(…)`, `readFile(p, 'utf-8')` | one project-owned decoding seam | — |  | — |

#### Build correctness

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-self-package-import` | importing the enclosing package by its own name | a relative path to the defining module | — |  | — |

#### Code and test hygiene

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `no-test-scoped-functions` | helper functions declared inside `describe`/`it` | module scope | — |  | — |
| `prefer-startswith-over-regex` | `/^foo/.test(s)`, `` /^\*glob/.test(s) ``, `const RE = /^foo/; RE.test(s)` | `s.startsWith('foo')` | — |  | `error` |
| `require-justified-skip` | unannotated `it.skip`/`it.todo`, tautological assertions, empty test bodies | a `SKIP(#123): reason` annotation, or a real assertion | — |  | — |

#### Other

| Rule | Bans | Use instead | Subpath | Fix | `recommended` |
|---|---|---|---|---|---|
| `commands-import-boundary` | Disallow filesystem and internal-module imports in command modules — a command calls a declared enumeration lane, it does not become one | — | — |  | — |
| `dirent-type-needs-symlink-check` | Require an isSymbolicLink() check on a Dirent before isFile()/isDirectory() — both are false for a symlink, so an unchecked walk drops links silently | — | — |  | — |
| `explicit-zod-strictness` | Require every z.object({...}) to declare its unknown-key policy in the same chain — .strict(), .passthrough(), .loose() or an explicit .strip() — because the default silently strips keys | — | — |  | — |
| `no-decaying-referent` | Disallow issue/PR numbers, ISO dates and named people in src comments — they decay in place; the rule belongs in the comment and the history in the commit, CHANGELOG or docs | — | — |  | — |
| `no-dotdot-containment` | Disallow startsWith('..') / includes('..') / split-and-hunt as a path containment check — use the realpath-based isUnderRoot() helper | — | — |  | — |
| `no-io-in-unit-tier` | Disallow child_process imports and mkdtemp/spawn/exec calls in unit-tier test files — a test that spawns or writes to disk belongs in the integration or system tier | — | — |  | — |
| `no-literal-process-exit` | Disallow process.exit(<number>) and process.exitCode = <number> — name the meaning with the ExitCode enum so every command shares one exit contract | — | — |  | — |
| `no-registry-count-pin` | Disallow pinning the size of an imported registry with a literal in tests — toHaveLength(27) on something pulled from src is a change detector fixed by retyping | — | — |  | — |
| `no-version-literal` | Disallow z.literal(<number>) on a version-named field and <X>_VERSION = <number> constants — a hand-bumped integer deciding data validity is the shape CLAUDE.md bans | — | — |  | — |

<!-- /gen:eslint-rules -->

## Creating New Rules

When you identify a dangerous pattern (security, platform-specific, error-prone):

### 1. Write the failing RuleTester suite first

`packages/utils/test/eslint/rules/<rule-name>.test.ts`, one file per rule, using the shared
harness:

```ts
import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const CASES: RuleCases = {
  valid: [/* the shapes the rule must let through — these are where a heuristic earns its keep */],
  invalid: [/* the shapes that shipped, each with `errors: [{ messageId }]` and, if fixable, `output` */],
};

describe('no-fs-unlinkSync', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-fs-unlinkSync', CASES); });
});
```

The harness parses every case with the TypeScript parser, so TS syntax needs no per-case
`languageOptions`. Include at least one **decoy** for any rule taking `exemptFiles`: a file whose
basename matches an exempt path but whose directory does not. That leg is what proves the exemption
is anchored. Fixable rules also get a row in `test/eslint/autofix-fixpoint.test.ts`'s
`MULTI_SITE_REWRITES` — the suite fails until they do, because it derives the expected set from
`meta.fixable`.

### 2. Create the rule file

In `packages/utils/eslint/rules/`. For "ban function X from module Y, suggest Z, fix the import",
use the factory:

```javascript
// no-fs-unlinkSync.cjs
const factory = require('./eslint-rule-factory.cjs');
const { SAFE_FS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'unlinkSync',
  unsafeModule: 'node:fs',
  safeFn: 'safeUnlinkSync',
  safeModule: SAFE_FS_MODULE,  // from './safe-import.cjs' — the NARROW subpath
  message: 'Use safeUnlinkSync() from {{safeModule}} for better error handling and cross-platform compatibility',
  docs: {
    category: 'Filesystem and process',
    bans: '`fs.unlinkSync()`',
    useInstead: '`safeUnlinkSync()`',
    subpath: '/fs',
    recommended: true,
    recommendedSeverity: 'error',
  },
  // NOTE: `safeModule` is where the autofix WRITES the import, so it must name
  // the subpath that actually exports `safeFn` — never the `.` barrel. Take it
  // from `safe-import.cjs` rather than spelling the string here: the rules and
  // the README table drifted apart once already, and the autofix rewrote code
  // away from the very subpaths the release existed to introduce.
  // NOTE: do NOT pass `exemptFiles` here. The factory supports it as a fallback,
  // but a shipped rule must not name a repo-specific implementation path — the
  // package is published, and that default becomes a hole in every consumer's
  // tree. The consuming config declares its own (see step 4).
});
```

A hand-written rule exports the same shape directly (`meta.type`, `meta.docs` as above,
`meta.messages`, `meta.schema`, `create`). `no-raw-node-path.cjs` is the worked example of a rule
driven by an option table.

**Never exempt with `filename.includes(...)`.** All three exemption shapes live in
`packages/utils/eslint/rules/exempt-path-matcher.cjs` — reuse them:

| Question the rule is asking | Helper | Substring bug it replaces |
|---|---|---|
| "Is this THAT file?" | `createExemptPathMatcher(['packages/utils/src/path-utils.ts'])` | `includes('path-utils.ts')` also exempted `tools/hooks/path-utils.ts` |
| "Is this file INSIDE that package?" | `createExemptDirectoryMatcher(['packages/git/'])` | `includes('packages/git/')` also exempted `vendor/copy-packages/git/` |
| "Is this a test file?" | `isTestFile(filename)` | `includes('.test.ts')` also exempted `x.test.ts.bak` and `tsconfig.test.json` |

All three normalize to forward slashes first, so they behave identically on Windows.

### 3. Regenerate the docs table

```bash
cd packages/utils && bun run generate:eslint-rules-doc
```

That rewrites the block above and the one in `packages/utils/eslint/README.md`. Nothing to
register: `index.cjs` found the file the moment it existed, and `configs.recommended` read its
`meta.docs`. If the rule is not recommended, say why in a comment beside `recommended: false`.

### 4. Enable in `eslint.config.js`, naming this repo's exempt files

```javascript
rules: {
  'local/no-child-process-execSync': ['error', { exemptFiles: ['packages/utils/src/safe-exec.ts'] }],
  'local/no-fs-unlinkSync': ['error', { exemptFiles: ['packages/dev-tools/src/common.ts'] }], // New rule
}
```

Exempt paths are ALWAYS repo-relative, never a bare basename: they are anchored at a path-segment
boundary (`exempt-path-matcher.cjs`), so a same-named file in another directory is still linted. A
bare `'common.ts'` used to be a substring match, which silently exempted every path merely
CONTAINING it.

A rule that cannot be green on the whole tree today lands as a **ratchet**: enable it with an
explicit allowlist of today's offending files (a reason beside each), so a listed file that becomes
clean fails until delisted and an unlisted new site fails at once. The list may only shrink.

## Why This Matters for Agentic Development

Without custom rules:
- ❌ AI reintroduces `execSync()` → security vulnerability
- ❌ AI uses `os.tmpdir()` → Windows path issues
- ❌ Manual code review catches it → time wasted, issue deployed

With custom rules:
- ✅ AI writes code → ESLint catches violation immediately
- ✅ Auto-fix available → AI or dev applies fix instantly
- ✅ Pattern enforced forever → never have to think about it again

**Best Practice**: Every time you fix a dangerous pattern, ask yourself: "Should this be a custom ESLint rule?" If yes, create it immediately.

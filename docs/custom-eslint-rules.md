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
it), so a change here is a change to a public API. That README is the adopter-facing rule table;
this doc is the contributor view.

They live inside `utils` rather than in a plugin package of their own because an ESLint plugin is
*data*: every rule module exports a plain object and none of them `require('eslint')`. So the pack
adds nothing to the twelve runtime subpaths, `eslint` can be an **optional** peer dependency, and
the rules can never be installed at a different version from the helpers whose signatures they name.
Anything you add here inherits that contract — `test/eslint/subpath-purity.test.ts` fails the build
on the first `require()` of anything outside `eslint/`.

Two things follow from being published:

- **No rule may bake in a repo-specific exemption path.** `packages/utils/src/path-utils.ts` is a
  fact about *this* repo; as a default it would be a silent hole at that path in every other one.
  Exemptions are a rule **option** (`{ exemptFiles: [...] }`), and this repo passes its own in
  `eslint.config.js`.
- **The plugin is registered under the `local` namespace here**, not the conventional
  `@vibe-agent-toolkit` one, because 23 `eslint-disable-next-line local/…` directives across 19 files
  in 7 packages are keyed on it — renaming turns every one into a no-op suppression while the tree
  still lints clean. Adopters get `@vibe-agent-toolkit/…` from `configs.recommended`.
  Flat config lets the namespace be any key, so it is a local alias, not part of the published
  contract. ESLint 9 defaults `reportUnusedDisableDirectives` to `warn` and this repo lints with
  `--max-warnings=0`, so if the alias ever stops resolving, all 23 surface as dead directives and
  fail CI rather than passing silently.

  Re-derive the count with the command below, **not** a bare `rg 'local/'` — this file, `CLAUDE.md`,
  `CHANGELOG.md` and `eslint.config.js` all *discuss* the directive, and counting those prose
  mentions as directives is how this number was wrong twice (43, then 26):

  ```bash
  rg --no-heading -g '!node_modules' -g '!dist' \
     "eslint-disable[a-z-]* .*local/" packages | wc -l
  ```

## Current Rules

### `no-child-process-execSync`

Enforces `safeExecSync()` instead of raw `execSync()`.

**Why it's dangerous:**
- `execSync()` uses shell interpreter → command injection risk
- `safeExecSync()` uses `which` pattern + no shell → cross-platform + secure

**Auto-fix**: Replaces `execSync` with `safeExecSync` and adds import

### `no-path-join` / `no-path-resolve` / `no-path-relative`

Enforces `safePath.join()`, `safePath.resolve()`, `safePath.relative()` from `@vibe-agent-toolkit/utils` instead of the corresponding `node:path` functions.

**Why it's dangerous:**
- `path.join()`, `path.resolve()`, `path.relative()` return backslashes on Windows
- Backslash paths break Map key lookups, string comparisons, and glob matching
- `safePath.*` wraps the native function + `toForwardSlash()` to always return forward slashes
- See issue [#38](https://github.com/jdutton/vibe-agent-toolkit/issues/38)

**Auto-fix**: Replaces `path.join(...)` / `join(...)` with `safePath.join(...)` and adds import. Handles both named imports (`import { join } from 'node:path'`) and default imports (`import path from 'node:path'`).

**Implementation**: Uses a shared `path-function-rule-factory.cjs` (separate from `eslint-rule-factory.cjs`) because the replacement target is an object method (`safePath.join`), not a standalone function.

**Exempt**: whatever the consuming config declares. This repo passes
`{ exemptFiles: ['packages/utils/src/path-core.ts', 'packages/utils/src/path-utils.ts', 'packages/utils/test/path-utils.test.ts'] }`
in `eslint.config.js`. The rule ships no default.

### `require-justified-skip`

Errors on test code that claims coverage it does not provide:

- **Unconditional skips** — `it.skip` / `test.skip` / `describe.skip` / `suite.skip`,
  `it.todo` / `test.todo`, and the `xit` / `xdescribe` / `xtest` aliases.
- **Tautological assertions** — `expect(<literal>)` whose matcher argument is also a
  literal or absent: `expect(true).toBe(true)`, `expect(1).toBe(1)`,
  `expect(true).toBeTruthy()`. These are worse than a skip because they report as
  **passing**.

**Exempt**: conditional gates. `it.skipIf(...)`, `describe.runIf(...)`, and the
hand-rolled ternary form `(NET ? describe : describe.skip)(...)` are conditions, not
coverage claims.

**Escape hatch — annotation grammar**: a comment on the same line, or the line
immediately above, matching:

```
/\bSKIP\(#\d+\):\s*\S/
```

i.e. `// SKIP(#163): references[] not populated by the extractor yet`. All three parts
are required — the uppercase `SKIP` keyword, a `#`-prefixed issue number, and a
non-empty reason. A vague comment does not qualify; an escape hatch that accepts any
comment is an off switch.

The keyword is `SKIP` rather than the more natural `TODO` because this repo runs
`sonarjs/todo-tag` at error level, which bans the `TODO` token in comments outright —
a grammar built on it would trip a second rule on every use.

Find outstanding debt with `rg 'SKIP\(#'`.

**Honest scope**: this rule catches 3 of the 9 false-coverage instances found by the
coherence audit that motivated it. The other 6 were live, green, passing tests that
asserted the wrong thing — no linter can see those. The control for that class is the
convention in [writing-tests.md](writing-tests.md#every-assertion-of-absence-needs-a-positive-control),
not this rule.

## Creating New Rules

When you identify a dangerous pattern (security, platform-specific, error-prone):

### 1. Use the factory pattern

See `eslint-rule-factory.cjs` for the template.

### 2. Create rule file

In `packages/utils/eslint/rules/`:

```javascript
// no-fs-unlinkSync.cjs
const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'unlinkSync',
  unsafeModule: 'node:fs',
  safeFn: 'safeUnlinkSync',
  safeModule: './common.js',
  message: 'Use safeUnlinkSync() for better error handling and cross-platform compatibility',
  // NOTE: do NOT pass `exemptFiles` here. The factory supports it as a fallback,
  // but a shipped rule must not name a repo-specific implementation path — the
  // package is published, and that default becomes a hole in every consumer's
  // tree. The consuming config declares its own (see step 4).
});
```

**Never exempt with `filename.includes(...)`.** All three exemption shapes live in
`packages/utils/eslint/rules/exempt-path-matcher.cjs` — reuse them:

| Question the rule is asking | Helper | Substring bug it replaces |
|---|---|---|
| "Is this THAT file?" | `createExemptPathMatcher(['packages/utils/src/path-utils.ts'])` | `includes('path-utils.ts')` also exempted `tools/hooks/path-utils.ts` |
| "Is this file INSIDE that package?" | `createExemptDirectoryMatcher(['packages/git/'])` | `includes('packages/git/')` also exempted `vendor/copy-packages/git/` |
| "Is this a test file?" | `isTestFile(filename)` | `includes('.test.ts')` also exempted `x.test.ts.bak` and `tsconfig.test.json` |

All three normalize to forward slashes first, so they behave identically on Windows.

### 3. Register it in `packages/utils/eslint/index.cjs`

```javascript
const rules = {
  'no-child-process-execSync': require('./rules/no-child-process-execSync.cjs'),
  'no-fs-unlinkSync': require('./rules/no-fs-unlinkSync.cjs'), // New rule
};
```

`configs.recommended` is generated from that object, so a new rule is enabled for adopters
automatically — at `error` unless you add it to `RECOMMENDED_WARN`.

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

### 5. Add a case table in `packages/utils/test/eslint/rules.test.ts`

Include at least one **decoy**: a file whose basename matches an exempt path but whose directory
does not. That leg is what proves the exemption is anchored.

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

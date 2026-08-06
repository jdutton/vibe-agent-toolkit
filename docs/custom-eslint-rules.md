# Custom ESLint Rules - Agentic Code Safety Pattern

## Overview

**Critical for AI-Heavy Development**: When working with agentic code (Claude, Cursor, Copilot), AI can easily reintroduce unsafe patterns that were previously fixed. Custom ESLint rules provide automatic guardrails that catch these issues during development.

## The Pattern: Identify → Create Rule → Never Repeat

**When you identify a dangerous pattern that was fixed:**
1. **Document why it's dangerous** (security, cross-platform, performance)
2. **Create a custom ESLint rule** in `packages/dev-tools/eslint-local-rules/`
3. **The pattern can never be reintroduced** - ESLint catches it automatically

This is "good overkill" - prevents technical debt from accumulating through AI-assisted development.

## Current Rules

Located in `packages/dev-tools/eslint-local-rules/`:

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

**Exempt**: `packages/utils/src/path-utils.ts` (the implementation file).

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

In `packages/dev-tools/eslint-local-rules/`:

```javascript
// no-fs-unlinkSync.cjs
const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'unlinkSync',
  unsafeModule: 'node:fs',
  safeFn: 'safeUnlinkSync',
  safeModule: './common.js',
  message: 'Use safeUnlinkSync() for better error handling and cross-platform compatibility',
  // Where the safe version is implemented. ALWAYS a repo-relative path, never a
  // bare basename: exemptions are anchored at a path-segment boundary
  // (`exempt-path-matcher.cjs`), so a same-named file in another directory is
  // still linted. A bare `'common.ts'` used to be a substring match, which
  // silently exempted every path merely CONTAINING it.
  exemptFiles: ['packages/dev-tools/src/common.ts'],
});
```

**Never exempt with `filename.includes(...)`.** All three exemption shapes live in
`packages/dev-tools/eslint-local-rules/exempt-path-matcher.cjs` — reuse them:

| Question the rule is asking | Helper | Substring bug it replaces |
|---|---|---|
| "Is this THAT file?" | `createExemptPathMatcher(['packages/utils/src/path-utils.ts'])` | `includes('path-utils.ts')` also exempted `tools/hooks/path-utils.ts` |
| "Is this file INSIDE that package?" | `createExemptDirectoryMatcher(['packages/git/'])` | `includes('packages/git/')` also exempted `vendor/copy-packages/git/` |
| "Is this a test file?" | `isTestFile(filename)` | `includes('.test.ts')` also exempted `x.test.ts.bak` and `tsconfig.test.json` |

All three normalize to forward slashes first, so they behave identically on Windows.

### 3. Add to `index.js`

```javascript
export default {
  rules: {
    'no-child-process-execSync': require('./no-child-process-execSync.cjs'),
    'no-fs-unlinkSync': require('./no-fs-unlinkSync.cjs'), // New rule
  },
};
```

### 4. Enable in `eslint.config.js`

```javascript
rules: {
  'local/no-child-process-execSync': 'error',
  'local/no-fs-unlinkSync': 'error', // New rule
}
```

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

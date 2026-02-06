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
  exemptFile: 'common.ts', // Where the safe version is implemented
});
```

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

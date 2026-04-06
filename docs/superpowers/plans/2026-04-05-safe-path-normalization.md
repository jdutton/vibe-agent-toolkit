# Safe Path Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate cross-platform path bugs by normalizing all paths to forward slashes at the source — safe wrappers for `path.join`/`path.resolve`/`path.relative`, ESLint enforcement, registry boundary fix, and skill-packager cleanup.

**Architecture:** Create `safePath` wrappers in utils that call Node's `path.*` then `toForwardSlash()`. An ESLint rule bans direct `path.join`/`path.resolve`/`path.relative` imports and usage, auto-fixing to safe equivalents. The resource registry normalizes paths at its boundary. Skill-packager drops all manual `toForwardSlash()` on Map operations.

**Tech Stack:** TypeScript, ESLint custom rules (CJS via rule factory pattern), Vitest

**Closes:** GitHub issue #38

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/utils/src/path-utils.ts` | Modify | Add `safePath.join()`, `safePath.resolve()`, `safePath.relative()` |
| `packages/utils/test/path-utils.test.ts` | Modify | Tests for safe wrappers |
| `packages/dev-tools/eslint-local-rules/no-path-join.cjs` | Create | ESLint rule banning `join` from `node:path` |
| `packages/dev-tools/eslint-local-rules/no-path-resolve.cjs` | Create | ESLint rule banning `resolve` from `node:path` |
| `packages/dev-tools/eslint-local-rules/no-path-relative.cjs` | Create | ESLint rule banning `relative` from `node:path` |
| `packages/dev-tools/eslint-local-rules/index.js` | Modify | Register new rules |
| `eslint.config.js` | Modify | Enable new rules |
| `packages/resources/src/resource-registry.ts` | Modify | Normalize filePath at boundary |
| `packages/agent-skills/src/skill-packager.ts` | Modify | Remove manual `toForwardSlash()` on Map ops |
| ~36 files across all packages | Modify | ESLint auto-fix migration |

---

### Task 1: Create safe path wrappers in utils

**Files:**
- Modify: `packages/utils/src/path-utils.ts` (append after `toForwardSlash`)
- Modify: `packages/utils/test/path-utils.test.ts`

- [ ] **Step 1: Write failing tests for safePath wrappers**

Add to `packages/utils/test/path-utils.test.ts`:

```typescript
describe('safePath', () => {
  describe('safePath.join', () => {
    it('should return forward slashes on all platforms', () => {
      const result = safePath.join('C:\\Users', 'docs', 'file.md');
      expect(result).not.toContain('\\');
      expect(result).toBe('C:/Users/docs/file.md');
    });

    it('should handle already-forward paths', () => {
      const result = safePath.join('/project', 'docs', 'file.md');
      expect(result).toBe('/project/docs/file.md');
    });

    it('should handle single argument', () => {
      const result = safePath.join('docs');
      expect(result).toBe('docs');
    });
  });

  describe('safePath.resolve', () => {
    it('should return forward slashes on all platforms', () => {
      const result = safePath.resolve('/project', 'docs', 'file.md');
      expect(result).not.toContain('\\');
    });

    it('should produce absolute paths', () => {
      const result = safePath.resolve('docs', 'file.md');
      expect(result).toMatch(/^\//); // Unix absolute (CI runs on Ubuntu/Mac)
    });
  });

  describe('safePath.relative', () => {
    it('should return forward slashes on all platforms', () => {
      const result = safePath.relative('/project/docs', '/project/README.md');
      expect(result).not.toContain('\\');
      expect(result).toBe('../README.md');
    });

    it('should handle same-directory paths', () => {
      const result = safePath.relative('/project/docs', '/project/docs/file.md');
      expect(result).toBe('file.md');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- --reporter=verbose 2>&1 | grep -A2 'safePath'`
Expected: FAIL — `safePath` is not defined

- [ ] **Step 3: Implement safePath wrappers**

Add to `packages/utils/src/path-utils.ts` after the `toForwardSlash` function:

```typescript
/**
 * Cross-platform safe path operations.
 *
 * Wraps Node's `path.join()`, `path.resolve()`, and `path.relative()` to always
 * return forward-slash paths. On Windows, the native `path.*` functions return
 * backslashes, which causes bugs when paths are used as Map keys, compared as
 * strings, or matched with glob patterns.
 *
 * **Use these instead of importing from `node:path` directly.**
 * ESLint rules enforce this — see `no-path-join`, `no-path-resolve`, `no-path-relative`.
 *
 * @example
 * ```typescript
 * import { safePath } from '@vibe-agent-toolkit/utils';
 *
 * // Always forward slashes, even on Windows
 * safePath.join('C:\\Users', 'docs', 'file.md')   // → 'C:/Users/docs/file.md'
 * safePath.resolve('/project', './docs')            // → '/project/docs'
 * safePath.relative('/project/docs', '/project')    // → '..'
 * ```
 */
export const safePath = {
  /** Like `path.join()` but always returns forward slashes. */
  join(...paths: string[]): string {
    return toForwardSlash(path.join(...paths));
  },

  /** Like `path.resolve()` but always returns forward slashes. */
  resolve(...paths: string[]): string {
    return toForwardSlash(path.resolve(...paths));
  },

  /** Like `path.relative()` but always returns forward slashes. */
  relative(from: string, to: string): string {
    return toForwardSlash(path.relative(from, to));
  },
} as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- --reporter=verbose 2>&1 | grep -A2 'safePath'`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/path-utils.ts packages/utils/test/path-utils.test.ts
git commit -m "feat(utils): add safePath.join/resolve/relative wrappers"
```

---

### Task 2: Create ESLint rules for path.join, path.resolve, path.relative

**Files:**
- Create: `packages/dev-tools/eslint-local-rules/no-path-join.cjs`
- Create: `packages/dev-tools/eslint-local-rules/no-path-resolve.cjs`
- Create: `packages/dev-tools/eslint-local-rules/no-path-relative.cjs`
- Modify: `packages/dev-tools/eslint-local-rules/index.js`
- Modify: `eslint.config.js`

**Important context:** The existing `eslint-rule-factory.cjs` handles named imports (`import { join } from 'node:path'`) but does NOT handle namespace/default imports (`import path from 'node:path'` → `path.join()`). Both patterns exist in the codebase. The factory's `checkMemberExpression` option handles `obj.method()` calls — set it to `true`.

However, the factory replaces `path.join(...)` with `safePath.join(...)` via the `safeFn` config. But `safePath` is an object, not a standalone function. The factory's auto-fix for member expressions replaces just the method name — so `path.join(...)` becomes `path.safePath(...)` which is wrong.

**Solution:** We need a custom rule (not the factory) that handles both import styles. The rule should:
1. Detect `import { join } from 'node:path'` → flag `join(...)` calls → auto-fix to `safePath.join(...)`
2. Detect `import path from 'node:path'` → flag `path.join(...)` calls → auto-fix to `safePath.join(...)`
3. Add `import { safePath } from '@vibe-agent-toolkit/utils'` if not present
4. Remove the `join` specifier from the `node:path` import (or the entire import if it was the only specifier)
5. Exempt `path-utils.ts` (the implementation file)

Since all three rules (`join`, `resolve`, `relative`) share the same logic with different function names, create a shared factory for path function rules.

- [ ] **Step 1: Create the path-function rule factory**

Create `packages/dev-tools/eslint-local-rules/path-function-rule-factory.cjs`:

```javascript
/**
 * ESLint Rule Factory for banning specific path functions from node:path
 *
 * Handles both import styles:
 * - Named: import { join } from 'node:path' → join(...)
 * - Default/namespace: import path from 'node:path' → path.join(...)
 *
 * Auto-fixes to safePath.fn() from @vibe-agent-toolkit/utils.
 */

/**
 * Remove a named import specifier, handling comma cleanup.
 */
function removeSpecifier(fixer, sourceCode, importNode, spec) {
  const fixes = [];
  if (importNode.specifiers.length === 1) {
    fixes.push(fixer.remove(importNode));
  } else {
    const comma = sourceCode.getTokenAfter(spec);
    if (comma && comma.value === ',') {
      fixes.push(fixer.removeRange([spec.range[0], comma.range[1]]));
    } else {
      const commaBefore = sourceCode.getTokenBefore(spec);
      if (commaBefore && commaBefore.value === ',') {
        fixes.push(fixer.removeRange([commaBefore.range[0], spec.range[1]]));
      } else {
        fixes.push(fixer.remove(spec));
      }
    }
  }
  return fixes;
}

module.exports = function createPathFunctionRule(config) {
  const { unsafeFn, message } = config;

  const pathModules = ['node:path', 'path'];
  const safeModule = '@vibe-agent-toolkit/utils';
  const safeObject = 'safePath';

  return {
    meta: {
      type: 'problem',
      docs: {
        description: `Enforce safePath.${unsafeFn}() instead of path.${unsafeFn}()`,
        category: 'Cross-platform compatibility',
        recommended: true,
      },
      fixable: 'code',
      schema: [],
      messages: {
        noUnsafePathFn: message,
      },
    },

    create(context) {
      const filename = context.getFilename();
      const sourceCode = context.getSourceCode();

      // Exempt the implementation file
      if (filename.includes('path-utils.ts')) {
        return {};
      }

      // Track imports
      let namedImportSpec = null; // The specific { join } specifier
      let namedImportNode = null; // The full import declaration
      let defaultImportName = null; // 'path' from: import path from 'node:path'
      let hasSafePathImport = false;
      let safeImportNode = null; // The @vibe-agent-toolkit/utils import

      return {
        ImportDeclaration(node) {
          if (pathModules.includes(node.source.value)) {
            for (const spec of node.specifiers) {
              // Named import: import { join } from 'node:path'
              if (spec.type === 'ImportSpecifier' && spec.imported.name === unsafeFn) {
                namedImportSpec = spec;
                namedImportNode = node;
              }
              // Default import: import path from 'node:path'
              if (spec.type === 'ImportDefaultSpecifier') {
                defaultImportName = spec.local.name;
              }
              // Namespace import: import * as path from 'node:path'
              if (spec.type === 'ImportNamespaceSpecifier') {
                defaultImportName = spec.local.name;
              }
            }
          }

          if (node.source.value === safeModule) {
            safeImportNode = node;
            for (const spec of node.specifiers) {
              if (spec.type === 'ImportSpecifier' && spec.imported.name === safeObject) {
                hasSafePathImport = true;
              }
            }
          }
        },

        CallExpression(node) {
          let isUnsafeCall = false;
          let isNamedCall = false;

          // Direct call from named import: join(...)
          if (
            node.callee.type === 'Identifier' &&
            node.callee.name === unsafeFn &&
            namedImportSpec
          ) {
            isUnsafeCall = true;
            isNamedCall = true;
          }

          // Member expression: path.join(...)
          if (
            node.callee.type === 'MemberExpression' &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === defaultImportName &&
            node.callee.property.type === 'Identifier' &&
            node.callee.property.name === unsafeFn
          ) {
            isUnsafeCall = true;
          }

          if (!isUnsafeCall) {
            return;
          }

          context.report({
            node,
            messageId: 'noUnsafePathFn',
            fix(fixer) {
              const fixes = [];

              // Replace the call
              if (isNamedCall) {
                // join(...) → safePath.join(...)
                fixes.push(fixer.replaceText(node.callee, `${safeObject}.${unsafeFn}`));
              } else {
                // path.join(...) → safePath.join(...)
                fixes.push(fixer.replaceText(node.callee, `${safeObject}.${unsafeFn}`));
              }

              // Add safePath import if needed
              if (!hasSafePathImport) {
                if (safeImportNode) {
                  const lastSpec = safeImportNode.specifiers[safeImportNode.specifiers.length - 1];
                  fixes.push(fixer.insertTextAfter(lastSpec, `, ${safeObject}`));
                } else {
                  const targetNode = namedImportNode || sourceCode.ast.body[0];
                  fixes.push(fixer.insertTextAfter(targetNode, `\nimport { ${safeObject} } from '${safeModule}';`));
                }
                hasSafePathImport = true; // Prevent duplicate imports in same file
              }

              // Remove the named import specifier (only for named imports)
              if (isNamedCall && namedImportNode) {
                fixes.push(...removeSpecifier(fixer, sourceCode, namedImportNode, namedImportSpec));
              }

              return fixes;
            },
          });
        },
      };
    },
  };
};
```

- [ ] **Step 2: Create the three ESLint rule files**

Create `packages/dev-tools/eslint-local-rules/no-path-join.cjs`:

```javascript
/**
 * ESLint rule: no-path-join
 *
 * Bans path.join() from node:path. Use safePath.join() from @vibe-agent-toolkit/utils.
 * safePath.join() wraps path.join() + toForwardSlash() to prevent Windows backslash bugs.
 */
const factory = require('./path-function-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'join',
  message:
    'Use safePath.join() from @vibe-agent-toolkit/utils instead of path.join(). ' +
    'path.join() returns backslashes on Windows, causing Map key mismatches and path comparison bugs.',
});
```

Create `packages/dev-tools/eslint-local-rules/no-path-resolve.cjs`:

```javascript
/**
 * ESLint rule: no-path-resolve
 *
 * Bans path.resolve() from node:path. Use safePath.resolve() from @vibe-agent-toolkit/utils.
 * safePath.resolve() wraps path.resolve() + toForwardSlash() to prevent Windows backslash bugs.
 */
const factory = require('./path-function-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'resolve',
  message:
    'Use safePath.resolve() from @vibe-agent-toolkit/utils instead of path.resolve(). ' +
    'path.resolve() returns backslashes on Windows, causing Map key mismatches and path comparison bugs.',
});
```

Create `packages/dev-tools/eslint-local-rules/no-path-relative.cjs`:

```javascript
/**
 * ESLint rule: no-path-relative
 *
 * Bans path.relative() from node:path. Use safePath.relative() from @vibe-agent-toolkit/utils.
 * safePath.relative() wraps path.relative() + toForwardSlash() to prevent Windows backslash bugs.
 */
const factory = require('./path-function-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'relative',
  message:
    'Use safePath.relative() from @vibe-agent-toolkit/utils instead of path.relative(). ' +
    'path.relative() returns backslashes on Windows, causing Map key mismatches and path comparison bugs.',
});
```

- [ ] **Step 3: Register rules in index.js**

Modify `packages/dev-tools/eslint-local-rules/index.js` — add to the rules object:

```javascript
    'no-path-join': require('./no-path-join.cjs'),
    'no-path-resolve': require('./no-path-resolve.cjs'),
    'no-path-relative': require('./no-path-relative.cjs'),
```

- [ ] **Step 4: Enable rules in eslint.config.js**

Add after existing local rules (around line 82):

```javascript
      'local/no-path-join': 'error',
      'local/no-path-resolve': 'error',
      'local/no-path-relative': 'error',
```

- [ ] **Step 5: Commit (rules created but not yet auto-fixed)**

```bash
git add packages/dev-tools/eslint-local-rules/ eslint.config.js
git commit -m "feat(dev-tools): add ESLint rules for no-path-join/resolve/relative"
```

---

### Task 3: Auto-fix the entire codebase

**Files:** ~36+ files across all packages (ESLint auto-fix handles them)

**Important context:** ESLint auto-fix may not handle every case perfectly in a single pass. Some files have both named imports and namespace imports. Run the fix, then manually review and fix any remaining issues. The `path-utils.ts` file is exempt — it's the implementation.

Files that use `import path from 'node:path'` and call `path.join()` will get `path.join()` replaced with `safePath.join()`, but the `import path from 'node:path'` stays (because `path.dirname()`, `path.basename()`, `path.isAbsolute()` etc. are still safe to use from the namespace import). That's correct — only `join`/`resolve`/`relative` produce backslashes.

- [ ] **Step 1: Run ESLint auto-fix**

Run: `bun run lint -- --fix`

This will auto-fix all violations. The auto-fixer:
- Replaces `join(...)` → `safePath.join(...)`
- Replaces `resolve(...)` → `safePath.resolve(...)`
- Replaces `relative(...)` → `safePath.relative(...)`
- Replaces `path.join(...)` → `safePath.join(...)`
- Replaces `path.resolve(...)` → `safePath.resolve(...)`
- Replaces `path.relative(...)` → `safePath.relative(...)`
- Adds `import { safePath } from '@vibe-agent-toolkit/utils'`
- Removes unused named import specifiers

- [ ] **Step 2: Run lint to check for remaining violations**

Run: `bun run lint`

If there are remaining violations that auto-fix couldn't handle (e.g., complex re-exports, type-only imports), fix them manually. Common patterns:
- Files that destructure `{ join, resolve, dirname, basename }` — auto-fix removes `join` and `resolve` but may leave a malformed import. Clean up the remaining specifiers.
- `path-utils.ts` is exempt — verify it has no violations.
- `getRelativePath` and `toAbsolutePath` in `path-utils.ts` use `path.relative()` and `path.resolve()` internally — these are exempt as implementation.

- [ ] **Step 3: Run typecheck to verify no type errors**

Run: `bun run typecheck`

The `safePath` object methods have the same signatures as `path.join/resolve/relative`, so this should pass cleanly. If any issues: check that `safePath` is properly exported from `@vibe-agent-toolkit/utils`.

- [ ] **Step 4: Run build to verify compilation**

Run: `bun run build`

- [ ] **Step 5: Commit the auto-fix migration**

```bash
git add -A
git commit -m "refactor: migrate path.join/resolve/relative to safePath (auto-fix)"
```

---

### Task 4: Normalize resource registry boundary

**Files:**
- Modify: `packages/resources/src/resource-registry.ts:286,855`
- Modify: `packages/agent-skills/src/skill-packager.ts:325,457,486,566,573`

**Context:** After Task 3, the registry already uses `safePath.resolve()` instead of `path.resolve()`, so `filePath` stored in resources will already be forward-slashed. This task verifies that and cleans up the downstream `toForwardSlash()` calls in skill-packager that are now redundant.

- [ ] **Step 1: Verify registry boundary is normalized**

Read `packages/resources/src/resource-registry.ts` around line 286 and confirm that `addResource` now uses `safePath.resolve()`:

```typescript
const absolutePath = safePath.resolve(filePath);
```

And `getResource` around line 855:

```typescript
const absolutePath = safePath.resolve(filePath);
```

If Task 3's auto-fix already changed these, this is already done. If not (e.g., the file uses `path.resolve` via namespace import), change them manually.

- [ ] **Step 2: Remove redundant toForwardSlash() in skill-packager**

In `packages/agent-skills/src/skill-packager.ts`, the following `toForwardSlash()` calls on Map operations are now redundant because all paths arriving from the registry are already forward-slashed:

Line ~325: `pathMap.get(toForwardSlash(resource.filePath))` → `pathMap.get(resource.filePath)`
Line ~457: `pathMap.set(toForwardSlash(skillPath), ...)` → `pathMap.set(skillPath, ...)`
Line ~473: `toForwardSlash(linkedFile)` → `linkedFile`
Line ~486: `pathMap.set(toForwardSlash(linkedFile), ...)` → `pathMap.set(linkedFile, ...)`
Line ~566: `ctx.pathMap.get(toForwardSlash(skillPath))` → `ctx.pathMap.get(skillPath)`
Line ~573: `ctx.pathMap.get(toForwardSlash(linkedFile))` → `ctx.pathMap.get(linkedFile)`

Also update the function doc comment on `buildPathMap` (line ~443): remove "(forward-slash normalized)" since normalization now happens at source.

Remove unused `toForwardSlash` import if no other uses remain in this file. Check with: `grep toForwardSlash packages/agent-skills/src/skill-packager.ts`

- [ ] **Step 3: Remove redundant toForwardSlash() in other files**

Search the entire codebase for `toForwardSlash` calls that wrap values already coming from `safePath.*` or `resource.filePath`. These are now redundant double-normalizations:

```bash
grep -n 'toForwardSlash' packages/*/src/**/*.ts
```

For each occurrence, evaluate:
- If the input is from `safePath.*` or `resource.filePath` → remove the wrapper
- If the input is from external source (user input, fs API, process.cwd()) → keep it
- If the input is from `path.dirname()` or `path.basename()` on an already-normalized path → remove it (dirname/basename preserve input separators)

Common safe removals:
- `toForwardSlash(resolve(...))` → already `safePath.resolve()`
- `toForwardSlash(join(...))` → already `safePath.join()`
- `toForwardSlash(relative(...))` → already `safePath.relative()`

- [ ] **Step 4: Run full validation**

Run: `bun run validate`

All 14 steps must pass. Pay special attention to:
- Windows system tests (if available locally)
- Skill packaging tests
- Resource validation tests
- Marketplace publish tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove redundant toForwardSlash() — paths normalized at source"
```

---

### Task 5: Update documentation and close issue

**Files:**
- Modify: `CLAUDE.md` (utils package section)
- Modify: `docs/custom-eslint-rules.md`

- [ ] **Step 1: Update CLAUDE.md utils section**

In the `CLAUDE.md` file, find the **utils package** section under "Package-Specific Guidelines" and add a bullet:

```markdown
- `safePath.join()`, `safePath.resolve()`, `safePath.relative()` — cross-platform path wrappers that always return forward slashes. ESLint rules (`no-path-join`, `no-path-resolve`, `no-path-relative`) enforce their use over raw `node:path` functions. Import from `@vibe-agent-toolkit/utils`.
```

- [ ] **Step 2: Update custom ESLint rules doc**

In `docs/custom-eslint-rules.md`, add entries for the three new rules following the existing format. Include:
- Rule name, what it detects, what it suggests
- Why: `path.join/resolve/relative` return backslashes on Windows, causing Map key mismatches
- Reference to the original bug (issue #38)

- [ ] **Step 3: Run final validation**

Run: `bun run validate`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/custom-eslint-rules.md
git commit -m "docs: document safePath wrappers and ESLint rules"
```

- [ ] **Step 5: Close issue #38**

```bash
gh issue close 38 --comment "Resolved via safePath wrappers + ESLint enforcement. See plan: docs/superpowers/plans/2026-04-05-safe-path-normalization.md"
```

# Marketplace Publish: Verbatim CHANGELOG + Dual-Source Commit Body Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `vat claude marketplace publish` mirror the source `CHANGELOG.md` **verbatim** into the publish tree and extract release-note content for the commit body only. Accept both Keep a Changelog workflows (Workflow A: non-empty `[Unreleased]`; Workflow B: pre-stamped `[X.Y.Z]`) — never mutate the user's CHANGELOG file.

**Architecture:** Delete `stampChangelog()` entirely. Add `parseVersionSection()` for extracting a stamped `[X.Y.Z]` section. In `publish-tree.ts`, copy the source changelog byte-for-byte to the publish tree and derive `changelogDelta` (the commit-body string) by preferring `[version]` → falling back to `[Unreleased]` → erroring if both are empty.

**Tech Stack:** TypeScript (ESM/NodeNext), Vitest, Commander.js. No new dependencies.

---

## Design Decisions (locked)

These were resolved before writing this plan. Do not re-debate them while executing:

1. **Version = provenance metadata.** `readProjectVersion()` reads from `package.json` and is threaded through `composePublishTree()` **only** for use in the commit message subject (`publish v${version}`) and the log line. It is **not** a file-mutation target.

2. **VAT never rewrites the user's `CHANGELOG.md`.** The file is copied byte-for-byte from `configDir` to `outputDir`. A side-benefit: corrections/typo-fixes to `CHANGELOG.md` on `main` propagate to the publish branch on the next publish.

3. **Commit body comes from the CHANGELOG but does not touch the file.** The `changelogDelta` field in `ComposeResult` is used by `createCommitMessage()` in `git-publish.ts:35-54` and is the only piece that needs extraction logic.

4. **Extraction rules** (in order):
   - Prefer `## [<version>]` section (Workflow B / pre-stamped).
   - Fall back to `## [Unreleased]` section (Workflow A).
   - Error if both are empty, naming both acceptable patterns.
   - A `[X.Y.Z]` section for a **different** version does NOT count — exact match on the requested version only.

5. **`stampChangelog()` is deleted entirely**, not just unused. It has exactly one caller (`publish-tree.ts`) and one test file; both get cleaned up in this change.

6. **Breaking change is accepted.** Three adopters (VAT, vibe-validate, one enterprise repo), all pre-1.0. Workflow A adopters whose `main` branch CHANGELOG.md continues to carry `[Unreleased]` at publish time will see that heading on the publish branch too — an honest representation. No migration of existing publish-branch history is needed.

## Behavior matrix

| `[Unreleased]` content | `[version]` section | Outcome | `changelogDelta` source | Published CHANGELOG.md |
|---|---|---|---|---|
| ✅ content | ❌ absent | publishes | `[Unreleased]` content | verbatim copy (keeps `[Unreleased]`) |
| ❌ empty | ✅ present | publishes | `[version]` content | verbatim copy (keeps both headings) |
| ✅ content | ✅ present | publishes | `[version]` content (prefer stamped) | verbatim copy (no mutation, no duplication) |
| ❌ empty | ❌ absent | **error** — names both patterns | n/a | n/a |
| ❌ empty | ✅ present but **different version** | **error** — don't silently use wrong notes | n/a | n/a |

---

## File Structure

**Source changes (3 files):**

| File | Change |
|---|---|
| `packages/cli/src/commands/claude/marketplace/changelog-utils.ts` | **Delete** `stampChangelog()`. **Add** `parseVersionSection()`. |
| `packages/cli/src/commands/claude/marketplace/publish-tree.ts` | Replace changelog block (lines 14 import + 65–81) with dual-source extraction + verbatim copy. |
| `packages/cli/src/commands/claude/marketplace/publish.ts` | Update `.addHelpText()` description to document dual-source acceptance + verbatim copy. |

**Test changes (2 files):**

| File | Change |
|---|---|
| `packages/cli/test/commands/claude/marketplace/changelog-utils.test.ts` | **Delete** `stampChangelog` tests. **Add** `parseVersionSection` tests. |
| `packages/cli/test/commands/claude/marketplace/publish-tree.test.ts` | **Update** existing compose test (no longer asserts stamped heading). **Update** existing empty-unreleased test (new error message). **Add** Workflow B, "prefer stamped when both", and "mismatched version" tests. |

**Docs changes (1 file):**

| File | Change |
|---|---|
| `CHANGELOG.md` | Add entry under `[Unreleased]` describing the breaking behavior change. |

**No changes to:**
- `publish.ts` command wiring (`readProjectVersion`, `composePublishTree` call site) — version flow is unchanged.
- `git-publish.ts` — `createCommitMessage(version, changelogDelta, metadata)` contract is unchanged; `changelogDelta` is still a trimmed string.
- `ComposeResult` interface — still `{ version, changelogDelta, files }`.
- Config schema — no new fields.
- `UNRELEASED_HEADING_RE` / `VERSION_HEADING_RE` constants — both stay (still used by `parseUnreleasedSection` and the new `parseVersionSection`).

---

## Task 1: Replace `stampChangelog()` with `parseVersionSection()` (TDD)

**Files:**
- Modify: `packages/cli/src/commands/claude/marketplace/changelog-utils.ts`
- Test: `packages/cli/test/commands/claude/marketplace/changelog-utils.test.ts`

- [ ] **Step 1: Write failing tests for `parseVersionSection` and delete `stampChangelog` tests**

Replace the entire contents of `packages/cli/test/commands/claude/marketplace/changelog-utils.test.ts` with:

```typescript
import { describe, expect, it } from 'vitest';

import {
  parseUnreleasedSection,
  parseVersionSection,
} from '../../../../src/commands/claude/marketplace/changelog-utils.js';

const SAMPLE_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- New marketplace publish command
- SPDX license shortcut support

### Fixed
- Version validation for plugins

## [0.1.0] - 2026-03-15

### Added
- Initial release
`;

const EMPTY_UNRELEASED = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-03-15

### Added
- Initial release
`;

const PRESTAMPED_CHANGELOG = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-04-09

### Added
- New feature X
- New feature Y

## [1.1.0] - 2026-03-15

### Fixed
- Bug Z
`;

const PRESTAMPED_WITH_UNRELEASED_CONTENT = `# Changelog

## [Unreleased]

### Added
- Upcoming feature

## [1.2.0] - 2026-04-09

### Added
- Released feature
`;

describe('changelog-utils', () => {
  describe('parseUnreleasedSection', () => {
    it('should extract unreleased content', () => {
      const result = parseUnreleasedSection(SAMPLE_CHANGELOG);
      expect(result).toContain('### Added');
      expect(result).toContain('New marketplace publish command');
      expect(result).toContain('### Fixed');
      expect(result).not.toContain('## [0.1.0]');
    });

    it('should return empty string when unreleased section has no content', () => {
      const result = parseUnreleasedSection(EMPTY_UNRELEASED);
      expect(result.trim()).toBe('');
    });

    it('should return empty string when no unreleased section exists', () => {
      const result = parseUnreleasedSection('# Changelog\n\n## [1.0.0] - 2026-01-01\n');
      expect(result.trim()).toBe('');
    });
  });

  describe('parseVersionSection', () => {
    it('should extract content of a stamped version section', () => {
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '1.2.0');
      expect(result).toContain('### Added');
      expect(result).toContain('New feature X');
      expect(result).toContain('New feature Y');
      expect(result).not.toContain('## [1.1.0]');
      expect(result).not.toContain('Bug Z');
    });

    it('should extract the last version section (no following heading)', () => {
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '1.1.0');
      expect(result).toContain('### Fixed');
      expect(result).toContain('Bug Z');
    });

    it('should return empty string when the requested version is absent', () => {
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '9.9.9');
      expect(result.trim()).toBe('');
    });

    it('should not match substrings of other versions', () => {
      // '1.2' must NOT match '[1.2.0]' — we require exact version match
      const result = parseVersionSection(PRESTAMPED_CHANGELOG, '1.2');
      expect(result.trim()).toBe('');
    });

    it('should ignore the [Unreleased] section entirely', () => {
      const result = parseVersionSection(PRESTAMPED_WITH_UNRELEASED_CONTENT, '1.2.0');
      expect(result).toContain('Released feature');
      expect(result).not.toContain('Upcoming feature');
    });

    it('should handle versions with pre-release suffixes', () => {
      const changelog = `# Changelog\n\n## [Unreleased]\n\n## [1.2.0-rc.1] - 2026-04-09\n\n### Added\n- RC feature\n`;
      const result = parseVersionSection(changelog, '1.2.0-rc.1');
      expect(result).toContain('RC feature');
    });
  });
});
```

Note: the `stampChangelog` describe block is completely removed. `stampChangelog` no longer exists.

- [ ] **Step 2: Run tests to verify failures**

Run: `cd packages/cli && bun run test:unit -- changelog-utils`
Expected: FAIL — `parseVersionSection is not a function` (import error) for each new test. The `parseUnreleasedSection` tests still pass unchanged.

- [ ] **Step 3: Replace `changelog-utils.ts` contents**

Replace the entire contents of `packages/cli/src/commands/claude/marketplace/changelog-utils.ts` with:

```typescript
/**
 * Changelog parsing utilities for marketplace publish.
 *
 * Follows Keep a Changelog format: https://keepachangelog.com/
 *
 * Used by publish-tree.ts to extract release-note content for the publish commit body.
 * VAT does NOT modify the user's CHANGELOG.md file — the published copy is byte-identical
 * to the source. These helpers only extract content for the commit message.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Regex to match the [Unreleased] heading (case-insensitive).
 */
const UNRELEASED_HEADING_RE = /^## \[unreleased\]\s*$/im;

/**
 * Regex to match any stamped version heading (e.g. `## [1.2.0]` or `## [1.2.0-rc.1]`).
 * Used to find where a section ends (= where the next version heading begins).
 */
const VERSION_HEADING_RE = /^## \[\d+\.\d+/m;

/**
 * Extract the content of the [Unreleased] section from a changelog string.
 * Returns the content between [Unreleased] heading and the next version heading (or EOF).
 * Returns empty string if no [Unreleased] section or it has no content.
 */
export function parseUnreleasedSection(changelog: string): string {
  const unreleasedMatch = UNRELEASED_HEADING_RE.exec(changelog);
  if (!unreleasedMatch) {
    return '';
  }

  const startIndex = unreleasedMatch.index + unreleasedMatch[0].length;
  const rest = changelog.slice(startIndex);

  const nextVersionMatch = VERSION_HEADING_RE.exec(rest);
  const content = nextVersionMatch
    ? rest.slice(0, nextVersionMatch.index)
    : rest;

  return content.trimEnd();
}

/**
 * Extract the content of a specific stamped version section (e.g. `## [1.2.0] - 2026-04-09`).
 *
 * Supports the "pre-stamped" workflow: a repo that promotes `[Unreleased]` to `[X.Y.Z]`
 * in its release commit before tagging, leaving `[Unreleased]` empty per the Keep a
 * Changelog canonical post-release state.
 *
 * Matches headings of the form `## [<version>]` with any trailing content (date, etc.)
 * on the same line. Requires an exact version match — `1.2` will NOT match `[1.2.0]`.
 *
 * Returns the trimmed content between the matching heading and the next `## [` version
 * heading (or EOF). Returns empty string if the version section does not exist.
 */
export function parseVersionSection(changelog: string, version: string): string {
  // Escape regex metacharacters in the version string (dots, hyphens, plus signs cover semver).
  const escaped = version.replace(/[.+\-]/g, '\\$&');
  // `## [<version>]` followed by any trailing content on the line (typically ` - date`).
  // eslint-disable-next-line security/detect-non-literal-regexp -- input escaped above
  const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm');
  const match = heading.exec(changelog);
  if (!match) {
    return '';
  }

  const startIndex = match.index + match[0].length;
  const rest = changelog.slice(startIndex);

  const nextVersionMatch = VERSION_HEADING_RE.exec(rest);
  const content = nextVersionMatch ? rest.slice(0, nextVersionMatch.index) : rest;

  return content.trim();
}

/**
 * Read a changelog file from disk.
 */
export function readChangelog(filePath: string, baseDir: string): string {
  const resolved = safePath.resolve(baseDir, filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
  return readFileSync(resolved, 'utf-8');
}
```

Note: `stampChangelog` export is **removed**. Both regex constants are retained (both are still used).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && bun run test:unit -- changelog-utils`
Expected: all tests PASS (3 existing `parseUnreleasedSection` tests + 6 new `parseVersionSection` tests = 9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/claude/marketplace/changelog-utils.ts \
        packages/cli/test/commands/claude/marketplace/changelog-utils.test.ts
git commit -m "refactor(cli): replace stampChangelog with parseVersionSection

Delete stampChangelog() and add parseVersionSection() to support
extracting release notes from a pre-stamped [X.Y.Z] section of a
Keep a Changelog file. The next commit wires this into publish-tree
so the marketplace publish no longer mutates CHANGELOG.md."
```

---

## Task 2: Publish tree copies CHANGELOG verbatim + dual-source commit body (TDD)

**Files:**
- Modify: `packages/cli/src/commands/claude/marketplace/publish-tree.ts`
- Test: `packages/cli/test/commands/claude/marketplace/publish-tree.test.ts`

- [ ] **Step 1: Update and add publish-tree tests (failing)**

Replace the entire contents of `packages/cli/test/commands/claude/marketplace/publish-tree.test.ts` with:

```typescript
/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file — all file operations are in temp directories, duplicated strings acceptable
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';


import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { composePublishTree } from '../../../../src/commands/claude/marketplace/publish-tree.js';

function makeTempDir(tempDirs: string[]): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-publish-tree-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a minimal marketplace build output under sourceDir so composePublishTree
 * can find it. Returns the marketplace name used.
 */
function seedMarketplaceBuild(sourceDir: string, mpName = 'test-mp'): string {
  const pluginDir = safePath.join(
    sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', mpName, '.claude-plugin',
  );
  mkdirSyncReal(pluginDir, { recursive: true });
  writeFileSync(safePath.join(pluginDir, 'marketplace.json'), `{"name":"${mpName}"}`);
  return mpName;
}

describe('publish-tree', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('should compose tree with marketplace artifacts, changelog, readme, and license', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);

    const sourceChangelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n- Feature\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);
    writeFileSync(safePath.join(sourceDir, 'README.md'), '# My Marketplace\n');

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
      changelog: { sourcePath: 'CHANGELOG.md' },
      readme: { sourcePath: 'README.md' },
      license: { type: 'spdx', value: 'mit', ownerName: 'Test Org' },
    });

    expect(existsSync(safePath.join(outputDir, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'CHANGELOG.md'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'README.md'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'LICENSE'))).toBe(true);
    expect(result.version).toBe('1.0.0');

    // CHANGELOG must be copied BYTE-FOR-BYTE — no stamping, no mutation.
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toBe(sourceChangelog);

    // Release notes still flow to the commit body via changelogDelta.
    expect(result.changelogDelta).toContain('### Added');
    expect(result.changelogDelta).toContain('- Feature');
  });

  it('should fail when build output does not exist', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);

    await expect(composePublishTree({
      marketplaceName: 'nonexistent',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
    })).rejects.toThrow(/build output/i);
  });

  it('should fail when changelog has neither unreleased content nor matching version section', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);

    // Empty [Unreleased] and a stamped section for a DIFFERENT version
    writeFileSync(
      safePath.join(sourceDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n- Old\n',
    );

    await expect(composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
      changelog: { sourcePath: 'CHANGELOG.md' },
    })).rejects.toThrow(/neither.*\[Unreleased\].*nor.*\[1\.0\.0\]/i);
  });

  it('should publish a pre-stamped changelog when [Unreleased] is empty (Workflow B)', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);

    const sourceChangelog =
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-04-09\n\n### Added\n- New feature X\n- New feature Y\n\n## [1.1.0] - 2026-03-15\n\n### Fixed\n- Old bug\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.2.0',
      date: '2026-04-09',
      changelog: { sourcePath: 'CHANGELOG.md' },
    });

    expect(result.version).toBe('1.2.0');
    // Commit body uses the stamped [1.2.0] section, not [Unreleased] and not [1.1.0].
    expect(result.changelogDelta).toContain('New feature X');
    expect(result.changelogDelta).toContain('New feature Y');
    expect(result.changelogDelta).not.toContain('Old bug');

    // Published CHANGELOG is BYTE-IDENTICAL to source.
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toBe(sourceChangelog);
  });

  it('should prefer stamped [X.Y.Z] over [Unreleased] when both have content', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);

    const sourceChangelog =
      '# Changelog\n\n## [Unreleased]\n\n### Added\n- Work-in-progress for next release\n\n## [1.2.0] - 2026-04-09\n\n### Added\n- Released feature\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.2.0',
      date: '2026-04-09',
      changelog: { sourcePath: 'CHANGELOG.md' },
    });

    // Commit body comes from the stamped section, not [Unreleased].
    expect(result.changelogDelta).toContain('Released feature');
    expect(result.changelogDelta).not.toContain('Work-in-progress');

    // Published CHANGELOG is BYTE-IDENTICAL (both sections preserved, nothing mutated).
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toBe(sourceChangelog);
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd packages/cli && bun run test:unit -- publish-tree`
Expected:
- `should compose tree...` — **FAIL**: currently writes a stamped copy containing `## [1.0.0] - 2026-04-01`, so `toBe(sourceChangelog)` fails.
- `should fail when build output does not exist` — PASS (unchanged).
- `should fail when changelog has neither...` — **FAIL**: current error says "empty [Unreleased] section".
- `should publish a pre-stamped changelog...` — **FAIL**: current code rejects when `[Unreleased]` is empty.
- `should prefer stamped [X.Y.Z]...` — **FAIL**: current code stamps, creating a duplicate `[1.2.0]` heading.

- [ ] **Step 3: Implement verbatim copy + dual-source extraction in `publish-tree.ts`**

In `packages/cli/src/commands/claude/marketplace/publish-tree.ts`:

**3a. Update the import on line 14** — remove `stampChangelog` (deleted), add `parseVersionSection`:

```typescript
import {
  parseUnreleasedSection,
  parseVersionSection,
  readChangelog,
} from './changelog-utils.js';
```

**3b. Replace the changelog block (current lines 65–81)** with:

```typescript
  // 3. Process changelog — VAT copies the source file byte-for-byte into the publish tree.
  //    We only extract a release-note string for the commit body (changelogDelta).
  //    Accept both Keep a Changelog workflows:
  //      (B) pre-stamped `## [version]` section — preferred when present, and
  //      (A) non-empty `## [Unreleased]` — fallback.
  //    Error if both are empty.
  if (options.changelog) {
    const rawChangelog = readChangelog(options.changelog.sourcePath, configDir);

    const stampedSection = parseVersionSection(rawChangelog, version);
    const unreleasedSection = parseUnreleasedSection(rawChangelog).trim();

    if (stampedSection !== '') {
      changelogDelta = stampedSection;
    } else if (unreleasedSection !== '') {
      changelogDelta = unreleasedSection;
    } else {
      throw new Error(
        `Changelog "${options.changelog.sourcePath}" has neither a non-empty [Unreleased] ` +
          `section nor a [${version}] section. Document the release before publishing.`,
      );
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated config
    await writeFile(safePath.join(outputDir, 'CHANGELOG.md'), rawChangelog);
    files.push('CHANGELOG.md');
  }
```

Note: `date` parameter is still destructured in the function signature — it remains in use nowhere now, but keep it in `ComposeOptions` for source compatibility with callers and future use. Actually, double-check: after this change `date` has no remaining users inside `composePublishTree`. Search for other uses.

- [ ] **Step 4: Check whether `date` is still needed in `ComposeOptions`**

Run: `cd packages/cli && grep -n 'date' src/commands/claude/marketplace/publish-tree.ts`
Expected: `date` only appears in the destructure on line 47 and the interface declaration.

If `date` is truly unused after the change, update the function to stop destructuring it and mark the interface field as reserved-for-future-use **OR** remove it from `ComposeOptions` entirely and drop it from the `buildComposeOptions()` call in `publish.ts:133-140`. Prefer removal — this is pre-1.0 and YAGNI applies.

**If removing `date`:**

In `publish-tree.ts`:
- Remove `date` from the `ComposeOptions` interface (around line 34).
- Remove `date` from the destructure on line 47.

In `publish.ts`:
- Remove `date` from the `buildComposeOptions` function signature and the returned `opts` object (around lines 126–140).
- Remove `today` and the `date: today` argument from the `publishOneMarketplace` call site (around line 234 and 247).
- Remove the `date` field from the `PublishOneOptions` interface (around line 159).

**Recheck all tests:** the existing `composePublishTree` test passes a `date: '2026-04-01'` argument. After removing `date` from `ComposeOptions`, TypeScript's `exactOptionalPropertyTypes` will reject extra fields. Remove `date:` from every `composePublishTree(...)` call in the test file (5 occurrences in the updated test file above).

- [ ] **Step 5: Run publish-tree tests to verify they pass**

Run: `cd packages/cli && bun run test:unit -- publish-tree`
Expected: all 5 tests PASS.

- [ ] **Step 6: Run the full CLI unit test suite**

Run: `cd packages/cli && bun run test:unit`
Expected: all tests PASS. Any failures are likely in publish.ts tests from removing `date`; update call sites as needed.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/claude/marketplace/publish-tree.ts \
        packages/cli/src/commands/claude/marketplace/publish.ts \
        packages/cli/test/commands/claude/marketplace/publish-tree.test.ts
git commit -m "fix(cli): marketplace publish mirrors CHANGELOG verbatim

VAT no longer rewrites the CHANGELOG.md it copies into the publish
tree. The source file is mirrored byte-for-byte and release notes
flow to the commit body via changelogDelta extraction only.

Accepts both Keep a Changelog workflows:
- Workflow A: non-empty [Unreleased] (extracted for commit body)
- Workflow B: pre-stamped [X.Y.Z] matching package.json (preferred)

Benefits:
- Corrections/typo-fixes to CHANGELOG.md on main propagate to the
  publish branch on the next publish.
- main and publish branch never diverge on CHANGELOG contents.
- Postel's Law: VAT is conservative in what it produces — never
  mutates files the user maintains.
- Eliminates the duplicate-heading footgun that would trigger if
  stampChangelog ran against a pre-stamped changelog.

BREAKING CHANGE: Workflow A adopters whose main branch CHANGELOG
continues to carry [Unreleased] at publish time will see that
heading on the publish branch too. To publish a stamped heading,
stamp CHANGELOG.md on main before tagging (e.g., via bump-version).

Refs: adopter bug report 2026-04-09"
```

---

## Task 3: Update help text

**Files:**
- Modify: `packages/cli/src/commands/claude/marketplace/publish.ts` (lines 54–79)

- [ ] **Step 1: Update the `.addHelpText('after', ...)` block**

Replace the existing `.addHelpText('after', ...)` block in `publish.ts` with:

```typescript
    .addHelpText('after', `
Description:
  Pushes built marketplace artifacts to a Git branch for distribution.
  Requires vat build to have been run first.

  Composes:
  - Marketplace artifacts from dist/.claude/plugins/marketplaces/
  - CHANGELOG.md — copied BYTE-FOR-BYTE from the source. Release notes
    for the commit body are extracted from either a pre-stamped
    [version] section matching package.json, or (as a fallback) a
    non-empty [Unreleased] section. Publish fails if neither is
    present. VAT never mutates CHANGELOG.md.
  - README.md
  - LICENSE (SPDX shortcut or file)

  Creates one squashed commit per version on the target branch.

Output:
  YAML summary -> stdout
  Progress -> stderr

Exit Codes:
  0 - Published successfully (or dry-run completed)
  1 - Publish error (missing build, changelog missing release notes for version)
  2 - System error

Example:
  $ vat build && vat claude marketplace publish --no-push  # Create local branch
  $ git push origin claude-marketplace                     # Push when ready
`);
```

- [ ] **Step 2: Rebuild and sanity-check help output**

Run:
```bash
cd /Users/jeffdutton/Workspaces/vibe-agent-toolkit
bun run build
node packages/cli/dist/bin/vat.js claude marketplace publish --help
```
Expected: help text shows the new CHANGELOG.md bullet with "BYTE-FOR-BYTE" and dual-source extraction wording.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/claude/marketplace/publish.ts
git commit -m "docs(cli): document verbatim changelog behavior in publish help"
```

---

## Task 4: Full validation + CHANGELOG entry + PR prep

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run full validation from repo root**

Run: `bun run validate`
Expected: all checks PASS (unit + integration + system tests, lint, typecheck, duplication-check).

Fix anything reported; re-run `bun run validate` until clean. Likely trouble spots:
- Lint/duplication failures in the new test file (hoist helpers if needed).
- Any `date` references I missed when removing it from `ComposeOptions`.
- System tests that may invoke marketplace publish with a fixture CHANGELOG — update the fixture if it relies on stamping.

- [ ] **Step 2: Add CHANGELOG entry under `[Unreleased]`**

Edit `CHANGELOG.md`. Under the existing `## [Unreleased]` section, add an `### Changed` block (creating it if missing) with:

```markdown
### Changed
- **BREAKING: Marketplace publish no longer rewrites `CHANGELOG.md`.** `vat claude marketplace publish` now mirrors the source `CHANGELOG.md` byte-for-byte into the publish tree and extracts release notes for the commit body only. Accepts both Keep a Changelog workflows: a pre-stamped `[X.Y.Z]` section matching `package.json` (preferred) or a non-empty `[Unreleased]` section (fallback). Fails if neither is present. Workflow A adopters whose `main` branch CHANGELOG continues to carry `[Unreleased]` at publish time will see that heading on the publish branch too — stamp `CHANGELOG.md` on `main` before tagging if you want a stamped heading in the published file. Side benefit: corrections/typo-fixes to `CHANGELOG.md` on `main` now propagate to the publish branch on the next publish.
```

- [ ] **Step 3: Re-run validation after changelog edit**

Run: `bun run validate`
Expected: all checks PASS. (The CHANGELOG edit is unlikely to affect tests; this run confirms nothing cached is stale.)

- [ ] **Step 4: Ask user about version bump**

Per the Pre-Pull-Request Checklist in `CLAUDE.md`:

> "Changelog updated. This is a breaking change to marketplace publish behavior. Would you like to bump the version or create an RC for this change?"

Wait for the user's answer before committing.

- [ ] **Step 5: Commit the changelog (and version bump if requested)**

If no bump:
```bash
git add CHANGELOG.md
git commit -m "docs: add changelog entry for verbatim marketplace changelog"
```

If bump requested (replace `<version>`):
```bash
bun run bump-version <version>
git add -A
git commit -m "chore: bump version to <version>"
```

- [ ] **Step 6: Dogfood the audit command (best-effort, not a hard gate)**

Per the CLAUDE.md "Dogfooding" guidance, run:

```bash
bun run vat audit --user --verbose 2>&1 | head -20
bun run vat audit packages/vat-development-agents/dist/skills/ 2>&1 | head -20
```

Look for regressions or unexpected errors. This change is to publish, not audit or skills, so no regressions are expected — but run it anyway.

- [ ] **Step 7: Create the PR**

Follow the standard PR creation workflow in `~/.claude/CLAUDE.md` / project CLAUDE.md.

Suggested PR title: `fix(cli): marketplace publish mirrors CHANGELOG verbatim (BREAKING)`

PR body should include:
- Summary of the behavior change (dual-source extraction, verbatim copy, never mutates).
- Breaking-change note and migration advice (stamp on main before tagging).
- Link to the adopter bug report.
- Test plan: unit tests for `parseVersionSection`, updated compose tests covering all 5 behavior-matrix rows.

---

## Self-Review Checklist

**Spec coverage** — map the behavior matrix to tests:

| Matrix row | Test |
|---|---|
| `[Unreleased]` content, no `[version]` → verbatim + extract from `[Unreleased]` | `should compose tree with marketplace artifacts, changelog, readme, and license` |
| `[Unreleased]` empty, `[version]` present → verbatim + extract from `[version]` | `should publish a pre-stamped changelog when [Unreleased] is empty (Workflow B)` |
| Both have content → verbatim, prefer `[version]` for commit body | `should prefer stamped [X.Y.Z] over [Unreleased] when both have content` |
| Both empty → error naming both patterns | `should fail when changelog has neither unreleased content nor matching version section` |
| `[Unreleased]` empty, `[version]` present but **different** → error | covered by the same "neither" test, which uses `version: '1.0.0'` against a CHANGELOG containing `[0.1.0]` only |

**Placeholder scan:** none. Every step has concrete code or commands.

**Type consistency:**
- `parseVersionSection(changelog: string, version: string): string` — defined Task 1, used Task 2.
- `parseUnreleasedSection(changelog: string): string` — unchanged.
- `stampChangelog` — **deleted**. No residual references.
- `ComposeOptions.date` — removed (Task 2 Step 4). Any residual reference will fail typecheck in Step 6 and must be cleaned up.
- `ComposeResult.changelogDelta` — contract unchanged (trimmed release-notes string).

**Edge cases explicitly tested:**
- Semver pre-release suffix (`1.2.0-rc.1`): regex escape covers `.`, `+`, `-`.
- Substring non-match (`'1.2'` must NOT match `[1.2.0]`): heading regex anchors on `\]`.
- Last section in file (no following `## [` heading): `VERSION_HEADING_RE.exec(rest)` returns null, helper returns `rest.trim()`.
- Verbatim copy byte-identity: compose test uses `toBe(sourceChangelog)`, not `toContain(...)`.
- Duplicate-heading risk: eliminated by construction (no stamping ever) — tests assert exactly one heading instance where it matters.

**Not changed (intentional):**
- `publish.ts:233` `readProjectVersion()` — version flow unchanged (still threaded for commit message + log only).
- `git-publish.ts` `createCommitMessage()` — `changelogDelta` contract unchanged.
- `UNRELEASED_HEADING_RE`, `VERSION_HEADING_RE` constants — retained.
- Config schema — no new fields.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-09-marketplace-publish-verbatim-changelog.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. This matches your project preference in `~/.claude/CLAUDE.md` ("always prefer the superpowers subagent driven development skill").

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

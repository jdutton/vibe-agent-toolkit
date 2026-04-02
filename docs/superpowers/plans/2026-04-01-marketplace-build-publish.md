# Marketplace Build & Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **EXECUTION GUIDANCE (from project owner):**
> - **Use subagent-driven development** — dispatch fresh subagents per task.
> - **Do NOT commit on every task.** Batch up commits to *meaningful* changes that have tests written.
> - **Run `vv validate` before completing each batch** and fix all failures before moving on.
> - **The main agent/session should validate and commit** before starting the next batch of changes — do not ask the user to commit mid-batch.
> - Commit granularity = a batch of related tasks that compile, pass lint, pass tests, and pass `vv validate`.

**Goal:** Add marketplace publish, standalone validation, and self-dogfooding so users can distribute skills via Git branches without npm.

**Architecture:** Extend the existing `vat claude` command group with a `marketplace` subcommand group containing `publish` and `validate`. The publish command composes a publish tree from `vat build` output + changelog/readme/license, then pushes it as a squashed commit to a configurable branch. Validation reuses existing `validatePlugin`/`validateMarketplace` from `agent-skills` with strict severity escalation. Config schema gets a `publish` section on `ClaudeMarketplaceSchema`.

**Tech Stack:** TypeScript, Commander.js, Zod, Node.js `child_process` for git operations, `node:fs` for tree composition.

---

## File Map

### New Files

| File | Purpose |
|------|---------|
| `packages/resources/src/schemas/spdx-licenses.ts` | SPDX license ID list + MIT/Apache-2.0 license text templates |
| `packages/cli/src/commands/claude/marketplace/index.ts` | `vat claude marketplace` command group registration |
| `packages/cli/src/commands/claude/marketplace/validate.ts` | `vat claude marketplace validate [path]` — standalone strict validation |
| `packages/cli/src/commands/claude/marketplace/publish.ts` | `vat claude marketplace publish` — compose tree + git push |
| `packages/cli/src/commands/claude/marketplace/changelog-utils.ts` | Parse Keep-a-Changelog, stamp `[Unreleased]`, extract delta |
| `packages/cli/src/commands/claude/marketplace/license-utils.ts` | Resolve SPDX shortcut → text or copy file |
| `packages/cli/src/commands/claude/marketplace/publish-tree.ts` | Compose the publish tree in a temp directory |
| `packages/cli/src/commands/claude/marketplace/git-publish.ts` | Git operations: fetch/create branch, commit, push |
| `packages/cli/test/commands/claude/marketplace/changelog-utils.test.ts` | Unit tests for changelog parsing/stamping |
| `packages/cli/test/commands/claude/marketplace/license-utils.test.ts` | Unit tests for license resolution |
| `packages/cli/test/commands/claude/marketplace/publish-tree.test.ts` | Unit tests for tree composition |
| `packages/cli/test/system/marketplace-validate.system.test.ts` | System tests for `vat claude marketplace validate` |
| `packages/cli/test/system/marketplace-publish.system.test.ts` | System tests for `vat claude marketplace publish --dry-run` |
| `docs/marketplace-changelog.md` | Marketplace changelog for self-dogfooding |
| `docs/marketplace-readme.md` | Marketplace README for self-dogfooding |

### Modified Files

| File | Change |
|------|--------|
| `packages/resources/src/schemas/project-config.ts` | Add `publish` section to `ClaudeMarketplaceSchema` |
| `packages/resources/src/index.ts` | Export new schema types if needed |
| `packages/agent-skills/src/validators/plugin-validator.ts` | Accept `strict` mode param to escalate PLUGIN_MISSING_VERSION to error |
| `packages/agent-skills/src/validators/types.ts` | Add new issue codes for marketplace validation |
| `packages/cli/src/commands/claude/index.ts` | Register `marketplace` subcommand group |
| `packages/cli/src/commands/verify.ts` | Add `marketplace` phase when marketplace config exists |
| `packages/cli/src/bin.ts` | No changes needed (claude command already registered) |
| `packages/vat-development-agents/vibe-agent-toolkit.config.yaml` | Add `publish` section for self-dogfooding |
| `packages/vat-development-agents/resources/skills/vat-skills-distribution.md` | Add marketplace publish workflow + npx/bunx section |
| `packages/vat-development-agents/resources/skills/SKILL.md` | Add "Running VAT" section with npx/bunx |

---

## Task 1: Extend Config Schema with `publish` Section

**Files:**
- Modify: `packages/resources/src/schemas/project-config.ts`
- Test: `packages/resources/test/schemas/project-config.test.ts`

This task adds the `publish` sub-schema to the marketplace config so `vat claude marketplace publish` knows where to push.

- [ ] **Step 1: Read existing config schema tests**

Read `packages/resources/test/schemas/project-config.test.ts` to understand test patterns.

- [ ] **Step 2: Write failing tests for publish config**

Add tests to `packages/resources/test/schemas/project-config.test.ts`:

```typescript
describe('ClaudeMarketplaceSchema with publish config', () => {
  it('should accept valid publish config with all fields', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      publish: {
        branch: 'claude-marketplace',
        remote: 'origin',
        changelog: 'docs/marketplace-changelog.md',
        readme: 'docs/marketplace-readme.md',
        license: 'mit',
        sourceRepo: false,
      },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('should accept publish config with only license', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      publish: { license: 'mit' },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('should accept license as file path', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      publish: { license: './LICENSE' },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('should accept marketplace config without publish section', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/resources && bun run test:unit -- --grep "publish config"`
Expected: FAIL — `publish` key rejected by `.strict()`

- [ ] **Step 4: Add publish schema to project-config.ts**

In `packages/resources/src/schemas/project-config.ts`, add before `ClaudeMarketplaceSchema`:

```typescript
/**
 * Publish configuration for a Claude marketplace.
 * Controls where and how the marketplace is published to a Git branch or repo.
 */
export const ClaudeMarketplacePublishSchema = z.object({
  branch: z.string().optional()
    .describe('Target branch name (default: claude-marketplace)'),
  remote: z.string().optional()
    .describe('Git remote name or URL (default: origin)'),
  changelog: z.string().optional()
    .describe('Path to source changelog file (Keep a Changelog format)'),
  readme: z.string().optional()
    .describe('Path to source README file for the marketplace'),
  license: z.string().optional()
    .describe('SPDX license identifier (e.g., "mit") or file path (e.g., "./LICENSE")'),
  sourceRepo: z.union([z.boolean(), z.string()]).optional()
    .describe('Source repo URL for commit metadata (false to disable, string to override)'),
}).strict().describe('Publish configuration for marketplace distribution');

export type ClaudeMarketplacePublish = z.infer<typeof ClaudeMarketplacePublishSchema>;
```

Then add `publish` to `ClaudeMarketplaceSchema`:

```typescript
export const ClaudeMarketplaceSchema = z.object({
  owner: z.object({
    name: z.string(),
    email: z.string().optional(),
  }).strict().describe('Marketplace owner information'),

  skills: z.union([z.literal('*'), z.array(z.string())]).optional()
    .describe('Default skill selectors for this marketplace'),

  publish: ClaudeMarketplacePublishSchema.optional()
    .describe('Publish configuration for marketplace distribution'),

  plugins: z.array(ClaudeMarketplacePluginEntrySchema).min(1)
    .describe('Plugin groupings within this marketplace'),
}).strict().describe('Configuration for a Claude plugin marketplace');
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/resources && bun run test:unit`
Expected: PASS

---

## Task 2: SPDX License Utilities

**Files:**
- Create: `packages/cli/src/commands/claude/marketplace/license-utils.ts`
- Create: `packages/cli/test/commands/claude/marketplace/license-utils.test.ts`

- [ ] **Step 1: Write failing tests for license utilities**

Create `packages/cli/test/commands/claude/marketplace/license-utils.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  isFilePath,
  generateLicenseText,
  isSpdxIdentifier,
} from '../../../src/commands/claude/marketplace/license-utils.js';

describe('license-utils', () => {
  describe('isFilePath', () => {
    it('should detect file paths with slashes', () => {
      expect(isFilePath('./LICENSE')).toBe(true);
      expect(isFilePath('docs/LICENSE-ENTERPRISE')).toBe(true);
    });

    it('should detect file paths with dots', () => {
      expect(isFilePath('LICENSE.txt')).toBe(true);
    });

    it('should not treat SPDX identifiers as file paths', () => {
      expect(isFilePath('mit')).toBe(false);
      expect(isFilePath('apache-2.0')).toBe(false);
      expect(isFilePath('gpl-3.0')).toBe(false);
    });
  });

  describe('isSpdxIdentifier', () => {
    it('should recognize common SPDX identifiers (case-insensitive)', () => {
      expect(isSpdxIdentifier('mit')).toBe(true);
      expect(isSpdxIdentifier('MIT')).toBe(true);
      expect(isSpdxIdentifier('apache-2.0')).toBe(true);
      expect(isSpdxIdentifier('Apache-2.0')).toBe(true);
      expect(isSpdxIdentifier('gpl-3.0')).toBe(true);
    });

    it('should reject unknown identifiers', () => {
      expect(isSpdxIdentifier('not-a-license')).toBe(false);
      expect(isSpdxIdentifier('./LICENSE')).toBe(false);
    });
  });

  describe('generateLicenseText', () => {
    it('should generate MIT license text with owner and year', () => {
      const text = generateLicenseText('mit', 'Test Org', 2026);
      expect(text).toContain('MIT License');
      expect(text).toContain('Test Org');
      expect(text).toContain('2026');
      expect(text).toContain('Permission is hereby granted');
    });

    it('should generate Apache 2.0 license text', () => {
      const text = generateLicenseText('apache-2.0', 'Test Org', 2026);
      expect(text).toContain('Apache License');
      expect(text).toContain('Version 2.0');
      expect(text).toContain('Test Org');
      expect(text).toContain('2026');
    });

    it('should throw for unknown SPDX identifier', () => {
      expect(() => generateLicenseText('unknown', 'Org', 2026)).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun run test:unit -- --grep "license-utils"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement license-utils.ts**

Create `packages/cli/src/commands/claude/marketplace/license-utils.ts`:

```typescript
/**
 * License resolution utilities for marketplace publish.
 *
 * Handles SPDX shortcut identifiers (e.g., "mit" → full MIT license text)
 * and file path references (e.g., "./LICENSE" → copy as-is).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Known SPDX identifiers (lowercase). Extend as needed. */
const KNOWN_SPDX_IDS = new Set([
  'mit',
  'apache-2.0',
  'gpl-2.0',
  'gpl-3.0',
  'lgpl-2.1',
  'lgpl-3.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'mpl-2.0',
  'unlicense',
]);

/**
 * Check if a license value looks like a file path (contains `/` or `.`).
 */
export function isFilePath(value: string): boolean {
  return value.includes('/') || value.includes('.');
}

/**
 * Check if a value is a known SPDX license identifier (case-insensitive).
 */
export function isSpdxIdentifier(value: string): boolean {
  return KNOWN_SPDX_IDS.has(value.toLowerCase());
}

/**
 * Read a license file from disk.
 */
export function readLicenseFile(filePath: string, baseDir: string): string {
  const resolved = resolve(baseDir, filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
  return readFileSync(resolved, 'utf-8');
}

/**
 * Generate standard license text for a known SPDX identifier.
 */
export function generateLicenseText(spdxId: string, ownerName: string, year: number): string {
  const id = spdxId.toLowerCase();

  switch (id) {
    case 'mit':
      return `MIT License

Copyright (c) ${year} ${ownerName}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

    case 'apache-2.0':
      return `Copyright ${year} ${ownerName}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`;

    default:
      if (!KNOWN_SPDX_IDS.has(id)) {
        throw new Error(`Unknown SPDX license identifier: "${spdxId}". Use a file path instead.`);
      }
      return `This software is licensed under the ${spdxId} license.

Copyright (c) ${year} ${ownerName}
`;
  }
}

/**
 * Resolve a license config value to LICENSE file content.
 *
 * @param licenseValue - SPDX identifier or file path from config
 * @param ownerName - Owner name for generated license text
 * @param baseDir - Base directory for resolving file paths
 * @returns License text content
 */
export function resolveLicense(
  licenseValue: string,
  ownerName: string,
  baseDir: string
): string {
  if (isFilePath(licenseValue)) {
    return readLicenseFile(licenseValue, baseDir);
  }

  if (!isSpdxIdentifier(licenseValue)) {
    throw new Error(
      `"${licenseValue}" is neither a known SPDX identifier nor a file path. ` +
      `Use a known identifier (mit, apache-2.0, etc.) or a file path (./LICENSE).`
    );
  }

  return generateLicenseText(licenseValue, ownerName, new Date().getFullYear());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && bun run test:unit -- --grep "license-utils"`
Expected: PASS

---

## Task 3: Changelog Utilities

**Files:**
- Create: `packages/cli/src/commands/claude/marketplace/changelog-utils.ts`
- Create: `packages/cli/test/commands/claude/marketplace/changelog-utils.test.ts`

- [ ] **Step 1: Write failing tests for changelog utilities**

Create `packages/cli/test/commands/claude/marketplace/changelog-utils.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  parseUnreleasedSection,
  stampChangelog,
} from '../../../src/commands/claude/marketplace/changelog-utils.js';

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

  describe('stampChangelog', () => {
    it('should replace [Unreleased] with version and date', () => {
      const result = stampChangelog(SAMPLE_CHANGELOG, '0.2.0', '2026-04-01');
      expect(result).toContain('## [0.2.0] - 2026-04-01');
      expect(result).not.toContain('[Unreleased]');
      expect(result).toContain('New marketplace publish command');
    });

    it('should preserve content before and after unreleased section', () => {
      const result = stampChangelog(SAMPLE_CHANGELOG, '0.2.0', '2026-04-01');
      expect(result).toContain('# Changelog');
      expect(result).toContain('## [0.1.0] - 2026-03-15');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun run test:unit -- --grep "changelog-utils"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement changelog-utils.ts**

Create `packages/cli/src/commands/claude/marketplace/changelog-utils.ts`:

```typescript
/**
 * Changelog parsing and stamping utilities for marketplace publish.
 *
 * Follows Keep a Changelog format: https://keepachangelog.com/
 * Parses [Unreleased] section and stamps it with version + date on publish.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regex to match the [Unreleased] heading (case-insensitive).
 * Captures everything up to the next version heading or end of file.
 */
const UNRELEASED_HEADING_RE = /^## \[unreleased\]\s*$/im;
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
 * Replace `## [Unreleased]` with `## [version] - date` in changelog text.
 * Returns the full modified changelog string.
 */
export function stampChangelog(changelog: string, version: string, date: string): string {
  return changelog.replace(UNRELEASED_HEADING_RE, `## [${version}] - ${date}`);
}

/**
 * Read a changelog file from disk.
 */
export function readChangelog(filePath: string, baseDir: string): string {
  const resolved = resolve(baseDir, filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
  return readFileSync(resolved, 'utf-8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && bun run test:unit -- --grep "changelog-utils"`
Expected: PASS

---

## Task 4: Publish Tree Composition

**Files:**
- Create: `packages/cli/src/commands/claude/marketplace/publish-tree.ts`
- Create: `packages/cli/test/commands/claude/marketplace/publish-tree.test.ts`

- [ ] **Step 1: Write failing tests for publish tree composition**

Create `packages/cli/test/commands/claude/marketplace/publish-tree.test.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { composePublishTree, type ComposeOptions } from '../../../src/commands/claude/marketplace/publish-tree.js';

function createTempDir(prefix: string): string {
  const { mkdtempSync } = await import('node:fs');
  return mkdtempSync(join(normalizedTmpdir(), prefix));
}
// Note: tests will need to adapt to sync/async patterns used in the codebase.
// The actual test implementation should follow existing test-common.ts patterns.

describe('publish-tree', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(join(normalizedTmpdir(), 'vat-publish-tree-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    const fs = require('node:fs');
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('should compose tree with marketplace artifacts, changelog, readme, and license', async () => {
    const sourceDir = makeTempDir();
    const outputDir = makeTempDir();

    // Create mock marketplace build output
    const mpDir = join(sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', 'test-mp');
    const pluginDir = join(mpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'marketplace.json'), '{"name":"test-mp"}');

    // Create changelog source
    const changelogPath = join(sourceDir, 'CHANGELOG.md');
    writeFileSync(changelogPath, '# Changelog\n\n## [Unreleased]\n\n### Added\n- Feature\n');

    // Create readme source
    const readmePath = join(sourceDir, 'README.md');
    writeFileSync(readmePath, '# My Marketplace\n');

    const result = await composePublishTree({
      marketplaceName: 'test-mp',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
      changelog: { sourcePath: 'CHANGELOG.md' },
      readme: { sourcePath: 'README.md' },
      license: { type: 'spdx', value: 'mit', ownerName: 'Test Org' },
    });

    expect(existsSync(join(outputDir, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'CHANGELOG.md'))).toBe(true);
    expect(existsSync(join(outputDir, 'README.md'))).toBe(true);
    expect(existsSync(join(outputDir, 'LICENSE'))).toBe(true);
    expect(result.version).toBe('1.0.0');

    // Changelog should be stamped
    const changelogContent = readFileSync(join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toContain('[1.0.0] - 2026-04-01');
  });

  it('should fail when build output does not exist', async () => {
    const sourceDir = makeTempDir();
    const outputDir = makeTempDir();

    await expect(composePublishTree({
      marketplaceName: 'nonexistent',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
    })).rejects.toThrow(/build output/i);
  });

  it('should fail when changelog has empty unreleased section', async () => {
    const sourceDir = makeTempDir();
    const outputDir = makeTempDir();

    // Create marketplace build output
    const mpDir = join(sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', 'test-mp', '.claude-plugin');
    mkdirSync(mpDir, { recursive: true });
    writeFileSync(join(mpDir, 'marketplace.json'), '{}');

    // Empty unreleased changelog
    writeFileSync(join(sourceDir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n');

    await expect(composePublishTree({
      marketplaceName: 'test-mp',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
      changelog: { sourcePath: 'CHANGELOG.md' },
    })).rejects.toThrow(/empty/i);
  });
});
```

Note: The test above is a **sketch** — the implementing agent must adapt imports and patterns to match `test-common.ts` (use `mkdtempSync` from `node:fs`, not `require`). The assertions capture the intended behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun run test:unit -- --grep "publish-tree"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement publish-tree.ts**

Create `packages/cli/src/commands/claude/marketplace/publish-tree.ts`:

```typescript
/**
 * Compose a publish tree from build output + metadata files.
 *
 * Takes the marketplace artifacts from dist/.claude/plugins/marketplaces/<name>/
 * and combines them with CHANGELOG.md, README.md, and LICENSE into a clean
 * directory ready to be committed to the publish branch.
 */

import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseUnreleasedSection, readChangelog, stampChangelog } from './changelog-utils.js';
import { generateLicenseText, readLicenseFile } from './license-utils.js';

export interface ChangelogOptions {
  sourcePath: string;
}

export interface ReadmeOptions {
  sourcePath: string;
}

export type LicenseOptions =
  | { type: 'spdx'; value: string; ownerName: string }
  | { type: 'file'; filePath: string };

export interface ComposeOptions {
  marketplaceName: string;
  configDir: string;
  outputDir: string;
  version: string;
  date: string;
  changelog?: ChangelogOptions;
  readme?: ReadmeOptions;
  license?: LicenseOptions;
}

export interface ComposeResult {
  version: string;
  changelogDelta: string;
  files: string[];
}

export async function composePublishTree(options: ComposeOptions): Promise<ComposeResult> {
  const { marketplaceName, configDir, outputDir, version, date } = options;
  const files: string[] = [];
  let changelogDelta = '';

  // 1. Verify build output exists
  const buildDir = join(configDir, 'dist', '.claude', 'plugins', 'marketplaces', marketplaceName);
  if (!existsSync(buildDir)) {
    throw new Error(
      `Marketplace build output not found at ${buildDir}. Run "vat build" first.`
    );
  }

  // 2. Copy marketplace artifacts to output
  await cp(buildDir, outputDir, { recursive: true });
  files.push('.claude-plugin/marketplace.json', 'plugins/');

  // 3. Process changelog
  if (options.changelog) {
    const rawChangelog = readChangelog(options.changelog.sourcePath, configDir);
    const unreleased = parseUnreleasedSection(rawChangelog);

    if (unreleased.trim() === '') {
      throw new Error(
        `Changelog "${options.changelog.sourcePath}" has an empty [Unreleased] section. ` +
        `Add release notes before publishing.`
      );
    }

    changelogDelta = unreleased.trim();
    const stamped = stampChangelog(rawChangelog, version, date);
    await writeFile(join(outputDir, 'CHANGELOG.md'), stamped);
    files.push('CHANGELOG.md');
  }

  // 4. Process readme
  if (options.readme) {
    const readmePath = resolve(configDir, options.readme.sourcePath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
    const readmeContent = readFileSync(readmePath, 'utf-8');
    await writeFile(join(outputDir, 'README.md'), readmeContent);
    files.push('README.md');
  }

  // 5. Process license
  if (options.license) {
    let licenseContent: string;
    if (options.license.type === 'spdx') {
      licenseContent = generateLicenseText(
        options.license.value,
        options.license.ownerName,
        new Date().getFullYear()
      );
    } else {
      licenseContent = readLicenseFile(options.license.filePath, configDir);
    }
    await writeFile(join(outputDir, 'LICENSE'), licenseContent);
    files.push('LICENSE');
  }

  return { version, changelogDelta, files };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && bun run test:unit -- --grep "publish-tree"`
Expected: PASS

---

## Task 5: Git Publish Operations

**Files:**
- Create: `packages/cli/src/commands/claude/marketplace/git-publish.ts`
- Create: `packages/cli/test/commands/claude/marketplace/git-publish.test.ts`

- [ ] **Step 1: Write failing tests for git publish operations**

Create `packages/cli/test/commands/claude/marketplace/git-publish.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommitMessage,
  type PublishGitOptions,
} from '../../../src/commands/claude/marketplace/git-publish.js';

describe('git-publish', () => {
  describe('createCommitMessage', () => {
    it('should format commit message with version and changelog delta', () => {
      const msg = createCommitMessage('1.0.0', '### Added\n- Feature A\n- Feature B');
      expect(msg).toContain('publish v1.0.0');
      expect(msg).toContain('### Added');
      expect(msg).toContain('Feature A');
    });

    it('should include source repo metadata when provided', () => {
      const msg = createCommitMessage('1.0.0', '### Added\n- Feature', {
        sourceRepo: 'https://github.com/org/repo',
        commitRange: 'abc123..def456',
      });
      expect(msg).toContain('Source: https://github.com/org/repo');
      expect(msg).toContain('abc123..def456');
    });

    it('should work without changelog delta', () => {
      const msg = createCommitMessage('1.0.0', '');
      expect(msg).toContain('publish v1.0.0');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun run test:unit -- --grep "git-publish"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement git-publish.ts**

Create `packages/cli/src/commands/claude/marketplace/git-publish.ts`:

```typescript
/**
 * Git operations for marketplace publish.
 *
 * Handles: fetch/create orphan branch, stage tree, squash commit, push.
 * Uses child_process.spawnSync for git commands (no external dependencies).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';

import type { Logger } from '../../../utils/logger.js';

export interface CommitMetadata {
  sourceRepo?: string;
  commitRange?: string;
}

export interface PublishGitOptions {
  publishDir: string;
  branch: string;
  remote: string;
  commitMessage: string;
  force: boolean;
  dryRun: boolean;
  logger: Logger;
}

/**
 * Format a commit message for marketplace publish.
 */
export function createCommitMessage(
  version: string,
  changelogDelta: string,
  metadata?: CommitMetadata
): string {
  const lines = [`publish v${version}`];

  if (changelogDelta) {
    lines.push('', changelogDelta);
  }

  if (metadata?.sourceRepo) {
    lines.push('', `Source: ${metadata.sourceRepo}`);
    if (metadata.commitRange) {
      lines.push(`Commits: ${metadata.commitRange}`);
    }
  }

  return lines.join('\n');
}

/**
 * Execute a git command and return the result.
 * Throws on non-zero exit code unless allowFailure is true.
 */
function git(
  args: string[],
  options: { cwd: string; allowFailure?: boolean }
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${status}):\n${result.stderr ?? ''}`
    );
  }

  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status,
  };
}

/**
 * Publish the composed tree to a git branch.
 *
 * Strategy:
 * 1. Create a temp repo
 * 2. Init it and add the publish tree content
 * 3. Fetch the existing branch (if any) from the remote
 * 4. Create a new commit on top of the branch history
 * 5. Push to the remote
 */
export async function publishToGitBranch(options: PublishGitOptions): Promise<void> {
  const { publishDir, branch, remote, commitMessage, force, dryRun, logger } = options;

  // Resolve the remote URL if it's a name (e.g., "origin")
  const cwd = process.cwd();
  let remoteUrl = remote;
  if (!remote.includes('/') && !remote.includes(':')) {
    // It's a remote name — resolve to URL
    const urlResult = git(['remote', 'get-url', remote], { cwd, allowFailure: true });
    if (urlResult.status === 0) {
      remoteUrl = urlResult.stdout;
    } else {
      throw new Error(`Git remote "${remote}" not found. Configure it or use a full URL.`);
    }
  }

  logger.info(`   Remote: ${remoteUrl}`);
  logger.info(`   Branch: ${branch}`);

  // Create a temporary git repo for staging
  const tmpRepo = mkdtempSync(join(normalizedTmpdir(), 'vat-marketplace-publish-'));
  logger.debug(`   Staging repo: ${tmpRepo}`);

  try {
    // Init temp repo
    git(['init'], { cwd: tmpRepo });
    git(['checkout', '-b', branch], { cwd: tmpRepo });

    // Try to fetch existing branch history
    const fetchResult = git(
      ['fetch', remoteUrl, `${branch}:${branch}`],
      { cwd: tmpRepo, allowFailure: true }
    );

    const branchExists = fetchResult.status === 0;
    if (branchExists && !force) {
      // Reset to the fetched branch to build on top of existing history
      git(['reset', '--soft', branch], { cwd: tmpRepo });
    }

    // Copy publish tree content into temp repo
    const cpResult = spawnSync('cp', ['-r', `${publishDir}/.`, tmpRepo], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if ((cpResult.status ?? 1) !== 0) {
      // Fallback for Windows: use Node.js copy
      const { cpSync } = await import('node:fs');
      cpSync(publishDir, tmpRepo, { recursive: true });
    }

    // Stage all files
    git(['add', '-A'], { cwd: tmpRepo });

    // Check if there are changes to commit
    const diffResult = git(['diff', '--cached', '--quiet'], { cwd: tmpRepo, allowFailure: true });
    if (diffResult.status === 0) {
      logger.info('   No changes to publish (tree is identical to current branch)');
      return;
    }

    // Create commit
    git(['commit', '-m', commitMessage], { cwd: tmpRepo });

    if (dryRun) {
      logger.info('   [dry-run] Would push to remote. Commit created locally at:');
      logger.info(`   ${tmpRepo}`);

      // Show what would be pushed
      const log = git(['log', '--oneline', '-1'], { cwd: tmpRepo });
      logger.info(`   Commit: ${log.stdout}`);

      const diffStat = git(['diff', '--stat', 'HEAD~1..HEAD'], { cwd: tmpRepo, allowFailure: true });
      if (diffStat.status === 0) {
        logger.info(`   Changes:\n${diffStat.stdout}`);
      }
      return;
    }

    // Push
    const pushArgs = ['push', remoteUrl, `${branch}:${branch}`];
    if (force) {
      pushArgs.splice(1, 0, '--force');
    }
    git(pushArgs, { cwd: tmpRepo });
    logger.info(`   Pushed to ${remoteUrl} branch ${branch}`);
  } finally {
    // Cleanup temp repo (unless dry-run, where user might want to inspect)
    if (!dryRun) {
      const { rmSync } = await import('node:fs');
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && bun run test:unit -- --grep "git-publish"`
Expected: PASS

---

## Task 6: Marketplace Validate Command (Standalone)

**Files:**
- Create: `packages/cli/src/commands/claude/marketplace/index.ts`
- Create: `packages/cli/src/commands/claude/marketplace/validate.ts`
- Modify: `packages/cli/src/commands/claude/index.ts`
- Modify: `packages/agent-skills/src/validators/plugin-validator.ts`
- Modify: `packages/agent-skills/src/validators/types.ts`
- Create: `packages/cli/test/system/marketplace-validate.system.test.ts`

This task creates the `vat claude marketplace validate [path]` command — standalone strict marketplace validation. It reuses the existing audit discovery logic but with strict severity (PLUGIN_MISSING_VERSION → error, missing LICENSE → error, etc.).

- [ ] **Step 1: Add new issue codes to types.ts**

In `packages/agent-skills/src/validators/types.ts`, add to the `IssueCode` union:

```typescript
  // Marketplace validation (strict mode)
  | 'MARKETPLACE_MISSING_LICENSE'
  | 'MARKETPLACE_MISSING_README'
  | 'MARKETPLACE_MISSING_CHANGELOG'
  | 'MARKETPLACE_MISSING_VERSION'
```

- [ ] **Step 2: Add strict mode parameter to validatePlugin**

Modify `packages/agent-skills/src/validators/plugin-validator.ts` to accept an optional `strict` parameter. When `strict: true`, `PLUGIN_MISSING_VERSION` becomes an error instead of a warning:

```typescript
export async function validatePlugin(
  pluginPath: string,
  options?: { strict?: boolean }
): Promise<ValidationResult> {
  // ... existing code ...

  // Where PLUGIN_MISSING_VERSION is emitted, change severity based on strict:
  if (result.data.version === undefined) {
    issues.push({
      severity: options?.strict ? 'error' : 'warning',
      code: 'PLUGIN_MISSING_VERSION',
      message: 'plugin.json missing version field — Claude Code will cache as "unknown/", causing stale skill resolution across upgrades',
      location: pluginJsonPath,
      fix: 'Add a "version" field to plugin.json (semver format, e.g. "1.0.0")',
    });
    // ...
  }
```

Ensure existing callers (audit.ts) don't pass `strict`, preserving current warning behavior.

- [ ] **Step 3: Create marketplace command group index**

Create `packages/cli/src/commands/claude/marketplace/index.ts`:

```typescript
import { Command } from 'commander';

import { createMarketplacePublishCommand } from './publish.js';
import { createMarketplaceValidateCommand } from './validate.js';

export function createMarketplaceCommand(): Command {
  const command = new Command('marketplace');

  command
    .description('Validate and publish Claude plugin marketplaces')
    .helpCommand(false)
    .addHelpText('after', `
Description:
  Standalone marketplace validation and publishing.

  validate: Strict validation of a marketplace directory (works without config)
  publish:  Push built marketplace to a Git branch for distribution

Example:
  $ vat claude marketplace validate .                  # Validate current directory
  $ vat claude marketplace publish                     # Publish to claude-marketplace branch
  $ vat claude marketplace publish --dry-run           # Preview publish without pushing
`);

  command.addCommand(createMarketplaceValidateCommand());
  command.addCommand(createMarketplacePublishCommand());

  return command;
}
```

- [ ] **Step 4: Create marketplace validate command**

Create `packages/cli/src/commands/claude/marketplace/validate.ts`:

```typescript
/**
 * `vat claude marketplace validate [path]` — standalone strict marketplace validation.
 *
 * Reuses audit discovery logic but with strict expectations:
 * - Missing version → error (not warning)
 * - Missing LICENSE → error
 * - Bad plugin.json → error
 * - Missing README → warning
 * - Missing CHANGELOG → warning
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import {
  validateMarketplace,
  validatePlugin,
  validateSkill,
  type ValidationResult,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-skills';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';

export interface MarketplaceValidateOptions {
  debug?: boolean;
}

export function createMarketplaceValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate a marketplace directory with strict requirements')
    .argument('[path]', 'Path to marketplace directory (default: current directory)')
    .option('--debug', 'Enable debug logging')
    .action(marketplaceValidateCommand)
    .addHelpText('after', `
Description:
  Validates a marketplace directory against strict publishing requirements.
  Works without a vibe-agent-toolkit.config.yaml — inspects the directory directly.

  Strict checks (error if missing):
  - .claude-plugin/marketplace.json must exist and be valid
  - Each plugin must have valid plugin.json with version
  - LICENSE file must exist
  - All SKILL.md files must be valid

  Advisory checks (warning if missing):
  - README.md
  - CHANGELOG.md

Exit Codes:
  0 - Valid marketplace
  1 - Validation errors
  2 - System error

Example:
  $ vat claude marketplace validate .
  $ vat claude marketplace validate path/to/marketplace
`);

  return command;
}

async function marketplaceValidateCommand(
  targetPath: string | undefined,
  options: MarketplaceValidateOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const marketplacePath = targetPath ? resolve(targetPath) : process.cwd();
    logger.info(`Validating marketplace at: ${marketplacePath}`);

    const results: ValidationResult[] = [];

    // 1. Validate marketplace.json
    const mpResult = await validateMarketplace(marketplacePath);
    results.push(mpResult);

    // 2. Check LICENSE exists (error if missing)
    if (!existsSync(join(marketplacePath, 'LICENSE'))) {
      mpResult.issues.push({
        severity: 'error',
        code: 'MARKETPLACE_MISSING_LICENSE' as ValidationIssue['code'],
        message: 'Marketplace must include a LICENSE file for distribution',
        location: join(marketplacePath, 'LICENSE'),
        fix: 'Add a LICENSE file or configure license in publish settings',
      });
    }

    // 3. Check README (warning if missing)
    if (!existsSync(join(marketplacePath, 'README.md'))) {
      mpResult.issues.push({
        severity: 'warning',
        code: 'MARKETPLACE_MISSING_README' as ValidationIssue['code'],
        message: 'Marketplace should include a README.md for discoverability',
        location: join(marketplacePath, 'README.md'),
        fix: 'Add a README.md describing the marketplace and its plugins',
      });
    }

    // 4. Check CHANGELOG (warning if missing)
    if (!existsSync(join(marketplacePath, 'CHANGELOG.md'))) {
      mpResult.issues.push({
        severity: 'warning',
        code: 'MARKETPLACE_MISSING_CHANGELOG' as ValidationIssue['code'],
        message: 'Marketplace should include a CHANGELOG.md for version history',
        location: join(marketplacePath, 'CHANGELOG.md'),
        fix: 'Add a CHANGELOG.md following Keep a Changelog format',
      });
    }

    // 5. Validate each plugin directory (strict mode)
    const pluginsDir = join(marketplacePath, 'plugins');
    if (existsSync(pluginsDir)) {
      const { readdirSync } = await import('node:fs');
      const entries = readdirSync(pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginPath = join(pluginsDir, entry.name);
          const pluginResult = await validatePlugin(pluginPath, { strict: true });
          results.push(pluginResult);

          // Validate skills within plugin
          const skillsDir = join(pluginPath, 'skills');
          if (existsSync(skillsDir)) {
            const skillEntries = readdirSync(skillsDir, { withFileTypes: true });
            for (const skillEntry of skillEntries) {
              if (skillEntry.isDirectory()) {
                const skillMd = join(skillsDir, skillEntry.name, 'SKILL.md');
                if (existsSync(skillMd)) {
                  const skillResult = await validateSkill({ skillPath: skillMd });
                  results.push(skillResult);
                }
              }
            }
          }
        }
      }
    }

    // Recalculate marketplace result status after adding issues
    const hasErrors = mpResult.issues.some(i => i.severity === 'error');
    const hasWarnings = mpResult.issues.some(i => i.severity === 'warning');
    mpResult.status = hasErrors ? 'error' : hasWarnings ? 'warning' : 'success';
    mpResult.summary = hasErrors
      ? `Found ${mpResult.issues.filter(i => i.severity === 'error').length} error(s)`
      : mpResult.summary;

    // Output
    const totalErrors = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
    const totalWarnings = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'warning').length, 0);

    writeYamlOutput({
      status: totalErrors > 0 ? 'error' : totalWarnings > 0 ? 'warning' : 'success',
      summary: {
        filesScanned: results.length,
        errors: totalErrors,
        warnings: totalWarnings,
      },
      files: results,
      duration: `${Date.now() - startTime}ms`,
    });

    if (totalErrors > 0) {
      logger.error(`Marketplace validation failed: ${totalErrors} error(s)`);
      for (const r of results) {
        for (const issue of r.issues.filter(i => i.severity === 'error')) {
          logger.error(`  [${issue.code}] ${issue.message}`);
          if (issue.location) logger.error(`    at: ${issue.location}`);
          if (issue.fix) logger.error(`    fix: ${issue.fix}`);
        }
      }
      process.exit(1);
    }

    if (totalWarnings > 0) {
      logger.info(`Marketplace valid with ${totalWarnings} warning(s)`);
    } else {
      logger.info('Marketplace validation passed');
    }
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MarketplaceValidate');
  }
}
```

- [ ] **Step 5: Register marketplace command in claude/index.ts**

In `packages/cli/src/commands/claude/index.ts`, add:

```typescript
import { createMarketplaceCommand } from './marketplace/index.js';
// ...
command.addCommand(createMarketplaceCommand());
```

- [ ] **Step 6: Create system test for marketplace validate**

Create `packages/cli/test/system/marketplace-validate.system.test.ts` following the test-common.ts patterns. Test:
- Valid marketplace directory → exit 0
- Missing marketplace.json → exit 1
- Missing LICENSE → exit 1 with MARKETPLACE_MISSING_LICENSE
- Missing version in plugin.json → exit 1 with PLUGIN_MISSING_VERSION error (not warning)
- Missing README → exit 0 with warning

- [ ] **Step 7: Run all tests**

Run: `bun run validate`
Expected: PASS

---

## Task 7: Marketplace Publish Command

**Files:**
- Create: `packages/cli/src/commands/claude/marketplace/publish.ts`
- Create: `packages/cli/test/system/marketplace-publish.system.test.ts`

- [ ] **Step 1: Implement the publish command**

Create `packages/cli/src/commands/claude/marketplace/publish.ts`:

```typescript
/**
 * `vat claude marketplace publish` — push built marketplace to a git branch.
 *
 * Prerequisites:
 * - `vat build` has been run (dist/.claude/plugins/marketplaces/<name>/ exists)
 * - Marketplace config has a `publish` section
 * - Changelog has [Unreleased] content (if changelog configured)
 *
 * Flow:
 * 1. Load config, resolve version
 * 2. Compose publish tree (marketplace + changelog + readme + license)
 * 3. Create squashed commit on target branch
 * 4. Push to remote
 */

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
import { loadClaudeProjectConfig } from '../claude-config.js';

import { isFilePath, isSpdxIdentifier } from './license-utils.js';
import { createCommitMessage, publishToGitBranch } from './git-publish.js';
import { composePublishTree, type LicenseOptions } from './publish-tree.js';

export interface MarketplacePublishOptions {
  dryRun?: boolean;
  branch?: string;
  force?: boolean;
  marketplace?: string;
  debug?: boolean;
}

export function createMarketplacePublishCommand(): Command {
  const command = new Command('publish');

  command
    .description('Publish built marketplace to a Git branch')
    .option('--dry-run', 'Show what would be published without pushing')
    .option('--branch <name>', 'Override publish branch')
    .option('--force', 'Force-push (first publish or recovery)')
    .option('--marketplace <name>', 'Publish specific marketplace only')
    .option('--debug', 'Enable debug logging')
    .action(marketplacePublishCommand)
    .addHelpText('after', `
Description:
  Pushes built marketplace artifacts to a Git branch for distribution.
  Requires vat build to have been run first.

  Composes:
  - Marketplace artifacts from dist/.claude/plugins/marketplaces/
  - CHANGELOG.md (stamped with version and date)
  - README.md
  - LICENSE (SPDX shortcut or file)

  Creates one squashed commit per version on the target branch.

Output:
  YAML summary → stdout
  Progress → stderr

Exit Codes:
  0 - Published successfully (or dry-run completed)
  1 - Publish error (missing build, empty changelog)
  2 - System error

Example:
  $ vat build && vat claude marketplace publish
  $ vat claude marketplace publish --dry-run
  $ vat claude marketplace publish --force          # First publish
`);

  return command;
}

async function marketplacePublishCommand(options: MarketplacePublishOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { configPath, configDir, claudeConfig } = await loadClaudeProjectConfig();

    if (!claudeConfig?.marketplaces || Object.keys(claudeConfig.marketplaces).length === 0) {
      throw new Error('No claude.marketplaces configured in ' + configPath);
    }

    // Resolve version from package.json
    let packageVersion: string | undefined;
    try {
      const pkgPath = join(configDir, 'package.json');
      const pkgRaw = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      packageVersion = pkg.version;
    } catch {
      // No package.json
    }

    if (!packageVersion) {
      throw new Error('No version found in package.json. Set a version before publishing.');
    }

    const results: Array<{ name: string; status: string; version: string }> = [];

    for (const [name, mpConfig] of Object.entries(claudeConfig.marketplaces)) {
      if (options.marketplace && options.marketplace !== name) continue;

      const publishConfig = mpConfig.publish;
      if (!publishConfig) {
        logger.info(`Skipping "${name}" — no publish config`);
        continue;
      }

      logger.info(`\n📦 Publishing marketplace: ${name}`);

      const branch = options.branch ?? publishConfig.branch ?? 'claude-marketplace';
      const remote = publishConfig.remote ?? 'origin';
      const date = new Date().toISOString().slice(0, 10);

      // Compose publish tree in temp directory
      const outputDir = mkdtempSync(join(normalizedTmpdir(), `vat-publish-${name}-`));

      // Resolve license options
      let licenseOpts: LicenseOptions | undefined;
      if (publishConfig.license) {
        if (isFilePath(publishConfig.license)) {
          licenseOpts = { type: 'file', filePath: publishConfig.license };
        } else if (isSpdxIdentifier(publishConfig.license)) {
          licenseOpts = { type: 'spdx', value: publishConfig.license, ownerName: mpConfig.owner.name };
        } else {
          throw new Error(`Invalid license value: "${publishConfig.license}". Use an SPDX ID or file path.`);
        }
      }

      const composeResult = await composePublishTree({
        marketplaceName: name,
        configDir,
        outputDir,
        version: packageVersion,
        date,
        changelog: publishConfig.changelog ? { sourcePath: publishConfig.changelog } : undefined,
        readme: publishConfig.readme ? { sourcePath: publishConfig.readme } : undefined,
        license: licenseOpts,
      });

      // Resolve source repo metadata
      const metadata = publishConfig.sourceRepo
        ? { sourceRepo: typeof publishConfig.sourceRepo === 'string' ? publishConfig.sourceRepo : undefined }
        : undefined;

      const commitMessage = createCommitMessage(
        packageVersion,
        composeResult.changelogDelta,
        metadata
      );

      // Git publish
      await publishToGitBranch({
        publishDir: outputDir,
        branch,
        remote,
        commitMessage,
        force: options.force ?? false,
        dryRun: options.dryRun ?? false,
        logger,
      });

      results.push({ name, status: 'published', version: packageVersion });
    }

    const duration = Date.now() - startTime;
    writeYamlOutput({
      status: 'success',
      marketplaces: results,
      duration: `${duration}ms`,
    });

    if (options.dryRun) {
      logger.info('\n[dry-run] No changes pushed. Review output above.');
    } else {
      logger.info('\n✅ Marketplace published successfully');
      logger.info(`Install with: /plugin marketplace add <owner>/<repo>#${options.branch ?? 'claude-marketplace'}`);
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MarketplacePublish');
  }
}
```

- [ ] **Step 2: Create system test for marketplace publish --dry-run**

Create `packages/cli/test/system/marketplace-publish.system.test.ts`. Test scenarios:
- Publish with `--dry-run` flag → exit 0, shows what would be committed
- Publish fails when no build output exists → exit 1
- Publish fails when no publish config → exit 1
- Publish fails when changelog has empty [Unreleased] → exit 1

These tests should create a temp directory with config, built artifacts, and run the CLI.

- [ ] **Step 3: Run all tests**

Run: `bun run validate`
Expected: PASS

---

## Task 8: Integrate Marketplace Validation into `vat verify`

**Files:**
- Modify: `packages/cli/src/commands/verify.ts`

- [ ] **Step 1: Add marketplace phase to verify command**

Modify `buildPhaseList` in `packages/cli/src/commands/verify.ts`:

```typescript
import { loadConfig } from '../utils/config-loader.js';

function hasClaudeMarketplacesConfig(cwd: string): boolean {
  try {
    const config = loadConfig(cwd);
    return Boolean(config?.claude?.marketplaces && Object.keys(config.claude.marketplaces).length > 0);
  } catch {
    return false;
  }
}

function buildPhaseList(options: VerifyCommandOptions): Phase[] {
  const { only } = options;
  const cwd = process.cwd();
  const phases: Phase[] = [];

  if (!only || only === 'resources') {
    phases.push({ name: 'resources', args: ['resources', 'validate'] });
  }

  if (!only || only === 'skills') {
    phases.push({ name: 'skills', args: ['skills', 'validate'] });
  }

  if (!only || only === 'marketplace') {
    // Only add marketplace phase when config exists and build output is present
    if (hasClaudeMarketplacesConfig(cwd)) {
      phases.push({ name: 'marketplace', args: ['claude', 'marketplace', 'validate'] });
    }
  }

  return phases;
}
```

Update the description and help text to mention the marketplace phase:

```typescript
command
  .description('Verify all project artifacts in dependency order (resources → skills → marketplace)')
  .option('--only <phase>', 'Verify only a specific phase: resources, skills, marketplace')
```

Update `validPhaseNames` in the action to `'resources, skills, marketplace'`.

- [ ] **Step 2: Update the existing build-verify system test**

Add a test case to `packages/cli/test/system/build-verify.system.test.ts` that verifies the marketplace phase runs when config exists. After build, write marketplace artifacts to the expected location, then run verify and check it passes.

- [ ] **Step 3: Run all tests**

Run: `bun run validate`
Expected: PASS

---

## Task 9: Self-Dogfooding — Configure VAT's Own Marketplace

**Files:**
- Modify: `packages/vat-development-agents/vibe-agent-toolkit.config.yaml`
- Create: `docs/marketplace-changelog.md`
- Create: `docs/marketplace-readme.md`

- [ ] **Step 1: Update vibe-agent-toolkit.config.yaml with publish section**

```yaml
version: 1

skills:
  include: ["resources/skills/SKILL.md", "resources/skills/vat-*.md"]
  defaults:
    linkFollowDepth: 2
    excludeNavigationFiles: true
  config:
    vibe-agent-toolkit:
      linkFollowDepth: 0
    authoring:
      linkFollowDepth: 0
    debugging:
      linkFollowDepth: 0

claude:
  marketplaces:
    vat-skills:
      owner:
        name: vibe-agent-toolkit contributors
      publish:
        branch: claude-marketplace
        changelog: docs/marketplace-changelog.md
        readme: docs/marketplace-readme.md
        license: mit
      plugins:
        - name: vibe-agent-toolkit
          description: Development agents and skills for building with vibe-agent-toolkit
          skills: "*"
```

- [ ] **Step 2: Create docs/marketplace-changelog.md**

```markdown
# Changelog

All notable changes to the vibe-agent-toolkit marketplace will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Initial marketplace publish via `vat claude marketplace publish`
- Skills: vibe-agent-toolkit, distribution, resources, audit, authoring, debugging, install, org-admin
```

- [ ] **Step 3: Create docs/marketplace-readme.md**

```markdown
# vibe-agent-toolkit Skills Marketplace

Development agents and skills for building with [vibe-agent-toolkit](https://github.com/jdutton/vibe-agent-toolkit).

## Install

```
/plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace
```

## Skills

| Skill | Description |
|-------|-------------|
| vibe-agent-toolkit | Router skill — covers agent creation, CLI commands, skill packaging |
| distribution | Build, publish & install pipeline for Claude plugins |
| resources | Resource collections, frontmatter validation, link checking |
| audit | Plugin and skill validation with `vat audit` |
| authoring | SKILL.md authoring and agent architecture design |
| debugging | Debug unexpected VAT behavior and test fixes |
| install | Install/uninstall architecture reference |
| org-admin | Anthropic org administration for Enterprise/Team admins |

## Running VAT

```bash
vat <command>                     # Global install
npx vibe-agent-toolkit <command>  # npm (no install)
bunx vibe-agent-toolkit <command> # Bun (no install)
```

## License

MIT
```

---

## Task 10: Update Skills for npx/bunx and Marketplace Publish

**Files:**
- Modify: `packages/vat-development-agents/resources/skills/vat-skills-distribution.md`
- Modify: `packages/vat-development-agents/resources/skills/SKILL.md`

- [ ] **Step 1: Add marketplace publish and npx/bunx to distribution skill**

Add a section to `packages/vat-development-agents/resources/skills/vat-skills-distribution.md` covering:

1. **Marketplace Distribution** section after the existing npm pipeline section:
   - How marketplace distribution works (build → publish → branch)
   - Configuration (the `publish` section in config YAML)
   - Publish workflow (`vat build && vat claude marketplace publish`)
   - Consumer install via `/plugin marketplace add owner/repo#claude-marketplace`

2. **Running VAT Without Global Install** section:
   ```
   npx vibe-agent-toolkit <command>    # npm/Node.js
   bunx vibe-agent-toolkit <command>   # Bun
   ```

- [ ] **Step 2: Add "Running VAT" section to router skill**

Add to `packages/vat-development-agents/resources/skills/SKILL.md` a section:

```markdown
## Running VAT

VAT can be run without a global install:

```bash
vat <command>                     # If installed globally
npx vibe-agent-toolkit <command>  # npm (downloads on demand)
bunx vibe-agent-toolkit <command> # Bun (downloads on demand)
```

All `vat` commands in this skill and sub-skills accept these alternatives.
```

- [ ] **Step 3: Rebuild skills to verify**

Run: `bun run vat skills build`
Expected: Builds successfully with updated skill content.

---

## Task 11: Final Validation and Build

- [ ] **Step 1: Run full validation**

Run: `bun run validate`
Expected: All phases pass (resources, skills, marketplace if wired up).

- [ ] **Step 2: Run duplication check**

Run: `bun run duplication-check`
Expected: PASS — no new duplication introduced.

- [ ] **Step 3: Run full build**

Run: `bun run build`
Expected: Skills build + claude plugin build succeeds.

- [ ] **Step 4: Dogfood audit**

Run: `bun run vat audit --user --verbose 2>&1 | head -20`
Expected: No new errors or regressions.

- [ ] **Step 5: Test dry-run publish**

Run: `cd packages/vat-development-agents && bun run vat claude marketplace publish --dry-run`
Expected: Shows composed tree and commit message without pushing.

---

## Implementation Notes for Agents

### Critical Patterns to Follow

1. **ESLint**: This project uses `--max-warnings=0`. All `fs` calls on non-literal paths need `// eslint-disable-next-line security/detect-non-literal-fs-filename` with a comment explaining why the path is safe.

2. **Imports**: Use `node:fs` prefix. Use `import type` for type-only imports. No default exports.

3. **Tests**: Follow `test-common.ts` patterns. Use `createTempDirTracker` for temp dirs. Use `executeCli` + `getBinPath` for system tests. See `packages/cli/test/system/build-verify.system.test.ts` for reference.

4. **Strict schemas**: All new schemas use `.strict()` per Postel's Law (this is our own config, not external data).

5. **No `bun test`**: Always use `bun run test:unit`, `bun run test:integration`, etc.

6. **Cross-platform**: Use `normalizedTmpdir()` from `@vibe-agent-toolkit/utils` for temp dirs, not `os.tmpdir()`.

7. **Git safety**: The `git-publish.ts` never runs `--force` unless the user explicitly passes `--force`. Default is accumulating history.

### Dependency Order

Tasks 1-5 have no inter-dependencies and can be parallelized. Task 6 depends on Tasks 1-5. Task 7 depends on Tasks 2-5. Task 8 depends on Task 6. Tasks 9-10 are independent docs/config tasks. Task 11 is the final integration check.

### Commit Batching Strategy

**Do NOT commit per-task.** Batch commits around meaningful, validated milestones:

| Batch | Tasks (parallel where possible) | Commit after `vv validate` passes |
|-------|-------------------------------|----------------------------------|
| **Batch 1** | Tasks 1, 2, 3, 5 (schema + utilities) | Yes — "feat(cli): add marketplace publish config schema and utilities" |
| **Batch 2** | Tasks 4, 9, 10 (publish tree + docs) | Yes — "feat(cli): add publish tree composition and marketplace docs" |
| **Batch 3** | Task 6 (marketplace validate command) | Yes — "feat(cli): add vat claude marketplace validate command" |
| **Batch 4** | Task 7 (marketplace publish command) | Yes — "feat(cli): add vat claude marketplace publish command" |
| **Batch 5** | Task 8 (verify integration) | Yes — "feat(cli): integrate marketplace validation into vat verify" |
| **Batch 6** | Task 11 (final integration) | Final commit if any fixups needed |

**Between each batch**: the main agent runs `vv validate`, fixes all failures, then commits before dispatching the next batch. The user should not need to intervene between batches.

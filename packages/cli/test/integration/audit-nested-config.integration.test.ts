/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: nested vibe-agent-toolkit.config.yaml files are honored
 * when `vat audit` is run from the monorepo root.
 *
 * Exercises limitation fix for "nearest-ancestor config" per SKILL.md:
 * when a subdirectory has its own config.yaml with skills section and
 * `excludeReferencesFromBundle` rules, those rules suppress
 * LINK_OUTSIDE_PROJECT for skills in that subdirectory — even when the
 * audit is launched from a parent directory with a different (or no skills)
 * config.
 *
 * Regression: skills in subdirectories WITHOUT a config.yaml still fire
 * LINK_OUTSIDE_PROJECT (confirms nested-config discovery is scoped to dirs
 * that actually have a config).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAudit } from '../test-helpers.js';

/**
 * Write a SKILL.md that contains a link to an external file (relative to its
 * own directory, but outside any bundle root), which would normally fire
 * LINK_OUTSIDE_PROJECT.
 *
 * The link target: `../../external-docs/guide.md` — referencing a file
 * at the scan root level, which is outside the pkg's own subtree.
 */
function writeSkillWithExternalLink(skillPath: string, skillName: string): void {
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    `---
name: ${skillName}
description: A test skill that links to external docs.
---

# ${skillName}

See [the guide](../../external-docs/guide.md) for details.
`,
  );
}

/**
 * Write a minimal external doc that the SKILL.md links to, so the link is
 * not broken (we want LINK_OUTSIDE_PROJECT, not BROKEN_LINK).
 */
function writeExternalDoc(docPath: string): void {
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, `# Guide\n\nSome external guidance.\n`);
}

/**
 * Write a root-level config (no skills section — just resources).
 * Also writes a package.json with "workspaces" so findProjectRoot treats
 * rootDir as the workspace root (same as a real monorepo).
 */
function writeRootConfig(rootDir: string): void {
  fs.writeFileSync(
    safePath.join(rootDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1\n\nresources:\n  exclude:\n    - "node_modules/**"\n`,
  );
  // Workspace root marker so findProjectRoot picks up rootDir as project root.
  fs.writeFileSync(
    safePath.join(rootDir, 'package.json'),
    JSON.stringify({ name: 'test-monorepo', workspaces: ['pkg-*'] }),
  );
}

/**
 * Write a nested config WITH a skills section that declares
 * excludeReferencesFromBundle to allow external doc references.
 */
function writeNestedConfigWithExclude(pkgDir: string, skillGlob: string): void {
  fs.writeFileSync(
    safePath.join(pkgDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1\n\nskills:\n  include:\n    - "${skillGlob}"\n  defaults:\n    excludeReferencesFromBundle:\n      rules:\n        - patterns:\n            - "external-docs/**"\n`,
  );
}

describe('audit nested config discovery (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-nested-cfg-'));

    // Initialize a git repo so resolveGitRootForScan returns non-null.
    // Without git, buildVATProjectContext is skipped (git guard in scanDirectory).
    // Files must be `git add`-ed so crawlDirectory (which uses git ls-files) finds them.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
    spawnSync('git', ['init', '-b', 'main', '--quiet', tempDir], { stdio: 'ignore' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
    spawnSync('git', ['-C', tempDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
    spawnSync('git', ['-C', tempDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });

    // Root config (no skills section)
    writeRootConfig(tempDir);

    // External doc that SKILL.md files link to (lives at scan root level)
    writeExternalDoc(safePath.join(tempDir, 'external-docs', 'guide.md'));

    // pkg-a: HAS its own config with excludeReferencesFromBundle
    const pkgADir = safePath.join(tempDir, 'pkg-a');
    const pkgASkillPath = safePath.join(pkgADir, 'resources', 'skills', 'SKILL.md');
    writeSkillWithExternalLink(pkgASkillPath, 'pkg-a-skill');
    writeNestedConfigWithExclude(pkgADir, 'resources/skills/SKILL.md');

    // pkg-b: NO config of its own — should still fire LINK_OUTSIDE_PROJECT
    const pkgBDir = safePath.join(tempDir, 'pkg-b');
    const pkgBSkillPath = safePath.join(pkgBDir, 'resources', 'skills', 'SKILL.md');
    writeSkillWithExternalLink(pkgBSkillPath, 'pkg-b-skill');
    // (No vibe-agent-toolkit.config.yaml in pkg-b — intentionally)

    // Track all files so crawlDirectory (git ls-files mode) can find them.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for staging files in tests
    spawnSync('git', ['-C', tempDir, 'add', '.'], { stdio: 'ignore' });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pkg-a: LINK_OUTSIDE_PROJECT is suppressed because pkg-a config excludes external-docs/**', async () => {
    const results = await runAudit(tempDir, { recursive: true });
    const pkgAResult = results.find(r => r.path.includes('pkg-a'));

    expect(pkgAResult).toBeDefined();
    const linkOutsideIssues = (pkgAResult?.issues ?? []).filter(
      i => i.code === 'LINK_OUTSIDE_PROJECT',
    );
    expect(linkOutsideIssues).toHaveLength(0);
  });

  it('pkg-b: LINK_OUTSIDE_PROJECT still fires because pkg-b has no config', async () => {
    const results = await runAudit(tempDir, { recursive: true });
    const pkgBResult = results.find(r => r.path.includes('pkg-b'));

    expect(pkgBResult).toBeDefined();
    const linkOutsideIssues = (pkgBResult?.issues ?? []).filter(
      i => i.code === 'LINK_OUTSIDE_PROJECT',
    );
    expect(linkOutsideIssues.length).toBeGreaterThan(0);
  });

  it('non-recursive mode: only uses root config (ignores nested configs)', async () => {
    // With --no-recursive, buildVATProjectContext should not walk into subdirs.
    // pkg-a skill won't even be found (it's in a subdir), so no results from it.
    const results = await runAudit(tempDir, { recursive: false });
    // Non-recursive: only looks at top-level entries. Neither SKILL.md is at root.
    const pkgAResult = results.find(r => r.path.includes('pkg-a'));
    expect(pkgAResult).toBeUndefined();
  });
});

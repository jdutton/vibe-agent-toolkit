/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: per-skill walk-up to the nearest-ancestor
 * `vibe-agent-toolkit.config.yaml`.
 *
 * VAT's design: one config per VAT project. Configs do NOT compose across
 * projects. Audit walks UP from each discovered SKILL.md to its
 * nearest-ancestor config and applies ONLY that skill's declared packaging
 * rules. Sibling configs never contaminate each other.
 *
 * Fixture:
 *   tempDir/
 *     vibe-agent-toolkit.config.yaml     (root — resources-only, no skills)
 *     external-docs/guide.md
 *     pkg-a/
 *       vibe-agent-toolkit.config.yaml   (declares pkg-a-skill with
 *                                          excludeReferencesFromBundle rule)
 *       resources/skills/SKILL.md        (links to ../../../external-docs/)
 *     pkg-b/
 *       resources/skills/SKILL.md        (no governing pkg-b config)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAudit } from '../test-helpers.js';

/**
 * Write a SKILL.md that references an external doc via a relative path that
 * escapes the skill's bundle root. Without a suppressing rule this fires
 * LINK_OUTSIDE_PROJECT under packaging validation.
 */
function writeSkillWithExternalLink(skillPath: string, skillName: string): void {
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    `---
name: ${skillName}
description: A test skill that links to external docs for per-skill config verification.
---

# ${skillName}

See [the guide](../../../external-docs/guide.md) for details.
`,
  );
}

/** Write the external doc the SKILLs point at (so links are not broken). */
function writeExternalDoc(docPath: string): void {
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, `# Guide\n\nExternal guidance content.\n`);
}

/**
 * Root config: resources-only (no skills section). Mirrors the VAT monorepo
 * pattern where the top-level config exists for resources validation but
 * declares no skills itself.
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
 * pkg-a's config declares pkg-a-skill explicitly in `skills.config` with an
 * `excludeReferencesFromBundle` rule that suppresses external-docs links.
 */
function writePkgAConfig(pkgDir: string): void {
  fs.writeFileSync(
    safePath.join(pkgDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1

skills:
  include:
    - "resources/skills/SKILL.md"
  config:
    pkg-a-skill:
      excludeReferencesFromBundle:
        rules:
          - patterns:
              - "external-docs/**"
`,
  );
}

/**
 * Run audit and collect LINK_OUTSIDE_PROJECT issues for the skill whose
 * path contains `pkgMarker`. Returns `{ result, linkOutsideIssues }` so
 * each test can assert on whatever shape it needs.
 */
async function auditAndCollectLinkOutside(
  scanDir: string,
  pkgMarker: string,
): Promise<{
  result: Awaited<ReturnType<typeof runAudit>>[number] | undefined;
  linkOutsideIssues: Array<{ code: string; message: string }>;
}> {
  const results = await runAudit(scanDir, { recursive: true });
  const result = results.find(r => r.path.includes(pkgMarker));
  const linkOutsideIssues = (result?.issues ?? []).filter(
    i => i.code === 'LINK_OUTSIDE_PROJECT',
  );
  return { result, linkOutsideIssues };
}

describe('audit per-skill walk-up to nearest-ancestor config (integration)', () => {
  let tempDir: string;
  let pkgADir: string;
  let pkgBDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-nested-cfg-'));

    // Git init so resolveScanContext returns a real git root and the walker
    // can use git ls-files to find fixtures.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
    spawnSync('git', ['init', '-b', 'main', '--quiet', tempDir], { stdio: 'ignore' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
    spawnSync('git', ['-C', tempDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
    spawnSync('git', ['-C', tempDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });

    // Root config (no skills section)
    writeRootConfig(tempDir);

    // External doc the SKILL.md files link to (lives at repo root)
    writeExternalDoc(safePath.join(tempDir, 'external-docs', 'guide.md'));

    // pkg-a: governing config suppresses LINK_OUTSIDE_PROJECT for pkg-a-skill.
    pkgADir = safePath.join(tempDir, 'pkg-a');
    writeSkillWithExternalLink(
      safePath.join(pkgADir, 'resources', 'skills', 'SKILL.md'),
      'pkg-a-skill',
    );
    writePkgAConfig(pkgADir);

    // pkg-b: NO governing config — walk-up finds the root config which has
    // no skills section, so wild mode / default rules apply. The skill's
    // external link should still fire LINK_OUTSIDE_PROJECT.
    pkgBDir = safePath.join(tempDir, 'pkg-b');
    writeSkillWithExternalLink(
      safePath.join(pkgBDir, 'resources', 'skills', 'SKILL.md'),
      'pkg-b-skill',
    );

    // Track all files so crawlDirectory (git ls-files mode) can find them.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for staging files in tests
    spawnSync('git', ['-C', tempDir, 'add', '.'], { stdio: 'ignore' });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pkg-a: LINK_OUTSIDE_PROJECT suppressed because pkg-a config excludes external-docs/**', async () => {
    const { result, linkOutsideIssues } = await auditAndCollectLinkOutside(tempDir, 'pkg-a');
    expect(result).toBeDefined();
    expect(linkOutsideIssues).toHaveLength(0);
  });

  it('pkg-b: LINK_OUTSIDE_PROJECT still fires — pkg-a rule does NOT compose into pkg-b', async () => {
    const { result, linkOutsideIssues } = await auditAndCollectLinkOutside(tempDir, 'pkg-b');
    expect(result).toBeDefined();
    expect(linkOutsideIssues.length).toBeGreaterThan(0);
    // Sanity: the firing link targets the external doc, proving the rule
    // from pkg-a did not bleed across sibling configs.
    expect(linkOutsideIssues[0]?.message ?? '').toContain('external-docs');
  });

  it('auditing from inside pkg-a directly still suppresses pkg-a-skill warning', async () => {
    // Same outcome via a different invocation path: running audit from
    // inside pkg-a walks up to pkg-a's own config.
    const { result, linkOutsideIssues } = await auditAndCollectLinkOutside(pkgADir, 'pkg-a');
    expect(result).toBeDefined();
    expect(linkOutsideIssues).toHaveLength(0);
  });
});

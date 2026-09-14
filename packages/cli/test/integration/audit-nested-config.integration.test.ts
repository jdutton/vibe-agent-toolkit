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
 *     vibe-agent-toolkit.config.yaml     (root — declares pkg-b-skill, raising
 *                                          LINK_OUTSIDE_SKILL_DIR to warning)
 *     external-docs/guide.md
 *     pkg-a/
 *       vibe-agent-toolkit.config.yaml   (declares pkg-a-skill, ignoring both
 *                                          boundary codes)
 *       resources/skills/SKILL.md        (links to ../../../external-docs/)
 *     pkg-b/
 *       resources/skills/SKILL.md        (no pkg-b config; governed by the root)
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitAddAll, initTestGitRepo, runAudit } from '../test-helpers.js';

/**
 * Write a SKILL.md that references an external doc via a relative path that
 * escapes the skill's directory. Which boundary it crosses depends on the
 * governing config: under pkg-a's the target is outside the PROJECT
 * (`LINK_OUTSIDE_PROJECT`); under the root's it is inside the project but
 * outside the SKILL DIRECTORY (`LINK_OUTSIDE_SKILL_DIR`, silent by default).
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
 * Root config: declares pkg-b-skill and raises its skill-directory boundary to
 * `warning`, so pkg-b has a finding that pkg-a's `ignore` could wrongly erase.
 */
function writeRootConfig(rootDir: string): void {
  fs.writeFileSync(
    safePath.join(rootDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1

resources:
  exclude:
    - "node_modules/**"

skills:
  include:
    - "pkg-b/resources/skills/SKILL.md"
  config:
    pkg-b-skill:
      validation:
        severity:
          LINK_OUTSIDE_SKILL_DIR: warning
`,
  );
  // Workspace root marker so findProjectRoot picks up rootDir as project root.
  fs.writeFileSync(
    safePath.join(rootDir, 'package.json'),
    JSON.stringify({ name: 'test-monorepo', workspaces: ['pkg-*'] }),
  );
}

/** The two boundary codes; see {@link writeSkillWithExternalLink}. */
const BOUNDARY_CODES = new Set(['LINK_OUTSIDE_PROJECT', 'LINK_OUTSIDE_SKILL_DIR']);

/**
 * pkg-a's config declares pkg-a-skill explicitly in `skills.config` with a
 * `validation.severity` override that demotes BOTH boundary codes to `ignore`
 * for that skill. Updated for canonical projectRoot semantics — see plan
 * 2026-05-17. Under the new model, pkg-a is the nearest-ancestor config so
 * external-docs is genuinely outside its project root. Audit deliberately
 * ignores `validation.allow` (it shows every potential issue) but DOES honor
 * `validation.severity` (which is exactly the per-skill walk-up signal this
 * test exists to verify).
 *
 * Both codes, not just the one pkg-a's link crosses: the non-composition claim
 * below is "nothing in this config reaches pkg-b", and pkg-b's finding is the
 * OTHER code. Ignoring only `LINK_OUTSIDE_PROJECT` here would let pkg-b's
 * finding survive for a reason that has nothing to do with composition.
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
      validation:
        severity:
          LINK_OUTSIDE_PROJECT: ignore
          LINK_OUTSIDE_SKILL_DIR: ignore
`,
  );
}

/**
 * Run audit and collect the boundary-code issues (either lane's) for the skill
 * whose path contains `pkgMarker`. Returns `{ result, linkOutsideIssues }` so
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
    i => BOUNDARY_CODES.has(i.code),
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
    initTestGitRepo(tempDir);

    // Root config (no skills section)
    writeRootConfig(tempDir);

    // External doc the SKILL.md files link to (lives at repo root)
    writeExternalDoc(safePath.join(tempDir, 'external-docs', 'guide.md'));

    // pkg-a: governing config suppresses both boundary codes for pkg-a-skill.
    pkgADir = safePath.join(tempDir, 'pkg-a');
    writeSkillWithExternalLink(
      safePath.join(pkgADir, 'resources', 'skills', 'SKILL.md'),
      'pkg-a-skill',
    );
    writePkgAConfig(pkgADir);

    // pkg-b: NO pkg-b config — walk-up finds the root config, which declares
    // pkg-b-skill and raises LINK_OUTSIDE_SKILL_DIR for it.
    pkgBDir = safePath.join(tempDir, 'pkg-b');
    writeSkillWithExternalLink(
      safePath.join(pkgBDir, 'resources', 'skills', 'SKILL.md'),
      'pkg-b-skill',
    );

    // Track all files so crawlDirectory (git ls-files mode) can find them.
    gitAddAll(tempDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pkg-a: boundary codes suppressed via validation.severity in pkg-a config', async () => {
    const { result, linkOutsideIssues } = await auditAndCollectLinkOutside(tempDir, 'pkg-a');
    expect(result).toBeDefined();
    expect(linkOutsideIssues).toHaveLength(0);
  });

  it('pkg-b: LINK_OUTSIDE_SKILL_DIR fires at the root config\'s warning — pkg-a rule does NOT compose into pkg-b', async () => {
    const { result, linkOutsideIssues } = await auditAndCollectLinkOutside(tempDir, 'pkg-b');
    expect(result).toBeDefined();
    // Emitted by the packaging walker for a target inside the project, and only
    // that code: the project-root escape does not apply to this link.
    expect(linkOutsideIssues.map(i => [i.code, i.severity])).toEqual([['LINK_OUTSIDE_SKILL_DIR', 'warning']]);
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

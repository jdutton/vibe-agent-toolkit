/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: `vat audit` honors `resources.exclude` from config.
 *
 * When a `vibe-agent-toolkit.config.yaml` contains `resources.exclude` patterns,
 * those patterns should be applied to `vat audit` directory scans in the same
 * way that `--exclude` CLI flag patterns are applied.
 *
 * Rationale: both commands scan the same project; users reasonably expect one
 * exclude list to cover both `vat resources` and `vat audit`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAudit } from '../test-helpers.js';

/**
 * Initialize a git repo at the given directory and configure identity.
 * Required so that resolveGitRootForScan returns non-null and
 * crawlDirectory (git ls-files mode) can find staged files.
 */
function initGitRepo(dir: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
  spawnSync('git', ['init', '-b', 'main', '--quiet', dir], { stdio: 'ignore' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
}

/**
 * Stage all files in a git repo so crawlDirectory (git ls-files mode) finds them.
 */
function gitAddAll(dir: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for staging files in tests
  spawnSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
}

/**
 * Write a SKILL.md that references a script that does not exist.
 * This causes LINK_INTEGRITY_BROKEN for the missing `scripts/cli.mjs`.
 */
function writeSkillWithBrokenLink(skillPath: string, skillName: string): void {
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    `---
name: ${skillName}
description: A test skill with a broken link.
---

# ${skillName}

Run the tool with:

\`\`\`bash
node scripts/cli.mjs
\`\`\`
`,
  );
}

/**
 * Write a minimal VAT config with resources.exclude patterns.
 */
function writeConfigWithResourcesExclude(dir: string, excludePatterns: string[]): void {
  const patternsYaml = excludePatterns.map(p => `    - "${p}"`).join('\n');
  fs.writeFileSync(
    safePath.join(dir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1\n\nresources:\n  exclude:\n${patternsYaml}\n`,
  );
}

describe('audit honors resources.exclude from config (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-res-excl-'));

    initGitRepo(tempDir);

    // Config with resources.exclude: ["fixtures/**"]
    writeConfigWithResourcesExclude(tempDir, ['fixtures/**']);

    // SKILL.md with a broken link inside the excluded fixtures dir
    writeSkillWithBrokenLink(
      safePath.join(tempDir, 'fixtures', 'skills', 'tool-x', 'SKILL.md'),
      'tool-x',
    );

    // SKILL.md with a broken link that is NOT in the excluded dir (control)
    writeSkillWithBrokenLink(
      safePath.join(tempDir, 'skills', 'tool-y', 'SKILL.md'),
      'tool-y',
    );

    gitAddAll(tempDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('excluded SKILL.md (fixtures/**) is not scanned', async () => {
    const results = await runAudit(tempDir, { recursive: true });

    // The skill under fixtures/ should NOT appear in results at all
    const excludedResult = results.find(r => r.path.includes('tool-x'));
    expect(excludedResult).toBeUndefined();
  });

  it('non-excluded SKILL.md (skills/tool-y) is still scanned', async () => {
    const results = await runAudit(tempDir, { recursive: true });

    // The skill NOT under fixtures/ should appear in results
    const includedResult = results.find(r => r.path.includes('tool-y'));
    expect(includedResult).toBeDefined();
  });

  it('no config resources.exclude: both SKILL.md files are scanned (regression)', async () => {
    // Create a separate temp dir with no resources.exclude
    const noExcludeTempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-no-excl-'));
    try {
      initGitRepo(noExcludeTempDir);

      // Config with NO resources.exclude
      fs.writeFileSync(
        safePath.join(noExcludeTempDir, 'vibe-agent-toolkit.config.yaml'),
        'version: 1\n',
      );

      writeSkillWithBrokenLink(
        safePath.join(noExcludeTempDir, 'fixtures', 'skills', 'tool-x', 'SKILL.md'),
        'tool-x',
      );
      writeSkillWithBrokenLink(
        safePath.join(noExcludeTempDir, 'skills', 'tool-y', 'SKILL.md'),
        'tool-y',
      );
      gitAddAll(noExcludeTempDir);

      const results = await runAudit(noExcludeTempDir, { recursive: true });

      // Both skills should be found when no resources.exclude
      const toolXResult = results.find(r => r.path.includes('tool-x'));
      const toolYResult = results.find(r => r.path.includes('tool-y'));
      expect(toolXResult).toBeDefined();
      expect(toolYResult).toBeDefined();
    } finally {
      fs.rmSync(noExcludeTempDir, { recursive: true, force: true });
    }
  });

  it('combined: both --exclude flag and resources.exclude contribute', async () => {
    // Create a temp dir where resources.exclude covers fixtures/** and
    // we also pass --exclude to cover another pattern (extra/**).
    const combinedTempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-combined-'));
    try {
      initGitRepo(combinedTempDir);

      // Config excludes fixtures/**
      writeConfigWithResourcesExclude(combinedTempDir, ['fixtures/**']);

      // Skill in fixtures/ (excluded by config)
      writeSkillWithBrokenLink(
        safePath.join(combinedTempDir, 'fixtures', 'skills', 'tool-x', 'SKILL.md'),
        'tool-x',
      );
      // Skill in extra/ (excluded by --exclude CLI flag)
      writeSkillWithBrokenLink(
        safePath.join(combinedTempDir, 'extra', 'skills', 'tool-z', 'SKILL.md'),
        'tool-z',
      );
      // Skill in skills/ (not excluded by either)
      writeSkillWithBrokenLink(
        safePath.join(combinedTempDir, 'skills', 'tool-y', 'SKILL.md'),
        'tool-y',
      );
      gitAddAll(combinedTempDir);

      const results = await runAudit(combinedTempDir, {
        recursive: true,
        exclude: ['extra/**'],
      });

      // tool-x excluded by config resources.exclude
      expect(results.find(r => r.path.includes('tool-x'))).toBeUndefined();
      // tool-z excluded by --exclude CLI flag
      expect(results.find(r => r.path.includes('tool-z'))).toBeUndefined();
      // tool-y not excluded by either — should appear
      expect(results.find(r => r.path.includes('tool-y'))).toBeDefined();
    } finally {
      fs.rmSync(combinedTempDir, { recursive: true, force: true });
    }
  });
});

/**
 * System tests for skill distribution consistency checks in vat verify.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSkillMarkdown,
  createTempDirTracker,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
/** The per-severity counts block the verify YAML must carry beside its status. */
const ISSUE_COUNTS_KEY = 'issueCounts:';

function setupConsistencyTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs: cleanup } = createTempDirTracker('vat-consistency-test-');

  const createSkillSource = (tempDir: string, skillName: string) => {
    const dir = safePath.join(tempDir, 'skills', skillName);
    mkdirSyncReal(dir, { recursive: true });
    writeTestFile(safePath.join(dir, 'SKILL.md'), createSkillMarkdown(skillName));
  };

  const writeConfig = (tempDir: string, content: string) => {
    writeTestFile(safePath.join(tempDir, VAT_CONFIG_FILENAME), content);
  };

  /** Config with skills.include only (no claude section) */
  const writeSkillsOnlyConfig = (tempDir: string, extra = '') => {
    writeConfig(tempDir, `version: 1\nskills:\n  include:\n    - "skills/**/SKILL.md"\n${extra}`);
  };

  /** Config with skills + marketplace with specified plugin skills selector */
  const writeMarketplaceConfig = (tempDir: string, pluginSkills: string, extra = '') => {
    writeConfig(tempDir, `version: 1\nskills:\n  include:\n    - "skills/**/SKILL.md"\n${extra}claude:\n  marketplaces:\n    test-mp:\n      owner:\n        name: Test Org\n      plugins:\n        - name: test-plugin\n          ${pluginSkills}\n`);
  };

  const writePackageJson = (tempDir: string, vatSkills?: string[]) => {
    const pkg: Record<string, unknown> = { name: 'test-pkg', version: '1.0.0' };
    if (vatSkills !== undefined) {
      pkg['vat'] = { skills: vatSkills };
    }
    writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify(pkg));
  };

  const runVerify = async (tempDir: string) => {
    return executeCli(binPath, ['--cwd', tempDir, 'verify', '--only', 'consistency']);
  };

  /** Common setup: two skills (skill-a, skill-b) with package.json and marketplace config */
  const setupTwoSkillsWithMarketplace = (vatSkills: string[], pluginSkills: string) => {
    const tempDir = createTempDir();
    createSkillSource(tempDir, 'skill-a');
    createSkillSource(tempDir, 'skill-b');
    writePackageJson(tempDir, vatSkills);
    writeMarketplaceConfig(tempDir, pluginSkills);
    return tempDir;
  };

  return { createTempDir, cleanup, createSkillSource, writeConfig, writeSkillsOnlyConfig, writeMarketplaceConfig, writePackageJson, runVerify, setupTwoSkillsWithMarketplace };
}

describe('vat verify consistency checks (system test)', () => {
  const suite = setupConsistencyTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  it('should pass when all skills are in package.json and assigned to plugins', async () => {
    const tempDir = suite.setupTwoSkillsWithMarketplace(['skill-a', 'skill-b'], 'skills: "*"');

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(0);
  });

  it('should error when published skill is missing from package.json vat.skills', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.createSkillSource(tempDir, 'skill-b');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('skill-b');
    expect(result.stderr).toContain('PUBLISHED_SKILL_NOT_IN_PACKAGE_JSON');
    expect(result.stderr).toContain('publish: false');
    // ...and the archived YAML carries the finding and its distribution, not
    // just a phase status that stderr alone could explain.
    expect(result.stdout).toContain('status: error');
    expect(result.stdout).toContain(ISSUE_COUNTS_KEY);
    expect(result.stdout).toMatch(/errors: [1-9]/);
    expect(result.stdout).toContain('PUBLISHED_SKILL_NOT_IN_PACKAGE_JSON');
  });

  it('should error when package.json vat.skills lists undiscovered skill', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a', 'ghost-skill']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ghost-skill');
    expect(result.stderr).toContain('PACKAGE_JSON_LISTS_UNKNOWN_SKILL');
  });

  it('should error when published skill is not assigned to any plugin', async () => {
    const tempDir = suite.setupTwoSkillsWithMarketplace(
      ['skill-a', 'skill-b'],
      'skills:\n            - "skill-a"'
    );

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('skill-b');
    expect(result.stderr).toContain('PUBLISHED_SKILL_NOT_IN_PLUGIN');
  });

  it('should suppress checks for skills with publish: false', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.createSkillSource(tempDir, 'dev-skill');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeMarketplaceConfig(tempDir, 'skills:\n            - "skill-a"', '  config:\n    dev-skill:\n      publish: false\n');

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('SKILL_UNPUBLISHED');
    expect(result.stderr).toContain('dev-skill');
  });

  it('should warn when unpublished skill is listed in package.json', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir, '  config:\n    skill-a:\n      publish: false\n');

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('UNPUBLISHED_SKILL_IN_PACKAGE_JSON');
    // The archived YAML is the artifact of record. It used to say
    // `status: passed` with nothing beside it, so a warning that stderr had
    // already scrolled past left no trace at all.
    expect(result.stdout).toContain('status: warning');
    expect(result.stdout).toContain(ISSUE_COUNTS_KEY);
    expect(result.stdout).toMatch(/warnings: [1-9]/);
    expect(result.stdout).toContain('UNPUBLISHED_SKILL_IN_PACKAGE_JSON');
  });

  it('publishes zero counts for a clean consistency phase, so `success` is quantified', async () => {
    const tempDir = suite.setupTwoSkillsWithMarketplace(['skill-a', 'skill-b'], 'skills: "*"');

    const result = await suite.runVerify(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status: success');
    expect(result.stdout).toContain(ISSUE_COUNTS_KEY);
    expect(result.stdout).toContain('errors: 0');
  });

  it('should error when skills.config references unknown skill name', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir, '  config:\n    typo-skill:\n      publish: false\n');

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('typo-skill');
    expect(result.stderr).toContain('CONFIG_REFERENCES_UNKNOWN_SKILL');
  });

  it('should error when plugin references non-existent skill selector', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeMarketplaceConfig(tempDir, 'skills:\n            - "skill-a"\n            - "nonexistent-skill"');

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nonexistent-skill');
    expect(result.stderr).toContain('PLUGIN_REFERENCES_UNKNOWN_SKILL');
  });

  it('should skip package.json checks when no package.json exists', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writeSkillsOnlyConfig(tempDir);

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(0);
  });

  it('fails an explicit --only consistency when the project has no skills block', async () => {
    // An explicit request for a phase that cannot run must not answer with an
    // empty phase list and `status: success` — that is indistinguishable from
    // "checked everything, all good" to anyone reading the exit code.
    const tempDir = suite.createTempDir();
    suite.writeConfig(tempDir, 'version: 1\nresources:\n  exclude:\n    - "node_modules/**"\n');

    const result = await suite.runVerify(tempDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status: error');
    expect(result.stderr).toContain("Phase 'consistency' needs a skills: block");
  });

  it('should skip plugin assignment checks when no claude.marketplaces configured', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = await suite.runVerify(tempDir);
    expect(result.status).toBe(0);
  });
});

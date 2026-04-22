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

  const writePackageJson = (tempDir: string, vatSkills?: string[]) => {
    const pkg: Record<string, unknown> = { name: 'test-pkg', version: '1.0.0' };
    if (vatSkills !== undefined) {
      pkg['vat'] = { skills: vatSkills };
    }
    writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify(pkg));
  };

  const runVerify = (tempDir: string) => {
    return executeCli(binPath, ['--cwd', tempDir, 'verify', '--only', 'consistency']);
  };

  return { createTempDir, cleanup, createSkillSource, writeConfig, writeSkillsOnlyConfig, writePackageJson, runVerify };
}

describe('vat verify consistency checks (system test)', () => {
  const suite = setupConsistencyTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  it('should pass when all published skills are in package.json', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.createSkillSource(tempDir, 'skill-b');
    suite.writePackageJson(tempDir, ['skill-a', 'skill-b']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = suite.runVerify(tempDir);
    expect(result.status).toBe(0);
  });

  it('should error when published skill is missing from package.json vat.skills', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.createSkillSource(tempDir, 'skill-b');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('skill-b');
    expect(result.stderr).toContain('PUBLISHED_SKILL_NOT_IN_PACKAGE_JSON');
    expect(result.stderr).toContain('publish: false');
  });

  it('should error when package.json vat.skills lists undiscovered skill', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a', 'ghost-skill']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ghost-skill');
    expect(result.stderr).toContain('PACKAGE_JSON_LISTS_UNKNOWN_SKILL');
  });

  it('should report SKILL_UNPUBLISHED info for skills with publish: false', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.createSkillSource(tempDir, 'dev-skill');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir, '  config:\n    dev-skill:\n      publish: false\n');

    const result = suite.runVerify(tempDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('SKILL_UNPUBLISHED');
    expect(result.stderr).toContain('dev-skill');
  });

  it('should warn when unpublished skill is listed in package.json', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir, '  config:\n    skill-a:\n      publish: false\n');

    const result = suite.runVerify(tempDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('UNPUBLISHED_SKILL_IN_PACKAGE_JSON');
  });

  it('should error when skills.config references unknown skill name', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir, '  config:\n    typo-skill:\n      publish: false\n');

    const result = suite.runVerify(tempDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('typo-skill');
    expect(result.stderr).toContain('CONFIG_REFERENCES_UNKNOWN_SKILL');
  });

  it('should skip package.json checks when no package.json exists', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writeSkillsOnlyConfig(tempDir);

    const result = suite.runVerify(tempDir);
    expect(result.status).toBe(0);
  });
});

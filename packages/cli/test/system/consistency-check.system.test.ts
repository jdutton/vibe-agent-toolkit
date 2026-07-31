/**
 * System tests for skill distribution consistency checks in vat verify.
 *
 * Driven by a BARE `vat verify`. These used to run `vat verify --only
 * consistency`, which no longer exists — the flag saved at most ~18s of a ~32s
 * command and repeatedly produced wrong answers, so it was retired. A bare run
 * on a fixture with a `skills:` block reaches the same in-process phase.
 *
 * Consequence for the assertions: the process exit code is now the WORST status
 * across every configured phase, so it no longer speaks for `consistency`
 * alone (the marketplace fixtures, for one, have no built `dist/` for the
 * marketplace phase to read). Each test therefore asserts on the `consistency`
 * entry of the emitted document — a strictly narrower claim than the exit code
 * ever made, and the one these tests were always about.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

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

/** One phase entry of a `vat verify` document. */
interface VerifyPhaseEntry {
  name?: string;
  status?: string;
}

/**
 * The status `vat verify` recorded for its in-process `consistency` phase.
 *
 * Throws when the phase is absent: a run that never reached `consistency` must
 * fail these tests loudly rather than compare `undefined` to `undefined`.
 */
function consistencyStatus(stdout: string): string | undefined {
  const doc = yaml.parseAllDocuments(stdout).find((d) => d.contents !== null);
  const phases = (doc?.toJS() as { phases?: VerifyPhaseEntry[] } | undefined)?.phases ?? [];
  const phase = phases.find((p) => p.name === 'consistency');
  if (phase === undefined) {
    throw new Error(
      `No 'consistency' phase in the verify document. Phases: ${phases.map((p) => p.name).join(', ') || '(none)'}`,
    );
  }
  return phase.status;
}

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
    return executeCli(binPath, ['--cwd', tempDir, 'verify']);
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
    expect(consistencyStatus(result.stdout)).toBe('success');
  });

  it('should error when published skill is missing from package.json vat.skills', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.createSkillSource(tempDir, 'skill-b');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = await suite.runVerify(tempDir);
    expect(consistencyStatus(result.stdout)).toBe('error');
    // The one place the process exit code is still asserted: this fixture
    // declares `skills:` and nothing else, so the aggregate can only be the
    // consistency verdict. It pins that a consistency error actually FAILS the
    // run rather than being published and shrugged off.
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
    expect(consistencyStatus(result.stdout)).toBe('error');
    expect(result.stderr).toContain('ghost-skill');
    expect(result.stderr).toContain('PACKAGE_JSON_LISTS_UNKNOWN_SKILL');
  });

  it('should error when published skill is not assigned to any plugin', async () => {
    const tempDir = suite.setupTwoSkillsWithMarketplace(
      ['skill-a', 'skill-b'],
      'skills:\n            - "skill-a"'
    );

    const result = await suite.runVerify(tempDir);
    expect(consistencyStatus(result.stdout)).toBe('error');
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
    expect(consistencyStatus(result.stdout)).toBe('success');
    expect(result.stderr).toContain('SKILL_UNPUBLISHED');
    expect(result.stderr).toContain('dev-skill');
  });

  it('should warn when unpublished skill is listed in package.json', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir, '  config:\n    skill-a:\n      publish: false\n');

    const result = await suite.runVerify(tempDir);
    expect(consistencyStatus(result.stdout)).toBe('warning');
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

    expect(consistencyStatus(result.stdout)).toBe('success');
    expect(result.stdout).toContain(ISSUE_COUNTS_KEY);
    expect(result.stdout).toContain('errors: 0');
  });

  it('should error when skills.config references unknown skill name', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir, '  config:\n    typo-skill:\n      publish: false\n');

    const result = await suite.runVerify(tempDir);
    expect(consistencyStatus(result.stdout)).toBe('error');
    expect(result.stderr).toContain('typo-skill');
    expect(result.stderr).toContain('CONFIG_REFERENCES_UNKNOWN_SKILL');
  });

  it('should error when plugin references non-existent skill selector', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeMarketplaceConfig(tempDir, 'skills:\n            - "skill-a"\n            - "nonexistent-skill"');

    const result = await suite.runVerify(tempDir);
    expect(consistencyStatus(result.stdout)).toBe('error');
    expect(result.stderr).toContain('nonexistent-skill');
    expect(result.stderr).toContain('PLUGIN_REFERENCES_UNKNOWN_SKILL');
  });

  it('should skip package.json checks when no package.json exists', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writeSkillsOnlyConfig(tempDir);

    const result = await suite.runVerify(tempDir);
    expect(consistencyStatus(result.stdout)).toBe('success');
  });

  it('does not run consistency at all when the project has no skills block', async () => {
    // There used to be a test here asserting that `vat verify --only
    // consistency` ERRORS on a project with no `skills:` block, because an
    // explicit request for a phase that cannot run must not be answered with
    // `success`. That premise died with `--only`: there is no longer any way to
    // ask for this phase specifically, so a run with nothing to cross-reference
    // is a genuine no-op — and the contract that remains is that it must not
    // CLAIM to have checked distribution consistency.
    const tempDir = suite.createTempDir();
    suite.writeConfig(tempDir, 'version: 1\nresources:\n  exclude:\n    - "node_modules/**"\n');

    const result = await suite.runVerify(tempDir);

    expect(() => consistencyStatus(result.stdout)).toThrow(/No 'consistency' phase/);
    // ...and the startup line does not name it either.
    expect(result.stderr).toContain('🔍 vat verify (phases: resources)');
  });

  it('should skip plugin assignment checks when no claude.marketplaces configured', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'skill-a');
    suite.writePackageJson(tempDir, ['skill-a']);
    suite.writeSkillsOnlyConfig(tempDir);

    const result = await suite.runVerify(tempDir);
    expect(consistencyStatus(result.stdout)).toBe('success');
  });
});


/* eslint-disable security/detect-non-literal-fs-filename -- test file uses controlled temp directory */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { describe, it, expect } from 'vitest';

import type { ValidationIssue } from '../src/validators/types.js';

import {
  createAndValidateSingleResourceSkill,
  createAndValidateTransitiveSkill,
  createSkillAndValidate,
  createSkillContent,
  createTransitiveSkillStructure,
  expectError,
  expectWarning,
  setupTempDir,
} from './test-helpers.js';

// Common test constants for all describe blocks
const TEST_SKILL_NAME = 'test-skill';
const TEST_SKILL_DESC = 'Test skill';
const TEST_SKILL_HEADER = '\n# Test Skill\n\n';
const TEST_SKILL_TITLE_ONLY = '\n# Test Skill';
const UNREFERENCED_FILE_CODE = 'SKILL_UNREFERENCED_FILE';
const SKILL_MD_FILENAME = 'SKILL.md';
const ORPHANED_MD_FILENAME = 'orphaned.md';

/**
 * Helper to validate unreferenced file detection
 */
async function validateUnreferencedFileDetection(
  tempDir: string,
  skillBody: string,
  setupFn?: (tempDir: string) => void
): Promise<ValidationIssue[]> {
  if (setupFn) {
    setupFn(tempDir);
  }

  const skillPath = path.join(tempDir, SKILL_MD_FILENAME);
  fs.writeFileSync(
    skillPath,
    createSkillContent({ name: TEST_SKILL_NAME, description: TEST_SKILL_DESC }, skillBody),
  );

  const { validateSkill } = await import('../src/validators/skill-validator.js');
  const result = await validateSkill({
    skillPath,
    rootDir: tempDir,
    checkUnreferencedFiles: true,
  });

  return result.issues.filter((i) => i.code === UNREFERENCED_FILE_CODE);
}

describe('validateSkill', () => {
  const { getTempDir } = setupTempDir('skill-validator-test-');

  it('should validate minimal valid skill', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill', description: 'Does something useful' }),
    );

    expect(result.status).toBe('success');
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('should detect missing frontmatter', async () => {
    const result = await createSkillAndValidate(getTempDir(), '# Just content, no frontmatter');

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_MISSING_FRONTMATTER');
  });

  it('should detect missing name', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ description: 'Test' }, ''),
    );

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_MISSING_NAME');
  });

  it('should detect missing description', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill' }, ''),
    );

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_MISSING_DESCRIPTION');
  });

  it('should detect invalid name', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'MySkill', description: 'Test' }, ''),
    );

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_NAME_INVALID');
    const issue = result.issues.find((i) => i.code === 'SKILL_NAME_INVALID');
    expect(issue?.fix).toBeDefined();
  });

  it('should detect reserved words in name', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'claude-helper', description: 'Test' }, ''),
    );

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_NAME_RESERVED_WORD');
  });

  it('should detect XML tags in description', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill', description: '<test>content</test>' }, ''),
    );

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_DESCRIPTION_XML_TAGS');
  });

  it('should detect description too long', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill', description: 'x'.repeat(1025) }, ''),
    );

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_DESCRIPTION_TOO_LONG');
  });

  it('should return success status with no errors', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill', description: 'A valid skill' }, '\n# Content'),
    );

    expect(result.status).toBe('success');
    expect(result.summary).toContain('0 errors');
  });
});

describe('link validation', () => {
  const { getTempDir } = setupTempDir('skill-validator-link-test-');

  it('should detect broken links', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'my-skill', description: 'Test' },
        '\n\nSee [reference](./missing.md) for details.',
      ),
    );

    expectError(result, 'LINK_INTEGRITY_BROKEN');
    expect(result.issues.some((i) => i.code === 'LINK_INTEGRITY_BROKEN')).toBe(true);
  });

  it('should validate existing links', async () => {
    const refPath = path.join(getTempDir(), 'reference.md');
    fs.writeFileSync(refPath, '# Reference');

    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'my-skill', description: 'Test' },
        '\n\nSee [reference](./reference.md) for details.',
      ),
    );

    const issue = result.issues.find((i) => i.code === 'LINK_INTEGRITY_BROKEN');
    expect(issue).toBeUndefined();
  });

  it('should handle absolute links to rootDir', async () => {
    const docsDir = path.join(getTempDir(), 'docs');
    mkdirSyncReal(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'reference.md'), '# Reference');

    const skillPath = path.join(getTempDir(), SKILL_MD_FILENAME);
    fs.writeFileSync(
      skillPath,
      createSkillContent(
        { name: 'my-skill', description: 'Test' },
        '\n\nSee [docs](/docs/reference.md).',
      ),
    );

    const { validateSkill } = await import('../src/validators/skill-validator.js');
    const result = await validateSkill({
      skillPath,
      rootDir: getTempDir(),
    });

    const issue = result.issues.find((i) => i.code === 'LINK_INTEGRITY_BROKEN');
    expect(issue).toBeUndefined();
  });
});

describe('Windows path validation', () => {
  const { getTempDir } = setupTempDir('skill-validator-windows-test-');

  it('should detect backslashes in links', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      String.raw`---
name: my-skill
description: Test
---

See [reference](reference\guide.md).`,
    );

    expectError(result, 'PATH_STYLE_WINDOWS');
    expect(result.issues.some((i) => i.code === 'PATH_STYLE_WINDOWS')).toBe(true);
  });
});

describe('warning-level validations', () => {
  const { getTempDir } = setupTempDir('skill-validator-warning-test-');

  it('should warn when skill is too long', async () => {
    const longContent = 'x\n'.repeat(6000); // Exceed 5000 lines
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill', description: 'Test' }, `\n\n${longContent}`),
    );

    expectWarning(result, 'SKILL_TOO_LONG');
    expect(result.issues.some((i) => i.code === 'SKILL_TOO_LONG')).toBe(true);
  });

  it('should not warn for reasonable skill length', async () => {
    const reasonableContent = 'x\n'.repeat(1000); // Under 5000 lines
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill', description: 'Test' }, `\n\n${reasonableContent}`),
    );

    const issue = result.issues.find((i) => i.code === 'SKILL_TOO_LONG');
    expect(issue).toBeUndefined();
  });

  it('should warn when skill references console-incompatible features', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'my-skill', description: 'Test' },
        '\n\nThis skill uses the Write tool to create files.',
      ),
    );

    expectWarning(result, 'SKILL_CONSOLE_INCOMPATIBLE');
    expect(result.issues.some((i) => i.code === 'SKILL_CONSOLE_INCOMPATIBLE')).toBe(true);
  });

  it('should not warn for console-compatible skills', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'my-skill', description: 'Test' },
        '\n\nThis skill helps with code analysis and review.',
      ),
    );

    const issue = result.issues.find((i) => i.code === 'SKILL_CONSOLE_INCOMPATIBLE');
    expect(issue).toBeUndefined();
  });

  it('should return warning status when only warnings exist', async () => {
    const longContent = 'x\n'.repeat(6000); // Trigger warning
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill', description: 'Test' }, `\n\n${longContent}`),
    );

    expect(result.status).toBe('warning');
    expect(result.summary).toContain('0 errors');
    expect(result.summary).toContain('1 warning');
  });
});

describe('transitive validation and unreferenced files', () => {
  const { getTempDir } = setupTempDir('skill-validator-transitive-test-');

  describe('transitive link validation', () => {
    it('should validate SKILL.md with no linked files', async () => {
      const result = await createSkillAndValidate(
        getTempDir(),
        createSkillContent({ name: TEST_SKILL_NAME, description: TEST_SKILL_DESC }, `${TEST_SKILL_HEADER}No external links.`),
      );

      expect(result.status).toBe('success');
      expect(result.linkedFiles).toBeUndefined();
      expect(result.metadata?.referenceFiles).toBeUndefined();
    });

    it('should validate two-level link chain (SKILL.md → resource.md)', async () => {
      const { result, filePaths } = await createAndValidateTransitiveSkill(
        getTempDir(),
        {
          'resources/core.md': '# Core Content\n\nSome content here.',
        },
        createSkillContent(
          { name: TEST_SKILL_NAME, description: TEST_SKILL_DESC },
          `${TEST_SKILL_HEADER}See [core](./resources/core.md).`,
        ),
      );

      expect(result.status).toBe('success');
      expect(result.metadata?.referenceFiles).toBe(1);
      expect(result.linkedFiles).toHaveLength(1);
      expect(result.linkedFiles?.[0]?.path).toBe(filePaths['resources/core.md']);
      expect(result.linkedFiles?.[0]?.lineCount).toBe(3);
      expect(result.linkedFiles?.[0]?.issues).toHaveLength(0);
    });

    it('should validate three-level transitive chain', async () => {
      const { result, filePaths } = await createAndValidateTransitiveSkill(
        getTempDir(),
        {
          'resources/core.md': '# Core\n\nSee [example](./patterns/example.md) for details.\n',
          'resources/patterns/example.md': '# Example\n\nFinal content.\n',
        },
        createSkillContent(
          { name: TEST_SKILL_NAME, description: TEST_SKILL_DESC },
          `${TEST_SKILL_HEADER}See [core](./resources/core.md).`,
        ),
      );

      expect(result.status).toBe('success');
      expect(result.metadata?.referenceFiles).toBe(2);
      expect(result.linkedFiles).toHaveLength(2);

      const coreLinkResult = result.linkedFiles?.find((f) => f.path === filePaths['resources/core.md']);
      expect(coreLinkResult).toBeDefined();
      expect(coreLinkResult?.linksFound).toBe(1);
      expect(coreLinkResult?.linksValidated).toBe(1);

      const exampleLinkResult = result.linkedFiles?.find((f) => f.path === filePaths['resources/patterns/example.md']);
      expect(exampleLinkResult).toBeDefined();
      expect(exampleLinkResult?.linksFound).toBe(0);
    });

    it('should detect broken link in resource file', async () => {
      const { result, coreResult } = await createAndValidateSingleResourceSkill(
        getTempDir(),
        '# Core\n\nSee [missing](./nonexistent.md).\n',
        {},
        TEST_SKILL_NAME,
        TEST_SKILL_DESC,
      );

      expect(result.status).toBe('success');
      expect(result.linkedFiles).toHaveLength(1);
      expect(coreResult?.issues).toHaveLength(1);
      expect(coreResult?.issues[0]?.code).toBe('LINK_INTEGRITY_BROKEN');
      expect(coreResult?.issues[0]?.message).toContain('nonexistent.md');
      expect(coreResult?.linksFound).toBe(1);
      expect(coreResult?.linksValidated).toBe(0);
    });

    it('should handle circular references gracefully', async () => {
      const tempDir = getTempDir();
      const resourcesDir = path.join(tempDir, 'resources');
      mkdirSyncReal(resourcesDir, { recursive: true });

      const aPath = path.join(resourcesDir, 'a.md');
      const bPath = path.join(resourcesDir, 'b.md');

      fs.writeFileSync(aPath, '# A\n\nSee [b](./b.md).\n');
      fs.writeFileSync(bPath, '# B\n\nSee [a](./a.md).\n');

      const result = await createSkillAndValidate(
        tempDir,
        createSkillContent(
          { name: TEST_SKILL_NAME, description: TEST_SKILL_DESC },
          `${TEST_SKILL_HEADER}See [a](./resources/a.md).`,
        ),
      );

      expect(result.status).toBe('success');
      expect(result.linkedFiles).toHaveLength(2);

      const aResult = result.linkedFiles?.find((f) => f.path === aPath);
      const bResult = result.linkedFiles?.find((f) => f.path === bPath);

      expect(aResult).toBeDefined();
      expect(bResult).toBeDefined();
      expect(aResult?.linksFound).toBe(1);
      expect(bResult?.linksFound).toBe(1);
    });

    it('should ignore non-markdown links in transitive validation', async () => {
      const { result, coreResult, filePaths } = await createAndValidateSingleResourceSkill(
        getTempDir(),
        '# Core\n\nRun [build script](../scripts/build.sh).\n',
        { 'scripts/build.sh': '#!/bin/bash\necho "build"' },
        TEST_SKILL_NAME,
        TEST_SKILL_DESC,
      );

      expect(result.status).toBe('success');
      expect(result.linkedFiles).toHaveLength(1);
      expect(coreResult?.path).toBe(filePaths['resources/core.md']);
      expect(coreResult?.linksFound).toBe(1);
      expect(coreResult?.linksValidated).toBe(1);
    });

    it('should handle external links in transitive validation', async () => {
      const { result, coreResult } = await createAndValidateSingleResourceSkill(
        getTempDir(),
        '# Core\n\nSee [docs](https://example.com/docs).\n',
        {},
        TEST_SKILL_NAME,
        TEST_SKILL_DESC,
      );

      expect(result.status).toBe('success');
      expect(result.linkedFiles).toHaveLength(1);
      // External links are not counted as local file links
      expect(coreResult?.linksFound).toBe(0);
      expect(coreResult?.issues).toHaveLength(0);
    });

    it('should handle unparseable markdown in linked file', async () => {
      const tempDir = getTempDir();
      const resourcesDir = path.join(tempDir, 'resources');
      mkdirSyncReal(resourcesDir, { recursive: true });

      const badPath = path.join(resourcesDir, 'bad.md');
      fs.writeFileSync(badPath, ''); // Empty file that might fail parsing

      const result = await createSkillAndValidate(
        tempDir,
        createSkillContent(
          { name: TEST_SKILL_NAME, description: TEST_SKILL_DESC },
          `${TEST_SKILL_HEADER}See [bad](./resources/bad.md).`,
        ),
      );

      expect(result.linkedFiles).toHaveLength(1);
      const badResult = result.linkedFiles?.[0];
      expect(badResult?.path).toBe(badPath);
    });

    it('should validate links with absolute paths', async () => {
      const tempDir = getTempDir();
      const docsDir = path.join(tempDir, 'docs');
      mkdirSyncReal(docsDir, { recursive: true });

      const apiPath = path.join(docsDir, 'api.md');
      fs.writeFileSync(apiPath, '# API\n\nAPI documentation.\n');

      const skillPath = path.join(tempDir, SKILL_MD_FILENAME);
      fs.writeFileSync(
        skillPath,
        createSkillContent(
          { name: TEST_SKILL_NAME, description: TEST_SKILL_DESC },
          `${TEST_SKILL_HEADER}See [API](/docs/api.md).`,
        ),
      );

      const { validateSkill } = await import('../src/validators/skill-validator.js');
      const result = await validateSkill({
        skillPath,
        rootDir: tempDir,
      });

      expect(result.status).toBe('success');
      expect(result.linkedFiles).toHaveLength(1);
      expect(result.linkedFiles?.[0]?.path).toBe(apiPath);
    });
  });

  describe('unreferenced file detection', () => {
    it('should not detect unreferenced files when feature is disabled', async () => {
      const tempDir = getTempDir();
      const resourcesDir = path.join(tempDir, 'resources');
      mkdirSyncReal(resourcesDir, { recursive: true });

      const orphanedPath = path.join(resourcesDir, ORPHANED_MD_FILENAME);
      fs.writeFileSync(orphanedPath, '# Orphaned\n\nNot referenced anywhere.\n');

      const skillPath = path.join(tempDir, SKILL_MD_FILENAME);
      fs.writeFileSync(
        skillPath,
        createSkillContent({ name: TEST_SKILL_NAME, description: TEST_SKILL_DESC }, `${TEST_SKILL_HEADER}No links.`),
      );

      const { validateSkill } = await import('../src/validators/skill-validator.js');
      const result = await validateSkill({
        skillPath,
        rootDir: tempDir,
        checkUnreferencedFiles: false,
      });

      expect(result.status).toBe('success');
      const unreferencedIssues = result.issues.filter((i) => i.code === UNREFERENCED_FILE_CODE);
      expect(unreferencedIssues).toHaveLength(0);
    });

    it('should detect orphaned markdown files', async () => {
      const tempDir = getTempDir();

      const { skillPath } = createTransitiveSkillStructure(
        tempDir,
        {
          'resources/linked.md': '# Linked\n',
          'resources/orphaned.md': '# Orphaned\n',
        },
        createSkillContent(
          { name: TEST_SKILL_NAME, description: TEST_SKILL_DESC },
          `${TEST_SKILL_HEADER}See [linked](./resources/linked.md).`,
        ),
      );

      const { validateSkillWithUnreferencedFileCheck } = await import('./test-helpers.js');
      const result = await validateSkillWithUnreferencedFileCheck(skillPath, tempDir);

      const unreferencedIssues = result.issues.filter((i) => i.code === UNREFERENCED_FILE_CODE);

      // Should detect SKILL.md and orphaned.md as unreferenced
      // SKILL.md is the entry point so it's naturally not referenced by other files
      expect(unreferencedIssues.length).toBeGreaterThanOrEqual(1);
      const orphanedIssue = unreferencedIssues.find((i) => i.message.includes(ORPHANED_MD_FILENAME));
      expect(orphanedIssue).toBeDefined();
      expect(orphanedIssue?.severity).toBe('info');
    });

    it('should ignore node_modules directory', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        TEST_SKILL_TITLE_ONLY,
        (tempDir) => {
          const nodeModulesDir = path.join(tempDir, 'node_modules');
          const packageDir = path.join(nodeModulesDir, 'some-package');
          mkdirSyncReal(packageDir, { recursive: true });
          fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {}');
        },
      );

      // Only SKILL.md should be reported (entry point)
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should ignore .git, dist, and build directories', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        TEST_SKILL_TITLE_ONLY,
        (tempDir) => {
          const gitDir = path.join(tempDir, '.git');
          const distDir = path.join(tempDir, 'dist');
          const buildDir = path.join(tempDir, 'build');

          mkdirSyncReal(gitDir, { recursive: true });
          mkdirSyncReal(distDir, { recursive: true });
          mkdirSyncReal(buildDir, { recursive: true });

          fs.writeFileSync(path.join(gitDir, 'config'), 'git config');
          fs.writeFileSync(path.join(distDir, 'bundle.js'), 'bundled code');
          fs.writeFileSync(path.join(buildDir, 'output.js'), 'build output');
        },
      );

      // Only SKILL.md should be reported (entry point)
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should detect references in backticks', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        `${TEST_SKILL_HEADER}Run \`scripts/build.sh\` to build.`,
        (tempDir) => {
          const scriptsDir = path.join(tempDir, 'scripts');
          mkdirSyncReal(scriptsDir, { recursive: true });
          fs.writeFileSync(path.join(scriptsDir, 'build.sh'), '#!/bin/bash\necho "build"');
        },
      );

      // Only SKILL.md should be reported (entry point), build.sh is referenced
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should detect references in double quotes', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        `${TEST_SKILL_HEADER}Run "scripts/deploy.sh" to deploy.`,
        (tempDir) => {
          const scriptsDir = path.join(tempDir, 'scripts');
          mkdirSyncReal(scriptsDir, { recursive: true });
          fs.writeFileSync(path.join(scriptsDir, 'deploy.sh'), '#!/bin/bash\necho "deploy"');
        },
      );

      // Only SKILL.md should be reported (entry point), deploy.sh is referenced
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should detect references in single quotes', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        "\n# Test Skill\n\nRun 'scripts/test.sh' to test.",
        (tempDir) => {
          const scriptsDir = path.join(tempDir, 'scripts');
          mkdirSyncReal(scriptsDir, { recursive: true });
          fs.writeFileSync(path.join(scriptsDir, 'test.sh'), '#!/bin/bash\necho "test"');
        },
      );

      // Only SKILL.md should be reported (entry point), test.sh is referenced
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should detect references with ./ prefix', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        `${TEST_SKILL_HEADER}Run ./scripts/run.sh to run.`,
        (tempDir) => {
          const scriptsDir = path.join(tempDir, 'scripts');
          mkdirSyncReal(scriptsDir, { recursive: true });
          fs.writeFileSync(path.join(scriptsDir, 'run.sh'), '#!/bin/bash\necho "run"');
        },
      );

      // Only SKILL.md should be reported (entry point), run.sh is referenced
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should detect references in linked files', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        `${TEST_SKILL_HEADER}See [core](./resources/core.md).`,
        (tempDir) => {
          const resourcesDir = path.join(tempDir, 'resources');
          const scriptsDir = path.join(tempDir, 'scripts');
          mkdirSyncReal(resourcesDir, { recursive: true });
          mkdirSyncReal(scriptsDir, { recursive: true });

          fs.writeFileSync(path.join(scriptsDir, 'config.json'), '{}');
          fs.writeFileSync(path.join(resourcesDir, 'core.md'), '# Core\n\nSee `scripts/config.json` for configuration.\n');
        },
      );

      // Only SKILL.md should be reported (entry point), core.md and config.json are referenced
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should ignore common system files', async () => {
      const unreferencedIssues = await validateUnreferencedFileDetection(
        getTempDir(),
        TEST_SKILL_TITLE_ONLY,
        (tempDir) => {
          fs.writeFileSync(path.join(tempDir, '.DS_Store'), '');
          fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.log');
          fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
        },
      );

      // Only SKILL.md should be reported (entry point), system files are ignored
      expect(unreferencedIssues).toHaveLength(1);
      expect(unreferencedIssues[0]?.message).toContain(SKILL_MD_FILENAME);
    });

    it('should report multiple unreferenced files', async () => {
      const tempDir = getTempDir();

      const { skillPath } = createTransitiveSkillStructure(
        tempDir,
        {
          'old/draft1.md': '# Draft 1',
          'old/draft2.md': '# Draft 2',
          'unused.md': '# Unused',
        },
        createSkillContent({ name: TEST_SKILL_NAME, description: TEST_SKILL_DESC }, TEST_SKILL_TITLE_ONLY),
      );

      const { validateSkillWithUnreferencedFileCheck } = await import('./test-helpers.js');
      const result = await validateSkillWithUnreferencedFileCheck(skillPath, tempDir);

      const unreferencedIssues = result.issues.filter((i) => i.code === UNREFERENCED_FILE_CODE);
      expect(unreferencedIssues.length).toBeGreaterThanOrEqual(3);
    });
  });
});

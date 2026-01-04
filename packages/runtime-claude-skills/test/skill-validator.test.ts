/* eslint-disable security/detect-non-literal-fs-filename -- test file uses controlled temp directory */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  createSkillAndValidate,
  createSkillContent,
  expectError,
  expectWarning,
  setupTempDir,
} from './test-helpers.js';

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
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'reference.md'), '# Reference');

    const skillPath = path.join(getTempDir(), 'SKILL.md');
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

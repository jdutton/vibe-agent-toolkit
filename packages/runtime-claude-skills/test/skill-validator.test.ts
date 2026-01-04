/* eslint-disable security/detect-non-literal-fs-filename -- test file uses controlled temp directory */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { validateSkill } from '../src/validators/skill-validator.js';

const TEMP_DIR_PREFIX = 'skill-validator-test-';

// Test helper to manage temp directory lifecycle
function setupTempDir(): { getTempDir: () => string } {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    getTempDir: () => tempDir,
  };
}

describe('validateSkill', () => {
  const { getTempDir } = setupTempDir();

  it('should validate minimal valid skill', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Does something useful
---

# My Skill`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('success');
    expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('should detect missing frontmatter', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, '# Just content, no frontmatter');

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('error');
    const issue = result.issues.find(i => i.code === 'SKILL_MISSING_FRONTMATTER');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('should detect missing name', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
description: Test
---`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('error');
    const issue = result.issues.find(i => i.code === 'SKILL_MISSING_NAME');
    expect(issue).toBeDefined();
  });

  it('should detect missing description', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
---`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('error');
    const issue = result.issues.find(i => i.code === 'SKILL_MISSING_DESCRIPTION');
    expect(issue).toBeDefined();
  });

  it('should detect invalid name', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: MySkill
description: Test
---`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('error');
    const issue = result.issues.find(i => i.code === 'SKILL_NAME_INVALID');
    expect(issue).toBeDefined();
    expect(issue?.fix).toBeDefined();
  });

  it('should detect reserved words in name', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: claude-helper
description: Test
---`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('error');
    const issue = result.issues.find(i => i.code === 'SKILL_NAME_RESERVED_WORD');
    expect(issue).toBeDefined();
  });

  it('should detect XML tags in description', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: <test>content</test>
---`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('error');
    const issue = result.issues.find(i => i.code === 'SKILL_DESCRIPTION_XML_TAGS');
    expect(issue).toBeDefined();
  });

  it('should detect description too long', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: ${'x'.repeat(1025)}
---`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('error');
    const issue = result.issues.find(i => i.code === 'SKILL_DESCRIPTION_TOO_LONG');
    expect(issue).toBeDefined();
  });

  it('should return success status with no errors', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: A valid skill
---

# Content`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('success');
    expect(result.summary).toContain('0 errors');
  });
});

describe('link validation', () => {
  const { getTempDir } = setupTempDir();

  it('should detect broken links', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

See [reference](./missing.md) for details.`);

    const result = await validateSkill({ skillPath });

    const issue = result.issues.find(i => i.code === 'LINK_INTEGRITY_BROKEN');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('should validate existing links', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    const refPath = path.join(getTempDir(), 'reference.md');

    fs.writeFileSync(refPath, '# Reference');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

See [reference](./reference.md) for details.`);

    const result = await validateSkill({ skillPath });

    const issue = result.issues.find(i => i.code === 'LINK_INTEGRITY_BROKEN');
    expect(issue).toBeUndefined();
  });

  it('should handle absolute links to rootDir', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    const refPath = path.join(getTempDir(), 'docs', 'reference.md');

    fs.mkdirSync(path.join(getTempDir(), 'docs'));
    fs.writeFileSync(refPath, '# Reference');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

See [docs](/docs/reference.md).`);

    const result = await validateSkill({
      skillPath,
      rootDir: getTempDir(),
    });

    const issue = result.issues.find(i => i.code === 'LINK_INTEGRITY_BROKEN');
    expect(issue).toBeUndefined();
  });
});

describe('Windows path validation', () => {
  const { getTempDir } = setupTempDir();

  it('should detect backslashes in links', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, String.raw`---
name: my-skill
description: Test
---

See [reference](reference\guide.md).`);

    const result = await validateSkill({ skillPath });

    const issue = result.issues.find(i => i.code === 'PATH_STYLE_WINDOWS');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });
});

describe('warning-level validations', () => {
  const { getTempDir } = setupTempDir();

  it('should warn when skill is too long', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    const longContent = 'x\n'.repeat(6000); // Exceed 5000 lines
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

${longContent}`);

    const result = await validateSkill({ skillPath });

    const issue = result.issues.find(i => i.code === 'SKILL_TOO_LONG');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
  });

  it('should not warn for reasonable skill length', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    const reasonableContent = 'x\n'.repeat(1000); // Under 5000 lines
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

${reasonableContent}`);

    const result = await validateSkill({ skillPath });

    const issue = result.issues.find(i => i.code === 'SKILL_TOO_LONG');
    expect(issue).toBeUndefined();
  });

  it('should warn when skill references console-incompatible features', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

This skill uses the Write tool to create files.`);

    const result = await validateSkill({ skillPath });

    const issue = result.issues.find(i => i.code === 'SKILL_CONSOLE_INCOMPATIBLE');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
  });

  it('should not warn for console-compatible skills', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

This skill helps with code analysis and review.`);

    const result = await validateSkill({ skillPath });

    const issue = result.issues.find(i => i.code === 'SKILL_CONSOLE_INCOMPATIBLE');
    expect(issue).toBeUndefined();
  });

  it('should return warning status when only warnings exist', async () => {
    const skillPath = path.join(getTempDir(), 'SKILL.md');
    const longContent = 'x\n'.repeat(6000); // Trigger warning
    fs.writeFileSync(skillPath, `---
name: my-skill
description: Test
---

${longContent}`);

    const result = await validateSkill({ skillPath });

    expect(result.status).toBe('warning');
    expect(result.summary).toContain('0 errors');
    expect(result.summary).toContain('1 warning');
  });
});

import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { validateSkill } from '../src/validators/skill-validator.js';

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

  it('should return error when file does not exist', async () => {
    const result = await validateSkill({ skillPath: '/nonexistent/path/SKILL.md' });

    expect(result.status).toBe('error');
    expect(result.type).toBe('agent-skill');
    expectError(result, 'SKILL_MISSING_FRONTMATTER');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toBe('File does not exist');
  });

  it('should detect missing frontmatter', async () => {
    const result = await createSkillAndValidate(getTempDir(), '# Just content, no frontmatter');

    expect(result.status).toBe('error');
    expectError(result, 'SKILL_MISSING_FRONTMATTER');
  });

  it('should accept missing name (optional in base schema)', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ description: 'Test' }, ''),
    );

    expect(result.status).not.toBe('error');
  });

  it('should accept missing description (optional in base schema)', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent({ name: 'my-skill' }, ''),
    );

    expect(result.status).not.toBe('error');
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

  it('should emit local-shell capability when skill references local-shell tools', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'my-skill', description: 'Test' },
        '\n\nThis skill uses the Write tool to create files.',
      ),
    );

    const issue = result.issues.find((i) => i.code === 'CAPABILITY_LOCAL_SHELL');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('info');
  });

  it('should not emit local-shell capability for portable skills', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      createSkillContent(
        { name: 'my-skill', description: 'Test' },
        '\n\nThis skill helps with code analysis and review.',
      ),
    );

    const issue = result.issues.find((i) => i.code === 'CAPABILITY_LOCAL_SHELL');
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

describe('compat detectors in validateSkill', () => {
  const { getTempDir } = setupTempDir('skill-validator-compat-test-');

  it('emits CAPABILITY_LOCAL_SHELL when SKILL.md lists Bash in allowed-tools', async () => {
    const result = await createSkillAndValidate(
      getTempDir(),
      [
        '---',
        'name: uses-bash',
        'description: This skill needs a local shell for az-cli orchestration.',
        'allowed-tools: [Bash]',
        '---',
        '',
        'Use the Bash tool.',
        '',
      ].join('\n'),
    );
    expect(result.issues.some(i => i.code === 'CAPABILITY_LOCAL_SHELL')).toBe(true);
  });

  it('emits CAPABILITY_BROWSER_AUTH when a linked md references MSAL', async () => {
    const tmp = getTempDir();
    const skillPath = safePath.join(tmp, 'SKILL.md');
    const authPath = safePath.join(tmp, 'auth.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses controlled temp dir
    fs.writeFileSync(
      skillPath,
      [
        '---',
        'name: msal-skill',
        'description: Authenticates via Microsoft MSAL browser login for Azure AD users.',
        '---',
        '',
        'See [auth flow](./auth.md).',
      ].join('\n'),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses controlled temp dir
    fs.writeFileSync(
      authPath,
      [
        '# Auth',
        '',
        '```python',
        'from msal import PublicClientApplication',
        '```',
        '',
      ].join('\n'),
    );
    const result = await validateSkill({ skillPath });
    expect(result.issues.some(i => i.code === 'CAPABILITY_BROWSER_AUTH')).toBe(true);
  });

  it('attaches compat issues to per-file linkedFiles entry for linked md', async () => {
    const tmp = getTempDir();
    const skillPath = safePath.join(tmp, 'SKILL.md');
    const cliPath = safePath.join(tmp, 'cli.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses controlled temp dir
    fs.writeFileSync(
      skillPath,
      [
        '---',
        'name: uses-cli',
        'description: Wraps an external CLI tool via an include.',
        '---',
        '',
        'See [cli usage](./cli.md).',
      ].join('\n'),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses controlled temp dir
    fs.writeFileSync(
      cliPath,
      [
        '# CLI',
        '',
        '```bash',
        'az account show',
        '```',
        '',
      ].join('\n'),
    );
    const result = await validateSkill({ skillPath });
    const linked = result.linkedFiles?.find(lf => lf.path.endsWith('cli.md'));
    expect(linked).toBeDefined();
    expect(linked?.issues.some(i => i.code === 'CAPABILITY_EXTERNAL_CLI')).toBe(true);
    // And the top-level issues array also has it
    expect(result.issues.some(i => i.code === 'CAPABILITY_EXTERNAL_CLI')).toBe(true);
  });
});

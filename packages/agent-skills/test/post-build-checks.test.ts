/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- Tests use non-null assertions after explicit length checks */
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { checkBrokenPackagedLinks, checkUnreferencedFiles } from '../src/post-build-checks.js';

import { setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('post-build-checks-');

const SKILL_OUTPUT = 'skill-output';
const SKILL_MD = 'SKILL.md';
const RESOURCES = 'resources';
const SCRIPTS = 'scripts';
const SCRIPTS_CLI = 'scripts/cli.mjs';
const GUIDE_LINK_BODY = ['# Skill', '', 'See [guide](resources/guide.md).'].join('\n');

/**
 * Create a skill-output directory inside the test tmp dir, along with any
 * requested subdirectories (e.g. 'resources', 'scripts'). If no subdirs are
 * requested the output dir itself is still created.
 */
async function setupOutputDir(subdirs: string[] = []): Promise<string> {
  const outputDir = safePath.join(getTempDir(), SKILL_OUTPUT);
  if (subdirs.length === 0) {
    await mkdir(outputDir, { recursive: true });
  } else {
    for (const sub of subdirs) {
      await mkdir(safePath.join(outputDir, sub), { recursive: true });
    }
  }
  return outputDir;
}

/** Write SKILL.md at the root of outputDir. */
async function writeSkillMd(outputDir: string, body: string): Promise<void> {
  await writeFile(safePath.join(outputDir, SKILL_MD), body);
}

/** Write a file at a relative path inside outputDir. */
async function writeResource(
  outputDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(safePath.join(outputDir, relativePath), content);
}

/** Assert a single-issue result matches the expected code and message fragment. */
function expectSingleIssue(
  issues: Array<{ code: string; message: string; location?: string }>,
  code: string,
  messageContains: string,
): void {
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe(code);
  expect(issues[0]!.message).toContain(messageContains);
}

describe('checkUnreferencedFiles', () => {
  it('should return no issues when all files are referenced', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(outputDir, `${RESOURCES}/guide.md`, '# Guide\n');

    const issues = await checkUnreferencedFiles(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should report unreferenced non-markdown file', async () => {
    const outputDir = await setupOutputDir([SCRIPTS]);
    await writeSkillMd(outputDir, '# Skill\n\nNo links here.\n');
    await writeResource(outputDir, SCRIPTS_CLI, 'console.log("hi");\n');

    const issues = await checkUnreferencedFiles(outputDir);
    expectSingleIssue(issues, 'PACKAGED_UNREFERENCED_FILE', SCRIPTS_CLI);
  });

  it('should report unreferenced markdown file in subdirectory', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, '# Skill\n\nNo links.\n');
    await writeResource(outputDir, `${RESOURCES}/orphan.md`, '# Orphan\n');

    const issues = await checkUnreferencedFiles(outputDir);
    expectSingleIssue(issues, 'PACKAGED_UNREFERENCED_FILE', 'resources/orphan.md');
  });

  it('should follow transitive links', async () => {
    const outputDir = await setupOutputDir([RESOURCES, SCRIPTS]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(
      outputDir,
      `${RESOURCES}/guide.md`,
      ['# Guide', '', 'Uses [cli](../scripts/cli.mjs).'].join('\n'),
    );
    await writeResource(outputDir, SCRIPTS_CLI, 'console.log("hi");\n');

    const issues = await checkUnreferencedFiles(outputDir);
    expect(issues).toHaveLength(0);
  });
});

describe('checkBrokenPackagedLinks', () => {
  it('should return no issues when all links resolve', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(outputDir, `${RESOURCES}/guide.md`, '# Guide\n');

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should report broken link in packaged SKILL.md', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);

    const issues = await checkBrokenPackagedLinks(outputDir);
    expectSingleIssue(issues, 'PACKAGED_BROKEN_LINK', 'resources/guide.md');
  });

  it('should skip external URLs', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(
      outputDir,
      ['# Skill', '', 'See [docs](https://example.com).'].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should skip anchor-only links', async () => {
    const outputDir = await setupOutputDir();
    await writeSkillMd(
      outputDir,
      [
        '# Skill',
        '',
        'See [section](#details).',
        '',
        '## Details',
        '',
        'Content.',
      ].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should check links in nested markdown files', async () => {
    const outputDir = await setupOutputDir([RESOURCES]);
    await writeSkillMd(outputDir, GUIDE_LINK_BODY);
    await writeResource(
      outputDir,
      `${RESOURCES}/guide.md`,
      ['# Guide', '', 'See [missing](missing.md).'].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expectSingleIssue(issues, 'PACKAGED_BROKEN_LINK', 'missing.md');
    expect(issues[0]!.location).toContain('guide.md');
  });

  it('should skip link-like patterns inside fenced code blocks', async () => {
    const outputDir = await setupOutputDir();
    // Fenced code block with a link-like pattern and a Mustache placeholder —
    // neither should be treated as a real markdown link.
    await writeSkillMd(
      outputDir,
      [
        '# Skill',
        '',
        'Example usage:',
        '',
        '```markdown',
        'See [example]({{link.href}}) for details.',
        '[text](does-not-exist.md)',
        '```',
        '',
        'End of example.',
      ].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });

  it('should skip link-like patterns inside inline code spans', async () => {
    const outputDir = await setupOutputDir();
    // Inline code span containing a link-like pattern — should be ignored.
    await writeSkillMd(
      outputDir,
      ['# Skill', '', 'Syntax: `[text](path.md)` is a markdown link.'].join('\n'),
    );

    const issues = await checkBrokenPackagedLinks(outputDir);
    expect(issues).toHaveLength(0);
  });
});

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { packageSkill, type PackageSkillOptions } from '../src/skill-packager.js';

import { createFrontmatter, setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('skill-packager-');

// Test constants
const TEST_SKILL_NAME = 'test-skill';
const TEST_SKILL_CONTENT = '# Test Skill';
const COMPLEX_SKILL_NAME = 'complex-skill';
const GUIDE_MD = 'guide.md';
const DOCS_GUIDE_MD = 'docs/guide.md';
const GUIDE_CONTENT = '# Guide\n\nContent.';
const GUIDE_WITH_REF = '# Guide\n\nSee [reference](./reference.md).';

/**
 * Helper to package skill with default output path
 * Prevents tests from failing due to missing package.json in temp dir
 */
async function packageSkillForTest(
  skillPath: string,
  options: Omit<PackageSkillOptions, 'outputPath'> & { outputPath?: string } = {}
) {
  const tempDir = dirname(skillPath);
  const defaultOutputPath = join(tempDir, 'output');
  return packageSkill(skillPath, {
    ...options,
    outputPath: options.outputPath ?? defaultOutputPath,
  });
}

/**
 * Helper to create a skill with a linked file and test packaging
 * Reduces duplication in link rewriting tests
 */
async function createSkillWithLink(
  tempDir: string,
  linkHref: string,
  linkTarget: string,
  linkContent: string,
  options: { subdirectory?: string; linkText?: string } = {}
): Promise<{ skillPath: string; linkedPath: string }> {
  const skillPath = join(tempDir, 'SKILL.md');
  const linkText = options.linkText ?? 'guide';

  let linkedPath: string;
  if (options.subdirectory) {
    const subdir = join(tempDir, options.subdirectory);
    await mkdir(subdir, { recursive: true });
    linkedPath = join(subdir, linkTarget);
  } else {
    linkedPath = join(tempDir, linkTarget);
  }

  await writeFile(linkedPath, linkContent);
  await writeFile(
    skillPath,
    `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [${linkText}](${linkHref}).`
  );

  return { skillPath, linkedPath };
}

/**
 * Helper to create a simple skill and package with options
 * Reduces duplication in simple packaging tests
 */
async function createAndPackageSkill(
  tempDir: string,
  skillContent: string,
  options: Omit<PackageSkillOptions, 'outputPath'> = {}
) {
  const skillPath = join(tempDir, 'SKILL.md');
  await writeFile(skillPath, skillContent);
  return packageSkillForTest(skillPath, options);
}

/**
 * Helper to test link rewriting - creates skill with link, packages, and returns copied content
 * Reduces duplication in link rewriting tests
 */
async function testLinkRewriting(
  tempDir: string,
  linkHref: string,
  linkTarget: string,
  linkContent: string,
  options: { subdirectory?: string; linkText?: string } = {}
): Promise<string> {
  const { skillPath } = await createSkillWithLink(
    tempDir,
    linkHref,
    linkTarget,
    linkContent,
    options
  );

  const result = await packageSkillForTest(skillPath, {
    formats: ['directory'],
    rewriteLinks: true,
  });

  return readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
}

describe('skill-packager: extractSkillMetadata', () => {
  it('should extract required name from frontmatter', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');

    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n# Test Skill`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.skill.name).toBe(TEST_SKILL_NAME);
  });

  it('should extract optional metadata fields', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');

    await writeFile(
      skillPath,
      `${createFrontmatter({
        name: TEST_SKILL_NAME,
        description: 'A test skill',
        version: '1.0.0',
        license: 'MIT',
        author: 'Test Author',
      })}\n\n# Test Skill`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.skill).toEqual({
      name: TEST_SKILL_NAME,
      description: 'A test skill',
      version: '1.0.0',
      license: 'MIT',
      author: 'Test Author',
    });
  });

  it('should throw error if name is missing', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');

    await writeFile(
      skillPath,
      `${createFrontmatter({ description: 'No name' })}\n\n# Test Skill`
    );

    await expect(packageSkill(skillPath, { formats: [] }))
      .rejects
      .toThrow('SKILL.md must have a name in frontmatter');
  });

  it('should trim whitespace from name', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');

    await writeFile(
      skillPath,
      `${createFrontmatter({ name: '  test-skill  ' })}\n\n# Test Skill`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.skill.name).toBe(TEST_SKILL_NAME);
  });
});

describe('skill-packager: collectLinkedResources', () => {
  it('should collect single linked markdown file', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const linkedPath = join(tempDir, GUIDE_MD);

    await writeFile(linkedPath, '# Guide\n\nLinked content.');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [guide](./guide.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toEqual([GUIDE_MD]);
  });

  it('should collect recursively linked files', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const level1Path = join(tempDir, 'level1.md');
    const level2Path = join(tempDir, 'level2.md');

    await writeFile(level2Path, '# Level 2\n\nDeep content.');
    await writeFile(level1Path, '# Level 1\n\nSee [level2](./level2.md).');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [level1](./level1.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toHaveLength(2);
    expect(result.files.dependencies).toContain('level1.md');
    expect(result.files.dependencies).toContain('level2.md');
  });

  it('should handle circular references without infinite loop', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const aPath = join(tempDir, 'a.md');
    const bPath = join(tempDir, 'b.md');

    // Create circular references: SKILL -> a -> b -> a
    await writeFile(aPath, '# A\n\nSee [b](./b.md).');
    await writeFile(bPath, '# B\n\nSee [a](./a.md).');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [a](./a.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    // Should collect both without infinite loop
    expect(result.files.dependencies).toHaveLength(2);
    expect(result.files.dependencies).toContain('a.md');
    expect(result.files.dependencies).toContain('b.md');
  });

  it('should skip non-local links (http, https, mailto)', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');

    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [external](https://example.com) and [email](mailto:test@example.com).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toHaveLength(0);
  });

  it('should skip pure anchor links', async () => {
    const tempDir = getTempDir();
    const result = await createAndPackageSkill(
      tempDir,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [section](#section) below.`,
      { formats: [] }
    );

    expect(result.files.dependencies).toHaveLength(0);
  });

  it('should handle links with anchors by stripping anchor', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const guidePath = join(tempDir, GUIDE_MD);

    await writeFile(guidePath, '# Guide\n\n## Section\n\nContent.');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [section](./guide.md#section).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toEqual([GUIDE_MD]);
  });

  it('should collect files from subdirectories', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const docsDir = join(tempDir, 'docs');
    const docPath = join(docsDir, GUIDE_MD);

    await mkdir(docsDir, { recursive: true });
    await writeFile(docPath, GUIDE_CONTENT);
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [guide](./docs/guide.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toEqual([toForwardSlash(DOCS_GUIDE_MD)]);
  });

  it('should deduplicate multiple references to same file', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const guidePath = join(tempDir, GUIDE_MD);

    await writeFile(guidePath, GUIDE_CONTENT);
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [guide1](./guide.md) and [guide2](./guide.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toEqual([GUIDE_MD]);
  });

  it('should skip non-.md files', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const imagePath = join(tempDir, 'image.png');

    await writeFile(imagePath, 'fake-image-data');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See ![image](./image.png).`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toHaveLength(0);
  });
});

describe('skill-packager: link rewriting', () => {
  it('should rewrite relative links when copying to new location', async () => {
    const tempDir = getTempDir();
    const { skillPath } = await createSkillWithLink(
      tempDir,
      './guide.md',
      GUIDE_MD,
      '# Guide'
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: true,
    });

    const copiedContent = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(copiedContent).toContain('[guide](guide.md)');
  });

  it('should preserve links when rewriteLinks is false', async () => {
    const tempDir = getTempDir();
    const { skillPath } = await createSkillWithLink(
      tempDir,
      './guide.md',
      GUIDE_MD,
      '# Guide'
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: false,
    });

    const copiedContent = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(copiedContent).toContain('[guide](./guide.md)');
  });

  it('should preserve external URLs during rewriting', async () => {
    const tempDir = getTempDir();
    const result = await createAndPackageSkill(
      tempDir,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [external](https://example.com) and [mailto](mailto:test@example.com).`,
      { formats: ['directory'], rewriteLinks: true }
    );

    const copiedContent = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(copiedContent).toContain('[external](https://example.com)');
    expect(copiedContent).toContain('[mailto](mailto:test@example.com)');
  });

  it('should preserve anchor-only links during rewriting', async () => {
    const tempDir = getTempDir();
    const result = await createAndPackageSkill(
      tempDir,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [section](#section) below.`,
      { formats: ['directory'], rewriteLinks: true }
    );

    const copiedContent = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(copiedContent).toContain('[section](#section)');
  });

  it('should rewrite links with anchors correctly', async () => {
    const tempDir = getTempDir();
    const copiedContent = await testLinkRewriting(
      tempDir,
      './guide.md#section',
      GUIDE_MD,
      '# Guide\n\n## Section',
      { linkText: 'section' }
    );
    expect(copiedContent).toContain('[section](guide.md#section)');
  });

  it('should handle subdirectory structure in link rewriting', async () => {
    const tempDir = getTempDir();
    const copiedContent = await testLinkRewriting(
      tempDir,
      './docs/guide.md',
      GUIDE_MD,
      '# Guide',
      { subdirectory: 'docs' }
    );
    expect(copiedContent).toContain('[guide](docs/guide.md)');
  });

  it('should rewrite reference-style links', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');

    await writeFile(join(tempDir, GUIDE_MD), '# Guide');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [guide][guide-ref].\n\n[guide-ref]: ./guide.md`
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: true,
    });

    const copiedContent = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(copiedContent).toContain('[guide-ref]: guide.md');
  });
});

describe('skill-packager: file copying', () => {
  it('should copy SKILL.md to output directory', async () => {
    const tempDir = getTempDir();
    const result = await createAndPackageSkill(
      tempDir,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n${TEST_SKILL_CONTENT}`,
      { formats: ['directory'] }
    );

    const copiedContent = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(copiedContent).toContain('name: test-skill');
    expect(copiedContent).toContain(TEST_SKILL_CONTENT);
  });

  it('should copy linked files preserving directory structure', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const docsDir = join(tempDir, 'docs');
    const guidePath = join(docsDir, GUIDE_MD);

    await mkdir(docsDir, { recursive: true });
    await writeFile(guidePath, GUIDE_CONTENT);
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [guide](./docs/guide.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: ['directory'] });

    const copiedGuidePath = join(result.outputPath, 'docs', GUIDE_MD);
    const copiedGuideContent = await readFile(copiedGuidePath, 'utf-8');

    expect(copiedGuideContent).toBe(GUIDE_CONTENT);
  });

  it('should preserve file contents exactly when rewriteLinks is false', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const content = `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n# Test\n\nSpecial chars: àéïöü\nEmojis: 🐱🎉`;

    await writeFile(skillPath, content);

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: false,
    });

    const copiedSkillPath = join(result.outputPath, 'SKILL.md');
    const copiedContent = await readFile(copiedSkillPath, 'utf-8');

    expect(copiedContent).toBe(content);
  });
});

describe('skill-packager: output path determination', () => {
  it('should use default output path when not specified', async () => {
    const tempDir = getTempDir();

    // Create package.json to establish package root
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-package' })
    );

    const skillPath = join(tempDir, 'SKILL.md');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n# Test`
    );

    // Use packageSkill directly (not helper) to test default path detection
    const result = await packageSkill(skillPath, { formats: [] });

    // Should be <package-root>/dist/skills/<skill-name>
    expect(result.outputPath).toContain('dist');
    expect(result.outputPath).toContain('skills');
    expect(result.outputPath).toContain(TEST_SKILL_NAME);
  });

  it('should use custom output path when specified', async () => {
    const tempDir = getTempDir();
    const customPath = join(tempDir, 'custom-output');
    const skillPath = join(tempDir, 'SKILL.md');

    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n# Test`
    );

    const result = await packageSkillForTest(skillPath, {
      formats: [],
      outputPath: customPath,
    });

    expect(result.outputPath).toBe(customPath);
  });
});

describe('skill-packager: integration', () => {
  it('should package skill with all components', async () => {
    const tempDir = getTempDir();
    const skillPath = join(tempDir, 'SKILL.md');
    const docsDir = join(tempDir, 'docs');
    const guidePath = join(docsDir, GUIDE_MD);
    const referencePath = join(docsDir, 'reference.md');

    // Create linked structure
    await mkdir(docsDir, { recursive: true });
    await writeFile(referencePath, '# Reference\n\nAPI docs.');
    await writeFile(
      guidePath,
      GUIDE_WITH_REF
    );
    await writeFile(
      skillPath,
      `${createFrontmatter({
        name: COMPLEX_SKILL_NAME,
        description: 'A complex skill',
        version: '1.0.0',
      })}\n\nSee [guide](./docs/guide.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: ['directory'] });

    // Verify metadata
    expect(result.skill.name).toBe(COMPLEX_SKILL_NAME);
    expect(result.skill.description).toBe('A complex skill');
    expect(result.skill.version).toBe('1.0.0');

    // Verify files collected
    expect(result.files.dependencies).toHaveLength(2);
    expect(result.files.dependencies).toContain(toForwardSlash(DOCS_GUIDE_MD));
    expect(result.files.dependencies).toContain(toForwardSlash('docs/reference.md'));

    // Verify files copied
    const copiedSkill = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    const copiedGuide = await readFile(join(result.outputPath, 'docs', GUIDE_MD), 'utf-8');
    const copiedReference = await readFile(join(result.outputPath, 'docs', 'reference.md'), 'utf-8');

    expect(copiedSkill).toContain(COMPLEX_SKILL_NAME);
    expect(copiedGuide).toContain('# Guide');
    expect(copiedReference).toContain('# Reference');

    // Verify artifacts
    expect(result.artifacts).toBeDefined();
    expect(result.artifacts?.directory).toBe(result.outputPath);
  });
});

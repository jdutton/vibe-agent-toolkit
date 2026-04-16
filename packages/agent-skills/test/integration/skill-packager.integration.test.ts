/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { packageSkill, type PackageSkillOptions } from '../../src/skill-packager.js';
import { createFrontmatter, setupTempDir } from '../test-helpers.js';

const { getTempDir } = setupTempDir('skill-packager-');

// Test constants
const TEST_SKILL_NAME = 'test-skill';
const TEST_SKILL_CONTENT = '# Test Skill';
const COMPLEX_SKILL_NAME = 'complex-skill';
const GUIDE_MD = 'guide.md';
const DOCS_GUIDE_MD = 'docs/guide.md';
const GUIDE_CONTENT = '# Guide\n\nContent.';
const GUIDE_WITH_REF = '# Guide\n\nSee [reference](./reference.md).';
const CONFIG_JSON = 'config.json';
const CONFIG_YAML = 'config.yaml';
const REFERENCE_MD = 'reference.md';

/**
 * Helper to package skill with default output path
 * Prevents tests from failing due to missing package.json in temp dir
 */
async function packageSkillForTest(
  skillPath: string,
  options: Omit<PackageSkillOptions, 'outputPath'> & { outputPath?: string } = {}
) {
  const tempDir = dirname(skillPath);
  const defaultOutputPath = safePath.join(tempDir, 'output');
  return packageSkill(skillPath, {
    ...options,
    outputPath: options.outputPath ?? defaultOutputPath,
  });
}

/**
 * Package a skill with rewriteLinks and read the resulting SKILL.md content.
 */
async function packageAndReadSkillContent(skillPath: string): Promise<string> {
  const result = await packageSkillForTest(skillPath, {
    formats: ['directory'],
    rewriteLinks: true,
  });
  return readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
}

/**
 * Helper to create a two-level linked chain: SKILL.md -> level1.md -> level2.md
 * Used by both recursive collection tests and depth-limited packaging tests
 */
async function createTwoLevelChain(tempDir: string): Promise<string> {
  const skillPath = safePath.join(tempDir, 'SKILL.md');

  await writeFile(safePath.join(tempDir, 'level2.md'), '# Level 2\n\nDeep content.');
  await writeFile(safePath.join(tempDir, 'level1.md'), '# Level 1\n\nSee [level2](./level2.md).');
  await writeFile(
    skillPath,
    `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [level1](./level1.md).`
  );

  return skillPath;
}

/**
 * Helper to create a skill with a single guide.md link
 * Used by deduplication tests, exclude pattern tests, and other single-link tests
 */
async function createSkillWithGuideFile(
  tempDir: string,
  skillBody: string,
): Promise<string> {
  const skillPath = safePath.join(tempDir, 'SKILL.md');

  await writeFile(safePath.join(tempDir, GUIDE_MD), GUIDE_CONTENT);
  await writeFile(skillPath, `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n${skillBody}`);

  return skillPath;
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
  const skillPath = safePath.join(tempDir, 'SKILL.md');
  const linkText = options.linkText ?? 'guide';

  let linkedPath: string;
  if (options.subdirectory) {
    const subdir = safePath.join(tempDir, options.subdirectory);
    await mkdir(subdir, { recursive: true });
    linkedPath = safePath.join(subdir, linkTarget);
  } else {
    linkedPath = safePath.join(tempDir, linkTarget);
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
  const skillPath = safePath.join(tempDir, 'SKILL.md');
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

  return readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
}

describe('skill-packager: extractSkillMetadata', () => {
  it('should extract required name from frontmatter', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');

    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n# Test Skill`
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.skill.name).toBe(TEST_SKILL_NAME);
  });

  it('should extract optional metadata fields', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');

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

  it('should use H1 title as fallback if name missing in frontmatter', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const outputPath = safePath.join(tempDir, 'output');

    await writeFile(
      skillPath,
      `${createFrontmatter({ description: 'No name' })}\n\n# Test Skill`
    );

    const result = await packageSkill(skillPath, { formats: [], outputPath });
    expect(result.skill.name).toBe('Test Skill');
  });

  it('should use filename as last resort if no name or H1', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'my-custom-skill.md');
    const outputPath = safePath.join(tempDir, 'output');

    await writeFile(
      skillPath,
      `${createFrontmatter({ description: 'No name or H1' })}\n\nSome content without H1`
    );

    const result = await packageSkill(skillPath, { formats: [], outputPath });
    expect(result.skill.name).toBe('my-custom-skill');
  });

  it('should trim whitespace from name', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');

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
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const linkedPath = safePath.join(tempDir, GUIDE_MD);

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
    const skillPath = await createTwoLevelChain(tempDir);

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toHaveLength(2);
    expect(result.files.dependencies).toContain('level1.md');
    expect(result.files.dependencies).toContain('level2.md');
  });

  it('should handle circular references without infinite loop', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const aPath = safePath.join(tempDir, 'a.md');
    const bPath = safePath.join(tempDir, 'b.md');

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
    const skillPath = safePath.join(tempDir, 'SKILL.md');

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
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const guidePath = safePath.join(tempDir, GUIDE_MD);

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
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const docsDir = safePath.join(tempDir, 'docs');
    const docPath = safePath.join(docsDir, GUIDE_MD);

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
    const skillPath = await createSkillWithGuideFile(
      tempDir,
      'See [guide1](./guide.md) and [guide2](./guide.md).',
    );

    const result = await packageSkillForTest(skillPath, { formats: [] });

    expect(result.files.dependencies).toEqual([GUIDE_MD]);
  });

  it('should skip non-.md files', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const imagePath = safePath.join(tempDir, 'image.png');

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

    const copiedContent = await packageAndReadSkillContent(skillPath);
    expect(copiedContent).toContain('[guide](resources/guide.md)');
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

    const copiedContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
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

    const copiedContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
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

    const copiedContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
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
    expect(copiedContent).toContain('[section](resources/guide.md#section)');
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
    // Flat structure: all files under resources/, links rewritten accordingly
    expect(copiedContent).toContain('[guide](resources/guide.md)');
  });

  it('should rewrite reference-style links', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');

    await writeFile(safePath.join(tempDir, GUIDE_MD), '# Guide');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [guide][guide-ref].\n\n[guide-ref]: ./guide.md`
    );

    const copiedContent = await packageAndReadSkillContent(skillPath);
    expect(copiedContent).toContain('[guide-ref]: resources/guide.md');
  });

  it('should rewrite links to non-markdown bundled files (YAML → templates/)', async () => {
    const tempDir = getTempDir();
    const skillDir = safePath.join(tempDir, 'yaml-link-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(safePath.join(skillDir, 'SKILL.md'), [
      '---',
      'name: yaml-link-test',
      'description: Test YAML link rewriting',
      '---',
      TEST_SKILL_CONTENT,
      '',
      'Load [config](resources/config.yaml) at startup.',
    ].join('\n'));

    const resourcesDir = safePath.join(skillDir, 'resources');
    await mkdir(resourcesDir, { recursive: true });
    await writeFile(safePath.join(resourcesDir, CONFIG_YAML), 'key: value\n');

    const result = await packageSkillForTest(safePath.join(skillDir, 'SKILL.md'), {
      formats: ['directory'],
      rewriteLinks: true,
    });

    // YAML should be routed to templates/
    const yamlExists = existsSync(safePath.join(result.outputPath, 'templates', CONFIG_YAML));
    expect(yamlExists).toBe(true);

    // Link should be rewritten to templates/config.yaml, NOT stripped to ()
    const skillContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('[config](templates/config.yaml)');
    expect(skillContent).not.toContain('()');
  });

  it('should handle paired markdown and non-markdown files with same stem', async () => {
    const tempDir = getTempDir();
    const skillDir = safePath.join(tempDir, 'paired-files-skill');
    const resourcesDir = safePath.join(skillDir, 'resources');
    await mkdir(resourcesDir, { recursive: true });

    await writeFile(safePath.join(resourcesDir, CONFIG_YAML), 'key: value\n');
    await writeFile(safePath.join(resourcesDir, 'config.md'), '# Config Docs\n');

    await writeFile(safePath.join(skillDir, 'SKILL.md'), [
      '---',
      'name: paired-files-test',
      'description: Test paired markdown and non-markdown files',
      '---',
      TEST_SKILL_CONTENT,
      '',
      'Load [config data](resources/config.yaml) and see [config docs](resources/config.md).',
    ].join('\n'));

    // Should not throw duplicate-ID error
    const result = await packageSkillForTest(safePath.join(skillDir, 'SKILL.md'), {
      formats: ['directory'],
      rewriteLinks: true,
    });

    // Both files should be in output (different content-type routing)
    expect(existsSync(safePath.join(result.outputPath, 'templates', CONFIG_YAML))).toBe(true);
    expect(existsSync(safePath.join(result.outputPath, 'resources', 'config.md'))).toBe(true);

    // Both links rewritten correctly
    const skillContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('[config data](templates/config.yaml)');
    expect(skillContent).toContain('[config docs](resources/config.md)');
  });

  it('should preserve links to already-bundled resources even when depth-exceeded from current file', async () => {
    const tempDir = getTempDir();
    const skillDir = safePath.join(tempDir, 'depth-boundary-skill');
    await mkdir(skillDir, { recursive: true });

    // SKILL.md links to both guide.md and reference.md (both at depth 1)
    await writeFile(safePath.join(skillDir, 'SKILL.md'), [
      '---',
      'name: depth-boundary-test',
      'description: Test depth boundary link preservation',
      '---',
      '# Test Skill',
      '',
      'See [Guide](guide.md) and [Reference](reference.md).',
    ].join('\n'));

    // guide.md links to reference.md (would be depth 2 from guide's perspective)
    await writeFile(safePath.join(skillDir, 'guide.md'), [
      '# Guide',
      '',
      'Also see [Reference](reference.md) for details.',
    ].join('\n'));

    await writeFile(safePath.join(skillDir, REFERENCE_MD), [
      '# Reference',
      '',
      'Reference content here.',
    ].join('\n'));

    const result = await packageSkillForTest(safePath.join(skillDir, 'SKILL.md'), {
      formats: ['directory'],
      linkFollowDepth: 1,
      rewriteLinks: true,
    });

    // Both files should be bundled
    expect(existsSync(safePath.join(result.outputPath, 'resources', 'guide.md'))).toBe(true);
    expect(existsSync(safePath.join(result.outputPath, 'resources', REFERENCE_MD))).toBe(true);

    // guide.md's link to reference.md should be PRESERVED (not stripped)
    const guideContent = await readFile(
      safePath.join(result.outputPath, 'resources', 'guide.md'), 'utf-8'
    );
    expect(guideContent).toContain('(reference.md)');
    expect(guideContent).not.toContain('Reference for details.');  // not plain text
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

    const copiedContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(copiedContent).toContain('name: test-skill');
    expect(copiedContent).toContain(TEST_SKILL_CONTENT);
  });

  it('should copy linked files preserving directory structure', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const docsDir = safePath.join(tempDir, 'docs');
    const guidePath = safePath.join(docsDir, GUIDE_MD);

    await mkdir(docsDir, { recursive: true });
    await writeFile(guidePath, GUIDE_CONTENT);
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n` +
        `See [guide](./docs/guide.md).`
    );

    const result = await packageSkillForTest(skillPath, { formats: ['directory'] });

    // Flat structure: all linked files under resources/ subdirectory
    const copiedGuidePath = safePath.join(result.outputPath, 'resources', GUIDE_MD);
    const copiedGuideContent = await readFile(copiedGuidePath, 'utf-8');

    expect(copiedGuideContent).toBe(GUIDE_CONTENT);
  });

  it('should preserve file contents exactly when rewriteLinks is false', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const content = `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\n# Test\n\nSpecial chars: àéïöü\nEmojis: 🐱🎉`;

    await writeFile(skillPath, content);

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: false,
    });

    const copiedSkillPath = safePath.join(result.outputPath, 'SKILL.md');
    const copiedContent = await readFile(copiedSkillPath, 'utf-8');

    expect(copiedContent).toBe(content);
  });
});

describe('skill-packager: output path determination', () => {
  it('should use default output path when not specified', async () => {
    const tempDir = getTempDir();

    // Create package.json to establish package root
    await writeFile(
      safePath.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-package' })
    );

    const skillPath = safePath.join(tempDir, 'SKILL.md');
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
    const customPath = safePath.join(tempDir, 'custom-output');
    const skillPath = safePath.join(tempDir, 'SKILL.md');

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

describe('skill-packager: depth-limited packaging', () => {
  it('should exclude files beyond linkFollowDepth and rewrite links to text', async () => {
    const tempDir = getTempDir();
    const skillPath = await createTwoLevelChain(tempDir);

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      linkFollowDepth: 1,
      rewriteLinks: true,
    });

    // level1.md should be bundled (depth 0), level2.md excluded (depth 1 >= maxDepth 1)
    expect(result.files.dependencies).toContain('level1.md');
    expect(result.files.dependencies).not.toContain('level2.md');

    // The link to level2.md in level1.md should be rewritten to just the link text
    const level1Content = await readFile(safePath.join(result.outputPath, 'resources', 'level1.md'), 'utf-8');
    expect(level1Content).toContain('level2');
    expect(level1Content).not.toContain('[level2](');

    // excludedReferences should contain level2.md
    expect(result.excludedReferences).toBeDefined();
    expect(result.excludedReferences).toContain('level2.md');
  });

  it('should use custom template for excluded link rewriting', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const level1Path = safePath.join(tempDir, 'level1.md');

    await writeFile(level1Path, '# Level 1\n\nContent.');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [important doc](./level1.md).`
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      linkFollowDepth: 0,
      rewriteLinks: true,
      excludeReferencesFromBundle: {
        defaultTemplate: '{{link.text}} (search KB for details)',
      },
    });

    // level1.md should be excluded (depth 0 means no markdown links followed)
    expect(result.files.dependencies).not.toContain('level1.md');

    // The link in SKILL.md should be rewritten using the custom template
    const skillContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('important doc (search KB for details)');
    expect(skillContent).not.toContain('[important doc](');
  });

  it('should render all template variables (skill.name, link.resource.fileName, link.href)', async () => {
    const tempDir = getTempDir();
    const subDir = safePath.join(tempDir, 'docs');
    await mkdir(subDir, { recursive: true });
    const refPath = safePath.join(subDir, REFERENCE_MD);
    const skillPath = safePath.join(tempDir, 'SKILL.md');

    await writeFile(refPath, '# Reference\n\nContent.');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: 'my-test-skill' })}\n\nSee [ref](./docs/reference.md).`
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      linkFollowDepth: 0,
      rewriteLinks: true,
      excludeReferencesFromBundle: {
        defaultTemplate: 'Search {{skill.name}} for {{link.resource.fileName}} ({{link.href}})',
      },
    });

    const skillContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('Search my-test-skill for reference.md (./docs/reference.md)');
    expect(skillContent).not.toContain('[ref](');
  });

  it('should bundle non-markdown assets as plain copies', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const jsonPath = safePath.join(tempDir, CONFIG_JSON);
    const jsonContent = JSON.stringify({ key: 'value' });

    await writeFile(jsonPath, jsonContent);
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nConfig: [config](./config.json).`
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: true,
    });

    // JSON file should be bundled
    expect(result.files.dependencies).toContain(CONFIG_JSON);

    // JSON file should be copied as-is (plain copy, not rewritten)
    // Content-type routing places .json files in templates/
    const copiedJson = await readFile(safePath.join(result.outputPath, 'templates', CONFIG_JSON), 'utf-8');
    expect(copiedJson).toBe(jsonContent);
  });

  it('should exclude pattern-matched files and rewrite links using rule template', async () => {
    const tempDir = getTempDir();
    const skillPath = await createSkillWithGuideFile(
      tempDir,
      'See [the guide](./guide.md).',
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      linkFollowDepth: 'full',
      rewriteLinks: true,
      excludeReferencesFromBundle: {
        rules: [{
          patterns: ['**/*.md'],
          template: '[Search: {{link.text}}]',
        }],
      },
    });

    // guide.md should be excluded by pattern (NOT in output)
    expect(result.files.dependencies).not.toContain(GUIDE_MD);
    expect(result.excludedReferences).toBeDefined();
    expect(result.excludedReferences).toContain(GUIDE_MD);

    // The link in SKILL.md should be rewritten using the rule's template
    const skillContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('[Search: the guide]');
    expect(skillContent).not.toContain('[the guide](');
  });

  it('should preserve inline code formatting in bundled link text after rewriting', async () => {
    // Authors commonly write `[\`path.yaml\`](path.yaml)` so the rendered HTML
    // shows the path styled as code. The packaged output must keep the backticks
    // when the href is rewritten to the new output location.
    const configYaml = 'config.yaml';
    const tempDir = getTempDir();
    const configDir = safePath.join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(safePath.join(configDir, configYaml), 'setting: value\n');

    const skillPath = safePath.join(tempDir, 'SKILL.md');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [\`config/${configYaml}\`](./config/${configYaml}).`
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: true,
    });

    const skillContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    // Backticks preserved around the code-styled link text
    expect(skillContent).toContain(`[\`config/${configYaml}\`](templates/${configYaml})`);
  });

  it('should apply pattern-based excludes to terminal non-markdown links', async () => {
    // Terminal links to assets (YAML, JSON, images) are not indexed by the
    // registry (the registry only crawls markdown). Their pattern-based exclude
    // must fall back to matching the raw href so the link is rewritten via the
    // rule template rather than leaking through the bundled-link template with
    // an undefined `link.resource.*`.
    const rosterYaml = 'roster.yaml';
    const tempDir = getTempDir();
    const dataDir = safePath.join(tempDir, 'data', 'teams');
    await mkdir(dataDir, { recursive: true });
    await writeFile(safePath.join(dataDir, rosterYaml), 'members:\n  - alice\n');

    const skillPath = safePath.join(tempDir, 'SKILL.md');
    await writeFile(
      skillPath,
      `${createFrontmatter({ name: TEST_SKILL_NAME })}\n\nSee [the roster](./data/teams/${rosterYaml}).`
    );

    const result = await packageSkillForTest(skillPath, {
      formats: ['directory'],
      rewriteLinks: true,
      excludeReferencesFromBundle: {
        rules: [{
          patterns: ['**/data/**'],
          template: '{{link.text}} (search KB)',
        }],
      },
    });

    // The YAML must NOT be bundled (pattern excluded it)
    const yamlOutput = safePath.join(result.outputPath, 'templates', rosterYaml);
    expect(existsSync(yamlOutput)).toBe(false);

    // The terminal link must be rewritten via the pattern's template, not left
    // as a broken relative path and not collapsed to `[text]()` by the bundled
    // rule's template.
    const skillContent = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('the roster (search KB)');
    expect(skillContent).not.toContain('[the roster](');
    expect(skillContent).not.toContain(rosterYaml);

    // No post-build integrity issues should surface.
    expect(result.postBuildIssues ?? []).toEqual([]);
  });
});

describe('skill-packager: integration', () => {
  it('should package skill with all components', async () => {
    const tempDir = getTempDir();
    const skillPath = safePath.join(tempDir, 'SKILL.md');
    const docsDir = safePath.join(tempDir, 'docs');
    const guidePath = safePath.join(docsDir, GUIDE_MD);
    const referencePath = safePath.join(docsDir, REFERENCE_MD);

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
    expect(result.files.dependencies).toContain(toForwardSlash(`docs/${REFERENCE_MD}`));

    // Verify files copied (linked files under resources/ subdirectory)
    const copiedSkill = await readFile(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    const copiedGuide = await readFile(safePath.join(result.outputPath, 'resources', GUIDE_MD), 'utf-8');
    const copiedReference = await readFile(safePath.join(result.outputPath, 'resources', REFERENCE_MD), 'utf-8');

    expect(copiedSkill).toContain(COMPLEX_SKILL_NAME);
    expect(copiedGuide).toContain('# Guide');
    expect(copiedReference).toContain('# Reference');

    // Verify artifacts
    expect(result.artifacts).toBeDefined();
    expect(result.artifacts?.directory).toBe(result.outputPath);
  });
});

const ORPHAN_DEST = 'resources/orphan.txt';

/**
 * Set up a temp project with a package.json so findProjectRoot() anchors correctly,
 * then create a skill and an orphan asset. Returns the skill path and output path.
 */
async function setupUnreferencedFixture(
  rootDir: string,
  skillName: string,
): Promise<{ skillPath: string; outputPath: string }> {
  await writeFile(
    safePath.join(rootDir, 'package.json'),
    JSON.stringify({ name: 'unref-fixture', workspaces: ['skills/*'] }),
  );
  const skillDir = safePath.join(rootDir, 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await mkdir(safePath.join(rootDir, 'extra'), { recursive: true });

  const skillPath = safePath.join(skillDir, 'SKILL.md');
  await writeFile(skillPath, [
    '---',
    `name: ${skillName}`,
    'description: Test unreferenced file detection',
    '---',
    TEST_SKILL_CONTENT,
    '',
    'This skill has no links.',
  ].join('\n'));

  await writeFile(safePath.join(rootDir, 'extra', 'orphan.txt'), 'orphan content\n');

  return {
    skillPath,
    outputPath: safePath.join(rootDir, 'out', skillName),
  };
}

describe('skill-packager: post-build integrity', () => {
  it('should report PACKAGED_UNREFERENCED_FILE for files not referenced from markdown', async () => {
    const tempDir = getTempDir();
    const rootDir = safePath.join(tempDir, 'unreferenced-root');
    await mkdir(rootDir, { recursive: true });
    const { skillPath, outputPath } = await setupUnreferencedFixture(rootDir, 'unreferenced-test');

    const result = await packageSkill(skillPath, {
      outputPath,
      formats: ['directory'],
      rewriteLinks: true,
      files: [{ source: 'extra/orphan.txt', dest: ORPHAN_DEST }],
    });

    // File should exist in output
    expect(existsSync(safePath.join(result.outputPath, ORPHAN_DEST))).toBe(true);

    // Result should include the unreferenced-file issue
    expect(result.postBuildIssues).toBeDefined();
    expect(result.postBuildIssues?.some(i =>
      i.code === 'PACKAGED_UNREFERENCED_FILE' && i.message.includes('orphan.txt')
    )).toBe(true);

    // Also assert no broken-link issues — guards against fixture drift
    expect(result.postBuildIssues?.filter(i => i.code === 'PACKAGED_BROKEN_LINK')).toHaveLength(0);
  });

  it('should suppress PACKAGED_UNREFERENCED_FILE when validation.severity is set to ignore', async () => {
    const tempDir = getTempDir();
    const rootDir = safePath.join(tempDir, 'unreferenced-suppressed-root');
    await mkdir(rootDir, { recursive: true });
    const { skillPath, outputPath } = await setupUnreferencedFixture(rootDir, 'unreferenced-suppressed-test');

    const result = await packageSkill(skillPath, {
      outputPath,
      formats: ['directory'],
      rewriteLinks: true,
      files: [{ source: 'extra/orphan.txt', dest: ORPHAN_DEST }],
      validation: { severity: { PACKAGED_UNREFERENCED_FILE: 'ignore' } },
    });

    // File should still exist in output (suppression doesn't prevent packaging)
    expect(existsSync(safePath.join(result.outputPath, ORPHAN_DEST))).toBe(true);

    // No active issues should be reported (suppression took effect)
    expect(result.postBuildIssues ?? []).toHaveLength(0);
    // Suppression is not an error
    expect(result.hasErrors).toBe(false);
  });

  it('emits LINK_DROPPED_BY_DEPTH as a warning by default and blocks when severity=error', async () => {
    const tempDir = getTempDir();
    const skillPath = await createTwoLevelChain(tempDir);
    const outputPath = safePath.join(tempDir, 'output-depth-warn');
    const outputPathStrict = safePath.join(tempDir, 'output-depth-error');

    // Default: LINK_DROPPED_BY_DEPTH is a warning, non-blocking
    const warn = await packageSkill(skillPath, {
      outputPath,
      linkFollowDepth: 0,
      formats: ['directory'],
    });
    expect(warn.postBuildIssues?.some(i =>
      i.code === 'LINK_DROPPED_BY_DEPTH' && i.severity === 'warning'
    )).toBe(true);
    expect(warn.hasErrors).toBe(false);

    // Upgraded to error: hasErrors = true, issue surfaces as error
    const strict = await packageSkill(skillPath, {
      outputPath: outputPathStrict,
      linkFollowDepth: 0,
      formats: ['directory'],
      validation: { severity: { LINK_DROPPED_BY_DEPTH: 'error' } },
    });
    expect(strict.hasErrors).toBe(true);
    expect(strict.postBuildIssues?.some(i =>
      i.code === 'LINK_DROPPED_BY_DEPTH' && i.severity === 'error'
    )).toBe(true);
  });
});

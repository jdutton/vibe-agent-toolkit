/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { extractH1Title, packageSkill } from '../src/skill-packager.js';

import { createFrontmatter, setupTempDir } from './test-helpers.js';

// ============================================================================
// Setup
// ============================================================================

const { getTempDir } = setupTempDir('skill-packager-unit-');

// ============================================================================
// Constants - must be distinct from integration test constants
// ============================================================================

const UNIT_SKILL_NAME = 'unit-test-skill';
const DIRECTORY_FORMAT = 'directory' as const;
const DETAILS_MD = 'details.md';

// ============================================================================
// Helpers - unique to this unit test file
// ============================================================================

/** Create a minimal SKILL.md and return its path */
async function writeSkillMd(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const skillPath = join(dir, 'SKILL.md');
  await writeFile(skillPath, `${createFrontmatter({ name })}\n\n${body}`);
  return skillPath;
}

/** Package with explicit outputPath to avoid package.json lookups */
async function packWithOutput(
  skillPath: string,
  overrides: Parameters<typeof packageSkill>[1] = {},
) {
  const dir = join(skillPath, '..');
  return packageSkill(skillPath, {
    outputPath: join(dir, 'out'),
    ...overrides,
  });
}

// ============================================================================
// extractH1Title (exported function, not tested elsewhere)
// ============================================================================

describe('extractH1Title', () => {
  it('should extract H1 from markdown content', () => {
    expect(extractH1Title('# My Title\n\nContent')).toBe('My Title');
  });

  it('should return undefined when content has no H1', () => {
    expect(extractH1Title('No heading here\n\n## H2 only')).toBeUndefined();
  });

  it('should extract the first H1 when multiple are present', () => {
    expect(extractH1Title('# First\n\n# Second')).toBe('First');
  });

  it('should trim leading and trailing whitespace from H1 text', () => {
    expect(extractH1Title('#   Padded Title  \n')).toBe('Padded Title');
  });

  it('should not match H2 or deeper headings', () => {
    expect(extractH1Title('## H2\n### H3\n#### H4')).toBeUndefined();
  });

  it('should handle content that starts with frontmatter-like dashes', () => {
    expect(extractH1Title('---\nsome: yaml\n---\n# After Front')).toBe('After Front');
  });

  it('should handle empty string', () => {
    expect(extractH1Title('')).toBeUndefined();
  });
});

// ============================================================================
// Resource naming strategies
// These tests use different fixture shapes than resource-naming.integration.test.ts
// to avoid duplication. Integration tests use two overview.md files with project dir;
// we use single-file scenarios and unique naming patterns here.
// ============================================================================

describe('packageSkill - resource naming: basename (default)', () => {
  it('should flatten subdirectory files to root', async () => {
    const tmp = getTempDir();
    const nested = join(tmp, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, DETAILS_MD), '# Details');

    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [details](./nested/details.md).');
    const result = await packWithOutput(sp);

    expect(existsSync(join(result.outputPath, 'resources', DETAILS_MD))).toBe(true);
    expect(result.files.dependencies.some(f => toForwardSlash(f).includes(DETAILS_MD))).toBe(true);
  });
});

describe('packageSkill - resource naming: resource-id with stripPrefix', () => {
  it('should kebab-case path and strip configured prefix', async () => {
    const tmp = getTempDir();
    const deep = join(tmp, 'kb', 'section');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'topic.md'), '# Topic');

    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [topic](./kb/section/topic.md).');
    const result = await packWithOutput(sp, {
      resourceNaming: 'resource-id',
      stripPrefix: 'kb',
    });

    // After stripping 'kb', remaining path is section/topic.md -> section-topic.md
    expect(existsSync(join(result.outputPath, 'resources', 'section-topic.md'))).toBe(true);
  });
});

describe('packageSkill - resource naming: preserve-path', () => {
  it('should keep directory structure in output', async () => {
    const tmp = getTempDir();
    const sub = join(tmp, 'articles');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'welcome.md'), '# Welcome');

    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [welcome](./articles/welcome.md).');
    const result = await packWithOutput(sp, { resourceNaming: 'preserve-path' });

    expect(existsSync(join(result.outputPath, 'resources', 'articles', 'welcome.md'))).toBe(true);
  });
});

describe('packageSkill - preserve-path with stripPrefix (no false collision)', () => {
  it('should not collide on same-basename files in different directories', async () => {
    // Reproduces adopter scenario: two overview.md files at different paths
    const tmp = getTempDir();
    const kb = 'knowledge-base';
    const overview = 'overview.md';
    const dirA = join(tmp, kb, 'guides');
    const dirB = join(tmp, kb, 'guides', 'topics', 'quickstart');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, overview), '# Guides Overview');
    await writeFile(join(dirB, overview), '# Quickstart Overview');

    const sp = await writeSkillMd(
      tmp,
      UNIT_SKILL_NAME,
      [
        `See [guides](./${kb}/guides/${overview})`,
        `and [quickstart](./${kb}/guides/topics/quickstart/${overview}).`,
      ].join('\n'),
    );

    const result = await packWithOutput(sp, {
      resourceNaming: 'preserve-path',
      stripPrefix: kb,
      excludeNavigationFiles: false,
    });

    // Both files should exist at their stripped paths (no collision)
    expect(existsSync(join(result.outputPath, 'resources', 'guides', overview))).toBe(true);
    expect(existsSync(join(result.outputPath, 'resources', 'guides', 'topics', 'quickstart', overview))).toBe(true);
  });
});

describe('packageSkill - filename collision detection', () => {
  it('should throw when two different source files map to the same basename', async () => {
    const tmp = getTempDir();
    const dirA = join(tmp, 'alpha');
    const dirB = join(tmp, 'beta');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, 'notes.md'), '# Notes A');
    await writeFile(join(dirB, 'notes.md'), '# Notes B');

    const sp = await writeSkillMd(
      tmp,
      UNIT_SKILL_NAME,
      'See [a notes](./alpha/notes.md) and [b notes](./beta/notes.md).',
    );

    await expect(packWithOutput(sp)).rejects.toThrow(/collision/i);
  });
});

// ============================================================================
// Excluded references reporting
// ============================================================================

describe('packageSkill - excludedReferences reporting', () => {
  it('should populate excludedReferences for depth-limited files', async () => {
    const tmp = getTempDir();
    await writeFile(join(tmp, 'far.md'), '# Far Away');
    await writeFile(join(tmp, 'near.md'), '# Near\n\nSee [far](./far.md).');

    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [near](./near.md).');
    const result = await packWithOutput(sp, { linkFollowDepth: 1 });

    expect(result.excludedReferences).toBeDefined();
    const excluded = result.excludedReferences ?? [];
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.some(r => r.includes('far.md'))).toBe(true);
  });

  it('should deduplicate excluded paths when multiple files reference same excluded target', async () => {
    const tmp = getTempDir();
    await writeFile(join(tmp, 'common.md'), '# Common');
    await writeFile(join(tmp, 'x.md'), '# X\n\nSee [common](./common.md).');
    await writeFile(join(tmp, 'y.md'), '# Y\n\nSee [common](./common.md).');

    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [x](./x.md) and [y](./y.md).');
    const result = await packWithOutput(sp, { linkFollowDepth: 1 });

    const excluded = result.excludedReferences ?? [];
    const commonRefs = excluded.filter(r => r.includes('common.md'));
    expect(commonRefs).toHaveLength(1);
  });

  it('should not set excludedReferences when no files are excluded', async () => {
    const tmp = getTempDir();
    await writeFile(join(tmp, 'page.md'), '# Page');
    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [page](./page.md).');

    const result = await packWithOutput(sp);

    expect(result.excludedReferences).toBeUndefined();
  });
});

// ============================================================================
// Artifact generation (zip, npm, marketplace)
// ============================================================================

describe('packageSkill - artifact generation', () => {
  it('should create a zip artifact alongside the directory', async () => {
    const tmp = getTempDir();
    const outDir = join(tmp, 'zip-out');
    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, '# Zip Test Content');

    const result = await packageSkill(sp, {
      outputPath: outDir,
      formats: [DIRECTORY_FORMAT, 'zip'],
    });

    expect(result.artifacts?.directory).toBe(outDir);
    expect(result.artifacts?.zip).toBeDefined();
    const zipPath = result.artifacts?.zip ?? '';
    expect(existsSync(zipPath)).toBe(true);
    expect(zipPath.endsWith('.zip')).toBe(true);
  });

  it('should create npm package with package.json', async () => {
    const tmp = getTempDir();
    const outDir = join(tmp, 'npm-out');
    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, '# npm Test Content');

    const result = await packageSkill(sp, {
      outputPath: outDir,
      formats: [DIRECTORY_FORMAT, 'npm'],
    });

    expect(result.artifacts?.npm).toBeDefined();

    // Verify package.json was created
    const pkgPath = join(outDir, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);
    const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8'));
    expect(pkgJson.name).toContain(UNIT_SKILL_NAME);
    expect(pkgJson.keywords).toContain('vat');
    expect(pkgJson.files).toContain('**/*.md');
  });

  it('should populate npm package.json with optional metadata when present', async () => {
    const tmp = getTempDir();
    const outDir = join(tmp, 'npm-meta-out');
    const sp = join(tmp, 'SKILL.md');
    await writeFile(sp, `${createFrontmatter({
      name: UNIT_SKILL_NAME,
      description: 'Unit test description',
      version: '2.5.0',
      license: 'Apache-2.0',
      author: 'Unit Tester',
    })}\n\n# Metadata Test`);

    await packageSkill(sp, {
      outputPath: outDir,
      formats: [DIRECTORY_FORMAT, 'npm'],
    });

    const pkgJson = JSON.parse(await readFile(join(outDir, 'package.json'), 'utf-8'));
    expect(pkgJson.version).toBe('2.5.0');
    expect(pkgJson.description).toBe('Unit test description');
    expect(pkgJson.license).toBe('Apache-2.0');
    expect(pkgJson.author).toBe('Unit Tester');
  });

  it('should create marketplace manifest json', async () => {
    const tmp = getTempDir();
    const outDir = join(tmp, 'mkt-out');
    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, '# Marketplace Test');

    const result = await packageSkill(sp, {
      outputPath: outDir,
      formats: [DIRECTORY_FORMAT, 'marketplace'],
    });

    expect(result.artifacts?.marketplace).toBeDefined();
    const manifestPath = result.artifacts?.marketplace ?? '';
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(manifest.name).toBe(UNIT_SKILL_NAME);
    expect(manifest.type).toBe('skill');
    expect(manifest.entrypoint).toBe('SKILL.md');
    expect(manifest.version).toBe('1.0.0'); // default version
  });

  it('should generate all three artifact formats together', async () => {
    const tmp = getTempDir();
    const outDir = join(tmp, 'all-out');
    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, '# All Formats');

    const result = await packageSkill(sp, {
      outputPath: outDir,
      formats: [DIRECTORY_FORMAT, 'zip', 'npm', 'marketplace'],
    });

    expect(result.artifacts?.directory).toBeDefined();
    expect(result.artifacts?.zip).toBeDefined();
    expect(result.artifacts?.npm).toBeDefined();
    expect(result.artifacts?.marketplace).toBeDefined();
  });
});

// ============================================================================
// Excluded link rewriting via templates
// ============================================================================

describe('packageSkill - excluded link rewriting', () => {
  it('should rewrite pattern-excluded links using rule template', async () => {
    const tmp = getTempDir();
    const pvtDir = join(tmp, 'private');
    await mkdir(pvtDir, { recursive: true });
    await writeFile(join(pvtDir, 'credentials.md'), '# Credentials\n\nSensitive data.');

    const sp = await writeSkillMd(
      tmp,
      UNIT_SKILL_NAME,
      'See [credentials](./private/credentials.md) for access.',
    );

    const result = await packWithOutput(sp, {
      excludeReferencesFromBundle: {
        rules: [{ patterns: ['private/**'], template: 'Search for: {{link.text}}' }],
      },
    });

    const content = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Search for: credentials');
    expect(content).not.toContain('[credentials](');
  });

  it('should rewrite depth-exceeded links using defaultTemplate', async () => {
    const tmp = getTempDir();
    await writeFile(join(tmp, 'chain.md'), '# Chain\n\nSee [end](./end.md).');
    await writeFile(join(tmp, 'end.md'), '# End');

    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [chain](./chain.md).');
    const result = await packWithOutput(sp, {
      linkFollowDepth: 1,
      excludeReferencesFromBundle: {
        defaultTemplate: 'Look up: {{link.text}}',
      },
    });

    const chainContent = await readFile(join(result.outputPath, 'resources', 'chain.md'), 'utf-8');
    expect(chainContent).toContain('Look up: end');
    expect(chainContent).not.toContain('[end](');
  });

  it('should render link.fileName and link.filePath in template context', async () => {
    const tmp = getTempDir();
    const sub = join(tmp, 'arch');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'design.md'), '# Design');

    const sp = await writeSkillMd(
      tmp,
      UNIT_SKILL_NAME,
      'See [design doc](./arch/design.md).',
    );

    const result = await packWithOutput(sp, {
      linkFollowDepth: 0,
      excludeReferencesFromBundle: {
        defaultTemplate: '{{link.fileName}} at {{link.filePath}}',
      },
    });

    const content = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(content).toContain('design.md at arch/design.md');
  });

  it('should render skill.name in template context', async () => {
    const tmp = getTempDir();
    await writeFile(join(tmp, 'info.md'), '# Info');

    const sp = await writeSkillMd(tmp, 'branded-skill', 'See [info](./info.md).');
    const result = await packWithOutput(sp, {
      linkFollowDepth: 0,
      excludeReferencesFromBundle: {
        defaultTemplate: 'Find in {{skill.name}} KB',
      },
    });

    const content = await readFile(join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Find in branded-skill KB');
  });
});

// ============================================================================
// Output directory structure integrity
// ============================================================================

describe('packageSkill - output directory structure', () => {
  const GUIDE_MD = 'guide.md';
  const REFERENCE_MD = 'reference.md';

  it('should place bundled resources under resources/ not at root', async () => {
    const tmp = getTempDir();
    const docsDir = join(tmp, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, GUIDE_MD), '# Guide\n\nContent here.');
    await writeFile(join(docsDir, REFERENCE_MD), '# Reference\n\nMore content.');

    const sp = await writeSkillMd(
      tmp,
      UNIT_SKILL_NAME,
      `See [guide](./docs/${GUIDE_MD}) and [reference](./docs/${REFERENCE_MD}).`,
    );
    const result = await packWithOutput(sp);

    // Only SKILL.md and resources/ should be at the root
    const rootEntries = await readdir(result.outputPath);
    const rootMdFiles = rootEntries.filter(e => e.endsWith('.md'));
    expect(rootMdFiles).toEqual(['SKILL.md']);

    // Bundled files should be under resources/
    expect(existsSync(join(result.outputPath, 'resources', GUIDE_MD))).toBe(true);
    expect(existsSync(join(result.outputPath, 'resources', REFERENCE_MD))).toBe(true);

    // Bundled files must NOT be at the root
    expect(existsSync(join(result.outputPath, GUIDE_MD))).toBe(false);
    expect(existsSync(join(result.outputPath, REFERENCE_MD))).toBe(false);
  });

  it('should clean stale files from output directory on rebuild', async () => {
    const tmp = getTempDir();
    const outDir = join(tmp, 'out');
    await writeFile(join(tmp, 'page.md'), '# Page');

    const sp = await writeSkillMd(tmp, UNIT_SKILL_NAME, 'See [page](./page.md).');

    // First build
    await packageSkill(sp, { outputPath: outDir });

    // Plant stale files
    await writeFile(join(outDir, 'stale.md'), '# Should be removed');
    await mkdir(join(outDir, 'old-dir'), { recursive: true });
    await writeFile(join(outDir, 'old-dir', 'leftover.md'), '# Also gone');

    // Rebuild — should clean stale files
    await packageSkill(sp, { outputPath: outDir });

    const rootEntries = await readdir(outDir);
    expect(rootEntries).not.toContain('stale.md');
    expect(rootEntries).not.toContain('old-dir');
    expect(rootEntries).toHaveLength(2);
    expect(rootEntries).toContain('SKILL.md');
    expect(rootEntries).toContain('resources');
  });
});

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

import * as claudePaths from '../../src/utils/claude-paths.js';
import { scanUserContext } from '../../src/utils/user-context-scanner.js';

describe('scanUserContext', () => {
  let suiteDir: string;
  let tempDir: string;
  let testCounter = 0;
  let mockClaudeDir: string;
  let mockPluginsDir: string;
  let mockSkillsDir: string;
  let mockMarketplacesDir: string;

  beforeAll(async () => {
    suiteDir = await mkdtemp(join(normalizedTmpdir(), 'vat-user-context-suite-'));
  });

  afterAll(async () => {
    await rm(suiteDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Create subdirectory for each test
    testCounter++;
    tempDir = join(suiteDir, `test-${testCounter}`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtemp
    await mkdir(tempDir, { recursive: true });

    mockClaudeDir = join(tempDir, '.claude');
    mockPluginsDir = join(mockClaudeDir, 'plugins');
    mockSkillsDir = join(mockClaudeDir, 'skills');
    mockMarketplacesDir = join(mockClaudeDir, 'marketplaces');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: tempDir is from mkdtemp
    await mkdir(mockClaudeDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path derived from mkdtemp
    await mkdir(mockPluginsDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path derived from mkdtemp
    await mkdir(mockSkillsDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path derived from mkdtemp
    await mkdir(mockMarketplacesDir);

    // Mock getClaudeUserPaths to return our temp directories
    vi.spyOn(claudePaths, 'getClaudeUserPaths').mockReturnValue({
      claudeDir: mockClaudeDir,
      pluginsDir: mockPluginsDir,
      skillsDir: mockSkillsDir,
      marketplacesDir: mockMarketplacesDir,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('should scan plugins directory for SKILL.md files', async () => {
    // Create plugin structure
    const plugin1Dir = join(mockPluginsDir, 'plugin1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(plugin1Dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(plugin1Dir, 'SKILL.md'), '# Skill 1');

    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.path).toContain('SKILL.md');
    expect(result.plugins[0]?.format).toBe('agent-skill');
  });

  it('should scan skills directory for SKILL.md files', async () => {
    // Create skill structure
    const skill1Dir = join(mockSkillsDir, 'skill1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(skill1Dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(skill1Dir, 'SKILL.md'), '# Skill 1');

    const result = await scanUserContext();

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.path).toContain('SKILL.md');
    expect(result.skills[0]?.format).toBe('agent-skill');
  });

  it('should return empty arrays when directories are empty', async () => {
    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.marketplaces).toHaveLength(0);
  });

  it('should return empty arrays when directories do not exist', async () => {
    // Delete directories
    await rm(mockPluginsDir, { recursive: true, force: true });
    await rm(mockSkillsDir, { recursive: true, force: true });

    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.marketplaces).toHaveLength(0);
  });

  it('should find multiple skills in plugins directory', async () => {
    // Create multiple plugins
    const plugin1Dir = join(mockPluginsDir, 'plugin1');
    const plugin2Dir = join(mockPluginsDir, 'plugin2');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(plugin1Dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(plugin2Dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(plugin1Dir, 'SKILL.md'), '# Skill 1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(plugin2Dir, 'SKILL.md'), '# Skill 2');

    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(2);
  });

  it('should find skills in nested directories', async () => {
    // Create nested structure
    const nestedDir = join(mockSkillsDir, 'category', 'subcategory', 'myskill');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(nestedDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(nestedDir, 'SKILL.md'), '# Nested Skill');

    const result = await scanUserContext();

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.path).toContain('SKILL.md');
  });

  it('should scan both plugins and skills directories independently', async () => {
    // Create one plugin and one skill
    const pluginDir = join(mockPluginsDir, 'plugin1');
    const skillDir = join(mockSkillsDir, 'skill1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(pluginDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(skillDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(pluginDir, 'SKILL.md'), '# Plugin Skill');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(skillDir, 'SKILL.md'), '# Standalone Skill');

    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(1);
    expect(result.skills).toHaveLength(1);
  });

  it('should handle plugins with both SKILL.md and other files', async () => {
    // Create plugin with SKILL.md and other files
    const pluginDir = join(mockPluginsDir, 'myplugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await mkdir(pluginDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(pluginDir, 'SKILL.md'), '# My Plugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: test temp dir
    await writeFile(join(pluginDir, 'README.md'), '# Readme');

    const result = await scanUserContext();

    // Should only find SKILL.md (README.md not included in plugin scan)
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.path).toContain('SKILL.md');
  });

  it('should return marketplaces as empty array (not implemented yet)', async () => {
    // Marketplaces scan is not implemented yet
    const result = await scanUserContext();

    expect(result.marketplaces).toHaveLength(0);
  });
});

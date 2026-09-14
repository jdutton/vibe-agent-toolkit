import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';


import * as claudePaths from '@vibe-agent-toolkit/claude-marketplace';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { removeScratchDir, withReaddirSyncRefused } from '@vibe-agent-toolkit/utils/testing';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

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
    suiteDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-user-context-suite-'));
  });

  afterAll(async () => {
    await removeScratchDir(suiteDir);
  });

  beforeEach(async () => {
    // Create subdirectory for each test
    testCounter++;
    tempDir = safePath.join(suiteDir, `test-${testCounter}`);
    await mkdir(tempDir, { recursive: true });

    mockClaudeDir = safePath.join(tempDir, '.claude');
    mockPluginsDir = safePath.join(mockClaudeDir, 'plugins');
    mockSkillsDir = safePath.join(mockClaudeDir, 'skills');
    mockMarketplacesDir = safePath.join(mockClaudeDir, 'marketplaces');

    await mkdir(mockClaudeDir);
    await mkdir(mockPluginsDir);
    await mkdir(mockSkillsDir);
    await mkdir(mockMarketplacesDir);

    // Mock getClaudeUserPaths to return our temp directories
    vi.spyOn(claudePaths, 'getClaudeUserPaths').mockReturnValue({
      claudeDir: mockClaudeDir,
      pluginsDir: mockPluginsDir,
      skillsDir: mockSkillsDir,
      marketplacesDir: mockMarketplacesDir,
      userSettingsPath: safePath.join(mockClaudeDir, 'settings.json'),
      userDotJsonPath: safePath.join(tempDir, '.claude.json'),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('should scan plugins directory for SKILL.md files', async () => {
    // Create plugin structure
    const plugin1Dir = safePath.join(mockPluginsDir, 'plugin1');
    await mkdir(plugin1Dir);
    await writeFile(safePath.join(plugin1Dir, 'SKILL.md'), '# Skill 1');

    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.path).toContain('SKILL.md');
    expect(result.plugins[0]?.format).toBe('agent-skill');
  });

  it('should scan skills directory for SKILL.md files', async () => {
    // Create skill structure
    const skill1Dir = safePath.join(mockSkillsDir, 'skill1');
    await mkdir(skill1Dir);
    await writeFile(safePath.join(skill1Dir, 'SKILL.md'), '# Skill 1');

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
    const plugin1Dir = safePath.join(mockPluginsDir, 'plugin1');
    const plugin2Dir = safePath.join(mockPluginsDir, 'plugin2');
    await mkdir(plugin1Dir);
    await mkdir(plugin2Dir);
    await writeFile(safePath.join(plugin1Dir, 'SKILL.md'), '# Skill 1');
    await writeFile(safePath.join(plugin2Dir, 'SKILL.md'), '# Skill 2');

    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(2);
  });

  // `~/.claude/plugins` is populated by sudo installs and macOS quarantine, so
  // one directory the scan cannot list is ordinary there. The listing must keep
  // every plugin it could read AND carry the gap — a shorter list is the defect,
  // and so is aborting the whole listing for one directory.
  it('keeps the readable plugins and reports the directory it could not list', async () => {
    const openDir = safePath.join(mockPluginsDir, 'open');
    const lockedDir = safePath.join(mockPluginsDir, 'locked');
    await mkdir(openDir);
    await mkdir(lockedDir);
    await writeFile(safePath.join(openDir, 'SKILL.md'), '# Open');
    await writeFile(safePath.join(lockedDir, 'SKILL.md'), '# Locked');

    const result = await withReaddirSyncRefused(lockedDir, 'EACCES', () => scanUserContext());

    expect(result.plugins.map((r) => r.relativePath)).toEqual([safePath.join('open', 'SKILL.md')]);
    expect(result.unreadable.map((r) => [r.code, r.directory])).toEqual([['EACCES', lockedDir]]);
  });

  it('should find skills in nested directories', async () => {
    // Create nested structure
    const nestedDir = safePath.join(mockSkillsDir, 'category', 'subcategory', 'myskill');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(safePath.join(nestedDir, 'SKILL.md'), '# Nested Skill');

    const result = await scanUserContext();

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.path).toContain('SKILL.md');
  });

  it('should scan both plugins and skills directories independently', async () => {
    // Create one plugin and one skill
    const pluginDir = safePath.join(mockPluginsDir, 'plugin1');
    const skillDir = safePath.join(mockSkillsDir, 'skill1');
    await mkdir(pluginDir);
    await mkdir(skillDir);
    await writeFile(safePath.join(pluginDir, 'SKILL.md'), '# Plugin Skill');
    await writeFile(safePath.join(skillDir, 'SKILL.md'), '# Standalone Skill');

    const result = await scanUserContext();

    expect(result.plugins).toHaveLength(1);
    expect(result.skills).toHaveLength(1);
  });

  it('should handle plugins with both SKILL.md and other files', async () => {
    // Create plugin with SKILL.md and other files
    const pluginDir = safePath.join(mockPluginsDir, 'myplugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(safePath.join(pluginDir, 'SKILL.md'), '# My Plugin');
    await writeFile(safePath.join(pluginDir, 'README.md'), '# Readme');

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

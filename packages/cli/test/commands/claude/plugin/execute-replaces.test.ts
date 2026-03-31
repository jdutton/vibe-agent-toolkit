/**
 * Unit tests for executeReplaces() and helpers in install.ts
 *
 * Tests the vat.replaces feature: before installing a new plugin, the installer
 * removes old plugin registrations and legacy flat-skill installs declared in
 * the package's vat.replaces field.
 */

import { lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { uninstallPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PackageJsonVatReplaces } from '../../../../src/commands/claude/plugin/helpers.js';
import {
  executeReplaces,
  logFlatSkillRemoval,
  removeOldPlugins,
  removeFlatSkill,
} from '../../../../src/commands/claude/plugin/install.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@vibe-agent-toolkit/claude-marketplace', () => ({
  getClaudeUserPaths: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  symlink: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DRY_RUN_PREFIX = '[dry-run]';
const SKILLS_DIR = '/mock-home/.claude/skills';
const OLD_PLUGIN_NAME = 'old-plugin';
const OLD_FLAT_SKILL = 'my-old-skill';
const MARKETPLACES_DIR = '/mock-home/.claude/plugins/marketplaces';

function makePaths(): ClaudeUserPaths {
  return {
    claudeDir: '/mock-home/.claude',
    pluginsDir: '/mock-home/.claude/plugins',
    skillsDir: SKILLS_DIR,
    marketplacesDir: MARKETPLACES_DIR,
    pluginsCacheDir: '/mock-home/.claude/plugins/cache',
    userSettingsPath: '/mock-home/.claude/settings.json',
    installedPluginsPath: '/mock-home/.claude/installed_plugins.json',
    knownMarketplacesPath: '/mock-home/.claude/known_marketplaces.json',
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

/**
 * Run executeReplaces with a single flat skill and lstatSync mocked to succeed.
 * Returns the logger so callers can assert on log messages.
 */
async function runFlatSkillTest(
  skillName: string,
  dryRun: boolean
): Promise<ReturnType<typeof makeLogger>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock return value only needs to not throw
  vi.mocked(lstatSync).mockReturnValue({} as any);
  const replaces: PackageJsonVatReplaces = { flatSkills: [skillName] };
  const paths = makePaths();
  const logger = makeLogger();
  await executeReplaces(replaces, [], paths, dryRun, logger);
  return logger;
}

const EMPTY_UNINSTALL_RESULT = {
  removed: false,
  artifacts: {
    pluginDir: false,
    cacheDir: false,
    installedPlugins: false,
    knownMarketplaces: false,
    settings: false,
  },
};

// ---------------------------------------------------------------------------
// executeReplaces — plugins section
// ---------------------------------------------------------------------------

describe('executeReplaces — plugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uninstallPlugin).mockResolvedValue(EMPTY_UNINSTALL_RESULT);
  });

  it('calls uninstallPlugin for each plugin × marketplace combination', async () => {
    const replaces: PackageJsonVatReplaces = { plugins: [OLD_PLUGIN_NAME] };
    const marketplaceNames = ['market-a', 'market-b'];
    const paths = makePaths();
    const logger = makeLogger();

    await executeReplaces(replaces, marketplaceNames, paths, false, logger);

    expect(uninstallPlugin).toHaveBeenCalledTimes(2);
    expect(uninstallPlugin).toHaveBeenCalledWith({
      pluginKey: `${OLD_PLUGIN_NAME}@market-a`,
      paths,
      dryRun: false,
    });
    expect(uninstallPlugin).toHaveBeenCalledWith({
      pluginKey: `${OLD_PLUGIN_NAME}@market-b`,
      paths,
      dryRun: false,
    });
  });

  it('does NOT call uninstallPlugin when replaces.plugins is empty', async () => {
    const replaces: PackageJsonVatReplaces = { plugins: [] };
    const paths = makePaths();
    const logger = makeLogger();

    await executeReplaces(replaces, ['market-a'], paths, false, logger);

    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it('does NOT call uninstallPlugin when replaces.plugins is undefined', async () => {
    const replaces: PackageJsonVatReplaces = {};
    const paths = makePaths();
    const logger = makeLogger();

    await executeReplaces(replaces, ['market-a'], paths, false, logger);

    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it('dry-run: logs [dry-run] message and does NOT call uninstallPlugin', async () => {
    const replaces: PackageJsonVatReplaces = { plugins: [OLD_PLUGIN_NAME] };
    const paths = makePaths();
    const logger = makeLogger();

    await executeReplaces(replaces, ['market-a'], paths, true, logger);

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(DRY_RUN_PREFIX));
  });

  it('uninstallPlugin returning removed:false (not found) does not throw — idempotent', async () => {
    vi.mocked(uninstallPlugin).mockResolvedValue(EMPTY_UNINSTALL_RESULT);

    const replaces: PackageJsonVatReplaces = { plugins: ['nonexistent-plugin'] };
    const paths = makePaths();
    const logger = makeLogger();

    await expect(
      executeReplaces(replaces, ['market-a'], paths, false, logger)
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// executeReplaces — flatSkills section
// ---------------------------------------------------------------------------

describe('executeReplaces — flatSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uninstallPlugin).mockResolvedValue(EMPTY_UNINSTALL_RESULT);
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  it('removes existing flat skill when lstatSync succeeds', async () => {
    const logger = await runFlatSkillTest(OLD_FLAT_SKILL, false);

    const expectedPath = join(SKILLS_DIR, OLD_FLAT_SKILL);
    expect(rm).toHaveBeenCalledWith(expectedPath, { recursive: true, force: true });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(toForwardSlash(expectedPath)));
  });

  it('skips removal when lstatSync throws (path does not exist)', async () => {
    vi.mocked(lstatSync).mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const replaces: PackageJsonVatReplaces = { flatSkills: ['gone-skill'] };
    const paths = makePaths();
    const logger = makeLogger();

    await executeReplaces(replaces, [], paths, false, logger);

    expect(rm).not.toHaveBeenCalled();
  });

  it('removes dangling symlink — lstatSync succeeds but existsSync would return false', async () => {
    // lstatSync returns the stat of the symlink itself (not its target), so it
    // succeeds even for dangling symlinks. existsSync would return false here
    // because it follows the symlink to the (missing) target. This test
    // documents WHY executeReplaces uses lstatSync instead of existsSync.
    await runFlatSkillTest('dangling-skill', false);

    // rm IS called because lstatSync found the symlink inode (even though target is gone)
    const expectedPath = join(SKILLS_DIR, 'dangling-skill');
    expect(rm).toHaveBeenCalledWith(expectedPath, { recursive: true, force: true });
  });

  it('dry-run: logs [dry-run] message and does NOT call rm', async () => {
    const logger = await runFlatSkillTest(OLD_FLAT_SKILL, true);

    expect(rm).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(DRY_RUN_PREFIX));
  });
});

// ---------------------------------------------------------------------------
// executeReplaces — edge cases
// ---------------------------------------------------------------------------

describe('executeReplaces — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uninstallPlugin).mockResolvedValue(EMPTY_UNINSTALL_RESULT);
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  it('empty replaces object {} is a no-op', async () => {
    const replaces: PackageJsonVatReplaces = {};
    const paths = makePaths();
    const logger = makeLogger();

    await expect(
      executeReplaces(replaces, ['market-a'], paths, false, logger)
    ).resolves.not.toThrow();

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('processes both plugins and flatSkills when both are provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock return value only needs to not throw
    vi.mocked(lstatSync).mockReturnValue({} as any);

    const replaces: PackageJsonVatReplaces = {
      plugins: [OLD_PLUGIN_NAME],
      flatSkills: ['old-flat-skill'],
    };
    const paths = makePaths();
    const logger = makeLogger();

    await executeReplaces(replaces, ['market-a'], paths, false, logger);

    expect(uninstallPlugin).toHaveBeenCalledWith({
      pluginKey: `${OLD_PLUGIN_NAME}@market-a`,
      paths,
      dryRun: false,
    });

    const expectedSkillPath = join(SKILLS_DIR, 'old-flat-skill');
    expect(rm).toHaveBeenCalledWith(expectedSkillPath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Helper function unit tests
// ---------------------------------------------------------------------------

describe('removeOldPlugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uninstallPlugin).mockResolvedValue(EMPTY_UNINSTALL_RESULT);
  });

  it('calls uninstallPlugin for each plugin name across each marketplace', async () => {
    const paths = makePaths();
    const logger = makeLogger();

    await removeOldPlugins(['plugin-a', 'plugin-b'], ['market-x'], paths, false, logger);

    expect(uninstallPlugin).toHaveBeenCalledTimes(2);
    expect(uninstallPlugin).toHaveBeenCalledWith({
      pluginKey: 'plugin-a@market-x',
      paths,
      dryRun: false,
    });
    expect(uninstallPlugin).toHaveBeenCalledWith({
      pluginKey: 'plugin-b@market-x',
      paths,
      dryRun: false,
    });
  });

  it('no-ops when plugins array is undefined', async () => {
    const paths = makePaths();
    const logger = makeLogger();

    await removeOldPlugins(undefined, ['market-x'], paths, false, logger);

    expect(uninstallPlugin).not.toHaveBeenCalled();
  });
});

describe('removeFlatSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  it('calls rm with recursive:true force:true for the given path', async () => {
    const logger = makeLogger();
    const skillPath = '/mock-home/.claude/skills/my-skill';

    await removeFlatSkill(skillPath, logger);

    expect(rm).toHaveBeenCalledWith(skillPath, { recursive: true, force: true });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(skillPath));
  });
});

describe('logFlatSkillRemoval', () => {
  it('logs a [dry-run] message containing the skill path', () => {
    const logger = makeLogger();
    const skillPath = '/mock-home/.claude/skills/my-skill';

    logFlatSkillRemoval(skillPath, logger);

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(DRY_RUN_PREFIX));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(skillPath));
  });
});

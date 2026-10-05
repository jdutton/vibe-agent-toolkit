/**
 * Unit tests for the vat.replaces feature of `vat claude plugin install`.
 *
 * Before the new plugin is installed, `planReplaces` resolves what the
 * package's `vat.replaces` removes and refuses anything it cannot examine;
 * only once the new tree is in place does `applyReplaces` uninstall the old
 * plugins and remove the legacy flat skills. `readPackageJson` refuses a
 * `vat.replaces` of the wrong shape before either runs.
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';

import type { ClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { uninstallPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import { HOSTILE_NAMES } from '@vibe-agent-toolkit/utils/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readPackageJson } from '../../../../src/commands/claude/plugin/helpers.js';
import {
  applyReplaces,
  assertSkillEntryName,
  planReplaces,
} from '../../../../src/commands/claude/plugin/install.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@vibe-agent-toolkit/claude-marketplace', async (importOriginal) => ({
  // The error codes and `codedUserStateWrite` stay real: the refusal classifier imports them.
  ...(await importOriginal<Record<string, unknown>>()),
  getClaudeUserPaths: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
}));

// Spread over the real module: `tar` (imported by helpers.ts) reads `constants` at load.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rm: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
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
/** The package's own built marketplaces directory, which `planReplaces` lists for shipped plugins. */
const SOURCE_MARKETPLACES = '/pkg/dist/.claude/plugins/marketplaces';

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

/** An errno-shaped error. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused`), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uninstallPlugin).mockResolvedValue(EMPTY_UNINSTALL_RESULT);
  vi.mocked(rm).mockResolvedValue(undefined);
  // The package ships no plugin directories unless a case says otherwise.
  vi.mocked(readdirSync).mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// planReplaces
// ---------------------------------------------------------------------------

describe('planReplaces — plugins', () => {
  it('plans one uninstall per replaced plugin × marketplace', () => {
    const plan = planReplaces({ plugins: [OLD_PLUGIN_NAME] }, SOURCE_MARKETPLACES, ['market-a', 'market-b'], makePaths());

    expect(plan.pluginKeys).toEqual([`${OLD_PLUGIN_NAME}@market-a`, `${OLD_PLUGIN_NAME}@market-b`]);
  });

  it('plans nothing for an absent or empty vat.replaces', () => {
    expect(planReplaces(undefined, SOURCE_MARKETPLACES, ['market-a'], makePaths())).toEqual({ pluginKeys: [], flatSkillPaths: [] });
    expect(planReplaces({}, SOURCE_MARKETPLACES, ['market-a'], makePaths())).toEqual({ pluginKeys: [], flatSkillPaths: [] });
    expect(planReplaces({ plugins: [] }, SOURCE_MARKETPLACES, ['market-a'], makePaths()).pluginKeys).toEqual([]);
  });

  it('never plans to uninstall a plugin the package itself ships into that marketplace', () => {
    // Removal now runs AFTER the install: uninstalling a same-named plugin then
    // would remove the one just installed.
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([{ name: OLD_PLUGIN_NAME, isDirectory: () => true, isSymbolicLink: () => false }] as never);

    const plan = planReplaces({ plugins: [OLD_PLUGIN_NAME] }, SOURCE_MARKETPLACES, ['market-a'], makePaths());

    expect(plan.pluginKeys).toEqual([]);
  });
});

describe('planReplaces — flatSkills', () => {
  it('plans removal of a flat skill that is there — a dangling link included (lstat, not exists)', () => {
    vi.mocked(lstatSync).mockReturnValue({} as never);

    const plan = planReplaces({ flatSkills: [OLD_FLAT_SKILL, '..cache'] }, SOURCE_MARKETPLACES, [], makePaths());

    expect(plan.flatSkillPaths).toEqual([safePath.join(SKILLS_DIR, OLD_FLAT_SKILL), safePath.join(SKILLS_DIR, '..cache')]);
  });

  it('plans nothing for a flat skill that is absent', () => {
    vi.mocked(lstatSync).mockImplementation(() => {
      throw errnoError('ENOENT');
    });

    expect(planReplaces({ flatSkills: ['gone-skill'] }, SOURCE_MARKETPLACES, [], makePaths()).flatSkillPaths).toEqual([]);
  });

  it('refuses a flat skill the OS will not let it examine, as INPUT_UNREADABLE — before anything changes', () => {
    // The legacy install is still there; a silent skip leaves it beside its replacement.
    vi.mocked(lstatSync).mockImplementation(() => {
      throw errnoError('EACCES');
    });

    expect(() => planReplaces({ plugins: [OLD_PLUGIN_NAME], flatSkills: ['locked-skill'] }, SOURCE_MARKETPLACES, ['market-a'], makePaths()))
      .toThrow(expect.objectContaining({ refusal: 'INPUT_UNREADABLE' }));
    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  // The sweep's fixture t6: `{"vat":{"replaces":{"flatSkills":["../victim"]}}}`
  // in the INSTALLED package removed `<skillsDir>/../victim` with no flag in
  // front of it. Every hostile spelling is refused by name, before lstat.
  it.each(HOSTILE_NAMES)('refuses flatSkills entry %j before examining anything', (name) => {
    vi.mocked(lstatSync).mockReturnValue({} as never);

    expect(() => planReplaces({ flatSkills: [name] }, SOURCE_MARKETPLACES, [], makePaths())).toThrow(/vat\.replaces\.flatSkills/);
    expect(lstatSync).not.toHaveBeenCalled();
  });
});

describe('assertSkillEntryName', () => {
  it.each(HOSTILE_NAMES)('refuses %j and names the origin', (name) => {
    expect(() => assertSkillEntryName(name, 'SKILL.md name')).toThrow(/SKILL\.md name/);
  });

  it('returns a single-segment name unchanged', () => {
    expect(assertSkillEntryName('my-skill', 'x')).toBe('my-skill');
    expect(assertSkillEntryName('..cache', 'x')).toBe('..cache');
  });
});

// ---------------------------------------------------------------------------
// applyReplaces
// ---------------------------------------------------------------------------

describe('applyReplaces', () => {
  const plan = { pluginKeys: [`${OLD_PLUGIN_NAME}@market-a`], flatSkillPaths: [safePath.join(SKILLS_DIR, OLD_FLAT_SKILL)] };

  it('uninstalls each planned plugin and removes each planned flat skill', async () => {
    const paths = makePaths();
    const logger = makeLogger();

    await applyReplaces(plan, paths, false, logger);

    expect(uninstallPlugin).toHaveBeenCalledWith({ pluginKey: `${OLD_PLUGIN_NAME}@market-a`, paths, dryRun: false });
    expect(rm).toHaveBeenCalledWith(plan.flatSkillPaths[0], { recursive: true, force: true });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(toForwardSlash(plan.flatSkillPaths[0] ?? '')));
  });

  it('dry-run: logs each removal and changes nothing', async () => {
    const logger = makeLogger();

    await applyReplaces(plan, makePaths(), true, logger);

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.filter(([line]) => String(line).includes(DRY_RUN_PREFIX))).toHaveLength(2);
  });

  it('codes a flat-skill removal the OS refuses as RUN_INCOMPLETE, never INTERNAL_ERROR, naming the path', async () => {
    vi.mocked(rm).mockRejectedValue(errnoError('EACCES'));

    const failure = applyReplaces(plan, makePaths(), false, makeLogger());

    await expect(failure).rejects.toMatchObject({ code: 'CLAUDE_USER_STATE_WRITE_FAILED' });
    await expect(failure).rejects.toThrow(OLD_FLAT_SKILL);
  });
});

// ---------------------------------------------------------------------------
// readPackageJson — the shape of vat.replaces
// ---------------------------------------------------------------------------

/** `readFile` answers every read with a package.json whose `vat.replaces` is `replaces`. */
function packageWith(replaces: unknown): void {
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ name: '@test/pkg', version: '1.0.0', vat: { replaces } }) as never);
}

describe('readPackageJson — vat.replaces shape', () => {

  it.each([
    ['a string flatSkills', { flatSkills: 'ab' }, 'vat.replaces.flatSkills'],
    ['a non-string flatSkills entry', { flatSkills: [123] }, 'vat.replaces.flatSkills.0'],
    ['a string plugins', { plugins: 'ab' }, 'vat.replaces.plugins'],
    ['an unknown key', { flatskills: ['ab'] }, 'flatskills'],
    ['a non-object', 'ab', 'vat.replaces'],
  ])('refuses %s as INPUT_UNREADABLE naming the package and the field', async (_label, replaces, field) => {
    packageWith(replaces);

    const read = readPackageJson('/pkg');

    await expect(read).rejects.toMatchObject({ refusal: 'INPUT_UNREADABLE' });
    await expect(read).rejects.toThrow('@test/pkg');
    await expect(read).rejects.toThrow(field);
  });

  it('accepts the documented shape, and a package with no vat.replaces', async () => {
    packageWith({ plugins: ['p'], flatSkills: ['s'] });
    await expect(readPackageJson('/pkg')).resolves.toMatchObject({ vat: { replaces: { plugins: ['p'], flatSkills: ['s'] } } });

    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ name: '@test/pkg', version: '1.0.0' }) as never);
    await expect(readPackageJson('/pkg')).resolves.toMatchObject({ name: '@test/pkg' });
  });
});

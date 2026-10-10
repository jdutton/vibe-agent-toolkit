/**
 * The shared config loading of the `vat claude` verbs: no config file is a
 * CONFIG_INVALID refusal, a found one is loaded from its own directory, and an
 * undeclared `--marketplace` is the invocation's mistake. The config finder and
 * loader are doubles; no file is read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertMarketplaceDeclared, loadClaudeProjectConfig } from '../../../src/commands/claude/claude-config.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';
import { thrownBy } from '../../helpers/refusal-doubles.js';

const doubles = vi.hoisted(() => ({ findConfigFile: vi.fn(), loadConfig: vi.fn() }));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findConfigFile: doubles.findConfigFile,
}));
vi.mock('../../../src/utils/config-loader.js', () => ({ loadConfig: doubles.loadConfig }));

beforeEach(() => {
  doubles.findConfigFile.mockReset();
  doubles.loadConfig.mockReset();
});

describe('loadClaudeProjectConfig', () => {
  it('refuses CONFIG_INVALID when no config file is found', () => {
    doubles.findConfigFile.mockReturnValue(undefined);

    const error = thrownBy(() => loadClaudeProjectConfig());

    expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
    expect(doubles.loadConfig).not.toHaveBeenCalled();
  });

  it('loads the config from the directory holding the file, and returns its claude section', () => {
    const claude = { marketplaces: {} };
    doubles.findConfigFile.mockReturnValue('/proj/vibe-agent-toolkit.config.yaml');
    doubles.loadConfig.mockReturnValue({ claude });

    const loaded = loadClaudeProjectConfig();

    expect(doubles.loadConfig).toHaveBeenCalledWith('/proj');
    expect(loaded).toMatchObject({ configPath: '/proj/vibe-agent-toolkit.config.yaml', configDir: '/proj', claudeConfig: claude });
  });
});

describe('assertMarketplaceDeclared', () => {
  it('passes no --marketplace, and a declared one', () => {
    expect(() => assertMarketplaceDeclared(undefined, [])).not.toThrow();
    expect(() => assertMarketplaceDeclared('mp', ['mp'])).not.toThrow();
  });

  it('refuses an undeclared one as USAGE_INVALID, naming what is declared — or none', () => {
    const some = thrownBy(() => assertMarketplaceDeclared('typo', ['a', 'b']));
    expect(refusalCodeOf(some)).toBe('USAGE_INVALID');
    expect((some as Error).message).toContain('(declared: a, b)');
    expect((thrownBy(() => assertMarketplaceDeclared('typo', [])) as Error).message).toContain('(declared: none)');
  });
});

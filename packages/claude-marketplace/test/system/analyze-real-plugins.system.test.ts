/**
 * System test: analyzeCompatibility against real locally-installed Claude plugins.
 *
 * Walks ~/.claude/plugins/cache and runs the compatibility analyzer on every
 * plugin that contains a .claude-plugin/plugin.json manifest.
 *
 * Skips automatically when the plugins cache directory does not exist (e.g. CI).
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { direntKindFollowingSync, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../../src/compatibility-analyzer.js';
import type { CompatibilityResult } from '../../src/types.js';

const PLUGINS_DIR = safePath.resolve(homedir(), '.claude', 'plugins', 'cache');

describe('analyzeCompatibility against local plugins', () => {
  const hasPlugins = existsSync(PLUGINS_DIR);

  it('resolves plugins cache path', () => {
    expect(PLUGINS_DIR).toContain(safePath.join('.claude', 'plugins', 'cache'));
  });

  it.skipIf(!hasPlugins)('analyzes all locally installed plugins without errors', async () => {
    // Followed throughout: a `--dev` install puts these here as links.
    const marketplaces = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter(d => direntKindFollowingSync(PLUGINS_DIR, d) === 'directory');

    const results: CompatibilityResult[] = [];

    for (const marketplace of marketplaces) {
      const mDir = safePath.resolve(PLUGINS_DIR, marketplace.name);
      const plugins = readdirSync(mDir, { withFileTypes: true })
        .filter(d => direntKindFollowingSync(mDir, d) === 'directory');

      for (const plugin of plugins) {
        const pDir = safePath.resolve(mDir, plugin.name);
        const versions = readdirSync(pDir, { withFileTypes: true })
          .filter(d => direntKindFollowingSync(pDir, d) === 'directory');
        const lastVersion = versions.at(-1);
        if (!lastVersion) continue;
        const latestDir = safePath.resolve(pDir, lastVersion.name);

        if (!existsSync(safePath.resolve(latestDir, '.claude-plugin/plugin.json'))) continue;

        const result = await analyzeCompatibility(latestDir, latestDir);
        results.push(result);

        expect(result.plugin).toBeTruthy();
        expect(Array.isArray(result.evidence)).toBe(true);
        expect(Array.isArray(result.observations)).toBe(true);
        expect(Array.isArray(result.verdicts)).toBe(true);
      }
    }

    expect(results.length).toBeGreaterThan(0);

    console.table(results.map(r => ({
      plugin: r.plugin,
      observations: r.observations.length,
      verdicts: r.verdicts.length,
      evidenceCount: r.evidence.length,
    })));
  });
});

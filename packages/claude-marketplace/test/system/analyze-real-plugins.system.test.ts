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

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../../src/compatibility-analyzer.js';
import type { CompatibilityResult } from '../../src/types.js';

const PLUGINS_DIR = safePath.resolve(homedir(), '.claude', 'plugins', 'cache');

describe('analyzeCompatibility against local plugins', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PLUGINS_DIR derived from homedir(), safe
  const hasPlugins = existsSync(PLUGINS_DIR);

  it('resolves plugins cache path', () => {
    expect(PLUGINS_DIR).toContain(safePath.join('.claude', 'plugins', 'cache'));
  });

  it.skipIf(!hasPlugins)('analyzes all locally installed plugins without errors', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- PLUGINS_DIR derived from homedir(), safe
    const marketplaces = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    const results: CompatibilityResult[] = [];

    for (const marketplace of marketplaces) {
      const mDir = safePath.resolve(PLUGINS_DIR, marketplace.name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- mDir derived from PLUGINS_DIR + readdir entry
      const plugins = readdirSync(mDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const plugin of plugins) {
        const pDir = safePath.resolve(mDir, plugin.name);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- pDir derived from PLUGINS_DIR + readdir entries
        const versions = readdirSync(pDir, { withFileTypes: true })
          .filter(d => d.isDirectory());
        const lastVersion = versions.at(-1);
        if (!lastVersion) continue;
        const latestDir = safePath.resolve(pDir, lastVersion.name);

        // eslint-disable-next-line security/detect-non-literal-fs-filename -- latestDir derived from PLUGINS_DIR + readdir entries
        if (!existsSync(safePath.resolve(latestDir, '.claude-plugin/plugin.json'))) continue;

        const result = await analyzeCompatibility(latestDir);
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

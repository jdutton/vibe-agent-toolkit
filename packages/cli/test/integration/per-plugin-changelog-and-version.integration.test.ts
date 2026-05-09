/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file — all file operations are in temp directories; duplicated strings acceptable.
import { existsSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker(
  'vat-plugin-changelog-version-',
);

interface FixtureOptions {
  /** Whether to write a per-plugin CHANGELOG.md inside the plugin source dir. */
  withChangelog?: boolean;
  /** Optional custom plugin.json:version. Pass `null` to omit the version field. */
  pluginJsonVersion?: string | null;
  /** Whether to write a root package.json (and its version). Defaults to false (no root version). */
  rootPackageVersion?: string | null;
}

/**
 * Build a minimal single-plugin marketplace fixture under tempDir.
 * Returns the plugin source dir and plugin name for assertions.
 */
function buildFixture(
  tempDir: string,
  opts: FixtureOptions = {},
): { pluginName: string; pluginSourceDir: string; outDir: string } {
  const pluginName = 'demo-plugin';
  const marketplaceName = 'mp1';

  // Optional root package.json (lowest-precedence version source).
  if (opts.rootPackageVersion !== null && opts.rootPackageVersion !== undefined) {
    writeTestFile(
      safePath.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: opts.rootPackageVersion }),
    );
  }

  const config = `version: 1
skills:
  include: ["plugins/*/skills/**/SKILL.md"]
claude:
  marketplaces:
    ${marketplaceName}:
      owner:
        name: Test Org
        email: ops@test.example
      plugins:
        - name: ${pluginName}
          description: Demo plugin
          skills: []
`;
  writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), config);

  const pluginSourceDir = safePath.join(tempDir, 'plugins', pluginName);
  mkdirSyncReal(safePath.join(pluginSourceDir, 'commands'), { recursive: true });
  // Plugin needs at least one piece of content so the build doesn't error.
  writeTestFile(
    safePath.join(pluginSourceDir, 'commands', 'hello.md'),
    '---\n---\n# hello',
  );

  // Author plugin.json with optional version.
  mkdirSyncReal(safePath.join(pluginSourceDir, '.claude-plugin'), { recursive: true });
  const pluginJson: Record<string, unknown> = {
    license: 'MIT',
  };
  if (opts.pluginJsonVersion !== null && opts.pluginJsonVersion !== undefined) {
    pluginJson['version'] = opts.pluginJsonVersion;
  }
  writeTestFile(
    safePath.join(pluginSourceDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(pluginJson),
  );

  if (opts.withChangelog) {
    writeTestFile(
      safePath.join(pluginSourceDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 0.5.0\n- initial release\n',
    );
  }

  const outDir = safePath.join(
    tempDir,
    'dist',
    '.claude',
    'plugins',
    'marketplaces',
    marketplaceName,
    'plugins',
    pluginName,
  );

  return { pluginName, pluginSourceDir, outDir };
}

function readMarketplaceJson(tempDir: string): Record<string, unknown> {
  const path = safePath.join(
    tempDir,
    'dist',
    '.claude',
    'plugins',
    'marketplaces',
    'mp1',
    '.claude-plugin',
    'marketplace.json',
  );
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/**
 * Build a fixture, run the plugin build, and return the parsed marketplace.json
 * plugins array — shared helper for the version-in-marketplace.json scenarios.
 */
async function buildAndReadMarketplacePlugins(
  opts: FixtureOptions,
): Promise<Array<Record<string, unknown>>> {
  const tempDir = createTempDir();
  buildFixture(tempDir, opts);
  const pb = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'build'], {
    cwd: tempDir,
  });
  expect(pb.result.status).toBe(0);
  const mp = readMarketplaceJson(tempDir);
  const plugins = mp['plugins'] as Array<Record<string, unknown>>;
  expect(plugins).toHaveLength(1);
  return plugins;
}

describe('vat claude plugin build — per-plugin CHANGELOG and marketplace version', () => {
  afterEach(() => cleanupTempDirs());

  it('copies per-plugin CHANGELOG.md into the plugin output directory when present', async () => {
    const tempDir = createTempDir();
    const { pluginSourceDir, outDir } = buildFixture(tempDir, { withChangelog: true });

    const pb = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'build'], {
      cwd: tempDir,
    });
    expect(pb.result.status).toBe(0);

    const destChangelog = safePath.join(outDir, 'CHANGELOG.md');
    expect(existsSync(destChangelog)).toBe(true);

    const sourceContent = readFileSync(
      safePath.join(pluginSourceDir, 'CHANGELOG.md'),
      'utf-8',
    );
    const destContent = readFileSync(destChangelog, 'utf-8');
    expect(destContent).toBe(sourceContent);
  });

  it('does not produce CHANGELOG.md in plugin output when source has none', async () => {
    const tempDir = createTempDir();
    const { outDir } = buildFixture(tempDir, { withChangelog: false });

    const pb = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'build'], {
      cwd: tempDir,
    });
    expect(pb.result.status).toBe(0);

    expect(existsSync(safePath.join(outDir, 'CHANGELOG.md'))).toBe(false);
  });

  it('includes the per-plugin version in marketplace.json when a version is resolved', async () => {
    const plugins = await buildAndReadMarketplacePlugins({ pluginJsonVersion: '0.5.0' });
    expect(plugins[0]?.['version']).toBe('0.5.0');
    expect(plugins[0]?.['name']).toBe('demo-plugin');
  });

  it('omits the version field in marketplace.json when no version source is available', async () => {
    // Explicitly omit pluginJsonVersion (null) and rootPackageVersion (null) so
    // none of the precedence sources supply a version.
    const plugins = await buildAndReadMarketplacePlugins({
      pluginJsonVersion: null,
      rootPackageVersion: null,
    });
    expect(plugins[0]).not.toHaveProperty('version');
  });
});

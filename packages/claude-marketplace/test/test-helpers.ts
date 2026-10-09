import { mkdtempSync, rmSync } from 'node:fs';


import { applyTreePlan, type ApplyResult, copyTree, mkdirSyncReal, normalizedTmpdir, planTreeChanges, safePath } from '@vibe-agent-toolkit/utils';
import { type FaultFsSession, type FaultRule, installFaultFs, registerScratchTmpdir, type StatRewrite } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach } from 'vitest';

import { planPackageInstall } from '../src/install/package-install.js';
import type { InstallPluginOptions } from '../src/install/plugin-registry.js';
import type { ClaudeUserPaths } from '../src/paths/claude-paths.js';

export interface SetupPluginTestPathsOptions {
  /** If true, also creates paths.skillsDir for legacy skill tests */
  withSkillsDir?: boolean;
}

/**
 * Set up a fresh temp directory with Claude paths for each test suite.
 *
 * Always creates marketplacesDir and pluginsCacheDir.
 * Pass `{ withSkillsDir: true }` to also create skillsDir (needed by plugin-list tests).
 *
 * Usage:
 *   const { getPaths } = setupPluginTestPaths();
 *   // or
 *   const { getPaths } = setupPluginTestPaths({ withSkillsDir: true });
 */
export function setupPluginTestPaths(opts: SetupPluginTestPathsOptions = {}): { getPaths: () => ClaudeUserPaths } {
  let tempDir = '';
  beforeEach(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-plugin-test-'));
    const paths = buildTestPaths(tempDir);
    mkdirSyncReal(paths.marketplacesDir, { recursive: true });
    mkdirSyncReal(paths.pluginsCacheDir, { recursive: true });
    if (opts.withSkillsDir === true) {
      mkdirSyncReal(paths.skillsDir, { recursive: true });
    }
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
  useScratchTmpdir('vat-plugin-test-tmp-');
  return { getPaths: () => buildTestPaths(tempDir) };
}

/**
 * ⛔ Point TMPDIR, TEMP and TMP at a fresh scratch directory for each test (`scratchTmpdirEnv`): an
 * install or uninstall under test removes and chmods trees, and neither it nor a mutation run of
 * its guards may ever reach the real temp directory. Register it AFTER the hook that makes the
 * suite's own fixture root, so the scratch sits beside the fixture, never around it.
 *
 * @param prefix - The scratch directory's prefix, so a leaked one names its suite
 * @returns The current test's scratch temp directory
 */
export function useScratchTmpdir(prefix: string): () => string {
  return registerScratchTmpdir(prefix, { beforeEach, afterEach });
}

/**
 * Build test ClaudeUserPaths rooted in a temp base directory.
 * Uses a flat structure: base/.claude/plugins/... to avoid duplicating getClaudeUserPaths.
 */
export function buildTestPaths(base: string): ClaudeUserPaths {
  const root = safePath.join(base, '.claude');
  const plugins = safePath.join(root, 'plugins');
  return {
    claudeDir: root,
    pluginsDir: plugins,
    skillsDir: safePath.join(root, 'skills'),
    marketplacesDir: safePath.join(plugins, 'marketplaces'),
    pluginsCacheDir: safePath.join(plugins, 'cache'),
    knownMarketplacesPath: safePath.join(plugins, 'known_marketplaces.json'),
    installedPluginsPath: safePath.join(plugins, 'installed_plugins.json'),
    userSettingsPath: safePath.join(root, 'settings.json'),
    userDotJsonPath: safePath.join(base, '.claude.json'),
  };
}

/**
 * Run `body` with `faults` injected and `rewrites` applied to fs calls under `within`; the
 * session is restored after, whatever happened. `body` is handed the session (its traced calls).
 */
export async function underFaults<T>(
  within: string,
  options: { faults?: readonly FaultRule[]; rewrites?: readonly StatRewrite[] },
  body: (session: FaultFsSession) => Promise<T>,
): Promise<T> {
  const session = installFaultFs({ within, ...options });
  try {
    return await body(session);
  } finally {
    session.restore();
  }
}

/** What `run` rejected with, or `undefined` when it resolved. */
export async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Whether a path is the temp a registry write of `file` goes through (`replaceFile` stages beside the file, then renames it over). */
export const stagedWriteOf = (file: string) => (p: string): boolean => p.includes(`/.${file.slice(file.lastIndexOf('/') + 1)}.vat-staged-`);

/** Build a markdown bash code block containing a single command */
export function bashCodeBlock(command: string): string {
  return ['```bash', command, '```'].join('\n');
}

/**
 * Anchor root for scanner unit tests.
 *
 * Scanners take a REQUIRED `locationRoot` and relativize every emitted evidence
 * `location.file` against it, so a scanner test must state one. These tests pass
 * already-root-relative file paths, which round-trip unchanged through any root.
 */
export const TEST_LOCATION_ROOT = safePath.resolve('/scan-root');

/**
 * Install the one plugin at `pluginDir` the way `vat claude plugin install` does — `planPackageInstall`,
 * then the plan applied with its registry edit as `afterSwap` — as a package whose one marketplace
 * holds only that plugin: the marketplace copy is `plugins/<pluginName>`, the cache a copy of `pluginDir`.
 */
export async function installOnePlugin(
  pluginDir: string,
  paths: ClaudeUserPaths,
  names: InstallPluginOptions,
): Promise<ApplyResult> {
  const { marketplaceName, pluginName, version, source } = names;
  // The plugin is the operator's tree: every read of it is a fault on the source side.
  const side = 'source';
  const { changes, registry } = planPackageInstall({
    marketplaces: [{
      marketplaceName,
      write: (staged) => copyTree(pluginDir, safePath.join(staged, 'plugins', pluginName), { links: 'preserve', side }),
      reads: [pluginDir],
      plugins: [{ pluginName, cacheFill: { from: 'copy', source: pluginDir, side, links: 'preserve' } }],
    }],
    version,
    source,
    replacedPluginKeys: [],
    paths,
  });
  return applyTreePlan(await planTreeChanges(changes), { afterSwap: () => registry.apply() });
}

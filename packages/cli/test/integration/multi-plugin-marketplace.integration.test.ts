/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file — file ops happen in temp dirs; duplicated literals (plugin/branch
// names, paths) are expected and acceptable in fixture-driven tests.

/**
 * End-to-end sufficiency test for the multi-plugin marketplace versioning flow.
 *
 * Runs the actual VAT CLI (`vat claude plugin build` + `vat claude marketplace
 * publish`) against on-disk fixtures backed by a real local bare git remote.
 * Asserts on the published artifacts (marketplace.json, per-plugin
 * CHANGELOG.md, plugin.json:version) and on the per-plugin source-repo tags
 * (`<plugin>-v<version>`) pushed after a successful publish.
 *
 * Three scenarios:
 *   1. Initial publish — distinct per-plugin versions and CHANGELOGs
 *   2. Republish after one plugin version bump — tags accumulate, other plugin untouched
 *   3. Backwards-compat fallback — no per-plugin versions, both inherit root package.json:version
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commitAllAndPushMain,
  createTempDirTracker,
  executeCli,
  fs,
  getBinPath,
  getFixturePath,
  initGitRepoWithRemote,
  listRemoteTagNames,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);
const { createTempDir, cleanupTempDirs } = createTempDirTracker(
  'vat-multi-plugin-mp-',
);

const PUBLISH_BRANCH = 'claude-marketplace';

interface FixtureRepos {
  /** Source repo where the fixture lives + vat is invoked. */
  sourceRepo: string;
  /** Bare git remote that the publish branch is pushed to. */
  bareRemote: string;
}

/**
 * Copy a fixture into a temp source repo, init it as a real git repo, and set
 * up a bare remote at `origin`. Mirrors the structure publish-tags.integration.test.ts
 * uses, but copies the on-disk fixture tree instead of hand-building it.
 */
function setupFixtureRepo(fixtureName: string): FixtureRepos {
  const root = createTempDir();
  const bareRemote = safePath.join(root, 'remote.git');
  const sourceRepo = safePath.join(root, 'src');

  mkdirSyncReal(bareRemote, { recursive: true });
  mkdirSyncReal(sourceRepo, { recursive: true });

  // Bare remote
  safeExecSync('git', ['init', '--bare', '-q'], { cwd: bareRemote });

  // Copy fixture tree into source repo
  const fixturePath = getFixturePath(import.meta.url, fixtureName);
  cpSync(fixturePath, sourceRepo, { recursive: true });

  // Init source repo with remote, then initial commit so refs exist for tag operations
  initGitRepoWithRemote(sourceRepo, bareRemote);
  commitAllAndPushMain(sourceRepo);

  return { sourceRepo, bareRemote };
}

/**
 * Spawn the VAT CLI against `cwd` and assert it exits 0. Returns combined
 * stdout+stderr for diagnostic logging if assertions later fail.
 */
async function runVatExpectSuccess(cwd: string, args: string[]): Promise<string> {
  const result = await executeCli(binPath, args, { cwd });
  if (result.status !== 0) {
    throw new Error(
      `vat ${args.join(' ')} failed (status=${String(result.status)}):\n` +
        `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * Clone the publish branch out of the bare remote into a temp dir so we can
 * inspect the published files. Returns the working tree root.
 */
function cloneBranchToInspect(bareRemote: string, branch: string): string {
  const inspectDir = createTempDir();
  safeExecSync(
    'git',
    ['clone', '-q', '--branch', branch, '--single-branch', bareRemote, inspectDir],
    { cwd: bareRemote },
  );
  return inspectDir;
}

/** List local tags in a working repo. */
function listLocalTags(sourceRepo: string): string[] {
  const out = safeExecSync('git', ['tag', '--list'], {
    cwd: sourceRepo,
    encoding: 'utf-8',
  });
  return String(out).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Read+parse the published `.claude-plugin/marketplace.json` from an inspect clone. */
function readPublishedMarketplaceJson(inspectDir: string): {
  plugins: Array<Record<string, unknown>>;
} {
  const path = safePath.join(inspectDir, '.claude-plugin', 'marketplace.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as { plugins: Array<Record<string, unknown>> };
}

/** Read a published plugin's plugin.json from an inspect clone. */
function readPublishedPluginJson(
  inspectDir: string,
  pluginName: string,
): Record<string, unknown> {
  const path = safePath.join(
    inspectDir,
    'plugins',
    pluginName,
    '.claude-plugin',
    'plugin.json',
  );
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Find a plugin entry by name in the marketplace.json plugins array. */
function findPluginEntry(
  plugins: Array<Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  const entry = plugins.find((p) => p['name'] === name);
  if (!entry) {
    throw new Error(
      `Plugin "${name}" not found in marketplace.json plugins (got: ` +
        `${plugins.map((p) => JSON.stringify(p['name'])).join(', ')})`,
    );
  }
  return entry;
}

describe('multi-plugin marketplace — end-to-end build + publish (integration)', () => {
  afterEach(() => cleanupTempDirs());

  it('scenario 1: initial publish — both plugins ship with their own version, CHANGELOG, and tag', async () => {
    const { sourceRepo, bareRemote } = setupFixtureRepo('multi-plugin-marketplace');

    await runVatExpectSuccess(sourceRepo, ['claude', 'plugin', 'build']);

    // Run publish via executeCli (not runVatExpectSuccess) so we can inspect
    // stdout YAML separately from stderr log lines.
    const publishResult = await executeCli(
      binPath,
      ['claude', 'marketplace', 'publish'],
      { cwd: sourceRepo },
    );
    expect(
      publishResult.status,
      `publish failed:\nSTDOUT:\n${publishResult.stdout}\nSTDERR:\n${publishResult.stderr}`,
    ).toBe(0);

    // Issue #110 regression guard: multi-plugin marketplaces have no aggregate
    // version, so the published[*].version field must be omitted from the YAML
    // status payload. Match any indented `version:` line in stdout — YAML
    // fields are always indented under the array entry, top-level keys aren't.
    // Bounded quantifier avoids sonarjs/slow-regex backtracking concerns.
    expect(publishResult.stdout).not.toMatch(/^ {1,8}version:/m);

    // Inspect published branch
    const inspectDir = cloneBranchToInspect(bareRemote, PUBLISH_BRANCH);
    const { plugins } = readPublishedMarketplaceJson(inspectDir);

    // Both plugins listed with their per-plugin versions
    expect(plugins).toHaveLength(2);
    expect(findPluginEntry(plugins, 'plugin-a')['version']).toBe('0.1.0');
    expect(findPluginEntry(plugins, 'plugin-b')['version']).toBe('0.2.5');

    // Per-plugin CHANGELOGs ship inside each plugin dir
    expect(
      fs.existsSync(safePath.join(inspectDir, 'plugins', 'plugin-a', 'CHANGELOG.md')),
    ).toBe(true);
    expect(
      fs.existsSync(safePath.join(inspectDir, 'plugins', 'plugin-b', 'CHANGELOG.md')),
    ).toBe(true);

    // Per-plugin plugin.json has correct version
    expect(readPublishedPluginJson(inspectDir, 'plugin-a')['version']).toBe('0.1.0');
    expect(readPublishedPluginJson(inspectDir, 'plugin-b')['version']).toBe('0.2.5');

    // Source repo has the per-plugin tags, both pushed to remote
    const localTags = listLocalTags(sourceRepo);
    expect(localTags).toContain('plugin-a-v0.1.0');
    expect(localTags).toContain('plugin-b-v0.2.5');

    const remoteTags = listRemoteTagNames(sourceRepo, bareRemote);
    expect(remoteTags).toContain('plugin-a-v0.1.0');
    expect(remoteTags).toContain('plugin-b-v0.2.5');

    // Issue #110 regression guard: multi-plugin marketplaces have no aggregate
    // version, so the commit subject must NOT carry a misleading `v<X>` (which
    // historically came from the project root package.json).
    const commitSubject = String(
      safeExecSync('git', ['log', '-1', '--pretty=%s', 'HEAD'], {
        cwd: inspectDir,
        encoding: 'utf-8',
      }),
    ).trim();
    expect(commitSubject).toBe('publish multi-plugin');
  });

  it('scenario 2: republish after one plugin bump — only that plugin advances; tags accumulate', async () => {
    const { sourceRepo, bareRemote } = setupFixtureRepo('multi-plugin-marketplace');

    // First publish: plugin-a@0.1.0, plugin-b@0.2.5
    await runVatExpectSuccess(sourceRepo, ['claude', 'plugin', 'build']);
    await runVatExpectSuccess(sourceRepo, ['claude', 'marketplace', 'publish']);

    // Bump plugin-a to 0.2.0; update its CHANGELOG; commit.
    const pluginAJsonPath = safePath.join(
      sourceRepo,
      'plugins',
      'plugin-a',
      '.claude-plugin',
      'plugin.json',
    );
    const pluginAJson = JSON.parse(readFileSync(pluginAJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    pluginAJson['version'] = '0.2.0';
    writeFileSync(pluginAJsonPath, JSON.stringify(pluginAJson, null, 2));

    const pluginAChangelogPath = safePath.join(
      sourceRepo,
      'plugins',
      'plugin-a',
      'CHANGELOG.md',
    );
    writeFileSync(
      pluginAChangelogPath,
      '# Changelog\n\n' +
        'All notable changes to plugin-a will be documented in this file.\n\n' +
        '## [0.2.0] - 2026-05-09\n\n### Changed\n- Bumped plugin-a to 0.2.0 for republish test\n\n' +
        '## [0.1.0] - 2026-05-09\n\n### Added\n- Initial release of plugin-a\n',
    );

    safeExecSync('git', ['add', '-A'], { cwd: sourceRepo });
    safeExecSync('git', ['commit', '-q', '-m', 'bump plugin-a to 0.2.0'], {
      cwd: sourceRepo,
    });

    // Second publish (no --plugin flag — selective publish was dropped)
    await runVatExpectSuccess(sourceRepo, ['claude', 'plugin', 'build']);
    await runVatExpectSuccess(sourceRepo, ['claude', 'marketplace', 'publish']);

    // Inspect
    const inspectDir = cloneBranchToInspect(bareRemote, PUBLISH_BRANCH);
    const { plugins } = readPublishedMarketplaceJson(inspectDir);

    expect(findPluginEntry(plugins, 'plugin-a')['version']).toBe('0.2.0');
    expect(findPluginEntry(plugins, 'plugin-b')['version']).toBe('0.2.5');

    // plugin-a's published CHANGELOG includes the new entry
    const publishedAChangelog = readFileSync(
      safePath.join(inspectDir, 'plugins', 'plugin-a', 'CHANGELOG.md'),
      'utf-8',
    );
    expect(publishedAChangelog).toContain('## [0.2.0]');
    expect(publishedAChangelog).toContain('## [0.1.0]');

    // Tags accumulate: old plugin-a tag still on remote, new one added, plugin-b unchanged
    const remoteTags = listRemoteTagNames(sourceRepo, bareRemote);
    expect(remoteTags).toContain('plugin-a-v0.1.0');
    expect(remoteTags).toContain('plugin-a-v0.2.0');
    expect(remoteTags).toContain('plugin-b-v0.2.5');
  });

  it('scenario 3: backwards-compat — no per-plugin versions, both plugins inherit root package.json:version', async () => {
    const { sourceRepo, bareRemote } = setupFixtureRepo('single-version-marketplace');

    await runVatExpectSuccess(sourceRepo, ['claude', 'plugin', 'build']);
    await runVatExpectSuccess(sourceRepo, ['claude', 'marketplace', 'publish']);

    const inspectDir = cloneBranchToInspect(bareRemote, PUBLISH_BRANCH);
    const { plugins } = readPublishedMarketplaceJson(inspectDir);

    // Both plugins inherit root package.json:version (1.0.0)
    expect(plugins).toHaveLength(2);
    expect(findPluginEntry(plugins, 'plugin-a')['version']).toBe('1.0.0');
    expect(findPluginEntry(plugins, 'plugin-b')['version']).toBe('1.0.0');

    // No per-plugin CHANGELOG.md ships (fixture has none)
    expect(
      fs.existsSync(safePath.join(inspectDir, 'plugins', 'plugin-a', 'CHANGELOG.md')),
    ).toBe(false);
    expect(
      fs.existsSync(safePath.join(inspectDir, 'plugins', 'plugin-b', 'CHANGELOG.md')),
    ).toBe(false);

    // Per-plugin tags use the inherited root version
    const remoteTags = listRemoteTagNames(sourceRepo, bareRemote);
    expect(remoteTags).toContain('plugin-a-v1.0.0');
    expect(remoteTags).toContain('plugin-b-v1.0.0');
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { readMarketplaceDefaultTargets, resolveEffectiveTargets } from '../src/marketplace-defaults.js';

const CHAT = 'claude-chat' as const;
const COWORK = 'claude-cowork' as const;
const CODE = 'claude-code' as const;

describe('resolveEffectiveTargets', () => {
  it('plugin targets override all', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CHAT],
      pluginTargets: [CODE],
      marketplaceTargets: [COWORK],
    })).toEqual([CODE]);
  });

  it('marketplace overrides config when plugin absent', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CHAT],
      pluginTargets: undefined,
      marketplaceTargets: [COWORK],
    })).toEqual([COWORK]);
  });

  it('config used when plugin and marketplace absent', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CODE],
      pluginTargets: undefined,
      marketplaceTargets: undefined,
    })).toEqual([CODE]);
  });

  it('all absent returns undefined (undeclared)', () => {
    expect(resolveEffectiveTargets({
      configTargets: undefined,
      pluginTargets: undefined,
      marketplaceTargets: undefined,
    })).toBeUndefined();
  });

  it('explicit empty plugin targets override marketplace', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CODE],
      pluginTargets: [],
      marketplaceTargets: [COWORK],
    })).toEqual([]);
  });
});

function writeManifest(dir: string, contents: string): void {
  const claudePluginDir = safePath.join(dir, '.claude-plugin');
  mkdirSyncReal(claudePluginDir, { recursive: true });
  const manifestPath = safePath.join(claudePluginDir, 'marketplace.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
  writeFileSync(manifestPath, contents, 'utf8');
}

describe('readMarketplaceDefaultTargets', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-marketplace-defaults-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds marketplace in canonical (parent-of-plugin) layout', async () => {
    const parent = safePath.join(tempDir, 'marketplace-root');
    const plugin = safePath.join(parent, 'my-plugin');
    mkdirSyncReal(plugin, { recursive: true });
    writeManifest(parent, JSON.stringify({
      name: 'my-marketplace',
      defaults: { targets: [CODE] },
    }));

    // Caller passes parent-of-plugin (matches compatibility-analyzer contract).
    const targets = await readMarketplaceDefaultTargets(parent);
    expect(targets).toEqual([CODE]);
  });

  it('finds marketplace deeper up the tree (grandparent)', async () => {
    const grandparent = safePath.join(tempDir, 'grandparent');
    const sub = safePath.join(grandparent, 'sub');
    const plugin = safePath.join(sub, 'my-plugin');
    mkdirSyncReal(plugin, { recursive: true });
    writeManifest(grandparent, JSON.stringify({
      name: 'deep-marketplace',
      defaults: { targets: [COWORK, CODE] },
    }));

    // Starting walk from the parent of the plugin dir (per caller), the
    // marketplace lives one additional level up.
    const targets = await readMarketplaceDefaultTargets(sub);
    expect(targets).toEqual([COWORK, CODE]);
  });

  it('returns undefined when no marketplace anywhere up to root', async () => {
    const plugin = safePath.join(tempDir, 'orphan-plugin');
    mkdirSyncReal(plugin, { recursive: true });
    // Starting inside a fresh temp dir with no .claude-plugin anywhere.
    const targets = await readMarketplaceDefaultTargets(plugin);
    expect(targets).toBeUndefined();
  });

  it('stops at max depth without finding the marketplace', async () => {
    // Build a tree deeper than MAX_WALK_DEPTH (10). Marketplace lives at the
    // very top; the plugin sits 12 levels below — the walk should stop before
    // reaching it.
    let current = tempDir;
    for (let i = 0; i < 12; i++) {
      current = safePath.join(current, `lvl-${i.toString()}`);
    }
    mkdirSyncReal(current, { recursive: true });
    // Place the marketplace at tempDir (above all 12 levels).
    writeManifest(tempDir, JSON.stringify({
      name: 'too-far',
      defaults: { targets: [CODE] },
    }));

    const targets = await readMarketplaceDefaultTargets(current);
    expect(targets).toBeUndefined();
  });

  it('returns undefined for invalid JSON at the walk boundary', async () => {
    const parent = safePath.join(tempDir, 'broken-marketplace');
    const plugin = safePath.join(parent, 'my-plugin');
    mkdirSyncReal(plugin, { recursive: true });
    writeManifest(parent, '{ this is : not json');

    // Does not throw; returns undefined.
    await expect(readMarketplaceDefaultTargets(parent)).resolves.toBeUndefined();
  });

  it('returns undefined when marketplace.json lacks defaults.targets', async () => {
    const parent = safePath.join(tempDir, 'no-defaults');
    const plugin = safePath.join(parent, 'my-plugin');
    mkdirSyncReal(plugin, { recursive: true });
    writeManifest(parent, JSON.stringify({ name: 'no-defaults-here' }));

    const targets = await readMarketplaceDefaultTargets(parent);
    expect(targets).toBeUndefined();
  });

  it('stops the walk at node_modules boundary', async () => {
    // Plugin lives inside a node_modules dir; marketplace.json sits above
    // node_modules but the walk should NOT escape past it.
    const outer = safePath.join(tempDir, 'project');
    const nodeModules = safePath.join(outer, 'node_modules');
    const plugin = safePath.join(nodeModules, 'some-plugin');
    mkdirSyncReal(plugin, { recursive: true });
    writeManifest(outer, JSON.stringify({
      name: 'outside-node-modules',
      defaults: { targets: [CODE] },
    }));

    // Start the walk at node_modules — the boundary check should stop here.
    const targets = await readMarketplaceDefaultTargets(nodeModules);
    expect(targets).toBeUndefined();
  });
});

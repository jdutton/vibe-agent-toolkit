/**
 * The settings reader's user layer must come from the one Claude-user-paths
 * resolver, so `CLAUDE_CONFIG_DIR` relocates it exactly as it relocates the
 * path `vat audit settings --show-paths` names.
 */

import * as fs from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { removeScratchDir } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { getClaudeUserPaths } from '../../src/paths/claude-paths.js';
import { readSettingsLayers } from '../../src/settings/settings-reader.js';

describe('readSettingsLayers user layer', () => {
  let configDir: string;

  beforeAll(async () => {
    configDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-settings-reader-'));
    await fs.writeFile(safePath.join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-4-5' }));
  });

  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await removeScratchDir(configDir); });

  it('reads the user settings file CLAUDE_CONFIG_DIR names', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);

    const user = (await readSettingsLayers()).find((layer) => layer.level === 'user');

    expect(user?.file).toBe(safePath.join(configDir, 'settings.json'));
    expect(user?.settings).toMatchObject({ model: 'claude-sonnet-4-5' });
  });

  it('reads the same file the path enumeration names', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);

    const user = (await readSettingsLayers()).find((layer) => layer.level === 'user');

    expect(user?.file).toBe(getClaudeUserPaths().userSettingsPath);
  });
});

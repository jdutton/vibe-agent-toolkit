/**
 * Unit tests for settings-merger.ts
 * Verifies precedence rules, provenance tracking, and permission accumulation.
 */

import { describe, expect, it } from 'vitest';

import type { SettingsLayer } from '../src/settings/settings-merger.js';
import { mergeSettingsLayers } from '../src/settings/settings-merger.js';

// String constants to avoid sonarjs/no-duplicate-string
const MANAGED_FILE = '/managed.json';
const USER_FILE = '/user.json';
const OPUS_MODEL = 'claude-opus-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5';
const SONNET_MODEL = 'claude-sonnet-4-6';

function layer(
  level: SettingsLayer['level'],
  file: string,
  settings: SettingsLayer['settings']
): SettingsLayer {
  return { level, file, settings };
}

describe('mergeSettingsLayers', () => {
  it('returns empty effective settings for empty layers', () => {
    const result = mergeSettingsLayers([]);
    expect(result.model).toBeUndefined();
    expect(result.permissions.allow).toEqual([]);
    expect(result.permissions.deny).toEqual([]);
    expect(result.permissions.ask).toEqual([]);
  });

  it('highest precedence scalar wins and tracks overrode chain', () => {
    const layers = [
      layer('managed', MANAGED_FILE, { model: OPUS_MODEL }),
      layer('user', USER_FILE, { model: HAIKU_MODEL }),
    ];
    const result = mergeSettingsLayers(layers);
    // Managed wins
    expect(result.model?.value).toBe(OPUS_MODEL);
    expect(result.model?.provenance.level).toBe('managed');
    expect(result.model?.provenance.file).toBe(MANAGED_FILE);
    // User's value is stored in overrode chain
    expect(result.model?.overrode?.value).toBe(HAIKU_MODEL);
    expect(result.model?.overrode?.provenance.level).toBe('user');
  });

  it('single layer scalar has no overrode', () => {
    const layers = [
      layer('user', USER_FILE, { model: HAIKU_MODEL }),
    ];
    const result = mergeSettingsLayers(layers);
    expect(result.model?.value).toBe(HAIKU_MODEL);
    expect(result.model?.overrode).toBeUndefined();
  });

  it('permission rules accumulate from all layers', () => {
    const layers = [
      layer('managed', MANAGED_FILE, {
        permissions: { deny: ['Bash(curl *)'] },
      }),
      layer('user', USER_FILE, {
        permissions: { allow: ['Bash(npm run *)'], deny: ['Bash(rm -rf *)'] },
      }),
    ];
    const result = mergeSettingsLayers(layers);

    expect(result.permissions.deny).toHaveLength(2);
    expect(result.permissions.deny[0]).toMatchObject({
      rule: 'Bash(curl *)',
      provenance: { level: 'managed', file: MANAGED_FILE },
    });
    expect(result.permissions.deny[1]).toMatchObject({
      rule: 'Bash(rm -rf *)',
      provenance: { level: 'user', file: USER_FILE },
    });
    expect(result.permissions.allow).toHaveLength(1);
    expect(result.permissions.allow[0]).toMatchObject({
      rule: 'Bash(npm run *)',
      provenance: { level: 'user', file: USER_FILE },
    });
  });

  it('managed-only fields are picked up from managed layer', () => {
    const layers = [
      layer('managed', MANAGED_FILE, {
        availableModels: [SONNET_MODEL, HAIKU_MODEL],
        disableAllHooks: true,
        autoUpdatesChannel: 'stable',
      }),
    ];
    const result = mergeSettingsLayers(layers);

    expect(result.availableModels?.value).toEqual([SONNET_MODEL, HAIKU_MODEL]);
    expect(result.disableAllHooks?.value).toBe(true);
    expect(result.autoUpdatesChannel?.value).toBe('stable');
  });

  it('user layer does not override managed layer scalar', () => {
    const layers = [
      layer('managed', MANAGED_FILE, { model: OPUS_MODEL }),
      layer('project', '/proj/.claude/settings.json', { model: HAIKU_MODEL }),
      layer('user', USER_FILE, { model: SONNET_MODEL }),
    ];
    const result = mergeSettingsLayers(layers);
    // Managed wins (first in array = highest precedence)
    expect(result.model?.value).toBe(OPUS_MODEL);
    expect(result.model?.provenance.level).toBe('managed');
  });

  it('empty permissions object is handled gracefully', () => {
    const layers = [
      layer('user', USER_FILE, { permissions: {} }),
    ];
    const result = mergeSettingsLayers(layers);
    expect(result.permissions.allow).toEqual([]);
    expect(result.permissions.deny).toEqual([]);
  });

  it('permissions defaultMode uses first-wins semantics', () => {
    const layers = [
      layer('managed', MANAGED_FILE, {
        permissions: { defaultMode: 'autoEdit' },
      }),
      layer('user', USER_FILE, {
        permissions: { defaultMode: 'acceptEdits' },
      }),
    ];
    const result = mergeSettingsLayers(layers);
    expect(result.permissions.defaultMode?.value).toBe('autoEdit');
    expect(result.permissions.defaultMode?.provenance.level).toBe('managed');
  });
});

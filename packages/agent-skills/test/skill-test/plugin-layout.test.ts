/**
 * Unit tests for detectPluginLayout — the pure ancestor-walk that decides whether
 * a skill's true on-disk source dir lives inside a Claude plugin (an ancestor dir
 * containing `.claude-plugin/plugin.json`).
 *
 * The directory-existence probe is injected so these tests touch no real filesystem.
 */

import { describe, expect, it } from 'vitest';

import { detectPluginLayout } from '../../src/skill-test/plugin-layout.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `fileExists` probe that returns true only for the given set of absolute
 * forward-slash paths (the `.claude-plugin/plugin.json` markers under test).
 */
function makeProbe(present: Set<string>): (p: string) => boolean {
  return (p: string): boolean => present.has(p.replaceAll('\\', '/'));
}

describe('detectPluginLayout', () => {
  it('detects a plugin-distributed skill and returns plugin root + rel path', () => {
    const pluginRoot = '/home/u/.claude/plugins/acme-platform';
    const skillDir = `${pluginRoot}/skills/report-tools`;
    const marker = `${pluginRoot}/.claude-plugin/plugin.json`;

    const result = detectPluginLayout(skillDir, makeProbe(new Set([marker])));

    expect(result).not.toBeNull();
    expect(result?.pluginRoot).toBe(pluginRoot);
    expect(result?.relPathUnderPlugin).toBe('skills/report-tools');
  });

  it('finds the plugin root even when the marker is several ancestors up', () => {
    const pluginRoot = '/p/my-plugin';
    const skillDir = `${pluginRoot}/skills/group/nested-skill`;
    const marker = `${pluginRoot}/.claude-plugin/plugin.json`;

    const result = detectPluginLayout(skillDir, makeProbe(new Set([marker])));

    expect(result?.pluginRoot).toBe(pluginRoot);
    expect(result?.relPathUnderPlugin).toBe('skills/group/nested-skill');
  });

  it('returns null for a standalone skill (no .claude-plugin ancestor)', () => {
    const skillDir = '/home/u/projects/my-standalone-skill';
    const result = detectPluginLayout(skillDir, makeProbe(new Set()));
    expect(result).toBeNull();
  });

  it('stops at the NEAREST plugin ancestor (innermost wins)', () => {
    const outer = '/p/outer';
    const inner = `${outer}/vendor/inner-plugin`;
    const skillDir = `${inner}/skills/s`;
    const markers = new Set([
      `${outer}/.claude-plugin/plugin.json`,
      `${inner}/.claude-plugin/plugin.json`,
    ]);

    const result = detectPluginLayout(skillDir, makeProbe(markers));

    expect(result?.pluginRoot).toBe(inner);
    expect(result?.relPathUnderPlugin).toBe('skills/s');
  });
});

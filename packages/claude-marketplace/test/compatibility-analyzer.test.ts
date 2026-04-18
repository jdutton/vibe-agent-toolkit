/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

import fs from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../src/compatibility-analyzer.js';

const fixtureDir = (name: string) => safePath.resolve(import.meta.dirname, 'fixtures', name);
const PYTHON_SCRIPT_PLUGIN = 'python-script-plugin';
const DESKTOP_INCOMPATIBLE_PLUGIN = 'desktop-incompatible-plugin';
const TARGET_CLAUDE_CODE = 'claude-code' as const;
const TARGET_CLAUDE_CHAT = 'claude-chat' as const;

describe('analyzeCompatibility', () => {
  it('produces no observations for a pure instruction plugin', async () => {
    const result = await analyzeCompatibility(fixtureDir('pure-instruction-plugin'));
    expect(result.plugin).toBe('pure-instruction');
    expect(result.observations).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.verdicts).toEqual([]);
  });

  it('detects local-shell capability for python script plugin', async () => {
    const result = await analyzeCompatibility(fixtureDir(PYTHON_SCRIPT_PLUGIN));
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.observations.some(o => o.code === 'CAPABILITY_LOCAL_SHELL')).toBe(true);
  });

  it('detects local-shell capability for desktop-incompatible plugin (Bash in allowed-tools)', async () => {
    const result = await analyzeCompatibility(fixtureDir(DESKTOP_INCOMPATIBLE_PLUGIN));
    expect(result.evidence.some(e => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL')).toBe(true);
    expect(result.observations.some(o => o.code === 'CAPABILITY_LOCAL_SHELL')).toBe(true);
  });

  it('detects HOOK_COMMAND_INVOKES_BINARY for hook-heavy plugin', async () => {
    const result = await analyzeCompatibility(fixtureDir('hook-heavy-plugin'));
    expect(result.evidence.some(e => e.patternId === 'HOOK_COMMAND_INVOKES_BINARY')).toBe(true);
    expect(result.observations.some(o => o.code === 'CAPABILITY_LOCAL_SHELL')).toBe(true);
  });

  it('detects MCP_SERVER_COMMAND for an MCP plugin without surfacing local-shell capability', async () => {
    const result = await analyzeCompatibility(fixtureDir('mcp-plugin'));
    expect(result.evidence.some(e => e.patternId === 'MCP_SERVER_COMMAND')).toBe(true);
    // MCP-only plugins shouldn't roll up to CAPABILITY_LOCAL_SHELL.
    expect(result.observations.some(o => o.code === 'CAPABILITY_LOCAL_SHELL')).toBe(false);
  });

  it('detects SCRIPT_FILE_NODE for a node-bundled plugin', async () => {
    const result = await analyzeCompatibility(fixtureDir('node-bundled-plugin'));
    expect(result.evidence.some(e => e.patternId === 'SCRIPT_FILE_NODE')).toBe(true);
  });

  it('includes summary counts', async () => {
    const result = await analyzeCompatibility(fixtureDir(PYTHON_SCRIPT_PLUGIN));
    expect(result.summary.totalFiles).toBeGreaterThan(0);
    expect(result.summary.scriptFiles).toBeGreaterThan(0);
    expect(result.summary.skillFiles).toBeGreaterThan(0);
  });

  it('throws for directory without plugin.json', async () => {
    const nonexistent = safePath.resolve(import.meta.dirname, 'fixtures', 'nonexistent');
    await expect(analyzeCompatibility(nonexistent))
      .rejects.toThrow();
  });

  describe('configTargets option', () => {
    it('flows configTargets through when plugin.json declares no targets (claude-code)', async () => {
      // python-script-plugin's plugin.json has no `targets` field and no marketplace.json,
      // so configTargets become the effective declared targets.
      const result = await analyzeCompatibility(
        fixtureDir(PYTHON_SCRIPT_PLUGIN),
        { configTargets: [TARGET_CLAUDE_CODE] },
      );
      expect(result.declaredTargets).toEqual([TARGET_CLAUDE_CODE]);

      // claude-code supports local shell, so no incompat/undeclared verdicts fire.
      const verdictCodes = result.verdicts.map(v => v.code);
      expect(verdictCodes).not.toContain('COMPAT_TARGET_UNDECLARED');
      expect(verdictCodes).not.toContain('COMPAT_TARGET_INCOMPATIBLE');
    });

    it('fires COMPAT_TARGET_INCOMPATIBLE when configTargets do not cover observed capability', async () => {
      // python-script-plugin uses local shell; claude-chat does not provide it.
      const result = await analyzeCompatibility(
        fixtureDir(PYTHON_SCRIPT_PLUGIN),
        { configTargets: [TARGET_CLAUDE_CHAT] },
      );
      expect(result.declaredTargets).toEqual([TARGET_CLAUDE_CHAT]);
      expect(result.verdicts.some(v => v.code === 'COMPAT_TARGET_INCOMPATIBLE')).toBe(true);
    });

    it('ignores configTargets when plugin.json declares targets (plugin wins)', async () => {
      // Build a throwaway plugin dir that explicitly declares targets in plugin.json.
      const tmpBase = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'compat-plugin-wins-'));
      const pluginDir = safePath.join(tmpBase, 'plugin');
      const claudeDir = safePath.join(pluginDir, '.claude-plugin');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        safePath.join(claudeDir, 'plugin.json'),
        JSON.stringify({ name: 'plugin-wins', version: '1.0.0', targets: [TARGET_CLAUDE_CODE] }),
      );

      try {
        const withConfig = await analyzeCompatibility(pluginDir, { configTargets: [TARGET_CLAUDE_CHAT] });
        const withoutConfig = await analyzeCompatibility(pluginDir);
        // plugin.json targets win; configTargets is ignored.
        expect(withConfig.declaredTargets).toEqual(['claude-code']);
        expect(withConfig.declaredTargets).toEqual(withoutConfig.declaredTargets);
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it('is identity-equivalent to omitting options when no configTargets are passed', async () => {
      const withOpts = await analyzeCompatibility(
        fixtureDir(PYTHON_SCRIPT_PLUGIN),
        {},
      );
      const withoutOpts = await analyzeCompatibility(fixtureDir(PYTHON_SCRIPT_PLUGIN));
      expect(withOpts.declaredTargets).toEqual(withoutOpts.declaredTargets);
      const cmp = (a: string, b: string) => a.localeCompare(b);
      expect(withOpts.verdicts.map(v => v.code).sort(cmp)).toEqual(
        withoutOpts.verdicts.map(v => v.code).sort(cmp),
      );
    });
  });
});

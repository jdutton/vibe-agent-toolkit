import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../src/compatibility-analyzer.js';

const fixtureDir = (name: string) => safePath.resolve(import.meta.dirname, 'fixtures', name);

describe('analyzeCompatibility', () => {
  it('produces no observations for a pure instruction plugin', async () => {
    const result = await analyzeCompatibility(fixtureDir('pure-instruction-plugin'));
    expect(result.plugin).toBe('pure-instruction');
    expect(result.observations).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.verdicts).toEqual([]);
  });

  it('detects local-shell capability for python script plugin', async () => {
    const result = await analyzeCompatibility(fixtureDir('python-script-plugin'));
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.observations.some(o => o.code === 'CAPABILITY_LOCAL_SHELL')).toBe(true);
  });

  it('detects local-shell capability for desktop-incompatible plugin (Bash in allowed-tools)', async () => {
    const result = await analyzeCompatibility(fixtureDir('desktop-incompatible-plugin'));
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
    const result = await analyzeCompatibility(fixtureDir('python-script-plugin'));
    expect(result.summary.totalFiles).toBeGreaterThan(0);
    expect(result.summary.scriptFiles).toBeGreaterThan(0);
    expect(result.summary.skillFiles).toBeGreaterThan(0);
  });

  it('throws for directory without plugin.json', async () => {
    const nonexistent = safePath.resolve(import.meta.dirname, 'fixtures', 'nonexistent');
    await expect(analyzeCompatibility(nonexistent))
      .rejects.toThrow();
  });
});

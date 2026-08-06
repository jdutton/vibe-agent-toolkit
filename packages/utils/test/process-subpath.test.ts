import { describe, expect, it } from 'vitest';

describe('./process subpath entry', () => {
  it('exports the sync exec + stdio helpers it already had', async () => {
    const mod = await import('../src/process.js');
    expect(typeof mod.safeExecSync).toBe('function');
    expect(typeof mod.safeExecResult).toBe('function');
    expect(typeof mod.isToolAvailable).toBe('function');
    expect(typeof mod.makeStdioBlocking).toBe('function');
  });

  it('exports the hardened async spawn and Windows shell helpers', async () => {
    const mod = await import('../src/process.js');
    expect(typeof mod.spawnHardened).toBe('function');
    expect(typeof mod.shouldUseShell).toBe('function');
    expect(typeof mod.windowsShellQuote).toBe('function');
    expect(typeof mod.buildWindowsShellLine).toBe('function');
  });
});

import { describe, it, expect } from 'vitest';

import { version, getVersionString } from '../src/version.js';

/**
 * A stand-in for the resolved path of the binary that is actually executing.
 * `bin.ts` derives the real one from its own `import.meta.filename`, so it is a
 * property of the running code — never of the cwd.
 */
const BIN = '/repo/packages/cli/dist/bin.js';

describe('version', () => {
  it('should export version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should format version without context', () => {
    const result = getVersionString('0.1.0', null, BIN);
    expect(result).toBe(`0.1.0\n  binary: ${BIN}`);
  });

  it('should format version with dev context', () => {
    const result = getVersionString('0.1.0', { type: 'dev', path: '/test/path' }, BIN);
    expect(result).toBe(`0.1.0-dev (/test/path)\n  binary: ${BIN}`);
  });

  it('should format version with local context', () => {
    const result = getVersionString('0.1.0', { type: 'local', path: '/project' }, BIN);
    expect(result).toBe(`0.1.0 (local: /project)\n  binary: ${BIN}`);
  });

  it('should format version with global context', () => {
    const result = getVersionString('0.1.0', { type: 'global' }, BIN);
    expect(result).toBe(`0.1.0\n  binary: ${BIN}`);
  });

  /**
   * The defect this pins (adopter finding B9): the `-dev (<path>)` suffix is
   * CWD-derived. A branch build invoked by absolute path from an adopter
   * checkout resolves `Context: global` and used to print a bare `0.1.41-rc.8`
   * — byte-identical to what the released rc.8 prints. Every adopter delta test
   * runs in exactly that directory, so the identity check the whole testing
   * protocol depends on was unperformable where the tests actually run.
   *
   * The resolved binary path is the one fact that always differs, so it is
   * printed unconditionally rather than only under `VAT_DEBUG=1`.
   */
  it('distinguishes two binaries that share a version and a context', () => {
    const branchBuild = getVersionString('0.1.41-rc.8', { type: 'global' }, '/worktree/packages/cli/dist/bin.js');
    const released = getVersionString('0.1.41-rc.8', { type: 'global' }, '/usr/local/lib/node_modules/@vibe-agent-toolkit/cli/dist/bin.js');

    expect(branchBuild).not.toBe(released);
    expect(branchBuild).toContain('/worktree/packages/cli/dist/bin.js');
    expect(released).toContain('/usr/local/lib/node_modules/@vibe-agent-toolkit/cli/dist/bin.js');
  });

  it('keeps the version itself first, so `--version | head -1` still parses', () => {
    // Existing callers (docs, scripts, the integration suite) match /^\d+\.\d+\.\d+/
    // against the whole output; the provenance line is appended, never prepended.
    const lines = getVersionString('0.1.0', { type: 'dev', path: '/p' }, BIN).split('\n');
    expect(lines[0]).toBe('0.1.0-dev (/p)');
  });
});

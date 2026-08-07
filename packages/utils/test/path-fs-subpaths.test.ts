import { describe, expect, it } from 'vitest';

describe('./path subpath entry', () => {
  it('exports the pure path-string helpers', async () => {
    const mod = await import('../src/path.js');
    expect(typeof mod.toForwardSlash).toBe('function');
    expect(typeof mod.isAbsolutePath).toBe('function');
    expect(typeof mod.isAbsoluteAnyPlatform).toBe('function');
    expect(typeof mod.hasParentTraversalSegment).toBe('function');
    expect(typeof mod.toAbsolutePath).toBe('function');
    expect(typeof mod.getRelativePath).toBe('function');
    expect(typeof mod.issueLocation).toBe('function');
    expect(typeof mod.safePath.join).toBe('function');
  });

  it('does NOT export fs-touching helpers', async () => {
    const mod: Record<string, unknown> = await import('../src/path.js');
    expect(mod.normalizedTmpdir).toBeUndefined();
    expect(mod.mkdirSyncReal).toBeUndefined();
    expect(mod.normalizePath).toBeUndefined();
  });
});

describe('./fs subpath entry', () => {
  it('exports the fs-touching helpers', async () => {
    const mod = await import('../src/fs.js');
    expect(typeof mod.normalizePath).toBe('function');
    expect(typeof mod.normalizedTmpdir).toBe('function');
    expect(typeof mod.mkdirSyncReal).toBe('function');
    expect(typeof mod.resolveFromImportMeta).toBe('function');
    expect(typeof mod.dynamicImportPath).toBe('function');
    expect(typeof mod.copyDirectory).toBe('function');
    expect(typeof mod.verifyCaseSensitiveFilename).toBe('function');
    expect(typeof mod.FsLookupCache).toBe('function');
  });

  it('does NOT re-export the pure path helpers', async () => {
    const mod: Record<string, unknown> = await import('../src/fs.js');
    expect(mod.safePath).toBeUndefined();
    expect(mod.toForwardSlash).toBeUndefined();
  });
});

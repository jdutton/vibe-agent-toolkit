import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';


import { prepareBinaries } from '../src/prepare-bin.js';


describe('prepareBinaries', () => {
  const suite = setupSyncTempDirSuite('prepare-bin');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should copy and chmod binary files', async () => {
    // Create source file
    const distDir = safePath.join(tempDir, 'dist', 'bin');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(safePath.join(distDir, 'vat.js'), '#!/usr/bin/env node\nconsole.log("test")');

    // Run prepare
    await prepareBinaries(tempDir);

    // Verify copy
    const binPath = safePath.join(distDir, 'vat');
    expect(fs.existsSync(binPath)).toBe(true);

    // Verify executable bit (on Unix)
    if (process.platform !== 'win32') {
      const stats = fs.statSync(binPath);
      expect(stats.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('should handle missing dist directory gracefully', async () => {
    await expect(prepareBinaries(tempDir)).rejects.toThrow(/dist\/bin directory not found/);
  });

  it('should handle missing source file gracefully', async () => {
    const distDir = safePath.join(tempDir, 'dist', 'bin');
    fs.mkdirSync(distDir, { recursive: true });

    await expect(prepareBinaries(tempDir)).rejects.toThrow(/vat.js not found/);
  });
});

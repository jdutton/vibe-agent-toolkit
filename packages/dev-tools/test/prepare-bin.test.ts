import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';


import { prepareBinaries } from '../src/prepare-bin.js';

/* eslint-disable security/detect-non-literal-fs-filename -- test file with dynamic temp paths */

describe('prepareBinaries', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'prepare-bin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should copy and chmod binary files', () => {
    // Create source file
    const distDir = path.join(tempDir, 'dist', 'bin');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'vat.js'), '#!/usr/bin/env node\nconsole.log("test")');

    // Run prepare
    prepareBinaries(tempDir);

    // Verify copy
    const binPath = path.join(distDir, 'vat');
    expect(fs.existsSync(binPath)).toBe(true);

    // Verify executable bit (on Unix)
    if (process.platform !== 'win32') {
      const stats = fs.statSync(binPath);
      expect(stats.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('should handle missing dist directory gracefully', () => {
    expect(() => prepareBinaries(tempDir)).toThrow(/dist\/bin directory not found/);
  });

  it('should handle missing source file gracefully', () => {
    const distDir = path.join(tempDir, 'dist', 'bin');
    fs.mkdirSync(distDir, { recursive: true });

    expect(() => prepareBinaries(tempDir)).toThrow(/vat.js not found/);
  });
});

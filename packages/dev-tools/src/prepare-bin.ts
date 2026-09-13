/**
 * Prepare CLI binaries after TypeScript compilation
 * Copies dist/bin/vat.js → dist/bin/vat and makes executable
 */

import { copyFileSync, chmodSync, existsSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

import { isEntrypoint } from './common.js';

export function prepareBinaries(packageRoot: string): void {
  const distBinDir = safePath.join(packageRoot, 'dist', 'bin');
  const sourcePath = safePath.join(distBinDir, 'vat.js');
  const targetPath = safePath.join(distBinDir, 'vat');

  if (!existsSync(distBinDir)) {
    throw new Error(`dist/bin directory not found at ${distBinDir}`);
  }

  if (!existsSync(sourcePath)) {
    throw new Error(`vat.js not found at ${sourcePath}`);
  }

  // Copy file
  copyFileSync(sourcePath, targetPath);

  // Make executable (cross-platform)
  // On Windows, this is a no-op but doesn't error
  try {
    chmodSync(targetPath, 0o755);
  } catch (error) {
    // Ignore chmod errors on Windows
    if (process.platform !== 'win32') {
      throw error;
    }
  }

  console.log(`✓ Prepared binary: ${targetPath}`);
}

// CLI entry point. `isEntrypoint`, not a raw `argv[1]` string compare: this
// script is reached through `node_modules/.bin`, which is a symlink, and the
// string compare is false there.
if (isEntrypoint(import.meta.url)) {
  const packageRoot = process.cwd();
  prepareBinaries(packageRoot);
}

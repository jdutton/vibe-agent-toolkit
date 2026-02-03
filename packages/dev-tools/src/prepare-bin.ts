/**
 * Prepare CLI binaries after TypeScript compilation
 * Copies dist/bin/vat.js → dist/bin/vat and makes executable
 */

import { copyFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function prepareBinaries(packageRoot: string): void {
  const distBinDir = join(packageRoot, 'dist', 'bin');
  const sourcePath = join(distBinDir, 'vat.js');
  const targetPath = join(distBinDir, 'vat');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are constructed from packageRoot parameter
  if (!existsSync(distBinDir)) {
    throw new Error(`dist/bin directory not found at ${distBinDir}`);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are constructed from packageRoot parameter
  if (!existsSync(sourcePath)) {
    throw new Error(`vat.js not found at ${sourcePath}`);
  }

  // Copy file
  copyFileSync(sourcePath, targetPath);

  // Make executable (cross-platform)
  // On Windows, this is a no-op but doesn't error
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are constructed from packageRoot parameter
    chmodSync(targetPath, 0o755);
  } catch (error) {
    // Ignore chmod errors on Windows
    if (process.platform !== 'win32') {
      throw error;
    }
  }

  console.log(`✓ Prepared binary: ${targetPath}`);
}

// CLI entry point
if (import.meta.url === `file://${String(process.argv[1] ?? '')}`) {
  const packageRoot = process.cwd();
  prepareBinaries(packageRoot);
}

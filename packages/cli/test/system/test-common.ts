/**
 * Common imports and utilities for system tests
 * Extracts common setup to reduce duplication across test files
 */

import { dirname as pathDirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath as urlFileURLToPath } from 'node:url';

// Re-export commonly used functions
export { spawnSync } from 'node:child_process';
export * as fs from 'node:fs';
export { join, resolve, dirname } from 'node:path';
export { fileURLToPath } from 'node:url';
export { describe, expect } from 'vitest';

/**
 * Get bin path from current test file location
 */
export function getBinPath(testFileUrl: string): string {
  const testDir = pathDirname(urlFileURLToPath(testFileUrl));
  return pathResolve(testDir, '../../dist/bin.js');
}

/**
 * Get wrapper path from current test file location
 */
export function getWrapperPath(testFileUrl: string): string {
  const testDir = pathDirname(urlFileURLToPath(testFileUrl));
  return pathResolve(testDir, '../../dist/bin/vat.js');
}

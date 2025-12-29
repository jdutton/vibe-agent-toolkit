/**
 * Common imports and utilities for system tests
 * Extracts common setup to reduce duplication across test files
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect } from 'vitest';

// Re-export commonly used functions
export {
  spawnSync,
  fs,
  join,
  resolve,
  dirname,
  fileURLToPath,
  describe,
  expect,
};

/**
 * Get bin path from current test file location
 */
export function getBinPath(testFileUrl: string): string {
  const testDir = dirname(fileURLToPath(testFileUrl));
  return resolve(testDir, '../../dist/bin.js');
}

/**
 * Get wrapper path from current test file location
 */
export function getWrapperPath(testFileUrl: string): string {
  const testDir = dirname(fileURLToPath(testFileUrl));
  return resolve(testDir, '../../dist/bin/vat.js');
}

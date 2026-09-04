/**
 * Test fixture loader - extracts compressed test fixtures for system tests
 *
 * This module provides cross-platform extraction of the test fixture ZIP.
 * The fixtures are extracted once per test run to a temp directory and reused.
 *
 * Security: existsSync warnings are acceptable here - paths are constructed
 * internally and not from user input.
 */

/* eslint-disable security/detect-non-literal-fs-filename */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';

// Vitest shims `__dirname` even in ESM, so this module worked under the test
// runner while failing under plain `tsx` with ERR_AMBIGUOUS_MODULE_SYNTAX —
// which silently broke the documented `bun run …/capture-legacy-snapshot.ts`
// path. Derive it from `import.meta.url` so both entry points work.
const moduleDir = dirname(fileURLToPath(import.meta.url));

let extractedFixturesPath: string | null = null;

/**
 * Get the path to extracted test fixtures, extracting if necessary
 *
 * Extracts the claude-plugins-snapshot.zip to a temp directory on first call.
 * Subsequent calls return the same path without re-extracting.
 *
 * @returns Path to extracted fixtures directory
 */
export async function getTestFixturesPath(): Promise<string> {
  if (extractedFixturesPath && existsSync(extractedFixturesPath)) {
    return extractedFixturesPath;
  }

  // Create temp directory for this test run
  const tempBase = safePath.join(normalizedTmpdir(), `vat-test-fixtures-${Date.now()}`);
  mkdirSyncReal(tempBase, { recursive: true });

  // Path to ZIP file (trusted, committed to repository)
  const zipPath = safePath.join(moduleDir, '../fixtures/claude-plugins-snapshot.zip');

  // Extract ZIP (fast on Windows, cross-platform using adm-zip)
  const zip = new AdmZip(zipPath);
   
  zip.extractAllTo(tempBase, true);

  // Path to extracted fixtures
  extractedFixturesPath = safePath.join(tempBase, 'claude-plugins-snapshot');

  if (!existsSync(extractedFixturesPath)) {
    throw new Error(`Extraction failed: ${String(extractedFixturesPath)} does not exist after extraction`);
  }

  return extractedFixturesPath;
}

/**
 * Get the path synchronously (requires extraction to have happened first)
 *
 * @throws Error if extraction hasn't happened yet
 */
export function getTestFixturesPathSync(): string {
  if (!extractedFixturesPath) {
    throw new Error('Test fixtures not extracted yet. Call getTestFixturesPath() first.');
  }
  return extractedFixturesPath;
}

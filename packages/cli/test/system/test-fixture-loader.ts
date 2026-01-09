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
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';

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
  const tempBase = join(normalizedTmpdir(), `vat-test-fixtures-${Date.now()}`);
  mkdirSyncReal(tempBase, { recursive: true });

  // Path to ZIP file (trusted, committed to repository)
  const zipPath = join(__dirname, '../fixtures/claude-plugins-snapshot.zip');

  // Extract ZIP (fast on Windows, cross-platform using adm-zip)
  const zip = new AdmZip(zipPath);
  // eslint-disable-next-line sonarjs/no-unsafe-unzip -- ZIP is trusted (committed to repo)
  zip.extractAllTo(tempBase, true);

  // Path to extracted fixtures
  extractedFixturesPath = join(tempBase, 'claude-plugins-snapshot');

  if (!existsSync(extractedFixturesPath)) {
    throw new Error(`Extraction failed: ${extractedFixturesPath} does not exist after extraction`);
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

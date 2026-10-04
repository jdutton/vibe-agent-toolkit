/**
 * Shared fixtures for the verdict facet's integration suites: temp
 * directories, a subject tree, and suite cleanup. Not a test file.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import { cleanupProbes } from '../command-probe.js';

/** The alias every verdict fixture subject is captured under. */
export const FIXTURE_ALIAS = 'crucible-1';

const tempDirs: string[] = [];

/**
 * @param prefix - Temp-directory prefix
 * @returns A fresh temp directory, removed by {@link cleanupVerdictFixtures}
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * @returns A subject tree — a plain folder, so its identity is a content fingerprint
 */
export function fixtureSubject(): string {
  const dir = tempDir('lab-verdict-subject-');
  writeFileSync(safePath.join(dir, 'README.md'), '# subject\n', 'utf-8');
  return dir;
}

/** Remove every probe and temp directory the suite made. Call from `afterAll`. */
export function cleanupVerdictFixtures(): void {
  cleanupProbes();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
}

/**
 * Shared test file helper utilities
 * Used across multiple test files to reduce duplication
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test helper with controlled inputs */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

/**
 * Helper to create multiple markdown test files with standard content
 *
 * @param inputDir - Directory to create files in
 * @param fileNames - Array of file names (can include paths like 'docs/guide.md')
 * @param contentTemplate - Optional function to generate content for each file
 */
export function createMultipleMarkdownFiles(
  inputDir: string,
  fileNames: string[],
  contentTemplate?: (fileName: string) => string,
): void {
  for (const file of fileNames) {
    const content = contentTemplate
      ? contentTemplate(file)
      : `# ${file}\n\n## Section\n\nContent for ${file}`;
    const filePath = join(inputDir, file);
    const dir = join(filePath, '..');
    mkdirSyncReal(dir, { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
  }
}

/**
 * Helper to verify operation results with expected success/failure counts
 *
 * @param results - Array of operation results with success property
 * @param expectedTotal - Expected total number of results
 * @param expectedSuccessCount - Expected number of successful results
 */
export function verifyOperationResults<T extends { success: boolean }>(
  results: T[],
  expectedTotal: number,
  expectedSuccessCount: number,
): { validResults: T[]; failedResults: T[] } {
  expect(results).toHaveLength(expectedTotal);

  const validResults = results.filter((r) => r.success);
  const failedResults = results.filter((r) => !r.success);

  expect(validResults).toHaveLength(expectedSuccessCount);
  expect(failedResults).toHaveLength(expectedTotal - expectedSuccessCount);

  return { validResults, failedResults };
}

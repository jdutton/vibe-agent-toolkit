import * as fs from 'node:fs';
import * as path from 'node:path';

import { crawlDirectory , isGitIgnored } from '@vibe-agent-toolkit/utils';

import { detectFormat } from '../detectors/format-detector.js';
import { createPatternFilter } from '../filters/pattern-filter.js';
import type { ScanOptions, ScanResult, ScanSummary } from '../types.js';

/**
 * Scan local filesystem for VAT agents and Claude Skills
 *
 * @param options - Scan options
 * @returns Scan summary with all discovered files
 */
export async function scan(options: ScanOptions): Promise<ScanSummary> {
  const { path: targetPath, recursive = false, include, exclude } = options;

  // Resolve to absolute path
  const absolutePath = path.resolve(targetPath);

  // Check if target exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- absolutePath is validated user input
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Path does not exist: ${absolutePath}`);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- absolutePath validated above
  const stat = fs.statSync(absolutePath);

  // Determine scan root for relative paths
  const scanRoot = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);

  // Get file list
  let filePaths: string[];

  if (stat.isFile()) {
    filePaths = [absolutePath];
  } else if (stat.isDirectory()) {
    if (recursive) {
      filePaths = await crawlDirectory({
        baseDir: absolutePath,
        respectGitignore: false, // We handle gitignore separately
        exclude: [], // Don't exclude anything - we handle filtering ourselves
      });
    } else {
      // Non-recursive: only immediate children
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- absolutePath validated above
      filePaths = fs.readdirSync(absolutePath)
        .map(name => path.join(absolutePath, name))
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are from validated directory
        .filter(p => fs.statSync(p).isFile());
    }
  } else {
    throw new Error(`Path is neither file nor directory: ${absolutePath}`);
  }

  // Create pattern filter
  const patternFilter = createPatternFilter({
    ...(include && { include }),
    ...(exclude && { exclude }),
  });

  // Process each file
  const results: ScanResult[] = [];

  for (const filePath of filePaths) {
    const relativePath = path.relative(scanRoot, filePath);

    // Apply pattern filter
    if (!patternFilter(relativePath)) {
      continue;
    }

    const format = detectFormat(filePath);
    const gitIgnored = isGitIgnored(filePath, scanRoot);

    results.push({
      path: filePath,
      format,
      isGitIgnored: gitIgnored,
      relativePath,
    });
  }

  // Build summary
  const byFormat = results.reduce((acc, r) => {
    acc[r.format] = (acc[r.format] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const sourceFiles = results.filter(r => !r.isGitIgnored);
  const buildOutputs = results.filter(r => r.isGitIgnored);

  return {
    results,
    totalScanned: results.length,
    byFormat: byFormat as ScanSummary['byFormat'],
    sourceFiles,
    buildOutputs,
  };
}

import * as fs from 'node:fs';
import * as path from 'node:path';

import { crawlDirectory, gitCheckIgnoredBatch } from '@vibe-agent-toolkit/utils';

import { detectFormat } from '../detectors/format-detector.js';
import { createPatternFilter } from '../filters/pattern-filter.js';
import type { DetectedFormat, ScanOptions, ScanResult, ScanSummary } from '../types.js';

/**
 * Directories that should ALWAYS be excluded from scanning to prevent catastrophic performance.
 * These contain tens of thousands of files and are never useful for discovery.
 */
const PERFORMANCE_POISON = [
  '**/.git/**',          // Git objects (1000s of files), never useful for discovery
  '**/node_modules/**',  // Dependencies (40K+ files), never user content
  '**/coverage/**',      // Test coverage reports, never useful for discovery
  '**/.test-output/**',  // Test artifacts, never useful for discovery
];

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
      // Merge performance poison patterns with user's exclude patterns
      // This prevents catastrophic crawls of .git, node_modules, etc. (52K+ files)
      const crawlExclusions = [...PERFORMANCE_POISON, ...(exclude ?? [])];

      filePaths = await crawlDirectory({
        baseDir: absolutePath,
        respectGitignore: false, // We handle gitignore separately
        exclude: crawlExclusions, // Skip poison directories during crawl (not after)
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

  // Create pattern filter for include patterns only
  // (exclude patterns already applied during crawl for performance)
  const patternFilter = createPatternFilter({
    ...(include && { include }),
    // Note: For recursive scans, exclude patterns are applied during crawl.
    // For non-recursive scans, we apply them here for consistency.
    ...(!recursive && exclude && { exclude }),
  });

  // Filter files by pattern and detect formats
  const filteredFiles: Array<{ path: string; relativePath: string; format: DetectedFormat }> = [];

  for (const filePath of filePaths) {
    const relativePath = path.relative(scanRoot, filePath);

    // Apply pattern filter (include patterns, and exclude for non-recursive)
    if (!patternFilter(relativePath)) {
      continue;
    }

    const format = detectFormat(filePath);
    filteredFiles.push({ path: filePath, relativePath, format });
  }

  // Batch check git-ignored status (single git subprocess instead of N)
  const gitIgnoredMap = gitCheckIgnoredBatch(
    filteredFiles.map((f) => f.path),
    scanRoot
  );

  // Build final results
  const results: ScanResult[] = filteredFiles.map((file) => ({
    path: file.path,
    format: file.format,
    isGitIgnored: gitIgnoredMap.get(file.path) ?? false,
    relativePath: file.relativePath,
  }));

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

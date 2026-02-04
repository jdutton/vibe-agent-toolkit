/**
 * Copy Resources Utility
 * Cross-platform utility for copying generated resources to dist directory
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface CopyResourcesOptions {
  /**
   * Source directory containing generated resources
   * Example: 'generated' or 'generated/resources'
   */
  sourceDir: string;

  /**
   * Target directory in dist
   * Example: 'dist/generated' or 'dist'
   */
  targetDir: string;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;
}

/**
 * Copy generated resources to dist directory (cross-platform)
 *
 * @example
 * ```typescript
 * import { copyResources } from '@vibe-agent-toolkit/resource-compiler/utils';
 *
 * copyResources({
 *   sourceDir: 'generated',
 *   targetDir: 'dist/generated',
 * });
 * ```
 */
export function copyResources(options: CopyResourcesOptions): void {
  const { sourceDir, targetDir, verbose = false } = options;

  if (verbose) {
    console.log(`Copying resources: ${sourceDir} → ${targetDir}`);
  }

  // Validate source exists
  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  // Ensure target parent directory exists
  const targetParent = dirname(targetDir);
  if (!existsSync(targetParent)) {
    mkdirSync(targetParent, { recursive: true });
  }

  try {
    // Copy recursively using Node's built-in cpSync (cross-platform)
    cpSync(sourceDir, targetDir, { recursive: true });

    if (verbose) {
      console.log(`✓ Copied resources to ${targetDir}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to copy resources: ${message}`);
  }
}

/**
 * Create a post-build script that copies resources
 *
 * @example
 * ```typescript
 * // scripts/post-build.ts
 * import { createPostBuildScript } from '@vibe-agent-toolkit/resource-compiler/utils';
 *
 * createPostBuildScript({
 *   generatedDir: 'generated',
 *   distDir: 'dist',
 * });
 * ```
 */
export function createPostBuildScript(options: {
  generatedDir: string;
  distDir: string;
  verbose?: boolean;
}): void {
  const { generatedDir, distDir, verbose = false } = options;

  try {
    copyResources({
      sourceDir: generatedDir,
      targetDir: join(distDir, generatedDir),
      verbose,
    });
  } catch (error) {
    console.error(`Error in post-build script:`, error);
    process.exit(1);
  }
}

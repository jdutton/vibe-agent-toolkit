/**
 * Copy Resources Utility
 * Cross-platform utility for copying generated resources to dist directory
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { copyTree, mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

export interface CopyResourcesOptions {
  /** Source directory containing generated resources, e.g. 'generated' or 'generated/resources'. */
  sourceDir: string;

  /** Target directory in dist, e.g. 'dist/generated'. The copy goes IN: what the source does not hold is left alone. */
  targetDir: string;

  /** Enable verbose logging */
  verbose?: boolean;

  /**
   * Paths relative to sourceDir to leave out of the copy, along with everything
   * under them. Example: ['resources/skills/evals'] to keep eval fixtures — test
   * input, not distributed skill content — out of the published package.
   */
  exclude?: string[];
}

/** `relativePath` is forward-slash, relative to the source root (the copy's own filter argument). */
function isExcludedPath(relativePath: string, exclude: readonly string[]): boolean {
  const normalized = toForwardSlash(relativePath);
  return normalized !== '' && exclude.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

/**
 * Copy generated resources to dist directory (cross-platform).
 *
 * The copy goes INTO `targetDir` and never removes anything: a file the source holds is
 * written over, anything else already there stays. VAT does not delete what it cannot prove
 * it made, and the target is the adopter's. A link in the source is copied as what it points
 * at, inside the source only; a named pipe or device is refused, never waited on.
 *
 * @example
 * ```typescript
 * import { copyResources } from '@vibe-agent-toolkit/resource-compiler/utils';
 *
 * await copyResources({
 *   sourceDir: 'generated',
 *   targetDir: 'dist/generated',
 * });
 * ```
 */
export async function copyResources(options: CopyResourcesOptions): Promise<void> {
  const { sourceDir, targetDir, verbose = false, exclude = [] } = options;

  if (verbose) {
    console.log(`Copying resources: ${sourceDir} → ${targetDir}`);
  }

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  const targetParent = dirname(targetDir);
  if (!existsSync(targetParent)) {
    mkdirSyncReal(targetParent, { recursive: true });
  }

  try {
    await copyTree(safePath.resolve(sourceDir), safePath.resolve(targetDir), '', {
      side: 'source',
      links: 'follow-contained',
      // The adopter's build output, written again on every build: what a previous build left is replaced.
      onto: 'merge',
      ...(exclude.length === 0 ? {} : { filter: (relative: string) => !isExcludedPath(relative, exclude) }),
    });

    if (verbose) {
      console.log(`✓ Copied resources to ${targetDir}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The classified fault (its side, class and errno) stays reachable as the cause.
    throw new Error(`Failed to copy resources: ${message}`, { cause: error });
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
 * await createPostBuildScript({
 *   generatedDir: 'generated',
 *   distDir: 'dist',
 * });
 * ```
 */
export async function createPostBuildScript(options: {
  generatedDir: string;
  distDir: string;
  verbose?: boolean;
  exclude?: string[];
}): Promise<void> {
  const { generatedDir, distDir, verbose = false, exclude } = options;

  try {
    await copyResources({
      sourceDir: generatedDir,
      targetDir: safePath.join(distDir, generatedDir),
      verbose,
      ...(exclude === undefined ? {} : { exclude }),
    });
  } catch (error) {
    console.error(`Error in post-build script:`, error);
    process.exit(ExitCode.ERROR);
  }
}

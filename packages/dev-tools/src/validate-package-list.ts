/**
 * Shared package list validation logic
 *
 * Used by both pre-publish-check.ts and publish-with-rollback.ts
 * to ensure all packages in packages/ are accounted for.
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT and 'packages' constants (controlled, not user input)

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { PUBLISHED_PACKAGES, SKIP_PACKAGES } from './package-lists.js';

/**
 * Validation results for package list synchronization
 */
export interface PackageListValidation {
  /** Packages that exist in packages/ but aren't declared in lists */
  undeclared: string[];
  /** Packages declared in lists but don't exist in packages/ */
  phantom: string[];
}

/**
 * Validate that all packages in packages/ are declared in either
 * PUBLISHED_PACKAGES or SKIP_PACKAGES, and that all declared packages
 * actually exist.
 *
 * @param projectRoot - Root directory of the project
 * @returns Validation results with undeclared and phantom packages
 */
export function validatePackageList(projectRoot: string): PackageListValidation {
  const packagesPath = join(projectRoot, 'packages');

  if (!existsSync(packagesPath)) {
    throw new Error('packages/ directory not found');
  }

  const actualPackages = new Set(
    readdirSync(packagesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
  );

  const declaredPackages = new Set<string>([...PUBLISHED_PACKAGES, ...SKIP_PACKAGES]);
  const undeclared: string[] = [];
  const phantom: string[] = [];

  // Check for undeclared packages (exist but not in lists)
  for (const pkg of actualPackages) {
    if (!declaredPackages.has(pkg)) {
      undeclared.push(pkg);
    }
  }

  // Check for phantom packages (declared but don't exist)
  for (const pkg of declaredPackages) {
    if (!actualPackages.has(pkg)) {
      phantom.push(pkg);
    }
  }

  return { undeclared, phantom };
}

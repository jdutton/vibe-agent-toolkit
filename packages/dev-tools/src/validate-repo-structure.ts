#!/usr/bin/env bun
/**
 * Repository Structure Validator
 *
 * Validates that the monorepo structure follows conventions to prevent
 * structural sprawl from agentic development (AI code generation).
 *
 * CRITICAL - Security:
 * - No credential/secret files (.env, credentials.json, certificate files, etc.)
 *
 * HIGH PRIORITY - File Location Sprawl:
 * - No nested package.json files (only root and packages directories)
 * - Source files must be in packages src or test directories
 * - Test file naming conventions (.test.ts, not .spec.ts)
 *
 * ORIGINAL RULES:
 * - No /examples directories in runtime packages
 * - No /scripts directories (except dev-tools, agent-schema)
 * - No shell scripts (.sh, .ps1, .bat, .cmd) - use TypeScript
 * - No /staging directories in test/fixtures
 * - Test fixtures follow size guidelines (over 100KB must be compressed)
 *
 * Run: bun run validate-structure
 * Use in CI to catch issues before they reach main branch
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// This utility script needs to read dynamic file paths for validation

import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');

/**
 * Validation error type constants
 */
const ERROR_TYPES = {
  FORBIDDEN_DIRECTORY: 'forbidden-directory',
  LARGE_FILE: 'large-file',
  STRUCTURAL_VIOLATION: 'structural-violation',
} as const;

/**
 * Common directories to skip during validation
 */
const WORKTREES_DIR = '.worktrees';
const COMMON_SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SKIP_DIRS_WITH_HUSKY = new Set([...COMMON_SKIP_DIRS, '.husky', WORKTREES_DIR]);

interface ValidationError {
  type: 'forbidden-directory' | 'large-file' | 'structural-violation';
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

const errors: ValidationError[] = [];

/**
 * Helper: Walk directory tree recursively, calling handler for each entry
 */
async function walkDirectory(
  dir: string,
  relativePath: string,
  options: {
    skipDirs?: Set<string>;
    onDirectory?: (entry: { name: string; fullPath: string; relPath: string }) => Promise<void>;
    onFile?: (entry: { name: string; fullPath: string; relPath: string }) => Promise<void>;
  },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist or not accessible
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = join(relativePath, entry.name);

    if (entry.isDirectory()) {
      // Check if we should skip this directory
      if (options.skipDirs?.has(entry.name)) {
        continue;
      }

      // Call directory handler
      if (options.onDirectory) {
        await options.onDirectory({ name: entry.name, fullPath, relPath });
      }

      // Recurse into subdirectory
      await walkDirectory(fullPath, relPath, options);
    } else if (entry.isFile()) {
      // Call file handler
      if (options.onFile) {
        await options.onFile({ name: entry.name, fullPath, relPath });
      }
    }
  }
}

/**
 * Helper: Apply checker function to all package test/fixtures directories
 */
async function forEachPackageFixturesDir(
  checkDirectory: (dir: string, relativePath: string) => Promise<void>,
): Promise<void> {
  const packagesDir = join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fixturesDir = join(packagesDir, entry.name, 'test', 'fixtures');
      await checkDirectory(fixturesDir, `packages/${entry.name}/test/fixtures`);
    }
  }
}

/**
 * Rule 1: No /examples directories in runtime-* packages
 * Demos should be in vat-example-cat-agents/examples/
 */
async function validateNoRuntimeExamples(): Promise<void> {
  const packagesDir = join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    // Check runtime-* packages for /examples
    if (entry.name.startsWith('runtime-')) {
      const examplesDir = join(packagesDir, entry.name, 'examples');
      if (existsSync(examplesDir)) {
        errors.push({
          type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
          path: `packages/${entry.name}/examples/`,
          message: `Runtime packages should not have /examples directories. Move demos to vat-example-cat-agents/examples/`,
          severity: 'error',
        });
      }
    }
  }
}

/**
 * Rule 2: Only specific packages can have /scripts
 * Prevents utility sprawl across packages
 * Allowed: dev-tools (repo utilities), agent-schema (schema generation)
 */
async function validateScriptsLocation(): Promise<void> {
  const packagesDir = join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });

  const allowedScriptsPackages = new Set(['dev-tools', 'agent-schema']);

  for (const entry of entries) {
    if (!entry.isDirectory() || allowedScriptsPackages.has(entry.name)) {
      continue;
    }

    const scriptsDir = join(packagesDir, entry.name, 'scripts');
    if (existsSync(scriptsDir)) {
      errors.push({
        type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
        path: `packages/${entry.name}/scripts/`,
        message: `Only dev-tools and vat-example-cat-agents should have /scripts directories. Move utilities to dev-tools package.`,
        severity: 'error',
      });
    }
  }
}

/**
 * Rule 3: No large test fixtures (>100KB) unless compressed
 * Prevents repo bloat from test data
 */
async function validateTestFixtureSizes(): Promise<void> {
  const MAX_SIZE_KB = 100;
  const ALLOWED_LARGE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.tar.gz']);

  async function checkFixturesDir(dir: string, relativePath: string): Promise<void> {
    await walkDirectory(dir, relativePath, {
      onFile: async ({ name, fullPath, relPath }) => {
        const stats = await stat(fullPath);
        const sizeKB = stats.size / 1024;

        if (sizeKB > MAX_SIZE_KB) {
          const ext = name.substring(name.lastIndexOf('.'));
          const isCompressed = ALLOWED_LARGE_EXTENSIONS.has(ext.toLowerCase());

          if (!isCompressed) {
            errors.push({
              type: ERROR_TYPES.LARGE_FILE,
              path: relPath,
              message: `File is ${Math.round(sizeKB)}KB (>${MAX_SIZE_KB}KB). Compress large test fixtures or use external storage.`,
              severity: 'warning',
            });
          }
        }
      },
    });
  }

  await forEachPackageFixturesDir(checkFixturesDir);
}

/**
 * Rule 4: No shell scripts (.sh, .ps1, .bat, .cmd)
 * All automation must be TypeScript for cross-platform compatibility
 */
async function validateNoShellScripts(): Promise<void> {
  const FORBIDDEN_EXTENSIONS = new Set(['.sh', '.ps1', '.bat', '.cmd']);
  const skipDirs = SKIP_DIRS_WITH_HUSKY;

  await walkDirectory(REPO_ROOT, '.', {
    skipDirs,
    onFile: async ({ name, relPath }) => {
      const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        errors.push({
          type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
          path: relPath,
          message: `Shell scripts are forbidden. Use TypeScript for cross-platform automation (packages/dev-tools/src/).`,
          severity: 'error',
        });
      }
    },
  });
}

/**
 * Rule 5: No /staging directories in test/fixtures
 * Staging directories should be temporary and not committed
 */
async function validateNoStagingDirectories(): Promise<void> {
  async function checkFixturesDir(dir: string, relativePath: string): Promise<void> {
    await walkDirectory(dir, relativePath, {
      onDirectory: async ({ name, relPath }) => {
        if (name === 'staging') {
          errors.push({
            type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
            path: relPath,
            message: `Staging directories should not be committed. Add to .gitignore and remove from git.`,
            severity: 'error',
          });
        }
      },
    });
  }

  await forEachPackageFixturesDir(checkFixturesDir);
}

/**
 * Rule 6: No nested package.json files (except in packages/)
 * Prevents AI creating sub-packages or component-level package.json files
 */
async function validateNoNestedPackageJson(): Promise<void> {
  const skipDirs = new Set([...COMMON_SKIP_DIRS, WORKTREES_DIR]);

  await walkDirectory(REPO_ROOT, '.', {
    skipDirs,
    onFile: async ({ name, relPath }) => {
      if (name === 'package.json') {
        // Normalize path separators
        const normalizedPath = relPath.replaceAll('\\', '/');

        // Check if it's in a valid location
        const isRootPackageJson = normalizedPath === 'package.json';
        const isInPackagesDir = /^packages\/[^/]+\/package\.json$/.test(normalizedPath);

        if (!isRootPackageJson && !isInPackagesDir) {
          errors.push({
            type: ERROR_TYPES.FORBIDDEN_DIRECTORY,
            path: relPath,
            message: `Nested package.json detected. Only root and packages/*/ can have package.json files.`,
            severity: 'error',
          });
        }
      }
    },
  });
}

/**
 * Rule 7: Source files must be in src/ or test/ directories
 * Prevents .ts files in wrong locations
 */
async function validateSourceFileLocations(): Promise<void> {
  const skipDirs = new Set(['node_modules', 'dist', '.git', '.husky', '.worktrees']);

  const ALLOWED_ROOT_TS_FILES = new Set([
    // Root config files
    'eslint.config.ts',
    'vitest.config.ts',
    'vitest.integration.config.ts',
    'vitest.system.config.ts',
    'vitest.workspace.ts',
  ]);

  await walkDirectory(REPO_ROOT, '.', {
    skipDirs,
    onFile: async ({ name, relPath }) => {
      if (!name.endsWith('.ts')) {
        return;
      }

      const normalizedPath = relPath.replaceAll('\\', '/');

      // Allow root config files
      if (ALLOWED_ROOT_TS_FILES.has(normalizedPath)) {
        return;
      }

      // Allow package-level vitest config files
      if (/^packages\/[^/]+\/vitest\.(config|integration\.config|system\.config)\.ts$/.test(normalizedPath)) {
        return;
      }

      // Allow agent-schema/scripts (build tooling for JSON Schema generation)
      if (/^packages\/agent-schema\/scripts\//.test(normalizedPath)) {
        return;
      }

      // Check if in valid location
      const isInPackageSrc = /^packages\/[^/]+\/src\//.test(normalizedPath);
      const isInPackageTest = /^packages\/[^/]+\/test\//.test(normalizedPath);
      const isInPackageExamples = /^packages\/[^/]+\/examples\//.test(normalizedPath);
      const isInPackageAgents = /^packages\/[^/]+\/agents\//.test(normalizedPath); // For vat-development-agents
      const isInDocs = /^docs\//.test(normalizedPath);

      if (!isInPackageSrc && !isInPackageTest && !isInPackageExamples && !isInPackageAgents && !isInDocs) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `TypeScript file in wrong location. Source files must be in packages/*/src/, packages/*/test/, or packages/*/examples/.`,
          severity: 'error',
        });
      }
    },
  });
}

/**
 * Rule 8: Test file naming conventions
 * Enforces consistent test patterns across the codebase
 */
async function validateTestFileNaming(): Promise<void> {
  await walkDirectory(REPO_ROOT, '.', {
    skipDirs: COMMON_SKIP_DIRS,
    onFile: async ({ name, relPath }) => {
      const normalizedPath = relPath.replaceAll('\\', '/');

      // Check for .spec.ts files (we use .test.ts)
      if (name.endsWith('.spec.ts')) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `Use .test.ts instead of .spec.ts for consistency.`,
          severity: 'error',
        });
      }

      // Check that integration tests are in test/integration/
      if (name.endsWith('.integration.test.ts') && !normalizedPath.includes('/test/integration/')) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `Integration tests must be in test/integration/ directory.`,
          severity: 'error',
        });
      }

      // Check that system tests are in test/system/
      if (name.endsWith('.system.test.ts') && !normalizedPath.includes('/test/system/')) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `System tests must be in test/system/ directory.`,
          severity: 'error',
        });
      }

      // Check that regular test files are NOT in integration/ or system/
      if (
        name.endsWith('.test.ts') &&
        !name.endsWith('.integration.test.ts') &&
        !name.endsWith('.system.test.ts') &&
        (normalizedPath.includes('/test/integration/') || normalizedPath.includes('/test/system/'))
      ) {
        errors.push({
          type: ERROR_TYPES.STRUCTURAL_VIOLATION,
          path: relPath,
          message: `Unit tests in integration/system directories must use .integration.test.ts or .system.test.ts suffix.`,
          severity: 'error',
        });
      }
    },
  });
}

/**
 * Print validation results
 */
function printResults(): void {
  if (errors.length === 0) {
    console.log('✅ Repository structure validation passed!');
    return;
  }

  const errorCount = errors.filter((e) => e.severity === 'error').length;
  const warningCount = errors.filter((e) => e.severity === 'warning').length;

  console.log(`\n❌ Repository structure validation failed:`);
  console.log(`   ${errorCount} errors, ${warningCount} warnings\n`);

  // Group by type
  const byType = errors.reduce(
    (acc, error) => {
      const list = (acc[error.type] ??= []);
      list.push(error);
      return acc;
    },
    {} as Record<string, ValidationError[]>,
  );

  for (const [type, typeErrors] of Object.entries(byType)) {
    console.log(`\n${type.toUpperCase().replaceAll('-', ' ')}:`);
    for (const error of typeErrors) {
      const icon = error.severity === 'error' ? '❌' : '⚠️';
      console.log(`  ${icon} ${error.path}`);
      console.log(`     ${error.message}\n`);
    }
  }
}

/**
 * Main validation function
 */
async function validate(): Promise<void> {
  console.log('🔍 Validating repository structure...\n');

  // NOTE: Secret file protection is handled by .gitignore + vibe-validate pre-commit hooks
  // which scan for secrets anywhere in code content

  // High Priority - File Location Sprawl
  await validateNoNestedPackageJson();
  await validateSourceFileLocations();
  await validateTestFileNaming();

  // Original Rules
  await validateNoRuntimeExamples();
  await validateScriptsLocation();
  await validateNoShellScripts();
  await validateNoStagingDirectories();
  await validateTestFixtureSizes();

  printResults();

  // Exit with error code if there are errors (not warnings)
  const hasErrors = errors.some((e) => e.severity === 'error');
  if (hasErrors) {
    process.exit(1);
  }
}

// Run validation
if (import.meta.main) {
  try {
    await validate();
  } catch (error) {
    console.error('Validation script failed:', error);
    process.exit(2);
  }
}

export { validate, type ValidationError };

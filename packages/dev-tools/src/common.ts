/**
 * Common utilities for tools/ scripts
 *
 * Shared code to eliminate duplication across tool scripts.
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT constant (controlled, not user input)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { normalizePath } from '@vibe-agent-toolkit/utils/fs';
import { safeExecResult } from '@vibe-agent-toolkit/utils/process';

export { safeExecSync, safeExecResult } from '@vibe-agent-toolkit/utils/process';


/**
 * JSCPD (Code Duplication Detection) Configuration
 *
 * Shared configuration for jscpd-check-new.ts and jscpd-update-baseline.ts
 * to ensure consistent duplication detection settings.
 */
export const JSCPD_CONFIG = {
  /** Minimum lines for duplication detection */
  MIN_LINES: '5',
  /** Minimum tokens for duplication detection */
  MIN_TOKENS: '50',
  /** File formats to check */
  FORMATS: 'typescript,javascript',
  /** Patterns to ignore (node_modules, dist, coverage, reports, config files, worktrees, test-fixtures, generated) */
  IGNORE_PATTERNS: '**/node_modules/**,**/dist/**,**/coverage/**,**/jscpd-report/**,**/.worktrees/**,**/.claude/worktrees/**,**/test-fixtures/**,**/generated/**,**/*.json,**/*.yaml,**/*.md',
  /** Output directory for jscpd reports */
  OUTPUT_DIR: 'jscpd-report',
} as const;

/**
 * Build jscpd command arguments array from configuration
 */
export function buildJscpdArgs(outputDir?: string): string[] {
  return [
    '.',
    '--min-lines', JSCPD_CONFIG.MIN_LINES,
    '--min-tokens', JSCPD_CONFIG.MIN_TOKENS,
    '--reporters', 'json',
    '--format', JSCPD_CONFIG.FORMATS,
    '--ignore', JSCPD_CONFIG.IGNORE_PATTERNS,
    '--output', outputDir ?? JSCPD_CONFIG.OUTPUT_DIR,
  ];
}

/**
 * Get __filename equivalent in ESM
 */
export function getFilename(importMetaUrl: string): string {
  return fileURLToPath(importMetaUrl);
}

/**
 * Get __dirname equivalent in ESM
 */
export function getDirname(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

/**
 * Was this module invoked as the process entrypoint, rather than imported?
 *
 * ⛔ **Do not reach for `import.meta.main` here.** It shipped in Node 24.2 and
 * 22.18; this repo declares a floor of `>=22.13.0`, and on a real 22.13.0 the
 * property is `undefined`:
 *
 * ```
 * $ node-v22.13.0 --input-type=module -e "console.log(import.meta.main)"  -> undefined
 * ```
 *
 * That is not a cosmetic gap. Every `if (import.meta.main)` guard in this
 * package was silently dead on the declared floor — running
 * `validate-repo-structure.ts` under 22.13.0 printed nothing and exited 0, so a
 * contributor sitting exactly on the supported Node got a green pre-commit
 * structure gate that had run no rule at all. Raising the floor to 22.18 would
 * have hidden the defect behind the number instead of fixing it.
 *
 * `process.argv[1]` is defined on every Node this repo supports, so the
 * comparison below is the portable form of the same question. The realpath pass
 * covers the case where the script is reached through a symlink (a
 * `node_modules/.bin` shim) on one side of the comparison but not the other.
 *
 * @param importMetaUrl - The calling module's `import.meta.url`
 * @param entryPath - The invoked script path; defaults to `process.argv[1]`
 * @returns `true` only when this module is the script Node was asked to run
 */
export function isEntrypoint(
  importMetaUrl: string,
  entryPath: string | undefined = process.argv[1],
): boolean {
  // An empty argv[1] would resolve to the cwd and could then match a module by
  // accident; `undefined` happens under `node -e`. Neither is an entrypoint.
  if (entryPath === undefined || entryPath === '') return false;

  const modulePath = safePath.resolve(getFilename(importMetaUrl));
  const invokedPath = safePath.resolve(entryPath);
  if (modulePath === invokedPath) return true;

  // `normalizePath` resolves symlinks and Windows 8.3 short names, and returns
  // the path unchanged when it cannot — which is the right answer here, since
  // the string comparison above has already decided the two differ and an
  // unresolvable path carries no symlink information to compare.
  return toForwardSlash(normalizePath(modulePath)) === toForwardSlash(normalizePath(invokedPath));
}

/**
 * Project root directory (../../.. from packages/dev-tools/src/)
 */
export const PROJECT_ROOT = safePath.join(getDirname(import.meta.url), '../../..');

/**
 * ANSI color codes for terminal output
 */
export const colors = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  reset: '\x1b[0m',
} as const;

export type Color = keyof typeof colors;

/**
 * Log a message with optional color
 */
export function log(message: string, color: Color = 'reset'): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Get the version of a package for a specific npm dist-tag
 */
export function getNpmTagVersion(packageName: string, tag: string): string | null {
  const result = safeExecResult('npm', ['view', `${packageName}@${tag}`, 'version'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.success && result.stdout) {
    return result.stdout.toString().trim();
  }

  return null;
}

/**
 * Result from processing a workspace package
 */
export interface PackageProcessResult {
  name: string;
  skipped: boolean;
  reason?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Format skip reason text consistently
 */
function formatSkipReason(reason: string, version?: string): string {
  if (reason === 'no-version') {
    return 'no version field';
  }
  return version ? `${reason}, v${version}` : reason;
}

// Type-only aliases for callback signatures
type ProcessorFn<T> = (pkgPath: string, pkgName: string) => T;
type SuccessHandler<T> = (result: T) => void;
type SkipHandler<T> = (result: T) => void;
type ErrorHandler = (pkgName: string, error: Error) => void;

/**
 * Process all workspace packages with a custom processor function
 */
export function processWorkspacePackages<T extends PackageProcessResult>(
  processor: ProcessorFn<T>,
  onSuccess: SuccessHandler<T>,
  onSkip: SkipHandler<T>,
  onError?: ErrorHandler
): { processed: number; skipped: number } {
  const packagesDir = safePath.join(PROJECT_ROOT, 'packages');
  let processedCount = 0;
  let skippedCount = 0;

  try {
    const packages = readdirSync(packagesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      // Security: Filter out path traversal attempts and invalid names
      .filter(name => !name.includes('..') && !name.includes('/') && !name.includes('\\') && name.length > 0)
      .sort((a, b) => a.localeCompare(b));

    for (const pkg of packages) {
      const pkgPath = safePath.join(packagesDir, pkg, 'package.json');
      try {
        const result = processor(pkgPath, pkg);

        if (result.skipped) {
          const reasonText = formatSkipReason(result.reason ?? 'unknown', result.version);
          log(`  - ${result.name}: skipped (${reasonText})`, 'yellow');
          onSkip(result);
          skippedCount++;
        } else {
          onSuccess(result);
          processedCount++;
        }
      } catch (error) {
        if (onError) {
          onError(pkg, error as Error);
        } else {
          log(`  ✗ ${pkg}: ${(error as Error).message}`, 'red');
          process.exit(1);
        }
      }
    }
  } catch (error) {
    log(`✗ Failed to read packages directory: ${(error as Error).message}`, 'red');
    process.exit(1);
  }

  return { processed: processedCount, skipped: skippedCount };
}

/**
 * Find all publishable packages in the monorepo
 *
 * @param packagesDir - Path to packages/ directory
 * @param options - Configuration options
 * @param options.skipUmbrellaPackage - Skip the umbrella package (vibe-agent-toolkit) for npm link
 * @returns Array of package information
 */
export function findPublishablePackages(
  packagesDir: string,
  options: { skipUmbrellaPackage?: boolean } = {}
): Array<{ name: string; path: string; packageJson: Record<string, unknown> }> {
  const packages: Array<{ name: string; path: string; packageJson: Record<string, unknown> }> = [];

  if (!existsSync(packagesDir)) {
    return packages;
  }

  const entries = readdirSync(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packagePath = safePath.join(packagesDir, entry.name);
    const packageJsonPath = safePath.join(packagePath, 'package.json');

    if (!existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;

      // Skip private packages (not published to npm)
      if (packageJson['private'] === true) {
        continue;
      }

      // Skip umbrella package if requested (for npm link, to avoid bin conflicts)
      if (options.skipUmbrellaPackage && packageJson['name'] === 'vibe-agent-toolkit') {
        continue;
      }

      packages.push({
        name: packageJson['name'] as string,
        path: packagePath,
        packageJson,
      });
    } catch {
      // Skip packages with invalid package.json
      continue;
    }
  }

  return packages;
}

type PackageInfo = { name: string; path: string; packageJson: Record<string, unknown> };

/**
 * Sort packages in topological order: leaf packages (no workspace deps) first,
 * then packages that depend on them.
 *
 * This matters for `npm link` because npm's arborist resolves the full dependency
 * tree during link. If a package has workspace:* deps on packages that aren't yet
 * globally linked, arborist can crash with "Cannot read properties of null".
 */
function topologicalSort(packages: PackageInfo[]): PackageInfo[] {
  const packageNames = new Set(packages.map(p => p.name));

  function countWorkspaceDeps(pkg: PackageInfo): number {
    const deps = pkg.packageJson['dependencies'] as Record<string, string> | undefined;
    if (!deps) return 0;
    return Object.entries(deps).filter(
      ([name, version]) => packageNames.has(name) && typeof version === 'string' && version.startsWith('workspace:')
    ).length;
  }

  return [...packages].sort((a, b) => countWorkspaceDeps(a) - countWorkspaceDeps(b));
}

/** Run handler on each package with a settle delay between operations */
function runPackageBatch(
  packages: PackageInfo[],
  handler: (name: string, path: string) => boolean,
  settleDelayMs: number,
): { processed: number; failed: PackageInfo[] } {
  let processed = 0;
  const failed: PackageInfo[] = [];

  for (const pkg of packages) {
    if (handler(pkg.name, pkg.path)) {
      processed++;
    } else {
      failed.push(pkg);
    }
    // Let npm's global state settle before the next link/unlink
    if (settleDelayMs > 0) {
      const start = Date.now();
      while (Date.now() - start < settleDelayMs) { /* settle */ }
    }
  }

  return { processed, failed };
}

/**
 * Process packages with a given action (link or unlink)
 *
 * @param options - Configuration for processing packages
 * @returns Exit code (0 = success, 1 = failure)
 */
export function processPackages(options: {
  action: 'link' | 'unlink';
  actionVerb: string; // "Linked" or "Unlinked"
  introMessage: string;
  successMessage: string;
  packageHandler: (name: string, path: string) => boolean;
  /** Milliseconds to wait between each package operation (default: 100) */
  settleDelayMs?: number;
}): number {
  const { actionVerb, introMessage, successMessage, packageHandler, settleDelayMs = 100 } = options;

  console.log(introMessage);

  // Find repo root (2 levels up from dev-tools/dist)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = safePath.join(__dirname, '../../..');
  const packagesDir = safePath.join(repoRoot, 'packages');

  // Find all publishable packages (skip umbrella package to avoid bin conflicts)
  const packages = findPublishablePackages(packagesDir, { skipUmbrellaPackage: true });

  if (packages.length === 0) {
    console.log('⚠️  No publishable packages found');
    return 0;
  }

  // Sort: leaf packages first so their global links exist before dependents need them
  const sorted = topologicalSort(packages);

  console.log(`Found ${sorted.length} publishable package(s)\n`);

  const first = runPackageBatch(sorted, packageHandler, settleDelayMs);
  let { processed } = first;

  // Retry failed packages once - ordering/timing issues often resolve on second pass
  // because all leaf dependencies have been linked by now.
  if (first.failed.length > 0) {
    console.log(`\n🔄 Retrying ${first.failed.length} failed package(s)...\n`);
    const retry = runPackageBatch(first.failed, packageHandler, settleDelayMs);
    processed += retry.processed;
    first.failed.length = 0;
    first.failed.push(...retry.failed);
  }

  const failed = first.failed.length;

  console.log('\n' + '='.repeat(60));
  console.log(`✅ ${actionVerb}: ${processed} package(s)`);
  if (failed > 0) {
    console.log(`❌ Failed: ${failed} package(s)`);
  }
  console.log('='.repeat(60));

  if (failed === 0) {
    console.log(successMessage);
    return 0;
  }

  return 1;
}

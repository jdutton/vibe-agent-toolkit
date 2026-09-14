/**
 * Common utilities for tools/ scripts
 *
 * Shared code to eliminate duplication across tool scripts.
 */

// File paths derived from PROJECT_ROOT constant (controlled, not user input)

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { direntKindFollowingSync, isPathAbsentError, isSingleFsSegment, safePath } from '@vibe-agent-toolkit/utils';
import { CommandExecutionError, safeExecResult, safeExecSync } from '@vibe-agent-toolkit/utils/process';

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
/** The parts of `jscpd-report.json` the scripts here read. */
export interface JscpdReport<TClone = unknown> {
  duplicates?: TClone[];
  statistics: { total: { percentage: number; duplicatedLines: number; totalLines: number } };
}

/**
 * Run jscpd with the shared arguments and return the JSON report it wrote.
 *
 * jscpd exits non-zero when it finds duplication, and that is the normal case
 * for a tool that reads its report — so the exit code is not the verdict, the
 * report file is. The previous report is deleted BEFORE the run: a jscpd that
 * crashed (or was never installed) would otherwise leave last time's report in
 * place to be read as this time's, and a baseline update over a stale report
 * silently accepts whatever was added since.
 *
 * @param args - The jscpd argument list (see {@link buildJscpdArgs})
 * @returns The parsed `jscpd-report.json`
 * @throws {Error} when jscpd is not installed, or wrote no report
 */
export function runJscpd<TClone = unknown>(args: string[]): JscpdReport<TClone> {
  const reportPath = safePath.join(JSCPD_CONFIG.OUTPUT_DIR, 'jscpd-report.json');
  rmSync(reportPath, { force: true });

  try {
    safeExecSync('npx', ['jscpd', ...args], { encoding: 'utf-8', stdio: 'pipe' });
  } catch (error) {
    // Verify it's the expected failure (not a critical error like ENOENT)
    if (isPathAbsentError(error)) {
      throw new Error('jscpd executable not found. Install with: npm install -g jscpd', { cause: error });
    }
    // Otherwise continue - duplications found, but report still generated below.
    // Surface jscpd's own stdout/stderr so a genuine crash (as opposed to the
    // expected "duplications found" non-zero exit) is diagnosable from CI logs
    // instead of only showing up as "report not found" further down.
    if (error instanceof CommandExecutionError) {
      const stdout = error.stdout.toString().trim();
      const stderr = error.stderr.toString().trim();
      if (stdout) console.error(`jscpd stdout:\n${stdout}`);
      if (stderr) console.error(`jscpd stderr:\n${stderr}`);
    } else if (error instanceof Error) {
      console.error(`jscpd invocation error: ${error.message}`);
    }
  }

  if (!existsSync(reportPath)) {
    throw new Error(`jscpd report not found at ${reportPath}`);
  }

  return JSON.parse(readFileSync(reportPath, 'utf-8')) as JscpdReport<TClone>;
}

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
 * Re-exported, not implemented here. It moved to `@vibe-agent-toolkit/utils` so
 * the seven guards outside this package — `packages/cli`'s build-time help
 * validator and `packages/lab`'s bin among them — can reach the SAME answer:
 * `dev-tools` is `private: true`, so a published package importing it would
 * ship a dependency npm cannot install. See that module for why neither
 * `import.meta.main` nor a raw `pathToFileURL` compare is an acceptable
 * spelling of this question.
 */
export { isEntrypoint } from '@vibe-agent-toolkit/utils/process';

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
      // Followed: a workspace package reached through a link is still a package.
      .filter(dirent => direntKindFollowingSync(packagesDir, dirent) === 'directory')
      .map(dirent => dirent.name)
      // A readdir name is one segment by construction; the guard states it.
      .filter(name => isSingleFsSegment(name))
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
          process.exit(ExitCode.ERROR);
        }
      }
    }
  } catch (error) {
    log(`✗ Failed to read packages directory: ${(error as Error).message}`, 'red');
    process.exit(ExitCode.ERROR);
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
    if (direntKindFollowingSync(packagesDir, entry) !== 'directory') {
      continue;
    }

    const packagePath = safePath.join(packagesDir, entry.name);
    const packageJsonPath = safePath.join(packagePath, 'package.json');

    if (!existsSync(packageJsonPath)) {
      continue;
    }

    // No try here, deliberately: a `packages/*/package.json` that exists but
    // cannot be read or is not JSON is a broken checkout, and a tool that
    // quietly drops that package from the list would link, publish, or bump
    // everything except the one that is wrong.
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

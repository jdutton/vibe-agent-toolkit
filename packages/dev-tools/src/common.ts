/**
 * Common utilities for tools/ scripts
 *
 * Shared code to eliminate duplication across tool scripts.
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT constant (controlled, not user input)

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import which from 'which';

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
  /** Patterns to ignore (node_modules, dist, coverage, reports, config files) */
  IGNORE_PATTERNS: '**/node_modules/**,**/dist/**,**/coverage/**,**/jscpd-report/**,**/*.json,**/*.yaml,**/*.md',
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
 * Project root directory (../../.. from packages/dev-tools/src/)
 */
export const PROJECT_ROOT = join(getDirname(import.meta.url), '../../..');

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
 * Safe command execution for tools using which pattern
 * Resolves command path first, then executes with shell: false for security
 * Returns Buffer by default, or string if encoding is specified
 */
// eslint-disable-next-line sonarjs/function-return-type -- Returns Buffer or string based on encoding option
export function safeExecSync(
  command: string,
  args: string[] = [],
  options: {
    encoding?: BufferEncoding;
    stdio?: 'pipe' | 'ignore' | 'inherit';
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Buffer | string {
  // Resolve command path using which (avoids PATH security issues)
  const commandPath = which.sync(command);

  const result = spawnSync(commandPath, args, {
    ...options,
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}: ${command} ${args.join(' ')}\n${result.stderr?.toString() ?? ''}`
    );
  }

  return result.stdout;
}

/**
 * Safe command execution that returns result instead of throwing
 * Uses which pattern for security
 */
export function safeExecResult(
  command: string,
  args: string[] = [],
  options: {
    encoding?: BufferEncoding;
    stdio?: 'pipe' | 'ignore';
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): { success: boolean; stdout: string; stderr: string; status: number } {
  // Resolve command path using which
  const commandPath = which.sync(command);

  const result = spawnSync(commandPath, args, {
    ...options,
    shell: false,
  });

  return {
    success: result.status === 0,
    stdout: result.stdout?.toString() || '',
    stderr: result.stderr?.toString() || '',
    status: result.status ?? -1,
  };
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
    return result.stdout.trim();
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
  const packagesDir = join(PROJECT_ROOT, 'packages');
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
      const pkgPath = join(packagesDir, pkg, 'package.json');
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

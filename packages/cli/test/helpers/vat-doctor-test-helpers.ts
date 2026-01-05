/**
 * VAT Doctor Command Test Helpers
 *
 * Test utilities for doctor command tests.
 * Prevents duplication across test cases.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { vi, expect } from 'vitest';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Environment mock configuration
 */
export interface DoctorEnvironmentConfig {
  /** Node.js version string (default: 'v22.0.0') */
  nodeVersion?: string | null;
  /** Git version string (default: 'git version 2.43.0') */
  gitVersion?: string | null;
  /** vat npm version (default: '0.1.0') */
  vatVersion?: string | null;
}

/**
 * File system mock configuration
 */
export interface DoctorFileSystemConfig {
  /** Package.json version (default: '0.1.0') */
  packageVersion?: string;
  /** Whether config file exists (default: true) */
  configExists?: boolean;
  /** Config file content (default: valid YAML) */
  configContent?: string;
  /** Whether in VAT source tree (default: false) */
  isVatSourceTree?: boolean;
}

/**
 * Config mock configuration
 */
export interface DoctorConfigMockConfig {
  /** Whether config is valid (default: true) */
  valid?: boolean;
  /** Configuration object */
  config?: unknown;
  /** Validation errors (if valid=false) */
  errors?: string[];
}

/**
 * Doctor check result structure
 */
export interface DoctorCheckResult {
  /** Name of the check */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Message describing the result */
  message: string;
  /** Optional suggestion for fixing the issue */
  suggestion?: string;
}

/**
 * Doctor result with checks array
 */
export interface DoctorResult {
  /** Array of check results */
  checks: DoctorCheckResult[];
}

// ============================================================================
// Mock Functions (Placeholders)
// ============================================================================

/**
 * Setup environment mocks for doctor tests
 *
 * Mocks execSync calls for version checks and system commands.
 *
 * @example
 * ```typescript
 * // Healthy environment
 * await mockDoctorEnvironment();
 *
 * // Old Node version
 * await mockDoctorEnvironment({ nodeVersion: 'v18.0.0' });
 *
 * // Missing git
 * await mockDoctorEnvironment({ gitVersion: null });
 * ```
 */
export async function mockDoctorEnvironment(
  config?: DoctorEnvironmentConfig,
): Promise<() => void> {
  const opts = {
    nodeVersion: 'v22.0.0',
    gitVersion: 'git version 2.43.0',
    vatVersion: '0.1.0',
    ...config,
  };

  // Cast to vi.Mock type (mocked modules return Mock types)
  (execSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string): Buffer => {
    const cmdStr = cmd.toString();

    if (cmdStr.includes('npm view vibe-agent-toolkit version')) {
      return Buffer.from(opts.vatVersion ?? '');
    }
    if (cmdStr.includes('node --version')) {
      if (opts.nodeVersion === null) throw new Error('node not found');
      return Buffer.from(opts.nodeVersion);
    }
    if (cmdStr.includes('git --version')) {
      if (opts.gitVersion === null) throw new Error('git not found');
      return Buffer.from(opts.gitVersion);
    }

    return Buffer.from('');
  });

  // Also mock getToolVersion from utils
  const { getToolVersion } = await import('@vibe-agent-toolkit/utils');
  (getToolVersion as ReturnType<typeof vi.fn>).mockImplementation((toolName: string) => {
    if (toolName === 'node') return opts.nodeVersion;
    if (toolName === 'git') return opts.gitVersion;
    return null;
  });

  return () => {
    vi.restoreAllMocks();
  };
}

/**
 * Setup file system mocks for doctor tests
 *
 * Mocks readFileSync and existsSync for common files.
 *
 * @example
 * ```typescript
 * // Healthy file system
 * await mockDoctorFileSystem();
 *
 * // Missing config
 * await mockDoctorFileSystem({ configExists: false });
 *
 * // In VAT source tree
 * await mockDoctorFileSystem({ isVatSourceTree: true });
 * ```
 */
export async function mockDoctorFileSystem(
  config?: DoctorFileSystemConfig,
): Promise<() => void> {
  const opts = {
    packageVersion: '0.1.0',
    configExists: true,
    configContent: 'version: "1.0"\nagents: {}\n',
    isVatSourceTree: false,
    ...config,
  };

  const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string | Buffer | URL): string => {
    const pathStr = path.toString();

    // package.json
    if (pathStr.includes('package.json')) {
      const isCliPackage = pathStr.includes('packages/cli/package.json');
      const name = isCliPackage
        ? '@vibe-agent-toolkit/cli'
        : 'vibe-agent-toolkit';
      return JSON.stringify({
        name,
        version: opts.packageVersion,
      });
    }

    // Config file
    if (pathStr.includes(CONFIG_FILENAME)) {
      return opts.configContent;
    }

    return '';
  });

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: string | Buffer | URL): boolean => {
    // Normalize path separators for cross-platform compatibility (Windows uses backslashes)
    const pathStr = path.toString().replaceAll('\\', '/');

    if (pathStr.includes(CONFIG_FILENAME)) {
      return opts.configExists;
    }

    if (pathStr.includes('packages/cli/package.json')) {
      return opts.isVatSourceTree;
    }

    // Assume git repo exists and other files exist by default
    return true;
  });

  // Mock findConfigPath
  const { findConfigPath } = await import('../../src/utils/config-loader.js');
  (findConfigPath as ReturnType<typeof vi.fn>).mockReturnValue(
    opts.configExists ? CONFIG_FILENAME : null,
  );

  return () => {
    vi.restoreAllMocks();
  };
}

/**
 * Setup config mocks for doctor tests
 */
export async function mockDoctorConfig(
  config?: DoctorConfigMockConfig,
): Promise<() => void> {
  const opts = {
    valid: true,
    config: { version: '1.0', agents: {} },
    errors: [],
    ...config,
  };

  const { loadConfig } = await import('../../src/utils/config-loader.js');

  if (opts.valid) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock config can be any shape
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue(opts.config as any);
  } else {
    (loadConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error(opts.errors.join(', ') || 'Invalid config');
    });
  }

  return () => {
    vi.restoreAllMocks();
  };
}

// ============================================================================
// Assertion Helpers
// ============================================================================

const SUGGESTION_FIELD = 'suggestion';

/**
 * Find a specific doctor check result
 *
 * Supports both individual DoctorCheckResult (for unit tests) and DoctorResult (for integration tests)
 */
export function findCheck(
  result: DoctorResult | DoctorCheckResult,
  checkName: string,
): DoctorCheckResult {
  // If result is already a DoctorCheckResult, verify name matches and return it
  if ('name' in result && 'passed' in result && 'message' in result) {
    if (result.name !== checkName) {
      throw new Error(
        `Check name mismatch: expected "${checkName}" but got "${result.name}"`,
      );
    }
    return result;
  }

  // Otherwise it's a DoctorResult with checks array
  const check = result.checks.find((c) => c.name === checkName);
  if (!check) {
    const available = result.checks.map((c) => c.name).join(', ');
    throw new Error(
      `Check "${checkName}" not found. Available: ${available}`,
    );
  }
  return check;
}

/**
 * Assert check passed with optional message matching
 *
 * Supports both individual DoctorCheckResult (for unit tests) and DoctorResult (for integration tests)
 */
export function assertCheckPassed(
  result: DoctorResult | DoctorCheckResult,
  checkName: string,
  messageContains?: string,
): void {
  const check = findCheck(result, checkName);
  expect(check.passed).toBe(true);
  if (messageContains) {
    expect(check.message).toContain(messageContains);
  }
}

/**
 * Assert check failed with message and suggestion matching
 *
 * Supports both individual DoctorCheckResult (for unit tests) and DoctorResult (for integration tests)
 */
export function assertCheckFailed(
  result: DoctorResult | DoctorCheckResult,
  checkName: string,
  messageContains: string,
  suggestionContains: string,
): void {
  const check = findCheck(result, checkName);
  expect(check.passed).toBe(false);
  expect(check.message).toContain(messageContains);
  expect(check[SUGGESTION_FIELD]).toBeDefined();
  expect(check[SUGGESTION_FIELD]).toContain(suggestionContains);
}

/**
 * Assert check with flexible assertions
 *
 * Supports both individual DoctorCheckResult (for unit tests) and DoctorResult (for integration tests)
 */
export function assertCheck(
  result: DoctorResult | DoctorCheckResult,
  checkName: string,
  assertions: {
    passed: boolean;
    messageContains?: string | string[];
    suggestionContains?: string | string[];
  },
): void {
  const check = findCheck(result, checkName);

  expect(check.passed).toBe(assertions.passed);

  if (assertions.messageContains) {
    const messages = Array.isArray(assertions.messageContains)
      ? assertions.messageContains
      : [assertions.messageContains];
    for (const msg of messages) {
      expect(check.message).toContain(msg);
    }
  }

  if (assertions.suggestionContains) {
    expect(check[SUGGESTION_FIELD]).toBeDefined();
    const suggestions = Array.isArray(assertions.suggestionContains)
      ? assertions.suggestionContains
      : [assertions.suggestionContains];
    for (const sug of suggestions) {
      expect(check[SUGGESTION_FIELD]).toContain(sug);
    }
  }
}

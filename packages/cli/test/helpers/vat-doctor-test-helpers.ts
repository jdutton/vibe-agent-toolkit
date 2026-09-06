/**
 * VAT Doctor Command Test Helpers
 *
 * Test utilities for doctor command tests.
 * Prevents duplication across test cases.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { vi, expect } from 'vitest';

import type { DoctorCheckResult, DoctorOutcome } from '../../src/commands/doctor.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Environment mock configuration
 */
export interface DoctorEnvironmentConfig {
  /** Node.js version string (default: 'v22.13.0', the declared floor) */
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
  /**
   * The `engines.node` range the mocked CLI manifest declares.
   *
   * `null` makes it declare none, which is the packaging-fault branch
   * `checkNodeVersion` reports rather than guessing a floor.
   */
  nodeEngines?: string | null;
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
 * Doctor result with checks array
 *
 * `DoctorCheckResult` / `DoctorOutcome` are imported from the command itself —
 * a second copy here would let the two drift, which is how an outcome the
 * command can emit ends up with no assertion helper that can see it.
 */
export interface DoctorResult {
  /** Array of check results */
  checks: DoctorCheckResult[];
}

// ============================================================================
// Mock Functions (Placeholders)
// ============================================================================

/**
 * `process.version` as this worker really has it, captured before any test can stub it.
 *
 * Captured at module load on purpose: reading it lazily inside the stub helper would let a
 * second call capture the FIRST stub as "pristine", and the real value would be lost for
 * the rest of the worker.
 */
const PRISTINE_VERSION_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  process,
  'version',
) as PropertyDescriptor;

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
    nodeVersion: 'v22.13.0',
    gitVersion: 'git version 2.43.0',
    vatVersion: '0.1.0',
    ...config,
  };

  // Cast to vi.Mock type (mocked modules return Mock types)
  vi.mocked(execSync).mockImplementation((cmd: string): Buffer => {
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

  // Also mock getToolVersion from utils.
  //
  // ⚠️ `checkNodeVersion` deliberately does NOT go through this. It reads
  // `process.version` — the interpreter running VAT — because a spawned `node` is a
  // different question under any version manager or shim. Mocking `getToolVersion` for
  // 'node' was how a real defect stayed invisible: the suite supplied a Node version the
  // check never consulted, so it could not see WHICH Node was being tested. `nodeVersion`
  // now drives `process.version` below, and this entry is kept only for `git`.
  const { getToolVersion } = await import('@vibe-agent-toolkit/utils/process');
  vi.mocked(getToolVersion).mockImplementation((toolName: string) => {
    if (toolName === 'git') return opts.gitVersion;
    return null;
  });

  // `process.version` is a non-writable own property, so it is replaced by definition.
  // The descriptor restored is the one captured at module load, never the one this call
  // is about to overwrite — otherwise a second call would "restore" the first stub and the
  // real version would be gone for the rest of the worker.
  if (opts.nodeVersion !== null) {
    Object.defineProperty(process, 'version', {
      value: opts.nodeVersion,
      configurable: true,
      writable: false,
    });
  }

  return () => {
    restoreProcessVersion();
    vi.restoreAllMocks();
  };
}

/**
 * Put `process.version` back to this worker's real value.
 *
 * Call from `afterEach` in any suite that stubs it. `vi.restoreAllMocks()` does not undo
 * an `Object.defineProperty`, so without this the stub leaks into every later test in the
 * file — including ones that never asked for a Node version and would then be asserting
 * against a fabricated one.
 */
export function restoreProcessVersion(): void {
  Object.defineProperty(process, 'version', PRISTINE_VERSION_DESCRIPTOR);
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
    nodeEngines: '>=22.13.0' as string | null,
    ...config,
  };

  const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

  vi.mocked(readFileSync).mockImplementation((path): string => {
    // Normalize path separators for cross-platform compatibility (Windows uses backslashes)
    const pathStr = path.toString().replaceAll('\\', '/');

    // package.json
    if (pathStr.includes('package.json')) {
      const isCliPackage = pathStr.includes('packages/cli/package.json');
      const name = isCliPackage
        ? '@vibe-agent-toolkit/cli'
        : 'vibe-agent-toolkit';
      /*
       * `engines` is supplied by the fixture, not copied from the real
       * manifest: `checkNodeVersion` derives the floor from whatever the
       * manifest declares, so what these tests own is the COMPARISON, not the
       * number. The real floor is pinned by
       * `packages/utils/test/package-exports.test.ts`. Pass `nodeEngines: null`
       * to drive the manifest-declares-nothing branch.
       */
      return JSON.stringify({
        name,
        version: opts.packageVersion,
        ...(opts.nodeEngines === null ? {} : { engines: { node: opts.nodeEngines } }),
      });
    }

    // Config file
    if (pathStr.includes(CONFIG_FILENAME)) {
      return opts.configContent;
    }

    return '';
  });

  vi.mocked(existsSync).mockImplementation((path): boolean => {
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

  // findConfigFile from @vibe-agent-toolkit/utils walks up the directory tree
  // calling existsSync. The existsSync mock above already returns true for
  // the config filename based on opts.configExists, so no separate mock is
  // needed — the walk will resolve to the cwd-joined CONFIG_FILENAME on the
  // first hit.

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
    vi.mocked(loadConfig).mockReturnValue(opts.config as any);
  } else {
    vi.mocked(loadConfig).mockImplementation(() => {
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
  if ('name' in result && 'outcome' in result && 'message' in result) {
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
  assertOutcome(result, checkName, 'pass', messageContains);
}

/**
 * Assert a check could NOT be determined — distinct from both pass and fail.
 */
export function assertCheckUndetermined(
  result: DoctorResult | DoctorCheckResult,
  checkName: string,
  messageContains?: string,
): void {
  assertOutcome(result, checkName, 'undetermined', messageContains);
}

/**
 * Assert a check did not apply — distinct from "it applied and was fine".
 */
export function assertCheckSkipped(
  result: DoctorResult | DoctorCheckResult,
  checkName: string,
  messageContains?: string,
): void {
  assertOutcome(result, checkName, 'skipped', messageContains);
}

function assertOutcome(
  result: DoctorResult | DoctorCheckResult,
  checkName: string,
  outcome: DoctorOutcome,
  messageContains?: string,
): void {
  const check = findCheck(result, checkName);
  expect(check.outcome).toBe(outcome);
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
  expect(check.outcome).toBe('fail');
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
    outcome: DoctorOutcome;
    messageContains?: string | string[];
    suggestionContains?: string | string[];
  },
): void {
  const check = findCheck(result, checkName);

  expect(check.outcome).toBe(assertions.outcome);

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

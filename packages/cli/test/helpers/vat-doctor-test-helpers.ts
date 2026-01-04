/**
 * VAT Doctor Command Test Helpers
 *
 * Test utilities for doctor command tests.
 * Prevents duplication across test cases.
 */

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

// ============================================================================
// Mock Functions (Placeholders)
// ============================================================================

/**
 * Mock doctor environment (Node.js, Git, npm versions)
 *
 * @param _config - Environment configuration
 * @returns Cleanup function to restore original environment
 */
export async function mockDoctorEnvironment(
  _config?: DoctorEnvironmentConfig,
): Promise<() => void> {
  return () => {};
}

/**
 * Mock doctor file system (package.json, config files)
 *
 * @param _config - File system configuration
 * @returns Cleanup function to restore original file system state
 */
export async function mockDoctorFileSystem(
  _config?: DoctorFileSystemConfig,
): Promise<() => void> {
  return () => {};
}

/**
 * Mock doctor configuration validation
 *
 * @param _config - Config mock configuration
 * @returns Cleanup function to restore original config state
 */
export async function mockDoctorConfig(
  _config?: DoctorConfigMockConfig,
): Promise<() => void> {
  return () => {};
}

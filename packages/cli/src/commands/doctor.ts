/**
 * Doctor Command
 *
 * Diagnoses common issues with vat setup:
 * - Environment checks (Node.js version, git)
 * - Configuration validation
 * - Version checks
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getToolVersion } from '@vibe-agent-toolkit/utils';
import type { Command } from 'commander';
import * as semver from 'semver';

import { findConfigPath, loadConfig } from '../utils/config-loader.js';

/**
 * Result of a single doctor check
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
 * Project context information
 */
export interface ProjectContext {
  /** Current working directory */
  currentDir: string;
  /** Detected project root (null if not found) */
  projectRoot: string | null;
  /** Detected config file path (null if not found) */
  configPath: string | null;
}

/**
 * Overall doctor diagnostic result
 */
export interface DoctorResult {
  /** Whether all checks passed */
  allPassed: boolean;
  /** Individual check results */
  checks: DoctorCheckResult[];
  /** Total number of checks run */
  totalChecks: number;
  /** Number of checks that passed */
  passedChecks: number;
  /** Project context information */
  projectContext: ProjectContext;
}

/**
 * Version checker interface for dependency injection (enables fast tests)
 */
export interface VersionChecker {
  /** Fetch latest version from npm registry */
  fetchLatestVersion(): Promise<string>;
}

/**
 * Options for running doctor checks
 */
export interface DoctorOptions {
  /** Show all checks including passing ones */
  verbose?: boolean;
  /** Version checker (for testing) */
  versionChecker?: VersionChecker;
}

// Constants for check names and URLs
const CHECK_NAME_NODE_VERSION = 'Node.js version';
const NODEJS_INSTALL_URL = 'Install Node.js: https://nodejs.org/';
const CHECK_NAME_GIT_INSTALLED = 'Git installed';
const GIT_INSTALL_URL = 'Install Git: https://git-scm.com/';
const CHECK_NAME_GIT_REPOSITORY = 'Git repository';
const CHECK_NAME_CONFIG_FILE = 'Configuration file';
const CHECK_NAME_CONFIG_VALID = 'Configuration valid';
const CREATE_CONFIG_SUGGESTION = 'Create vibe-agent-toolkit.config.yaml in project root';
const CHECK_NAME_VAT_VERSION = 'vat version';
const CHECK_NAME_CLI_BUILD_STATUS = 'CLI build status';

/**
 * Check Node.js version meets requirements
 */
export function checkNodeVersion(): DoctorCheckResult {
  try {
    const version = getToolVersion('node');

    if (!version) {
      return {
        name: CHECK_NAME_NODE_VERSION,
        passed: false,
        message: 'Not detected',
        suggestion: NODEJS_INSTALL_URL,
      };
    }

    const majorVersion = Number.parseInt(version.replace('v', '').split('.')[0] ?? '');

    if (Number.isNaN(majorVersion)) {
      return {
        name: CHECK_NAME_NODE_VERSION,
        passed: false,
        message: `Failed to parse version: "${version}"`,
        suggestion: NODEJS_INSTALL_URL,
      };
    }

    return majorVersion >= 20
      ? {
          name: CHECK_NAME_NODE_VERSION,
          passed: true,
          message: `${version} (meets requirement: >=20.0.0)`,
        }
      : {
          name: CHECK_NAME_NODE_VERSION,
          passed: false,
          message: `${version} is too old. Node.js 20+ required.`,
          suggestion: 'Upgrade Node.js: https://nodejs.org/ or use nvm',
        };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_NODE_VERSION,
      passed: false,
      message: `Failed to detect: ${errorMessage}`,
      suggestion: NODEJS_INSTALL_URL,
    };
  }
}

/**
 * Check if git is installed
 */
export function checkGitInstalled(): DoctorCheckResult {
  try {
    const version = getToolVersion('git');

    if (!version) {
      return {
        name: CHECK_NAME_GIT_INSTALLED,
        passed: false,
        message: 'Git is not installed',
        suggestion: GIT_INSTALL_URL,
      };
    }

    return {
      name: CHECK_NAME_GIT_INSTALLED,
      passed: true,
      message: version,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_GIT_INSTALLED,
      passed: false,
      message: `Git is not installed: ${errorMessage}`,
      suggestion: GIT_INSTALL_URL,
    };
  }
}

/**
 * Check if current directory is a git repository
 */
export function checkGitRepository(): DoctorCheckResult {
  try {
    // Walk up directory tree looking for .git
    let currentDir = process.cwd();
    let previousDir = '';

    // Loop until we reach root (works on both Unix / and Windows C:\)
    while (currentDir !== previousDir) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path walking is required for git repo detection
      if (existsSync(join(currentDir, '.git'))) {
        return {
          name: CHECK_NAME_GIT_REPOSITORY,
          passed: true,
          message: 'Current directory is a git repository',
        };
      }
      previousDir = currentDir;
      currentDir = join(currentDir, '..');
    }

    return {
      name: CHECK_NAME_GIT_REPOSITORY,
      passed: false,
      message: 'Current directory is not a git repository',
      suggestion: 'Run: git init',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_GIT_REPOSITORY,
      passed: false,
      message: `Error checking git repository: ${errorMessage}`,
      suggestion: 'Run: git init',
    };
  }
}

/**
 * Check if configuration file exists
 *
 * Uses findConfigPath() to walk up directory tree.
 */
export function checkConfigFile(): DoctorCheckResult {
  try {
    const configPath = findConfigPath();

    if (configPath) {
      return {
        name: CHECK_NAME_CONFIG_FILE,
        passed: true,
        message: `Found: ${configPath}`,
      };
    } else {
      return {
        name: CHECK_NAME_CONFIG_FILE,
        passed: false,
        message: 'Configuration file not found',
        suggestion: CREATE_CONFIG_SUGGESTION,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_CONFIG_FILE,
      passed: false,
      message: `Error checking configuration: ${errorMessage}`,
      suggestion: CREATE_CONFIG_SUGGESTION,
    };
  }
}

/**
 * Check if configuration is valid
 */
export function checkConfigValid(): DoctorCheckResult {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      return {
        name: CHECK_NAME_CONFIG_VALID,
        passed: false,
        message: 'Configuration file not found',
        suggestion: CREATE_CONFIG_SUGGESTION,
      };
    }

    try {
      loadConfig(configPath);
      return {
        name: CHECK_NAME_CONFIG_VALID,
        passed: true,
        message: 'Configuration is valid',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        name: CHECK_NAME_CONFIG_VALID,
        passed: false,
        message: `Configuration contains errors: ${errorMessage}`,
        suggestion: 'Fix YAML syntax or schema errors in vibe-agent-toolkit.config.yaml',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_CONFIG_VALID,
      passed: false,
      message: `Failed to check configuration: ${errorMessage}`,
      suggestion: 'Check configuration file',
    };
  }
}

/**
 * Default version checker - uses npm registry
 */
const defaultVersionChecker: VersionChecker = {
  async fetchLatestVersion(): Promise<string> {
    const { safeExecSync } = await import('@vibe-agent-toolkit/utils');
    const version = safeExecSync('npm', ['view', 'vibe-agent-toolkit', 'version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return (version as string).trim();
  },
};

/**
 * Check if vat version is up to date (advisory only)
 */
export async function checkVatVersion(
  versionChecker: VersionChecker = defaultVersionChecker,
): Promise<DoctorCheckResult> {
  try {
    // Get current version from package.json
    const packageJsonPath = new URL('../../package.json', import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Package.json path is trusted static import
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const currentVersion = packageJson.version;

    // Fetch latest version from npm registry
    try {
      const latestVersion = await versionChecker.fetchLatestVersion();

      const isOutdated = semver.lt(currentVersion, latestVersion);

      if (currentVersion === latestVersion) {
        return {
          name: CHECK_NAME_VAT_VERSION,
          passed: true,
          message: `Current: ${currentVersion} — up to date`,
        };
      } else if (isOutdated) {
        return {
          name: CHECK_NAME_VAT_VERSION,
          passed: true, // Advisory only
          message: `Current: ${currentVersion}, Latest: ${latestVersion} available`,
          suggestion: 'Upgrade: npm install -g vibe-agent-toolkit@latest',
        };
      } else {
        return {
          name: CHECK_NAME_VAT_VERSION,
          passed: true,
          message: `Current: ${currentVersion} (ahead of npm: ${latestVersion})`,
        };
      }
    } catch (npmError) {
      const errorMessage = npmError instanceof Error ? npmError.message : String(npmError);
      return {
        name: CHECK_NAME_VAT_VERSION,
        passed: true,
        message: `Unable to check for updates: ${errorMessage}`,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_VAT_VERSION,
      passed: true,
      message: `Unable to determine version: ${errorMessage}`,
    };
  }
}

/**
 * Find project root by walking up directory tree
 */
function findProjectRoot(): string | null {
  let currentDir = process.cwd();
  let previousDir = '';

  // Loop until we reach root (works on both Unix / and Windows C:\)
  while (currentDir !== previousDir) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path walking is required for project root detection
    const hasConfig = existsSync(join(currentDir, 'vibe-agent-toolkit.config.yaml'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path walking is required for project root detection
    const hasGit = existsSync(join(currentDir, '.git'));

    if (hasConfig || hasGit) {
      return currentDir;
    }
    previousDir = currentDir;
    currentDir = join(currentDir, '..');
  }

  return null;
}

/**
 * Detect if running in VAT source tree
 */
function isVatSourceTree(): boolean {
  try {
    const projectRoot = findProjectRoot();
    if (!projectRoot) return false;

    const cliPackagePath = join(projectRoot, 'packages/cli/package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path for VAT source detection
    if (!existsSync(cliPackagePath)) return false;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path for VAT source detection
    const pkg = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as { name?: string };
    return pkg.name === '@vibe-agent-toolkit/cli';
  } catch {
    return false;
  }
}

/**
 * Check if CLI build is in sync with source code (development mode only)
 */
export function checkCliBuildSync(): DoctorCheckResult {
  try {
    if (!isVatSourceTree()) {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        passed: true,
        message: 'Skipped (not in VAT source tree)',
      };
    }

    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        passed: true,
        message: 'Skipped',
      };
    }

    // Get running version
    const runningPackagePath = new URL('../../package.json', import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Static import path is safe
    const runningPackage = JSON.parse(readFileSync(runningPackagePath, 'utf8'));
    const runningVersion = runningPackage.version;

    // Get source version
    const sourcePackagePath = join(projectRoot, 'packages/cli/package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Project root path construction
    const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'));
    const sourceVersion = sourcePackage.version;

    if (runningVersion !== sourceVersion) {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        passed: false,
        message: `Build is stale: running v${runningVersion}, source v${sourceVersion}`,
        suggestion: 'Rebuild packages: bun run build',
      };
    }

    return {
      name: CHECK_NAME_CLI_BUILD_STATUS,
      passed: true,
      message: `Build is up to date (v${runningVersion})`,
    };
  } catch {
    return {
      name: CHECK_NAME_CLI_BUILD_STATUS,
      passed: true,
      message: 'Skipped (could not determine build status)',
    };
  }
}

/**
 * Run all doctor checks
 *
 * @param options - Doctor options
 * @returns Doctor result
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const { verbose = false, versionChecker } = options;

  // 1. Detect project context
  const currentDir = process.cwd();
  const projectRoot = findProjectRoot();
  const configPath = findConfigPath();

  const projectContext: ProjectContext = {
    currentDir,
    projectRoot,
    configPath,
  };

  // 2. Run all checks (mix of sync and async)
  const checks: DoctorCheckResult[] = [
    await checkVatVersion(versionChecker),
    checkNodeVersion(),
    checkGitInstalled(),
    checkGitRepository(),
    checkConfigFile(),
    checkConfigValid(),
    checkCliBuildSync(),
  ];

  // 3. Filter output based on verbose mode
  const displayChecks = verbose
    ? checks
    : checks.filter(c => !c.passed || c.suggestion);

  // 4. Calculate summary
  const allPassed = checks.every(c => c.passed);
  const totalChecks = checks.length;
  const passedChecks = checks.filter(c => c.passed).length;

  return {
    allPassed,
    checks: displayChecks,
    totalChecks,
    passedChecks,
    projectContext,
  };
}

/**
 * Main command handler for Commander.js
 */
export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose vat setup and environment')
    .option('--verbose', 'Show all checks including passing ones')
    .action(async function (this: Command) {
      // Check both command-level and parent (global) options for --verbose flag
      const localOptions = this.opts<{ verbose?: boolean }>();
      const parentOptions = this.parent?.opts<{ verbose?: boolean }>();

      const options = {
        verbose: localOptions.verbose ?? parentOptions?.verbose ?? false,
      };

      try {
        const result = await runDoctor(options);
        displayResults(result);
      } catch (error) {
        console.error('❌ Doctor check failed:');
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

/**
 * Display doctor results in human-friendly format
 */
function displayResults(result: DoctorResult): void {
  console.log('🩺 vat doctor\n');

  // Show project context if in subdirectory
  const { currentDir, projectRoot, configPath } = result.projectContext;
  const isSubdirectory = projectRoot && projectRoot !== currentDir;

  if (isSubdirectory) {
    console.log('📍 Project Context');
    console.log(`   Current directory: ${currentDir}`);
    console.log(`   Project root:      ${projectRoot}`);
    if (configPath) {
      console.log(`   Configuration:     ${configPath}`);
    }
    console.log('');
  }

  console.log('Running diagnostic checks...\n');

  // Show checks
  for (const check of result.checks) {
    const icon = check.passed ? '✅' : '❌';
    console.log(`${icon} ${check.name}`);
    console.log(`   ${check.message}`);
    if (check.suggestion) {
      console.log(`   💡 ${check.suggestion}`);
    }
    console.log('');
  }

  // Summary
  console.log(`📊 Results: ${result.passedChecks}/${result.totalChecks} checks passed\n`);

  if (result.allPassed) {
    console.log('✨ All checks passed! Your vat setup looks healthy.');
  } else {
    console.log('⚠️  Some checks failed. See suggestions above to fix.');
    process.exit(1);
  }
}

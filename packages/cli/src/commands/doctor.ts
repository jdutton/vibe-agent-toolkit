/**
 * Doctor Command
 *
 * Diagnoses common issues with vat setup:
 * - Environment checks (Node.js version, git)
 * - Configuration validation
 * - Version checks
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getToolVersion } from '@vibe-agent-toolkit/utils';
import type { Command } from 'commander';

import { findConfigPath } from '../utils/config-loader.js';

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
    const root = '/';

    while (currentDir !== root) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path walking is required for git repo detection
      if (existsSync(join(currentDir, '.git'))) {
        return {
          name: CHECK_NAME_GIT_REPOSITORY,
          passed: true,
          message: 'Current directory is a git repository',
        };
      }
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
        suggestion: 'Create vibe-agent-toolkit.config.yaml in project root',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_CONFIG_FILE,
      passed: false,
      message: `Error checking configuration: ${errorMessage}`,
      suggestion: 'Create vibe-agent-toolkit.config.yaml in project root',
    };
  }
}

/**
 * Run all doctor checks
 *
 * @param options - Doctor options
 * @returns Doctor result
 */
export async function runDoctor(_options: DoctorOptions = {}): Promise<DoctorResult> {
  // Placeholder - will implement in later tasks
  return {
    allPassed: true,
    checks: [],
    totalChecks: 0,
    passedChecks: 0,
    projectContext: {
      currentDir: process.cwd(),
      projectRoot: null,
      configPath: null,
    },
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
    .action(async (options: { verbose?: boolean }) => {
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
 * Display doctor results
 */
function displayResults(_result: DoctorResult): void {
  console.log('🩺 vat doctor\n');
  console.log('✨ All checks passed!\n');
}

/**
 * Doctor Command
 *
 * Diagnoses common issues with vat setup:
 * - Environment checks (Node.js version, git)
 * - Configuration validation
 * - Version checks
 */

import { existsSync, readFileSync } from 'node:fs';


import {
  findConfigFile,
  getToolVersion,
  resolveAssetReference,
  safePath,
} from '@vibe-agent-toolkit/utils';
import type { Command } from 'commander';
import * as semver from 'semver';

import { loadConfig } from '../utils/config-loader.js';
import { projectRootOrNull } from '../utils/project-root-policy.js';

/**
 * What a single check concluded.
 *
 * Four values, because a check has four possible answers and a boolean has two.
 * `passed: boolean` forced "I could not tell" and "it does not apply" to be
 * spelled as `true` — the reassuring value — so a swallowed EACCES and a healthy
 * build rendered identically, both as `✅`, and both counted toward
 * "7/7 checks passed".
 *
 * - `pass`         — the check ran and the thing is fine.
 * - `fail`         — the check ran and the thing is wrong. The only outcome that
 *                    affects the exit code.
 * - `undetermined` — the check could not reach an answer (network down, file
 *                    unreadable). NOT a pass: nothing was verified.
 * - `skipped`      — the check does not apply here (e.g. a VAT-source-tree-only
 *                    check outside the source tree). Determinate, but not a pass.
 */
export type DoctorOutcome = 'pass' | 'fail' | 'undetermined' | 'skipped';

/**
 * Result of a single doctor check
 */
export interface DoctorCheckResult {
  /** Name of the check */
  name: string;
  /** What the check concluded */
  outcome: DoctorOutcome;
  /** Message describing the result */
  message: string;
  /** Optional suggestion for fixing the issue */
  suggestion?: string;
}

/** How many checks landed in each outcome. Published beside the verdict, never folded into it. */
export interface DoctorOutcomeCounts {
  pass: number;
  fail: number;
  undetermined: number;
  skipped: number;
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
 *
 * `checks` holds EVERY check that ran — the display filter belongs to the
 * renderer, not the data. Returning only the displayed subset while counting all
 * of them is what let doctor print "7/7 checks passed" above an empty list.
 */
export interface DoctorResult {
  /** Every check that ran, unfiltered */
  checks: DoctorCheckResult[];
  /** Total number of checks run (always `checks.length`) */
  totalChecks: number;
  /** Distribution across outcomes; sums to `totalChecks` */
  outcomeCounts: DoctorOutcomeCounts;
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
        outcome: 'fail',
        message: 'Not detected',
        suggestion: NODEJS_INSTALL_URL,
      };
    }

    const majorVersion = Number.parseInt(version.replace('v', '').split('.')[0] ?? '');

    if (Number.isNaN(majorVersion)) {
      return {
        name: CHECK_NAME_NODE_VERSION,
        outcome: 'fail',
        message: `Failed to parse version: "${version}"`,
        suggestion: NODEJS_INSTALL_URL,
      };
    }

    return majorVersion >= 20
      ? {
          name: CHECK_NAME_NODE_VERSION,
          outcome: 'pass',
          message: `${version} (meets requirement: >=20.0.0)`,
        }
      : {
          name: CHECK_NAME_NODE_VERSION,
          outcome: 'fail',
          message: `${version} is too old. Node.js 20+ required.`,
          suggestion: 'Upgrade Node.js: https://nodejs.org/ or use nvm',
        };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_NODE_VERSION,
      outcome: 'fail',
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
        outcome: 'fail',
        message: 'Git is not installed',
        suggestion: GIT_INSTALL_URL,
      };
    }

    return {
      name: CHECK_NAME_GIT_INSTALLED,
      outcome: 'pass',
      message: version,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_GIT_INSTALLED,
      outcome: 'fail',
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
      if (existsSync(safePath.join(currentDir, '.git'))) {
        return {
          name: CHECK_NAME_GIT_REPOSITORY,
          outcome: 'pass',
          message: 'Current directory is a git repository',
        };
      }
      previousDir = currentDir;
      currentDir = safePath.join(currentDir, '..');
    }

    return {
      name: CHECK_NAME_GIT_REPOSITORY,
      outcome: 'fail',
      message: 'Current directory is not a git repository',
      suggestion: 'Run: git init',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_GIT_REPOSITORY,
      outcome: 'fail',
      message: `Error checking git repository: ${errorMessage}`,
      suggestion: 'Run: git init',
    };
  }
}

/**
 * Check if configuration file exists
 *
 * Walks up directory tree from cwd via canonical findConfigFile.
 */
export function checkConfigFile(): DoctorCheckResult {
  try {
    const configPath = findConfigFile(process.cwd());

    if (configPath) {
      return {
        name: CHECK_NAME_CONFIG_FILE,
        outcome: 'pass',
        message: `Found: ${configPath}`,
      };
    } else {
      return {
        name: CHECK_NAME_CONFIG_FILE,
        outcome: 'fail',
        message: 'Configuration file not found',
        suggestion: CREATE_CONFIG_SUGGESTION,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_CONFIG_FILE,
      outcome: 'fail',
      message: `Error checking configuration: ${errorMessage}`,
      suggestion: CREATE_CONFIG_SUGGESTION,
    };
  }
}

/**
 * Check if schema files referenced in collections exist
 */
function checkSchemaFiles(
  collections: Record<string, { validation?: { frontmatterSchema?: string | undefined } | undefined }>,
  configDir: string
): { schemaFiles: string[]; missingSchemas: string[] } {
  const schemaFiles: string[] = [];
  const missingSchemas: string[] = [];

  for (const collectionConfig of Object.values(collections)) {
    const schemaPath = collectionConfig.validation?.frontmatterSchema;
    if (schemaPath) {
      schemaFiles.push(schemaPath);
      try {
        const absoluteSchemaPath = resolveAssetReference(schemaPath, configDir);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- absoluteSchemaPath resolved via resolveAssetReference
        if (!existsSync(absoluteSchemaPath)) {
          missingSchemas.push(schemaPath);
        }
      } catch {
        // resolveAssetReference throws for unresolvable bare specifiers
        // (package not installed, subpath not exported). vat doctor's
        // contract is "report what's missing" — convert the throw back
        // to a missingSchemas entry.
        missingSchemas.push(schemaPath);
      }
    }
  }

  return { schemaFiles, missingSchemas };
}

/**
 * Check if configuration is valid
 */
export function checkConfigValid(): DoctorCheckResult {
  try {
    const configPath = findConfigFile(process.cwd());
    if (!configPath) {
      return {
        name: CHECK_NAME_CONFIG_VALID,
        outcome: 'fail',
        message: 'Configuration file not found',
        suggestion: CREATE_CONFIG_SUGGESTION,
      };
    }

    try {
      // loadConfig expects project root directory, not config file path
      const configDir = safePath.join(configPath, '..');
      const config = loadConfig(configDir);

      // Basic validation passed, now check collections and schema files
      const collections = config?.resources?.collections;

      if (!collections || Object.keys(collections).length === 0) {
        return {
          name: CHECK_NAME_CONFIG_VALID,
          outcome: 'pass',
          message: 'Configuration is valid (no collections defined)',
        };
      }

      // Check if schema files exist
      const collectionCount = Object.keys(collections).length;
      const { schemaFiles, missingSchemas } = checkSchemaFiles(collections, configDir);

      // Build message with details
      if (missingSchemas.length > 0) {
        const details = [
          `Collections: ${collectionCount} defined`,
          `Schema files: ${schemaFiles.length} referenced, ${missingSchemas.length} missing`,
          `Missing: ${missingSchemas.join(', ')}`,
        ].join('\n   ');

        return {
          name: CHECK_NAME_CONFIG_VALID,
          outcome: 'fail',
          message: `Configuration valid but schema files missing:\n   ${details}`,
          suggestion: 'Create missing schema files or update collection config',
        };
      }

      // All good - build success message with details
      const details = [
        `Collections: ${collectionCount} defined`,
        `Schema files: ${schemaFiles.length} referenced, all exist`,
      ].join('\n   ');

      return {
        name: CHECK_NAME_CONFIG_VALID,
        outcome: 'pass',
        message: `Configuration is valid\n   ${details}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        name: CHECK_NAME_CONFIG_VALID,
        outcome: 'fail',
        message: `Configuration contains errors: ${errorMessage}`,
        suggestion: 'Fix YAML syntax or schema errors in vibe-agent-toolkit.config.yaml',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_CONFIG_VALID,
      outcome: 'fail',
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
          outcome: 'pass',
          message: `Current: ${String(currentVersion)} — up to date`,
        };
      } else if (isOutdated) {
        return {
          name: CHECK_NAME_VAT_VERSION,
          outcome: 'pass', // Advisory only
          message: `Current: ${String(currentVersion)}, Latest: ${String(latestVersion)} available`,
          suggestion: 'Upgrade: npm install -g vibe-agent-toolkit@latest',
        };
      } else {
        return {
          name: CHECK_NAME_VAT_VERSION,
          outcome: 'pass',
          message: `Current: ${String(currentVersion)} (ahead of npm: ${String(latestVersion)})`,
        };
      }
    } catch (npmError) {
      // The registry was unreachable. We do not know whether a newer version
      // exists — which is not the same as knowing this one is current.
      const errorMessage = npmError instanceof Error ? npmError.message : String(npmError);
      return {
        name: CHECK_NAME_VAT_VERSION,
        outcome: 'undetermined',
        message: `Unable to check for updates: ${errorMessage}`,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_VAT_VERSION,
      outcome: 'undetermined',
      message: `Unable to determine version: ${errorMessage}`,
    };
  }
}

/** Whether the tree is VAT's own source. Three-valued: the probe can fail. */
type SourceTreeAnswer = 'yes' | 'no' | 'undetermined';

/**
 * Detect if running in VAT source tree
 *
 * Returns `'undetermined'` when the probe file exists but cannot be read or
 * parsed: "I could not tell whether this is the source tree" is a different
 * answer from "this is not the source tree", and only the latter justifies
 * skipping the build-sync check.
 *
 * @param projectRoot - Pre-resolved project root from the CLI boundary (null if absent)
 */
function isVatSourceTree(projectRoot: string | null): SourceTreeAnswer {
  if (!projectRoot) return 'no';

  const cliPackagePath = safePath.join(projectRoot, 'packages/cli/package.json');
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path for VAT source detection
    if (!existsSync(cliPackagePath)) return 'no';

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path for VAT source detection
    const pkg = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as { name?: string };
    return pkg.name === '@vibe-agent-toolkit/cli' ? 'yes' : 'no';
  } catch {
    return 'undetermined';
  }
}

/**
 * Check if CLI build is in sync with source code (development mode only)
 *
 * @param projectRoot - Pre-resolved project root from the CLI boundary (null if absent)
 */
export function checkCliBuildSync(projectRoot: string | null): DoctorCheckResult {
  try {
    if (!projectRoot) {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        outcome: 'skipped',
        message: 'Skipped (no project root detected — nothing to compare the build against)',
      };
    }

    const sourceTree = isVatSourceTree(projectRoot);

    if (sourceTree === 'undetermined') {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        outcome: 'undetermined',
        message: 'Could not determine whether this is the VAT source tree (packages/cli/package.json is unreadable)',
      };
    }

    if (sourceTree === 'no') {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        outcome: 'skipped',
        message: 'Skipped (not in VAT source tree — build sync only applies to VAT developers)',
      };
    }

    // Get running version
    const runningPackagePath = new URL('../../package.json', import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Static import path is safe
    const runningPackage = JSON.parse(readFileSync(runningPackagePath, 'utf8'));
    const runningVersion = runningPackage.version;

    // Get source version
    const sourcePackagePath = safePath.join(projectRoot, 'packages/cli/package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Project root path construction
    const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'));
    const sourceVersion = sourcePackage.version;

    if (runningVersion !== sourceVersion) {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        outcome: 'fail',
        message: `Build is stale: running v${String(runningVersion)}, source v${String(sourceVersion)}`,
        suggestion: 'Rebuild packages: bun run build',
      };
    }

    return {
      name: CHECK_NAME_CLI_BUILD_STATUS,
      outcome: 'pass',
      message: `Build is up to date (v${String(runningVersion)})`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_NAME_CLI_BUILD_STATUS,
      outcome: 'undetermined',
      message: `Could not determine build status: ${errorMessage}`,
      suggestion: 'Rebuild packages (bun run build) and re-run, or check file permissions',
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
  const { versionChecker } = options;

  // 1. Detect project context at the CLI boundary.
  // Doctor uses the `tolerate null` policy (spec §7) — null is reported as a finding.
  const currentDir = process.cwd();
  const projectRoot = projectRootOrNull(currentDir);
  const configPath = findConfigFile(currentDir);

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
    checkCliBuildSync(projectRoot),
  ];

  // 3. Report every check plus the outcome distribution. Filtering is the
  //    renderer's job — see selectDisplayChecks.
  return {
    checks,
    totalChecks: checks.length,
    outcomeCounts: countByOutcome(checks),
    projectContext,
  };
}

/** Tally checks by outcome. The four buckets always sum to `checks.length`. */
export function countByOutcome(checks: readonly DoctorCheckResult[]): DoctorOutcomeCounts {
  const counts: DoctorOutcomeCounts = { pass: 0, fail: 0, undetermined: 0, skipped: 0 };
  for (const check of checks) {
    counts[check.outcome] += 1;
  }
  return counts;
}

/**
 * Which checks the renderer prints.
 *
 * Verbose prints all of them. Concise hides only the checks with nothing to say:
 * a clean `pass` with no suggestion, and a `skipped` check that does not apply
 * here. `fail` and `undetermined` are ALWAYS printed — an undetermined check is
 * the one a concise view must never swallow.
 *
 * Whatever this hides, {@link formatDoctorSummary} states the number of hidden
 * checks, so the printed list and the printed counts cannot disagree.
 */
export function selectDisplayChecks(
  checks: readonly DoctorCheckResult[],
  verbose: boolean,
): DoctorCheckResult[] {
  if (verbose) return [...checks];
  return checks.filter(
    c => c.suggestion !== undefined || (c.outcome !== 'pass' && c.outcome !== 'skipped'),
  );
}

const OUTCOME_ICONS: Record<DoctorOutcome, string> = {
  pass: '✅',
  fail: '❌',
  undetermined: '❓',
  skipped: '⏭️',
};

/**
 * The summary block: the distribution, how many checks were not rendered, and
 * the verdict.
 *
 * `displayedCount` is required precisely so the block can never claim more
 * checks than the reader was shown without saying so.
 */
export function formatDoctorSummary(
  counts: DoctorOutcomeCounts,
  displayedCount: number,
): string[] {
  const total = counts.pass + counts.fail + counts.undetermined + counts.skipped;
  const lines = [
    `📊 Results: ${total} checks — ${counts.pass} passed, ${counts.fail} failed, ` +
      `${counts.undetermined} undetermined, ${counts.skipped} skipped`,
  ];

  const hidden = total - displayedCount;
  if (hidden > 0) {
    lines.push(
      `   ${hidden} not shown (nothing to report) — re-run with --verbose to see every check.`,
    );
  }

  lines.push('');

  if (counts.fail > 0) {
    lines.push(`⚠️  ${counts.fail} check(s) failed. See suggestions above to fix.`);
  } else if (counts.undetermined > 0) {
    lines.push(
      `❓ Nothing failed, but ${counts.undetermined} check(s) could not be determined — ` +
        'that is not the same as healthy.',
    );
  } else {
    lines.push('✨ All checks passed! Your vat setup looks healthy.');
  }

  return lines;
}

/**
 * Main command handler for Commander.js
 */
export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose vat setup and environment')
    .option('-v, --verbose', 'Show all checks including passing ones')
    .addHelpText('after', `
When to run:
  • Before starting development (ensure environment is ready)
  • After installing or updating vat
  • When debugging setup issues
  • In CI/CD pipelines (validate build environment)

Exit Codes:
  0 - No check failed (an undetermined check is reported, not fatal)
  1 - One or more checks failed (see output for suggested fixes)

Outcomes:
  ✅ pass          the check ran and the thing is fine
  ❌ fail          the check ran and the thing is wrong (exit 1)
  ❓ undetermined  the check could not reach an answer — nothing was verified
  ⏭️  skipped       the check does not apply here

Requirements:
  projectRoot: optional (tolerates absence — reported as a finding)
  config:      not used

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat doctor                  # Check environment, show only issues
  $ vat doctor --verbose        # Show all checks including passing ones

More details: vat --help --verbose or see packages/cli/docs/doctor.md
`)
    .action(async function (this: Command) {
      // Check both command-level and parent (global) options for --verbose flag
      const localOptions = this.opts<{ verbose?: boolean }>();
      const parentOptions = this.parent?.opts<{ verbose?: boolean }>();

      const options = {
        verbose: localOptions.verbose ?? parentOptions?.verbose ?? false,
      };

      try {
        const result = await runDoctor(options);
        displayResults(result, options.verbose);
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
function displayResults(result: DoctorResult, verbose: boolean): void {
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
  const displayed = selectDisplayChecks(result.checks, verbose);
  for (const check of displayed) {
    console.log(`${OUTCOME_ICONS[check.outcome]} ${check.name}`);
    console.log(`   ${check.message}`);
    if (check.suggestion) {
      console.log(`   💡 ${check.suggestion}`);
    }
    console.log('');
  }

  // Summary — states the distribution AND how many checks it did not print,
  // so the count can never contradict the list above it.
  for (const line of formatDoctorSummary(result.outcomeCounts, displayed.length)) {
    console.log(line);
  }

  if (result.outcomeCounts.fail > 0) {
    process.exit(1);
  }
}

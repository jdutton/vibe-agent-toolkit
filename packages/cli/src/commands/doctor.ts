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
  resolveAssetReference,
  safePath,
} from '@vibe-agent-toolkit/utils';
import {
  getToolVersion,
} from '@vibe-agent-toolkit/utils/process';
import type { Command } from 'commander';
import * as semver from 'semver';

import { COMMAND_LOADERS } from '../command-loaders.js';
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
/**
 * This package's own manifest.
 *
 * `../../package.json` resolves to `packages/cli/package.json` from both
 * `src` and `dist`, which is why every reader in this file uses that form.
 * Named once so the three of them cannot drift onto different files.
 */
const CLI_MANIFEST_URL = new URL('../../package.json', import.meta.url);

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
const CHECK_NAME_COMMAND_MODULES = 'Command modules';

/**
 * The Node range VAT actually requires, read from this package's own manifest.
 *
 * ⛔ **Derived, never written down here.** A second copy of a floor drifts from
 * the first in silence, and this one had: the check below used to pass anything
 * whose MAJOR was `>= 20`, while the manifest said `>=22.0.0` and
 * `vat resources query|check` need 22.13.0 for `node:sqlite`. Three numbers
 * disagreeing, and the one users were shown was the most permissive — so
 * `vat doctor` reported a healthy environment that could not run the toolkit.
 * Reading `engines.node` makes the manifest the single answer, so bumping the
 * floor cannot leave this check behind.
 *
 * @returns The `engines.node` range, or `undefined` when the manifest cannot
 *   be read or declares none — a packaging fault the caller reports rather
 *   than papers over with a guess
 */
function requiredNodeRange(): string | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a URL built from import.meta.url, not from input
    const manifest: unknown = JSON.parse(readFileSync(CLI_MANIFEST_URL, 'utf8'));
    const range = (manifest as { engines?: { node?: unknown } }).engines?.node;
    return typeof range === 'string' && range.length > 0 ? range : undefined;
  } catch {
    return undefined;
  }
}

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

    // Compared with the full range, not a major: `node:sqlite` arrived in
    // 22.13.0, so a major-only test passes 22.0.0 for a toolkit that cannot
    // run `vat resources query` there.
    const range = requiredNodeRange();
    if (range === undefined) {
      return {
        name: CHECK_NAME_NODE_VERSION,
        outcome: 'fail',
        message: 'Cannot determine the required Node.js version: the CLI manifest declares no engines.node',
        suggestion: 'Reinstall @vibe-agent-toolkit/cli — its package.json is incomplete',
      };
    }

    const parsed = semver.coerce(version);
    if (parsed === null) {
      return {
        name: CHECK_NAME_NODE_VERSION,
        outcome: 'fail',
        message: `Failed to parse version: "${version}"`,
        suggestion: NODEJS_INSTALL_URL,
      };
    }

    return semver.satisfies(parsed, range)
      ? {
          name: CHECK_NAME_NODE_VERSION,
          outcome: 'pass',
          message: `${version} (meets requirement: ${range})`,
        }
      : {
          name: CHECK_NAME_NODE_VERSION,
          outcome: 'fail',
          message: `${version} is too old. Node.js ${range} required.`,
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
    const { safeExecSync } = await import('@vibe-agent-toolkit/utils/process');
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Package.json path is trusted static import
    const packageJson = JSON.parse(readFileSync(CLI_MANIFEST_URL, 'utf8'));
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
 * One line saying WHY a command module would not load.
 *
 * The message is the load-bearing half: Node's `ERR_MODULE_NOT_FOUND` spells
 * out the missing specifier and the file that imported it, which is exactly the
 * fact the raw crash gave the user, and exactly what a bare `catch {}` here
 * threw away. The code is prefixed when there is one because that is the part
 * worth searching for.
 *
 * Whitespace is collapsed because some Node loader messages are multi-line, and
 * this ends up on a single doctor result line.
 *
 * @param error - Whatever the loader threw
 * @returns A single-line description of the failure
 */
function describeLoadFailure(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/gu, ' ')
    .trim();
  // Never return an empty string: a thrown `Error('')` would otherwise render as
  // "First failure — rag:" and read like the reporting itself is broken.
  const message = raw === '' ? 'threw with no message' : raw;
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? `${code}: ${message}` : message;
}

/**
 * Check that every command module in `COMMAND_LOADERS` can actually be loaded.
 *
 * ## Why this check exists
 *
 * The CLI loads only the command named on the command line, so a `dist/` with
 * one command module missing is no longer detected at startup. It used to be:
 * every invocation imported all fourteen, so ANY of them missing crashed
 * immediately, naming the file. After the change to lazy loading, `vat rag`
 * died with a raw `ERR_MODULE_NOT_FOUND` while `vat doctor` — which loads only
 * itself, and whose other checks compare version strings that a corrupt install
 * leaves intact — reported a healthy setup and exited 0. The one command a user
 * runs to diagnose a broken install was the one that could not see it.
 *
 * ## What it does NOT cover
 *
 * `doctor` itself. It is the fifteenth top-level command and is deliberately
 * outside `COMMAND_LOADERS`: it registers itself onto the program
 * (`doctorCommand(program)`) rather than returning a `Command`, so it does not
 * fit the table's shape, and `bin.ts` special-cases it. Checking it from here
 * would prove nothing anyway — this code is running, so its own module loaded.
 *
 * Loading the whole tree is the point here, so this check knowingly pays the
 * startup cost the rest of the CLI now avoids. `doctor` is a diagnostic, not a
 * hot path.
 *
 * Failures are reported by NAME **and by reason**. The name answers "which
 * command is broken", which is the question a user with a half-extracted
 * tarball has; the reason answers "which file is missing", which is the only
 * thing the raw crash this check replaced was ever good for. Reporting the
 * former without the latter left doctor strictly less informative than the
 * crash.
 *
 * @returns A failure listing every command whose module could not be loaded
 */
export async function checkCommandModules(): Promise<DoctorCheckResult> {
  const broken: { name: string; reason: string }[] = [];

  for (const [name, load] of Object.entries(COMMAND_LOADERS)) {
    try {
      await load();
    } catch (error) {
      broken.push({ name, reason: describeLoadFailure(error) });
    }
  }

  const total = Object.keys(COMMAND_LOADERS).length;

  const [first] = broken;
  if (first) {
    const names = broken.map(({ name }) => name).join(', ');
    // Only the first reason is shown: when a tree is half-extracted every
    // command fails, and fourteen near-identical stack messages bury the one
    // fact that matters. The rest stay reachable by running that command.
    const others = broken.length - 1;
    const plural = others === 1 ? '' : 's';
    const rest = others > 0 ? ` (${others} further failure${plural} not shown)` : '';
    return {
      name: CHECK_NAME_COMMAND_MODULES,
      outcome: 'fail',
      message: `${broken.length} of ${total} command modules failed to load: ${names}. First failure — ${first.name}: ${first.reason}${rest}`,
      suggestion: 'The installation is incomplete or corrupt. Reinstall vat, or re-run `bun run build` in a source tree.',
    };
  }

  return {
    name: CHECK_NAME_COMMAND_MODULES,
    outcome: 'pass',
    message: `All ${total} command modules load`,
  };
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Static import path is safe
    const runningPackage = JSON.parse(readFileSync(CLI_MANIFEST_URL, 'utf8'));
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
    await checkCommandModules(),
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

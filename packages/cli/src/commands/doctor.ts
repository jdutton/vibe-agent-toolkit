/**
 * Doctor Command
 *
 * Diagnoses common issues with vat setup:
 * - Environment checks (Node.js version, git)
 * - Configuration validation
 * - Version checks
 */

import { existsSync, readFileSync } from 'node:fs';


import { buildReport, toFindings, type FindingsReport, type Gate, type OkReport, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  ASSET_REFERENCE_UNREADABLE_CODE,
  ASSET_REFERENCE_UNRESOLVED_CODE,
  findConfigFile,
  fsFaultOf,
  isPathAbsentError,
  isVatError,
  resolveAssetReference,
  safePath,
} from '@vibe-agent-toolkit/utils';
import {
  getToolVersion,
} from '@vibe-agent-toolkit/utils/process';
import { Option, type Command } from 'commander';
import * as semver from 'semver';

import { COMMAND_LOADERS } from '../command-loaders.js';
import type { DocumentFormat } from '../report-schemas.js';
import { refusalCodeOf } from '../utils/command-refusal.js';
import { loadConfig } from '../utils/config-loader.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../utils/document-writer.js';
import { projectRootOrNull } from '../utils/project-root-policy.js';

import { renderDoctorBlock } from './doctor-render.js';
import type { DoctorCheckResult, DoctorData } from './doctor-schema.js';

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
 * @returns The `engines.node` range, or which of two DIFFERENT problems occurred.
 *   `undeclared` is a packaging fault the caller reports as a failure; `unreadable`
 *   means nothing was verified, which this module's own doctrine calls `undetermined`.
 *   Collapsing them told a user with an unreadable manifest to reinstall an incomplete
 *   one — the wrong diagnosis and the wrong remedy.
 */
function requiredNodeRange(): { range: string } | { problem: 'unreadable' | 'undeclared' } {
  let raw: string;
  try {
    raw = readFileSync(CLI_MANIFEST_URL, 'utf8');
  } catch (error) {
    // Distinguished from `undeclared` deliberately. This module's own doctrine says a
    // file that cannot be read is `undetermined` — nothing was verified — not a `fail`.
    // Collapsing the two told a user with an unreadable manifest that it was incomplete
    // and to reinstall, which is the wrong diagnosis and the wrong remedy.
    //
    // "Cannot be read" is the FILESYSTEM's answer, and the caller reports it as
    // one ("check permissions"). A throw with no errno is a defect, and is left
    // to the caller's own catch, which names it as what it is.
    if (fsFaultOf(error) === undefined) throw error;
    return { problem: 'unreadable' };
  }

  try {
    const manifest: unknown = JSON.parse(raw);
    const range = (manifest as { engines?: { node?: unknown } }).engines?.node;
    return typeof range === 'string' && range.length > 0 ? { range } : { problem: 'undeclared' };
  } catch (error) {
    // Not JSON: the manifest could not be read for its floor, which is the same
    // verdict as not being able to read it at all.
    if (!(error instanceof SyntaxError)) throw error;
    return { problem: 'unreadable' };
  }
}

/**
 * Check Node.js version meets requirements
 *
 * 🔑 Reads `process.version` — the interpreter actually executing this process — and NOT
 * a spawned `node --version`. Those are different questions whenever VAT is launched
 * through a shim (Volta, asdf, corepack, an IDE terminal, `npx --node-version`) or by an
 * absolute interpreter path, which is common. Asking `PATH` produced all three wrong
 * answers at once: it FAILED a healthy environment whose `PATH` node was old, it PASSED
 * an environment that cannot run `vat resources query|check` when only `PATH`'s node was
 * new, and where `node` was not on `PATH` at all it reported Node as "Not detected" —
 * from inside a Node process.
 *
 * The check that matters is whether the interpreter running VAT can run VAT, so it must
 * be asked of that interpreter. `nodeSqliteFloorFailure` in `utils/projection-store.ts`
 * already reported `process.version`; this makes the two agree instead of answering one
 * question from two sources.
 */
export function checkNodeVersion(): DoctorCheckResult {
  try {
    // Not `getToolVersion('node')`. See the note above: that spawns PATH's node, which is
    // not necessarily — and under any version manager, not usually — this process.
    const version = process.version;

    // Compared with the full range, not a major: `node:sqlite` is unflagged from
    // 22.13.0, so a major-only test passes 22.0.0 for a toolkit that cannot
    // run `vat resources query` there.
    const required = requiredNodeRange();
    if (!('range' in required)) {
      return required.problem === 'unreadable'
        ? {
            name: CHECK_NAME_NODE_VERSION,
            outcome: 'undetermined',
            message: `Cannot read the CLI manifest to learn the required Node.js version (running ${version})`,
            suggestion: 'Check permissions on the installed @vibe-agent-toolkit/cli package',
          }
        : {
            name: CHECK_NAME_NODE_VERSION,
            outcome: 'fail',
            message: 'Cannot determine the required Node.js version: the CLI manifest declares no engines.node',
            suggestion: 'Reinstall @vibe-agent-toolkit/cli — its package.json is incomplete',
          };
    }
    const { range } = required;

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
          // "does not satisfy", not "is too old". The range comes from the manifest and
          // this code no longer controls its shape: an upper bound or a gap (excluding the
          // odd-numbered 23 line, say) would make a NEWER Node fail here, and telling that
          // user to upgrade is advice that cannot work.
          message: `${version} does not satisfy the required range. Node.js ${range} required.`,
          suggestion: 'Install a Node.js version in that range: https://nodejs.org/ or use nvm',
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
): { schemaFiles: string[]; missingSchemas: string[]; unreadableSchemas: string[] } {
  const schemaFiles: string[] = [];
  const missingSchemas: string[] = [];
  const unreadableSchemas: string[] = [];

  for (const collectionConfig of Object.values(collections)) {
    const schemaPath = collectionConfig.validation?.frontmatterSchema;
    if (schemaPath) {
      schemaFiles.push(schemaPath);
      try {
        const absoluteSchemaPath = resolveAssetReference(schemaPath, configDir);
        if (!existsSync(absoluteSchemaPath)) {
          missingSchemas.push(schemaPath);
        }
      } catch (error) {
        // A bare specifier that names nothing installed is coded
        // ASSET_REFERENCE_UNRESOLVED: a missingSchemas entry. One whose package
        // is installed but unreadable (a malformed package.json) is not missing,
        // and is listed apart. Any other throw reaches the caller's own catch.
        if (isVatError(error, ASSET_REFERENCE_UNREADABLE_CODE)) unreadableSchemas.push(schemaPath);
        else if (isVatError(error, ASSET_REFERENCE_UNRESOLVED_CODE)) missingSchemas.push(schemaPath);
        else throw error;
      }
    }
  }

  return { schemaFiles, missingSchemas, unreadableSchemas };
}

/** The failed config check for schema references that are missing, or whose package cannot be read. */
function schemaProblemResult(
  collectionCount: number,
  referenced: number,
  missingSchemas: string[],
  unreadableSchemas: string[],
): DoctorCheckResult {
  const counts = [
    missingSchemas.length > 0 ? `${missingSchemas.length} missing` : undefined,
    unreadableSchemas.length > 0 ? `${unreadableSchemas.length} unreadable` : undefined,
  ].filter((part) => part !== undefined).join(', ');
  const details = [
    `Collections: ${collectionCount} defined`,
    `Schema files: ${referenced} referenced, ${counts}`,
    ...(missingSchemas.length > 0 ? [`Missing: ${missingSchemas.join(', ')}`] : []),
    ...(unreadableSchemas.length > 0 ? [`Unreadable: ${unreadableSchemas.join(', ')} (the package is installed but its package.json cannot be read)`] : []),
  ].join('\n   ');
  const suggestions = [
    ...(missingSchemas.length > 0 ? ['Create missing schema files or update collection config'] : []),
    ...(unreadableSchemas.length > 0 ? ['fix or reinstall the package whose package.json cannot be read'] : []),
  ];
  return {
    name: CHECK_NAME_CONFIG_VALID,
    outcome: 'fail',
    message: `Configuration valid but schema files ${counts}:\n   ${details}`,
    suggestion: suggestions.join('; '),
  };
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
      const { schemaFiles, missingSchemas, unreadableSchemas } = checkSchemaFiles(collections, configDir);

      // Build message with details
      if (missingSchemas.length > 0 || unreadableSchemas.length > 0) {
        return schemaProblemResult(collectionCount, schemaFiles.length, missingSchemas, unreadableSchemas);
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

/**
 * Detect if running in VAT source tree
 *
 * THROWS when the probe file exists but cannot be read or parsed: "I could not
 * tell whether this is the source tree" is a different answer from "this is not
 * the source tree", and only the latter justifies skipping the build-sync check.
 * The caller's catch reports the throw as `undetermined` WITH the reason — a
 * bare "is unreadable" used to stand in for an errno, a parse error and a
 * defect alike, and sent every one of them to check file permissions.
 *
 * @param projectRoot - Pre-resolved project root from the CLI boundary (null if absent)
 */
function isVatSourceTree(projectRoot: string | null): boolean {
  if (!projectRoot) return false;

  const cliPackagePath = safePath.join(projectRoot, 'packages/cli/package.json');
  if (!existsSync(cliPackagePath)) return false;

  let raw: string;
  try {
    raw = readFileSync(cliPackagePath, 'utf8');
  } catch (error) {
    // Gone since the existence check: not the source tree. Anything else is
    // the probe failing, not the probe answering "no".
    if (isPathAbsentError(error)) return false;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`packages/cli/package.json is unreadable: ${reason}`, { cause: error });
  }
  const pkg = JSON.parse(raw) as { name?: string };
  return pkg.name === '@vibe-agent-toolkit/cli';
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
  // Loaded together; the failures are listed in table order whatever order they land in.
  const entries = Object.entries(COMMAND_LOADERS);
  const outcomes = await Promise.allSettled(entries.map(([, load]) => load()));
  const broken = entries.flatMap(([name], index) => {
    const outcome = outcomes[index];
    return outcome?.status === 'rejected' ? [{ name, reason: describeLoadFailure(outcome.reason) }] : [];
  });

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

    if (!isVatSourceTree(projectRoot)) {
      return {
        name: CHECK_NAME_CLI_BUILD_STATUS,
        outcome: 'skipped',
        message: 'Skipped (not in VAT source tree — build sync only applies to VAT developers)',
      };
    }

    // Get running version
    const runningPackage = JSON.parse(readFileSync(CLI_MANIFEST_URL, 'utf8'));
    const runningVersion = runningPackage.version;

    // Get source version
    const sourcePackagePath = safePath.join(projectRoot, 'packages/cli/package.json');
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

  // 3. Report every check. Filtering is the renderer's job — see selectDisplayChecks.
  return { checks, projectContext };
}

/** Doctor has no `--strict`: an undetermined check warns, and a warning never fails the run. */
const DOCTOR_GATE: Gate = { strict: false };

/**
 * A check's outcome as a finding: `fail` is an error, `undetermined` a warning
 * (nothing was verified — not health, not a failure); `pass` and `skipped` say
 * nothing a finding should.
 */
function checkIssue(check: DoctorCheckResult): ValidationIssue | undefined {
  if (check.outcome !== 'fail' && check.outcome !== 'undetermined') return undefined;
  return {
    code: check.outcome === 'fail' ? 'DOCTOR_CHECK_FAILED' : 'DOCTOR_CHECK_WARNED',
    severity: check.outcome === 'fail' ? 'error' : 'warning',
    message: `${check.name}: ${check.message}`,
    ...(check.suggestion === undefined ? {} : { fix: check.suggestion }),
  };
}

/**
 * The document a doctor run publishes: every check a row, every failed or
 * undetermined one a finding, `examined` the checks run.
 *
 * @param result - What {@link runDoctor} returned
 */
export function doctorReport(result: DoctorResult): OkReport<DoctorData> | FindingsReport<DoctorData> {
  const data: DoctorData = {
    currentDir: result.projectContext.currentDir,
    projectRoot: result.projectContext.projectRoot,
    configPath: result.projectContext.configPath,
    checks: result.checks,
  };
  const issues = result.checks.flatMap((check) => checkIssue(check) ?? []);
  return buildReport({ examined: result.checks.length, findings: toFindings(issues), data, gate: DOCTOR_GATE });
}

/**
 * Main command handler for Commander.js
 */
export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose vat setup and environment')
    .option('-v, --verbose', 'Show all checks including passing ones')
    .addOption(
      new Option('--format <format>', 'Output format: yaml (default), json, or text')
        .choices(['yaml', 'json', 'text'])
        .default('yaml'),
    )
    .addHelpText('after', `
When to run:
  • Before starting development (ensure environment is ready)
  • After installing or updating vat
  • When debugging setup issues
  • In CI/CD pipelines (validate build environment)

Output:
  The report document on stdout (YAML by default, --format json): data.checks
  holds every check with its outcome, message and suggestion, and each failed or
  undetermined check is also a finding. The human check block goes to stderr.
  --format text puts that block on stdout instead, listing every check.

Exit Codes:
  0 - No check failed (an undetermined check is a warning finding, not fatal)
  1 - One or more checks failed (DOCTOR_CHECK_FAILED findings)
  2 - Doctor itself could not run; the document's error names why

Outcomes:
  ✅ pass          the check ran and the thing is fine
  ❌ fail          the check ran and the thing is wrong (DOCTOR_CHECK_FAILED, exit 1)
  ❓ undetermined  the check could not reach an answer — nothing was verified (DOCTOR_CHECK_WARNED)
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
      const localOptions = this.opts<{ verbose?: boolean; format: DocumentFormat }>();
      const parentOptions = this.parent?.opts<{ verbose?: boolean }>();
      const verbose = localOptions.verbose ?? parentOptions?.verbose ?? false;
      const format = localOptions.format;

      let result: DoctorResult;
      try {
        result = await runDoctor({ verbose });
      } catch (error) {
        // The command crashed: not a failed check, a run that produced no verdict.
        endWithRefusal('doctor', refusalCodeOf(error), error, format, DOCTOR_GATE, NOTHING_FINISHED);
      }

      const report = doctorReport(result);
      // Under --format text the block IS the stdout rendering; printing it here too would say it twice.
      if (format !== 'text') {
        process.stderr.write(renderDoctorBlock(report.data, verbose));
      }
      endWithReport('doctor', report, format);
    });
}

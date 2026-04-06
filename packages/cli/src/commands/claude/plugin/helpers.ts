/**
 * Helper functions for installing skills from various sources
 *
 * Supports:
 * - npm packages (npm:@scope/package)
 * - Local directories
 * - ZIP files
 * - npm postinstall hook
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';


import { safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import * as tar from 'tar';


export type SkillSource = 'npm' | 'local' | 'zip' | 'tgz' | 'npm-postinstall' | 'dev';

export interface PackageJsonVatReplaces {
  /** Old plugin names (without marketplace) this package used to publish under */
  plugins?: string[];
  /** Old skill names previously installed to ~/.claude/skills/<name> (legacy flat location) */
  flatSkills?: string[];
}

export interface PackageJsonVat {
  version?: string;
  // DEPRECATED(v0.1.x): vat.type — tolerated but ignored
  type?: string;
  skills?: string[];
  replaces?: PackageJsonVatReplaces;
}

export interface PackageJson {
  name: string;
  version: string;
  vat?: PackageJsonVat;
}

/**
 * Detect source type from user input
 */
export function detectSource(input: string): SkillSource {
  // Special flag for npm postinstall hook
  if (input === '--npm-postinstall') {
    return 'npm-postinstall';
  }

  // npm package with explicit prefix
  if (input.startsWith('npm:')) {
    return 'npm';
  }

  // ZIP file (explicit extension)
  if (input.endsWith('.zip')) {
    return 'zip';
  }

  // npm tarball (explicit extension)
  if (input.endsWith('.tgz') || input.endsWith('.tar.gz')) {
    return 'tgz';
  }

  // Check filesystem
  const absolutePath = safePath.resolve(input);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
  if (existsSync(absolutePath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument, validated above
    const stat = statSync(absolutePath);

    if (stat.isDirectory()) {
      return 'local';
    }

    if (stat.isFile()) {
      if (absolutePath.endsWith('.tgz') || absolutePath.endsWith('.tar.gz')) {
        return 'tgz';
      }
      return 'zip';
    }
  }

  throw new Error(
    `Cannot detect source type for: ${input}\n` +
      `Expected: npm:package-name, /path/to/dir, /path/to/file.zip, or --npm-postinstall`
  );
}

/**
 * Read package.json and extract vat field
 */
export async function readPackageJsonVatMetadata(
  dir: string
): Promise<{ packageJson: PackageJson; skills: string[] }> {
  const packageJsonPath = safePath.join(dir, 'package.json');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Directory path validated by caller
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in: ${dir}`);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Directory path validated by caller
  const content = await readFile(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(content) as PackageJson;

  if (!packageJson.vat?.skills || packageJson.vat.skills.length === 0) {
    throw new Error(
      `No skills found in package.json vat.skills field.\n` +
        `Package: ${packageJson.name}\n` +
        `Expected vat.skills array with at least one skill.`
    );
  }

  return {
    packageJson,
    skills: packageJson.vat.skills,
  };
}

/**
 * Download and extract npm package to temp directory
 * Returns path to extracted package
 *
 * Uses npm pack to download, then tar npm package for cross-platform extraction
 */
export function downloadNpmPackage(packageName: string, tempDir: string): string {
  // Remove npm: prefix if present
  const actualPackageName = packageName.startsWith('npm:')
    ? packageName.slice(4)
    : packageName;

  // Use npm pack to download package (creates .tgz in current dir)
  const packOutput = safeExecSync('npm', ['pack', actualPackageName], {
    cwd: tempDir,
    encoding: 'utf-8',
  });

  if (!packOutput) {
    throw new Error(`npm pack failed for package: ${actualPackageName}`);
  }

  // npm pack outputs the filename (e.g., "package-1.0.0.tgz")
  const tarballName = packOutput.toString().trim();
  const tarballPath = safePath.join(tempDir, tarballName);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is constructed from temp dir
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack succeeded but tarball not found: ${tarballPath}`);
  }

  // Extract tarball using tar npm package (cross-platform)
  // Creates package/ subdirectory
  tar.extract({
    file: tarballPath,
    cwd: tempDir,
    sync: true,
  });

  const packageDir = safePath.join(tempDir, 'package');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is constructed from temp dir
  if (!existsSync(packageDir)) {
    throw new Error(`npm tarball extracted but package/ directory not found`);
  }

  return packageDir;
}

/**
 * Case-insensitive environment variable lookup.
 *
 * npm sets lifecycle env vars lowercase (e.g. `npm_config_global`), but Windows
 * normalizes env var names to uppercase in the process environment block. When a
 * test passes `{ npm_config_global: 'true' }` and process.env already contains
 * `NPM_CONFIG_GLOBAL`, the merged object ends up with BOTH keys as separate
 * JavaScript properties. Windows `CreateProcess` behavior with duplicate
 * case-insensitive env var names is undefined — the uppercase version may win.
 *
 * This helper searches case-insensitively so the check works regardless of which
 * casing Windows chose to preserve.
 */
function getEnvCI(key: string): string | undefined {
  // Direct lookup first — on Windows, Node.js process.env is already case-insensitive
  // when reading from the real OS env. This fast path covers the normal runtime case.
  const direct = process.env[key];
  if (direct !== undefined) return direct;

  // Fallback: iterate to find a case-insensitive match. Handles the case where a
  // spawned child process received the key under a different casing than expected
  // (e.g. NPM_CONFIG_GLOBAL instead of npm_config_global).
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Validate npm postinstall environment
 * Returns true if running in global install context (but not during npm link)
 */
export function isGlobalNpmInstall(): boolean {
  // Check if npm_config_global is set (npm sets this during global installs).
  // Uses case-insensitive lookup because Windows normalizes env var names to
  // uppercase, which can cause the lowercase key to be missed on Windows CI.
  const isGlobal = getEnvCI('npm_config_global') === 'true';

  // Check if running as postinstall script
  const isPostinstall = getEnvCI('npm_lifecycle_event') === 'postinstall';

  // Check npm command to distinguish between:
  // - npm install -g → npm_command === 'install' → Run postinstall ✅
  // - npm link → npm_command === 'link' → Skip postinstall ✅
  // This prevents npm link from corrupting npm's internal state
  const isInstallCommand = getEnvCI('npm_command') === 'install';

  return isGlobal && isPostinstall && isInstallCommand;
}

/**
 * Write the common YAML header for skill command output
 * Eliminates duplication between install and uninstall output functions
 */
export function writeYamlHeader(dryRun?: boolean): void {
  process.stdout.write('---\n');
  process.stdout.write(`status: success\n`);
  if (dryRun) {
    process.stdout.write(`dryRun: true\n`);
  }
}

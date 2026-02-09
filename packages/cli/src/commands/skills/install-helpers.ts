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
import { join, resolve } from 'node:path';

import type { VatSkillMetadata } from '@vibe-agent-toolkit/agent-schema';
import { safeExecSync } from '@vibe-agent-toolkit/utils';
import * as tar from 'tar';

export type SkillSource = 'npm' | 'local' | 'zip' | 'npm-postinstall';

export interface PackageJsonVat {
  version?: string;
  type?: string;
  skills?: VatSkillMetadata[];
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

  // Check filesystem
  const absolutePath = resolve(input);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
  if (existsSync(absolutePath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument, validated above
    const stat = statSync(absolutePath);

    if (stat.isDirectory()) {
      return 'local';
    }

    if (stat.isFile()) {
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
): Promise<{ packageJson: PackageJson; skills: VatSkillMetadata[] }> {
  const packageJsonPath = join(dir, 'package.json');

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
  const tarballPath = join(tempDir, tarballName);

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

  const packageDir = join(tempDir, 'package');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is constructed from temp dir
  if (!existsSync(packageDir)) {
    throw new Error(`npm tarball extracted but package/ directory not found`);
  }

  return packageDir;
}

/**
 * Validate npm postinstall environment
 * Returns true if running in global install context (but not during npm link)
 */
export function isGlobalNpmInstall(): boolean {
  // Check if npm_config_global is set (npm sets this during global installs)
  const isGlobal = process.env['npm_config_global'] === 'true';

  // Check if running as postinstall script
  const isPostinstall = process.env['npm_lifecycle_event'] === 'postinstall';

  // Check npm command to distinguish between:
  // - npm install -g → npm_command === 'install' → Run postinstall ✅
  // - npm link → npm_command === 'link' → Skip postinstall ✅
  // This prevents npm link from corrupting npm's internal state
  const isInstallCommand = process.env['npm_command'] === 'install';

  return isGlobal && isPostinstall && isInstallCommand;
}

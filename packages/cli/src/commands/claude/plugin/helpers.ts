/**
 * Helper functions for installing skills from various sources
 *
 * Supports:
 * - npm packages (npm:@scope/package)
 * - Local directories
 * - ZIP files
 * - npm postinstall hook
 */

import { existsSync, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import * as tar from 'tar';
import { z } from 'zod';

import { CommandRefusalError } from '../../../utils/command-refusal.js';
import { unstatablePathRefusal } from '../../../utils/project-root-policy.js';


export type SkillSource = 'npm' | 'local' | 'zip' | 'tgz' | 'npm-postinstall' | 'dev';

/**
 * `package.json` `vat.replaces`: what an install removes once the package is in
 * place. Strict, because every entry becomes an uninstall or an `rm -rf` — a
 * string where the array belongs was walked letter by letter, each letter
 * uninstalled or removed as a name.
 */
const PackageJsonVatReplacesSchema = z.object({
  /** Old plugin names (without marketplace) this package used to publish under */
  plugins: z.array(z.string()).optional(),
  /** Old skill names previously installed to ~/.claude/skills/<name> (legacy flat location) */
  flatSkills: z.array(z.string()).optional(),
}).strict();

export type PackageJsonVatReplaces = z.infer<typeof PackageJsonVatReplacesSchema>;

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

/** What an install source looks like, for a refusal of one that is not. */
const SOURCE_FORMS_HINT = 'Expected: npm:package-name, /path/to/dir, /path/to/file.zip, or /path/to/file.tgz';

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

  // Check filesystem: a path naming nothing is the invocation's mistake, one the OS refuses the input's.
  const absolutePath = safePath.resolve(input);
  let stat: Stats;
  try {
    stat = statSync(absolutePath);
  } catch (error) {
    const refusal = unstatablePathRefusal(absolutePath, error);
    // A bare word that names nothing is most often a source typed wrong: say what a source looks like.
    throw new CommandRefusalError(refusal.refusal, `${refusal.message}\n${SOURCE_FORMS_HINT}`, { cause: error });
  }

  if (stat.isDirectory()) {
    return 'local';
  }

  if (stat.isFile()) {
    return 'zip';
  }

  throw new CommandRefusalError('USAGE_INVALID', `Cannot detect source type for: ${input}\n${SOURCE_FORMS_HINT}`);
}

/**
 * Read `dir/package.json`: absent is the invocation's mistake, unreadable or
 * not JSON the input's.
 */
export async function readPackageJson(dir: string): Promise<PackageJson> {
  const packageJsonPath = safePath.join(dir, 'package.json');
  let content: string;
  try {
    content = await readFile(packageJsonPath, 'utf-8');
  } catch (error) {
    throw unstatablePathRefusal(packageJsonPath, error);
  }
  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(content) as PackageJson;
  } catch (error) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${packageJsonPath} is not valid JSON: ${String(error)}`, { cause: error });
  }
  assertVatReplacesShape(packageJson, packageJsonPath);
  return packageJson;
}

/**
 * Refuse, before anything is read further or changed, a `vat.replaces` that is
 * not `{ plugins?: string[], flatSkills?: string[] }`. The package is the
 * input, so its malformed field is the input's refusal (`INPUT_UNREADABLE`),
 * naming the package and the field.
 */
function assertVatReplacesShape(packageJson: PackageJson, packageJsonPath: string): void {
  const replaces: unknown = (packageJson as { vat?: { replaces?: unknown } } | null)?.vat?.replaces;
  if (replaces === undefined) return;
  const result = PackageJsonVatReplacesSchema.safeParse(replaces);
  if (result.success) return;
  const problems = result.error.issues
    .map((issue) => `${['vat', 'replaces', ...issue.path.map(String)].join('.')}: ${issue.message}`)
    .join('; ');
  throw new CommandRefusalError(
    'INPUT_UNREADABLE',
    `Package ${String(packageJson.name)} cannot be installed, nothing was changed: ${packageJsonPath} ${problems}. ` +
      'vat.replaces is { plugins?: string[], flatSkills?: string[] }.',
  );
}

/**
 * Read package.json and extract vat field
 */
export async function readPackageJsonVatMetadata(
  dir: string
): Promise<{ packageJson: PackageJson; skills: string[] }> {
  const packageJson = await readPackageJson(dir);

  if (!packageJson.vat?.skills || packageJson.vat.skills.length === 0) {
    throw new CommandRefusalError(
      'INPUT_UNREADABLE',
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

  // Use npm pack to download package (creates .tgz in current dir). A failure
  // here is the registry's or the network's answer, not VAT's defect.
  let packOutput: string | Buffer;
  try {
    packOutput = safeExecSync('npm', ['pack', actualPackageName], {
      cwd: tempDir,
      encoding: 'utf-8',
    });
  } catch (error) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `npm pack failed for package ${actualPackageName}: ${String(error)}`, { cause: error });
  }

  if (!packOutput) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `npm pack failed for package: ${actualPackageName}`);
  }

  // npm pack outputs the filename (e.g., "package-1.0.0.tgz")
  const tarballName = packOutput.toString().trim();
  const tarballPath = safePath.join(tempDir, tarballName);

  if (!existsSync(tarballPath)) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `npm pack succeeded but tarball not found: ${tarballPath}`);
  }

  // Extract tarball using tar npm package (cross-platform)
  // Creates package/ subdirectory
  tar.extract({
    file: tarballPath,
    cwd: tempDir,
    sync: true,
  });

  const packageDir = safePath.join(tempDir, 'package');

  if (!existsSync(packageDir)) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', 'npm tarball extracted but package/ directory not found');
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

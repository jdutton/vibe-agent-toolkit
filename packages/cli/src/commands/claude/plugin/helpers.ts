/**
 * Helper functions for installing skills from various sources
 *
 * Supports:
 * - npm packages (npm:@scope/package)
 * - Local directories
 * - ZIP files
 * - npm postinstall hook
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { type FsSide, pathPresent, safePath } from '@vibe-agent-toolkit/utils';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import { z } from 'zod';

import { extractTarballSync } from '../../../utils/archive-staging.js';
import { CommandRefusalError } from '../../../utils/command-refusal.js';
import { requireInputPath } from '../../../utils/project-root-policy.js';


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

/** Every name once: a list that names one skill twice plans two changes over one directory. */
const hasNoDuplicate = (names: readonly string[]): boolean => new Set(names).size === names.length;

/**
 * Everything an install reads from a package's `package.json`, as ONE schema: `name`, `version`,
 * `vat.skills` and `vat.replaces`. Each becomes a path, a registry key or a list the install walks,
 * so a wrong type is refused here — the package is the input (`INPUT_UNREADABLE`) — and never met
 * later as a `TypeError` or as a string walked letter by letter.
 *
 * Passthrough at both levels, on purpose: `package.json` is npm's file (every other top-level key is
 * npm's or another tool's), and `vat` carries keys other verbs own (`vat.version`, the tolerated
 * `vat.type`, `vat.pureJs`), which an install does not read and must not refuse.
 */
const PackageJsonForInstallSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  vat: z.object({
    skills: z.array(z.string()).refine(hasNoDuplicate, 'names a skill more than once').optional(),
    replaces: PackageJsonVatReplacesSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

type PackageJsonForInstall = z.infer<typeof PackageJsonForInstallSchema>;

export type PackageJsonVat = NonNullable<PackageJsonForInstall['vat']>;

/** A package's `package.json`, as far as an install reads it. `version` is absent for a package that declares none. */
export interface PackageJson {
  name: string;
  version?: string | undefined;
  vat?: PackageJsonVat | undefined;
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
  // A bare word that names nothing is most often a source typed wrong: say what a source looks like.
  const stat = requireInputPath(absolutePath, { origin: 'argument', message: `Path does not exist: ${absolutePath}\n${SOURCE_FORMS_HINT}` });

  if (stat.isDirectory()) {
    return 'local';
  }

  if (stat.isFile()) {
    return 'zip';
  }

  throw new CommandRefusalError('USAGE_INVALID', `Cannot detect source type for: ${input}\n${SOURCE_FORMS_HINT}`);
}

/**
 * Read `dir/package.json` as an install reads it ({@link PackageJsonForInstallSchema}). The package
 * is the input, so everything wrong with what it HOLDS is the input's refusal (`INPUT_UNREADABLE`),
 * nothing changed: no `package.json` at all (naming `packageLabel`, since for an archive `dir` is
 * VAT's staging and names nothing the user has), not JSON, or a field of the wrong shape (naming
 * it). A read the OS refuses propagates for the caller to classify by path.
 *
 * @param dir - The package directory
 * @param from - The side `dir` is on (the operator's tree, or VAT's staging of an archive or a
 *   download), and what the user named as the package: the directory, the archive, or the npm spec
 */
export async function readPackageJson(dir: string, from: { readonly side: FsSide; readonly label: string }): Promise<PackageJson> {
  const packageJsonPath = safePath.join(dir, 'package.json');
  // Asked first, and believed only when the directory's listing agrees: a package with no
  // package.json is the input's shape, never "VAT's scratch space vanished".
  if (!pathPresent(packageJsonPath, 'follow', from.side, 'confirmed')) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${from.label} holds no package.json, so it is not a package VAT can install; nothing was changed.`);
  }
  // A read the OS refuses propagates as the errno: the install classifies it by the path it
  // names (the package the operator named, or VAT's staging of an archive or a download).
  const content = await readFile(packageJsonPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${packageJsonPath} is not valid JSON: ${String(error)}`, { cause: error });
  }
  const result = PackageJsonForInstallSchema.safeParse(parsed);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.map(String).join('.') || 'the document'}: ${issue.message}`).join('; ');
  // By its own name where it has one: the label is the path the user typed, the name what they know it as.
  const declared: unknown = (parsed as { name?: unknown } | null)?.name;
  const named = typeof declared === 'string' && declared !== '' ? `Package ${declared}` : from.label;
  throw new CommandRefusalError(
    'INPUT_UNREADABLE',
    `${named} cannot be installed, nothing was changed: ${packageJsonPath} — ${problems}. ` +
      'An install reads name (a string), version (a string), vat.skills (string[], each skill once) and vat.replaces ({ plugins?: string[], flatSkills?: string[] }).',
  );
}

/**
 * Read package.json and extract vat field
 */
export async function readPackageJsonVatMetadata(
  dir: string,
  from: { readonly side: FsSide; readonly label: string },
): Promise<{ packageJson: PackageJson; skills: string[] }> {
  const packageJson = await readPackageJson(dir, from);

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

  // Creates package/ subdirectory; an entry that cannot be extracted refuses, never installs without it
  extractTarballSync(tarballPath, tempDir);

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

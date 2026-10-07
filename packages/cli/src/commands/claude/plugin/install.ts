/**
 * Install skill packages to Claude Code plugins directory
 *
 * Supports installing from:
 * - npm packages (npm:@scope/package)
 * - Local ZIP file
 * - Local directory
 * - npm postinstall hook (--npm-postinstall)
 *
 * Plugin detection: looks for dist/.claude/plugins/marketplaces/ directory.
 * When present, copies the pre-built directory tree to ~/.claude/plugins/
 * and updates Claude's plugin registry files. When absent, falls back to
 * copying dist/skills/ to ~/.claude/skills/.
 */


import { existsSync, lstatSync, readdirSync, cpSync, statSync, type Dirent } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { basename } from 'node:path';

import { readDeclaredSkillName } from '@vibe-agent-toolkit/agent-skills';
import { codedUserStateWrite, getClaudeUserPaths, installPlugin, PLUGIN_KEY_INVALID_CODE, replaceDirectory, requirePluginInstallNames, requirePluginSource, uninstallPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { buildReport, createRegistryIssue, toFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { direntKindFollowingSync, forEachInOrder, isPathAbsentError, isSingleFsSegment, isVatError, normalizedTmpdir, toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import AdmZip from 'adm-zip';
import { Command } from 'commander';
import * as tar from 'tar';

import { CommandRefusalError, refusalCodeOf } from '../../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED, type FinishedWork } from '../../../utils/document-writer.js';
import { createLogger } from '../../../utils/logger.js';
import { unstatablePathRefusal } from '../../../utils/project-root-policy.js';

import {
  detectSource,
  downloadNpmPackage,
  isGlobalNpmInstall,
  readPackageJson,
  readPackageJsonVatMetadata,
  type PackageJson,
  type PackageJsonVatReplaces,
  type SkillSource,
} from './helpers.js';
import type { PluginInstallData, PluginInstallReport } from './install-schema.js';

type Logger = ReturnType<typeof createLogger>;

/** Relative path within a VAT npm package to its pre-built plugin structure. */
const PLUGIN_MARKETPLACES_SUBPATH = safePath.join('dist', '.claude', 'plugins', 'marketplaces');

/** `vat claude plugin install` has no `--strict`: a warning never fails it. */
const GATE = { strict: false } as const;

/** One install source resolved per run — the `--npm-postinstall` lane included. */
const INSTALL_SOURCES = 1;

/**
 * Where the child `vat build`'s streams go. Its stdout is sent straight to
 * this process's stderr (fd 2): this verb's stdout carries only its own
 * report, and a PIPE would buffer the build's document under spawnSync's
 * 1 MiB `maxBuffer` — a larger one kills the child with ENOBUFS.
 */
const BUILD_CHILD_STDIO: ['inherit', number, 'inherit'] = ['inherit', 2, 'inherit'];

/** One skill the run installed (or, under `--dry-run`, would install). */
interface InstalledSkill {
  name: string;
  installPath: string;
  /** The build a `--dev` link points at; `null` for a copy. */
  sourcePath: string | null;
}

/** What one install run did: the report's `data`, less `dryRun`, and its findings. */
export interface InstallOutcome {
  source: string;
  sourceType: SkillSource;
  symlink: boolean;
  skills: InstalledSkill[];
  issues: ValidationIssue[];
}

/**
 * One install run: the invocation, and what it has done SO FAR. Every lane
 * records each skill the moment it is on disk, so a refusal on skill k still
 * reports skills 1..k-1 — the catch reads the same record the report does.
 */
interface InstallRun {
  readonly options: PluginInstallCommandOptions;
  readonly logger: Logger;
  readonly dryRun: boolean;
  /** Set by the lane as soon as it knows what it installs from. */
  source: { label: string; type: SkillSource; symlink: boolean } | undefined;
  readonly skills: InstalledSkill[];
  readonly issues: ValidationIssue[];
}

/** Name the source the run installs from. */
function setSource(run: InstallRun, label: string, type: SkillSource, symlink = false): void {
  run.source = { label, type, symlink };
}

/** The run as an outcome, or `undefined` before any lane named its source. */
function outcomeOf(run: InstallRun): InstallOutcome | undefined {
  if (run.source === undefined) return undefined;
  return { source: run.source.label, sourceType: run.source.type, symlink: run.source.symlink, skills: run.skills, issues: run.issues };
}

/** The report's `data` for an outcome. */
function installData(outcome: InstallOutcome, dryRun: boolean): PluginInstallData {
  return { source: outcome.source, sourceType: outcome.sourceType, dryRun, symlink: outcome.symlink, skills: outcome.skills };
}

/**
 * What finished before a refusal: every skill already installed, and every
 * finding already made — or {@link NOTHING_FINISHED} when there is none.
 */
export function installFinished(outcome: InstallOutcome | undefined, dryRun: boolean): FinishedWork {
  if (outcome === undefined || (outcome.skills.length === 0 && outcome.issues.length === 0)) return NOTHING_FINISHED;
  return { examined: INSTALL_SOURCES, findings: toFindings(outcome.issues), data: installData(outcome, dryRun) };
}

/**
 * Whether `path` exists. Absent is `false`; a path the OS refuses to stat is
 * the input's refusal, never "absent" (`existsSync` answers `false` for both).
 */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw unstatablePathRefusal(path, error);
  }
}

/** A source FILE argument (a .zip, a .tgz): absent is the invocation's mistake, refused the input's. */
function assertSourceFile(path: string): void {
  try {
    statSync(path);
  } catch (error) {
    throw unstatablePathRefusal(path, error);
  }
}

/** The skills `--name` selects from a package's declared list; naming one it lacks is the invocation's mistake. */
function selectSkills(skills: readonly string[], name: string | undefined, packageName: string): string[] {
  if (name === undefined) return [...skills];
  const selected = skills.filter((skill) => skill === name);
  if (selected.length === 0) {
    throw new CommandRefusalError('USAGE_INVALID', `Skill "${name}" not found in package ${packageName}. Available: ${skills.join(', ')}`);
  }
  return selected;
}

/**
 * List immediate subdirectory names inside a directory of the PACKAGE being
 * installed, following links. Returns an empty array when the directory does
 * not exist; one the OS will not list (or an entry it will not stat) is the
 * package's refusal, `INPUT_UNREADABLE` — it used to escape raw, as INTERNAL_ERROR.
 *
 * Followed on purpose: a `--dev` install puts a plugin or marketplace here AS
 * a symlink, and `Dirent.isDirectory()` is false for a link — so every dev
 * install was invisible to the listing that uninstalls, lists and re-installs.
 */
function listSubdirectories(dir: string): string[] {
  const refusal = (path: string, error: unknown): CommandRefusalError =>
    new CommandRefusalError('INPUT_UNREADABLE', `Could not read the package to install at ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)}).`, { cause: error });
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isPathAbsentError(error)) return [];
    throw refusal(dir, error);
  }
  return entries
    .filter((d) => {
      try {
        return direntKindFollowingSync(dir, d) === 'directory';
      } catch (error) {
        throw refusal(safePath.join(dir, d.name), error);
      }
    })
    .map(d => d.name);
}

/**
 * Register a plugin in the Claude plugin registry. A failure propagates coded
 * (`CLAUDE_USER_STATE_UNREADABLE`, `CLAUDE_USER_STATE_WRITE_FAILED`): a plugin
 * that is not registered is never reported installed.
 */
async function registerPlugin(
  run: InstallRun,
  ctx: { mpName: string; pluginName: string; pluginDir: string; version: string; packageName: string },
  paths: ReturnType<typeof getClaudeUserPaths>,
): Promise<void> {
  const pluginKey = `${ctx.pluginName}@${ctx.mpName}`;
  const { warnings } = await installPlugin({
    marketplaceName: ctx.mpName,
    pluginName: ctx.pluginName,
    pluginDir: ctx.pluginDir,
    version: ctx.version,
    source: { source: 'npm', package: ctx.packageName, version: ctx.version },
    paths,
  });
  run.logger.info(`   Registered plugin ${pluginKey} in Claude plugin registry`);
  reportCleanupWarnings(run, warnings, pluginKey);
}

/**
 * Each previous tree a staged replace could not remove, as a warning: the
 * install is complete, and what it could not clean up still belongs in the report.
 *
 * @param location - The plugin key, or the marketplace name for its own copy
 */
function reportCleanupWarnings(run: InstallRun, warnings: readonly string[], location: string): void {
  for (const warning of warnings) {
    run.logger.warn(`   ${warning}`);
    run.issues.push({
      code: 'PLUGIN_INSTALL_CLEANUP_INCOMPLETE',
      severity: 'warning',
      message: warning,
      location,
      fix: 'Remove the directory the message names yourself (make it writable first if the OS refused); the installed plugin does not use it.',
    });
  }
}

/**
 * Refuse, before anything under ~/.claude changes, a package whose plugin tree
 * or `vat.replaces` names something that cannot be installed or removed: a
 * plugin or marketplace directory, the package version, a replaced plugin, or a
 * replaced flat skill that is not one path segment (or a dot-led version). Each
 * came from the PACKAGE, so the refusal is the input's (`INPUT_UNREADABLE`), not
 * the invocation's. (`vat.replaces`' SHAPE was already refused by `readPackageJson`.)
 */
function assertPackagePluginNames(
  marketplacesDir: string,
  marketplaceNames: readonly string[],
  packageJson: Pick<PackageJson, 'name' | 'vat'>,
  version: string,
): void {
  const check = (names: { marketplaceName: string; pluginName: string }, origin: string): void => {
    try {
      requirePluginInstallNames({ ...names, version });
    } catch (error) {
      if (!isVatError(error, PLUGIN_KEY_INVALID_CODE)) throw error;
      throw new CommandRefusalError('INPUT_UNREADABLE', `Package ${packageJson.name} cannot be installed, nothing was changed: ${error.message} (${origin}).`, { cause: error });
    }
  };
  for (const skillName of packageJson.vat?.replaces?.flatSkills ?? []) {
    if (!isSingleFsSegment(skillName)) {
      throw new CommandRefusalError(
        'INPUT_UNREADABLE',
        `Package ${packageJson.name} cannot be installed, nothing was changed: the legacy flat skill "${skillName}" it ` +
          'replaces (package.json vat.replaces.flatSkills) must be a single path segment (no separators, not "." or "..").',
      );
    }
  }
  for (const marketplaceName of marketplaceNames) {
    for (const pluginName of listSubdirectories(safePath.join(marketplacesDir, marketplaceName, 'plugins'))) {
      check({ marketplaceName, pluginName }, 'its built plugin tree and package.json version');
    }
    for (const pluginName of packageJson.vat?.replaces?.plugins ?? []) {
      check({ marketplaceName, pluginName }, 'package.json vat.replaces.plugins');
    }
  }
}

/**
 * Convert a skill name to a filesystem-safe path segment.
 * Colons in colon-namespaced names (e.g. "pkg:sub") become "__".
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

/**
 * A name about to become `join(skillsDir, name)` on a path that is deleted
 * or overwritten. Refused unless it is ONE entry name — the sweep installed a
 * SKILL.md declaring `name: ../victim` and watched `--force` delete
 * `<skillsDir>/../victim`, exit 0, `status: success`.
 *
 * @param name - The declared name, exactly as it arrived
 * @param origin - What declared it, for the refusal's wording
 * @returns `name`, unchanged, when it is a single segment
 * @throws When it is not
 */
export function assertSkillEntryName(name: string, origin: string): string {
  if (!isSingleFsSegment(name)) {
    throw new CommandRefusalError(
      'INPUT_UNREADABLE',
      `Refusing to install "${name}" (${origin}): a skill name must be a single path segment ` +
        `(no separators, not "." or "..").`,
    );
  }
  return name;
}

export interface PluginInstallCommandOptions {
  skillsDir?: string;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  npmPostinstall?: boolean;
  dev?: boolean;
  build?: boolean;
  userInstallWithoutPlugin?: boolean;
  target?: string;
  cwd?: string;
}

export function createPluginInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install skill packages to Claude Code plugins directory')
    .argument('[source]', 'Source to install from (npm:package, ZIP file, or directory path)')
    .option(
      '-s, --skills-dir <path>',
      'Claude skills directory',
      getClaudeUserPaths().skillsDir
    )
    .option('-n, --name <name>', 'Custom name for installed skill (default: auto-detect from source)')
    .option('-f, --force', 'Overwrite existing skill if present', false)
    .option('--dry-run', 'Preview installation without creating files', false)
    .option('--npm-postinstall', 'Run as npm postinstall hook (internal use)', false)
    .option('-d, --dev', 'Development mode: symlink skills from dist/skills/ (rebuilds reflected immediately)')
    .option('--build', 'Build skills before installing (implies --dev)')
    .option('--user-install-without-plugin', 'Force skills-only install (skip plugin registry even if dist/.claude/ exists)', false)
    .option('--target <target>', 'Target surface: code (default), claude.ai', 'code')
    .option('--debug', 'Enable debug logging')
    .option('--cwd <path>', 'Working directory for --dev install (default: current directory)')
    .action(installCommand)
    .addHelpText(
      'after',
      `
Description:
  Installs skill packages to Claude Code's plugins directory from various sources.

  Plugin detection: If the package contains dist/.claude/plugins/marketplaces/,
  the pre-built directory tree is copied to ~/.claude/plugins/ (dumb copy).
  Otherwise, falls back to copying dist/skills/ to ~/.claude/skills/.

  Supported sources:
  - npm package: npm:@scope/package-name
  - Local ZIP file: ./path/to/skill.zip
  - Local directory: ./path/to/skill-dir
  - npm postinstall: --npm-postinstall (automatic during global install)
  - Dev mode: --dev (symlinks from dist/skills/)

Output (YAML report on stdout):
  - status: ok, findings (a warning below), or error when the run could not install
  - examined: install sources resolved (1; a --npm-postinstall that skips is ok, skills: [])
  - data.source / data.sourceType: what was installed from (npm/local/zip/tgz/dev/npm-postinstall)
  - data.dryRun, data.symlink (true for --dev)
  - data.skills[]: { name, installPath, sourcePath } — sourcePath is the --dev link target, else null
  - findings: COMPONENT_DECLARED_BUT_MISSING (warning) for a --dev plugin skill whose build is missing;
    PLUGIN_INSTALL_CLEANUP_INCOMPLETE (warning) when a re-install could not remove a
    previous tree it replaced: the plugin cache (at the plugin key, left as
    .<version>.vat-staged-*.previous beside the version) or the marketplace copy (at
    the marketplace name, left as .<marketplace>.vat-staged-*.previous in
    ~/.claude/plugins/marketplaces/) — the install itself is complete

Exit Codes:
  0 - Installed (a warning does not fail the run)
  2 - The run could not install: a missing or unknown source, a skill that exists
      without --force, an unknown --target, a plain directory with no SKILL.md
      (USAGE_INVALID); --target claude.ai (NOT_IMPLEMENTED); an unreadable
      source (a package directory it cannot list included), a .zip that is
      not a ZIP archive, holds an entry that does not inflate or cannot be
      extracted, a package whose vat.replaces is not
      { plugins?: string[], flatSkills?: string[] }, whose plugin or marketplace
      directory, version, vat.replaces.plugins or vat.replaces.flatSkills entry
      is not one path segment (or whose version begins with "."), or a replaced
      flat skill the OS will not let it examine, refused before anything changes
      (INPUT_UNREADABLE); npm pack failing
      (EXTERNAL_API_FAILED); --build whose vat build failed, a staging copy
      under $TMPDIR it could not create or write (full, read-only), or a copy,
      registry write or removal that failed partway (RUN_INCOMPLETE). A refusal
      lists the skills already on disk. What vat.replaces names is removed only
      after the new install is in place, so a failed install leaves it
      installed; a replaced name that is the just-installed plugin on disk
      (Old -> old on a case-insensitive filesystem) loses only its registry entry.

Example:
  $ vat claude plugin install --dev                        # Symlink all skills from cwd
  $ vat claude plugin install --build                      # Build + symlink
  $ vat claude plugin install npm:@scope/package           # Install from npm
  $ vat claude plugin install --dev --cwd packages/vat-development-agents  # From monorepo root
`
    );

  return command;
}

/**
 * Build the report. Pure: no file system, no `process.exit`.
 *
 * @param outcome - What the install run did
 * @param dryRun - Whether anything was actually written
 * @param durationMs - How long the run took
 */
export function buildPluginInstallReport(outcome: InstallOutcome, dryRun: boolean, durationMs: number): PluginInstallReport {
  return buildReport({
    examined: INSTALL_SOURCES,
    findings: toFindings(outcome.issues),
    data: installData(outcome, dryRun),
    gate: GATE,
    durationMs,
  });
}

/** Refuse a `--target` this verb cannot install to. */
function assertInstallTarget(target: string): void {
  if (target === 'code') return;
  if (target === 'claude.ai') {
    throw new CommandRefusalError(
      'NOT_IMPLEMENTED',
      'claude.ai org provisioning API not yet confirmed as public. Use the claude.ai admin console to upload a .zip manually, '
        + 'or vat claude org skills install for workspace-scoped skill management.',
    );
  }
  throw new CommandRefusalError('USAGE_INVALID', `Unsupported --target "${target}": use code (default) or claude.ai.`);
}

/** Route the invocation to the lane that installs it. */
async function runInstall(source: string | undefined, run: InstallRun): Promise<void> {
  const { options, logger } = run;
  assertInstallTarget(options.target ?? 'code');

  // --build implies --dev
  if (options.build || options.dev) {
    await handleDevInstall(run);
    return;
  }
  if (options.npmPostinstall) {
    await handleNpmPostinstall(run);
    return;
  }

  // Regular install - source is required
  if (!source) {
    throw new CommandRefusalError('USAGE_INVALID', 'Source argument required. Use npm:package, ./dir, ./file.zip or ./file.tgz');
  }

  const sourceType = detectSource(source);
  logger.debug(`Detected source type: ${sourceType}`);

  switch (sourceType) {
    case 'npm':
      return handleNpmInstall(source, run);
    case 'local':
      return handleLocalInstall(source, run);
    case 'zip':
      return handleZipInstall(source, run);
    case 'tgz':
      return handleTgzInstall(source, run);
    case 'npm-postinstall':
    case 'dev':
      // detectSource never returns these for a positional source: each is a flag.
      throw new Error(`${sourceType} source type is handled by its own flag`);
  }
}

/** The human half, on stderr. */
function logInstallOutcome(outcome: InstallOutcome, dryRun: boolean, logger: Logger): void {
  const count = outcome.skills.length;
  if (outcome.symlink) {
    logger.info(dryRun ? `\n✅ Dry-run complete: ${count} skill(s) would be symlinked` : `\n✅ Dev-installed ${count} skill(s) via symlink`);
    if (!dryRun) logger.info(`   After rebuilding, run /reload-plugins in Claude Code`);
    return;
  }
  if (dryRun) {
    logger.info(`\n✅ Dry-run complete: ${count} skill(s) would be installed`);
    return;
  }
  logger.info(`\n✅ Installed ${count} skill(s)`);
  if (count > 0) {
    logger.info(`\n💡 Run 'vat claude plugin list' to verify installation`);
    logger.info(`   Restart Claude Code or run /reload-plugins to use the new skill`);
  }
}

async function installCommand(
  source: string | undefined,
  options: PluginInstallCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const dryRun = options.dryRun === true;
  const run: InstallRun = { options, logger, dryRun, source: undefined, skills: [], issues: [] };

  let outcome: InstallOutcome | undefined;
  try {
    await runInstall(source, run);
    outcome = outcomeOf(run);
    // Every lane names its source before it can return; reaching here without one is a defect.
    if (outcome === undefined) throw new Error('install lane returned without naming its source');
  } catch (error) {
    // Whatever installed before the refusal is still reported.
    endWithRefusal('claude plugin install', refusalCodeOf(error), error, 'yaml', GATE, installFinished(outcomeOf(run), dryRun));
  }

  logInstallOutcome(outcome, dryRun, logger);
  endWithReport('claude plugin install', buildPluginInstallReport(outcome, dryRun, Date.now() - startTime), 'yaml');
}

/**
 * Handle npm package installation
 */
async function handleNpmInstall(source: string, run: InstallRun): Promise<void> {
  const { options, logger } = run;
  const packageName = source.startsWith('npm:') ? source.slice(4) : source;
  setSource(run, `npm:${packageName}`, 'npm');

  logger.info(`📥 Installing skill from npm: ${packageName}`);

  const tempDir = await makeStagingDir('vat-install-npm-');

  try {
    logger.info('   Downloading package...');
    const extractedPath = downloadNpmPackage(packageName, tempDir);

    // If the package ships a pre-built plugin tree, install via dumb copy.
    const marketplacesDir = safePath.join(extractedPath, PLUGIN_MARKETPLACES_SUBPATH);
    if (!options.userInstallWithoutPlugin && pathExists(marketplacesDir)) {
      logger.info('   Plugin detected — installing via Claude plugin system');
      await copyPluginTree(run, marketplacesDir, await readPackageJson(extractedPath));
      return;
    }

    // No plugin tree — install skills directly to ~/.claude/skills/
    const { skills } = await readPackageJsonVatMetadata(extractedPath);
    await installDeclaredSkills(run, extractedPath, selectSkills(skills, options.name, packageName));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Copy each declared skill's `dist/skills/<name>` build into the skills directory. */
async function installDeclaredSkills(run: InstallRun, rootDir: string, skillNames: readonly string[]): Promise<void> {
  // In order: each install writes under ~/.claude, and the first refusal stops the run.
  await forEachInOrder(skillNames, (skillName) =>
    installSkillFromPath(run, safePath.join(rootDir, 'dist', 'skills', skillNameToFsPath(skillName)), skillName));
}

/**
 * Handle local directory installation
 */
async function handleLocalInstall(source: string, run: InstallRun): Promise<void> {
  const { options, logger } = run;
  const sourcePath = safePath.resolve(source);
  setSource(run, `local:${sourcePath}`, 'local');

  logger.info(`📥 Installing skill from directory: ${sourcePath}`);

  // Check for pre-built plugin tree first
  const marketplacesDir = safePath.join(sourcePath, PLUGIN_MARKETPLACES_SUBPATH);
  if (!options.userInstallWithoutPlugin && pathExists(marketplacesDir)) {
    await copyPluginTree(run, marketplacesDir, await readPackageJson(sourcePath));
    return;
  }

  // A directory with package.json installs each skill its vat.skills declares
  if (pathExists(safePath.join(sourcePath, 'package.json'))) {
    const { packageJson, skills } = await readPackageJsonVatMetadata(sourcePath);
    await installDeclaredSkills(run, sourcePath, selectSkills(skills, options.name, packageJson.name));
    return;
  }

  // Plain skill directory: it must hold a SKILL.md, or any directory would
  // install as a skill. A source that names nothing keeps its own refusal below.
  if (pathExists(sourcePath) && !pathExists(safePath.join(sourcePath, 'SKILL.md'))) {
    throw new CommandRefusalError('USAGE_INVALID', `No SKILL.md found at the root of: ${sourcePath}`);
  }
  // The package.json branch above installs each skill under its declared name;
  // do the same here rather than under whatever the source directory is called.
  const skillName =
    options.name ??
    readDeclaredSkillName(safePath.join(sourcePath, 'SKILL.md')) ??
    basename(sourcePath);
  await installSkillFromPath(run, sourcePath, skillName);
}

/**
 * Errnos that mean the disk VAT writes its staging copy to gave out — full, over
 * quota, read-only, out of descriptors, or failing — whatever archive it was writing.
 */
const STAGING_EXHAUSTED_ERRNOS: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO']);

/** VAT could not write its own staging copy at `path`: the run did not finish (`RUN_INCOMPLETE`), nothing was changed. */
function stagingRefusal(path: string, error: unknown): CommandRefusalError {
  return new CommandRefusalError(
    'RUN_INCOMPLETE',
    `Could not write the staging copy at ${path}, nothing was changed: ${error instanceof Error ? error.message : String(error)}. ` +
      'Free space in, or make writable, the temp directory ($TMPDIR), then re-run.',
    { cause: error },
  );
}

/** A fresh staging directory under the OS temp dir; one the OS will not create is {@link stagingRefusal}. */
async function makeStagingDir(prefix: string): Promise<string> {
  const template = safePath.join(normalizedTmpdir(), prefix);
  try {
    return await mkdtemp(template);
  } catch (error) {
    throw stagingRefusal(template, error);
  }
}

/**
 * Why `zip` could not be extracted into the staging directory `extracted`: the
 * disk giving out is the run not finishing (`RUN_INCOMPLETE`); anything else —
 * an entry that does not inflate, a file `a` beside a file `a/b` — is the
 * archive's (`INPUT_UNREADABLE`). Nothing outside the staging directory changed.
 */
export function zipExtractionRefusal(zipPath: string, extracted: string, error: unknown): CommandRefusalError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined && STAGING_EXHAUSTED_ERRNOS.has(code)) return stagingRefusal(extracted, error);
  return new CommandRefusalError('INPUT_UNREADABLE', `${zipPath} could not be extracted, nothing was changed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

/**
 * Handle ZIP file installation
 */
async function handleZipInstall(source: string, run: InstallRun): Promise<void> {
  const { options, logger } = run;
  const sourcePath = safePath.resolve(source);
  setSource(run, sourcePath, 'zip');

  logger.info(`📥 Installing skill from ZIP: ${sourcePath}`);
  assertSourceFile(sourcePath);

  // Read WHOLE before prepareInstallation: --force removes the skill being
  // replaced there. Opening parses only the central directory — entry data is
  // inflated (and its CRC checked) lazily, so a corrupt entry used to throw from
  // `extractAllTo`, uncoded, after the previous skill was already gone.
  let zip: AdmZip;
  try {
    zip = new AdmZip(sourcePath);
    for (const entry of zip.getEntries()) entry.getData();
  } catch (error) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `${sourcePath} could not be read as a ZIP archive: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const skillName = options.name ?? basename(sourcePath, '.zip');
  const installPath = checkInstallDestination(run, skillName);

  if (!run.dryRun) {
    logger.info('   Extracting ZIP...');
    // Extracted to a staging directory first, then swapped in: an archive the
    // pre-read accepts can still fail to EXTRACT (a file `a` and a file `a/b`),
    // and that used to happen in place, after --force had removed the skill.
    const tempDir = await makeStagingDir('vat-install-zip-');
    try {
      const extracted = safePath.join(tempDir, 'skill');
      try {
        await mkdir(extracted);
      } catch (error) {
        throw stagingRefusal(extracted, error);
      }
      try {
        zip.extractAllTo(extracted, /* overwrite */ true);
      } catch (error) {
        throw zipExtractionRefusal(sourcePath, extracted, error);
      }
      await swapInSkill(run, extracted, installPath, skillName);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  run.skills.push({ name: skillName, installPath, sourcePath: null });
}

/**
 * Handle npm tarball (.tgz / .tar.gz) installation.
 * npm pack format: all package files are under a `package/` subdirectory in the tarball.
 * Extracts to a temp directory then installs the plugin tree, or the declared skills.
 */
async function handleTgzInstall(source: string, run: InstallRun): Promise<void> {
  const { options, logger } = run;
  const sourcePath = safePath.resolve(source);
  setSource(run, sourcePath, 'tgz');

  logger.info(`📥 Installing skill from tarball: ${sourcePath}`);
  assertSourceFile(sourcePath);

  const tempDir = await makeStagingDir('vat-install-tgz-');

  try {
    logger.info('   Extracting tarball...');
    await tar.extract({ file: sourcePath, cwd: tempDir });

    // npm pack tarballs extract under package/ subdirectory
    const packageDir = safePath.join(tempDir, 'package');
    const extractedDir = existsSync(packageDir) ? packageDir : tempDir;

    const marketplacesDir = safePath.join(extractedDir, PLUGIN_MARKETPLACES_SUBPATH);
    if (!options.userInstallWithoutPlugin && pathExists(marketplacesDir)) {
      await copyPluginTree(run, marketplacesDir, await readPackageJson(extractedDir));
      return;
    }

    // Fallback: skills-only install
    const { packageJson, skills } = await readPackageJsonVatMetadata(extractedDir);
    await installDeclaredSkills(run, extractedDir, selectSkills(skills, options.name, packageJson.name));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Prepare destination for a dev symlink: remove any existing entry if --force.
 * Throws if the path exists and --force was not passed.
 */
async function prepareDevSymlinkDest(run: InstallRun, destPath: string, skillFsName: string): Promise<void> {
  // The probe is the ONLY thing whose failure may read as "nothing there". A
  // refusal on the probe, or a failed removal, stays loud: this used to catch
  // everything and recognise its own throw by the words in its message.
  try {
    lstatSync(destPath);
  } catch (error) {
    if (isPathAbsentError(error)) return;
    throw error;
  }
  if (!run.options.force) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Skill "${skillFsName}" already installed at ${destPath}.\n` +
        `Use --force to overwrite.`
    );
  }
  if (!run.dryRun) {
    await rm(destPath, { recursive: true, force: true });
  }
}

/** Where one plugin of a `--dev` install comes from and goes. */
interface DevPluginContext {
  mpName: string;
  pluginName: string;
  srcPluginDir: string;
  destPluginDir: string;
  packageName: string;
  version: string;
  cwd: string;
  paths: ReturnType<typeof getClaudeUserPaths>;
}

/**
 * Symlink a single skill directory from dist/skills/{name} into the plugin tree.
 * A skill the plugin tree declares but `dist/skills/` does not hold is not
 * linked, and is reported: the plugin installs without it.
 */
async function symlinkDevSkill(run: InstallRun, ctx: DevPluginContext, skillFsName: string, destSkillsDir: string): Promise<void> {
  const { cwd, pluginName } = ctx;
  const srcSkillPath = safePath.resolve(cwd, 'dist', 'skills', skillFsName);
  const destSkillPath = safePath.join(destSkillsDir, skillFsName);

  if (!pathExists(srcSkillPath)) {
    run.logger.info(`   Warning: skill not built at ${srcSkillPath} — skipping symlink`);
    run.issues.push(createRegistryIssue(
      'COMPONENT_DECLARED_BUT_MISSING',
      `Plugin "${pluginName}" declares skill "${skillFsName}", but it is not built — it was not linked. Run vat build, then re-install.`,
      { location: safePath.relative(cwd, srcSkillPath) },
    ));
    return;
  }

  await prepareDevSymlinkDest(run, destSkillPath, skillFsName);

  if (!run.dryRun) {
    try {
      // eslint-disable-next-line local/no-bare-symlink-in-tests -- eyes open: `handleDevInstall` refuses win32 upstream, so the Windows privilege hazard the rule names cannot be reached here.
      await symlink(srcSkillPath, destSkillPath, 'dir');
    } catch (error) {
      // ⚠️ POSIX-only in practice: `handleDevInstall` throws on win32 before
      // this call chain begins, so Windows-specific handling here would be dead
      // code — an earlier revision added exactly that. Making `--dev` work on
      // Windows means changing that guard (a junction needs no elevation), not
      // this catch. Not falling back to a copy either — dev mode exists so a
      // rebuild is picked up live, and a copy would quietly stop that.
      //
      // ⚠️ This throws mid-loop, after `devInstallMarketplace` already removed
      // the previous marketplace directory and `devInstallPlugin` copied the
      // non-skill content. Earlier skills are linked (and reported), later ones
      // are not, and `registerPlugin` never runs — so the tree is on disk but
      // unregistered. Recoverable by re-running, which starts over.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not symlink ${skillFsName} to ${destSkillPath}: ${detail}\n` +
          'Check that the destination directory is writable. This install is now ' +
          'incomplete — re-run the same command to start over.',
      );
    }
  }

  run.logger.info(`   Symlinked: ${safePath.relative(cwd, destSkillPath)} → ${srcSkillPath}`);
  run.skills.push({ name: `${pluginName}:${skillFsName}`, installPath: destSkillPath, sourcePath: srcSkillPath });
}

/**
 * Symlink all skill directories from a plugin's source skills dir into the destination.
 */
async function symlinkPluginSkills(run: InstallRun, ctx: DevPluginContext): Promise<void> {
  const srcSkillsDir = safePath.join(ctx.srcPluginDir, 'skills');
  if (!existsSync(srcSkillsDir)) return;

  const destSkillsDir = safePath.join(ctx.destPluginDir, 'skills');
  if (!run.dryRun) {
    await mkdir(destSkillsDir, { recursive: true });
  }

  // Followed: a skill directory that is itself a link is still a skill to link.
  const skillEntries = readdirSync(srcSkillsDir, { withFileTypes: true })
    .filter(d => direntKindFollowingSync(srcSkillsDir, d) === 'directory');
  // In order: each link writes under ~/.claude, and the dry-run log follows the listing.
  await forEachInOrder(skillEntries, (skillEntry) => symlinkDevSkill(run, ctx, skillEntry.name, destSkillsDir));
}

/**
 * Dev-install a single plugin: copy non-skill content, symlink skills, register.
 */
async function devInstallPlugin(run: InstallRun, ctx: DevPluginContext): Promise<void> {
  if (!run.dryRun) {
    await mkdir(ctx.destPluginDir, { recursive: true });
    // Copy non-skill entries (e.g. .claude-plugin/)
    for (const entry of readdirSync(ctx.srcPluginDir, { withFileTypes: true })) {
      if (entry.name !== 'skills') {
        cpSync(safePath.join(ctx.srcPluginDir, entry.name), safePath.join(ctx.destPluginDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  await symlinkPluginSkills(run, ctx);

  if (!run.dryRun) {
    await registerPlugin(run, { ...ctx, pluginDir: ctx.destPluginDir }, ctx.paths);
  }
}

/**
 * Dev-install a single marketplace: reset dir, copy non-plugin content, install each plugin.
 */
async function devInstallMarketplace(
  run: InstallRun,
  mpName: string,
  srcMpDir: string,
  packageInfo: { name: string; version: string; cwd: string },
): Promise<void> {
  const paths = getClaudeUserPaths();
  const destMpDir = safePath.join(paths.marketplacesDir, mpName);

  if (!run.dryRun) {
    await rm(destMpDir, { recursive: true, force: true });
    await mkdir(destMpDir, { recursive: true });
    // Copy non-plugin content (e.g. .claude-plugin/marketplace.json)
    for (const entry of readdirSync(srcMpDir, { withFileTypes: true })) {
      if (entry.name !== 'plugins') {
        cpSync(safePath.join(srcMpDir, entry.name), safePath.join(destMpDir, entry.name), { recursive: true, force: true });
      }
    }
  }
  run.logger.info(`   Marketplace: ${mpName} → ${destMpDir}`);

  const pluginsDir = safePath.join(srcMpDir, 'plugins');
  // In order: each plugin registers by read-modify-write of the ~/.claude registry files.
  await forEachInOrder(listSubdirectories(pluginsDir), (pluginName) =>
    devInstallPlugin(run, {
      mpName,
      pluginName,
      srcPluginDir: safePath.join(pluginsDir, pluginName),
      destPluginDir: safePath.join(destMpDir, 'plugins', pluginName),
      packageName: packageInfo.name,
      version: packageInfo.version,
      cwd: packageInfo.cwd,
      paths,
    }));
}

/**
 * Handle development mode installation via plugin tree (symlinks).
 *
 * Reads the pre-built plugin tree from dist/.claude/plugins/marketplaces/:
 * - Copies non-skill content (.claude-plugin/ dirs) to ~/.claude/plugins/
 * - For each skill directory under plugins/{plugin}/skills/{name}/, creates a
 *   symlink to the corresponding dist/skills/{name}/ directory
 * - Registers each plugin in the Claude plugin registry (same as copyPluginTree)
 *
 * Skills appear in Claude Code as {plugin}:{skill} instead of the flat {skill} name.
 */
async function handleDevInstall(run: InstallRun): Promise<void> {
  const { options, logger } = run;
  if (process.platform === 'win32') {
    throw new CommandRefusalError(
      'NOT_IMPLEMENTED',
      '--dev (symlink) not supported on Windows.\n' +
        'Use copy mode (omit --dev) or WSL for development.'
    );
  }

  // --cwd only applies to --dev mode; other paths (npm postinstall, etc.) use process.cwd()
  const cwd = options.cwd ? safePath.resolve(options.cwd) : process.cwd();

  if (options.build) {
    runBuild(cwd, logger);
  }

  // Check for pre-built plugin tree
  const marketplacesDir = safePath.join(cwd, PLUGIN_MARKETPLACES_SUBPATH);
  if (!pathExists(marketplacesDir)) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Plugin tree not found at ${marketplacesDir}\n` +
        `Run: vat build first (builds the plugin tree)`
    );
  }

  const packageJson = await readPackageJson(cwd);
  setSource(run, packageJson.name, 'dev', true);
  logger.info(`📥 Dev-installing plugin tree from ${packageJson.name}`);

  const packageInfo = { name: packageJson.name, version: packageJson.version ?? '0.0.0', cwd };
  const marketplaceNames = listSubdirectories(marketplacesDir);
  assertPackagePluginNames(marketplacesDir, marketplaceNames, packageJson, packageInfo.version);
  const paths = getClaudeUserPaths();
  const replaced = planReplaces(packageJson.vat?.replaces, marketplacesDir, marketplaceNames, paths);

  // In order: each marketplace registers by read-modify-write of the ~/.claude registry files.
  await forEachInOrder(marketplaceNames, (mpName) =>
    devInstallMarketplace(run, mpName, safePath.join(marketplacesDir, mpName), packageInfo));

  // Only once the new tree is in place: a failed install leaves what it replaces.
  await applyReplaces(replaced, paths, run.dryRun, logger);
}

/**
 * Shell out to `vat build` (skills + claude plugin tree) in `cwd`.
 *
 * Its stdout goes to this process's stderr ({@link BUILD_CHILD_STDIO}), never
 * through a buffered pipe. A build that exits non-zero, or one that cannot be
 * started, stops the install before anything is installed: `RUN_INCOMPLETE`.
 *
 * @throws A `RUN_INCOMPLETE` {@link CommandRefusalError}
 */
export function runBuild(cwd: string, logger: Logger): void {
  logger.info('🔨 Building first (skills + plugin tree)...');
  const binPath = safePath.resolve(safePath.join(import.meta.dirname, '../../../../bin/vat.js'));
  try {
    safeExecSync(process.execPath, [binPath, 'build'], { cwd, stdio: BUILD_CHILD_STDIO });
  } catch (error) {
    const why = isVatError(error, 'COMMAND_EXECUTION')
      ? 'vat build failed — its output above says why'
      : `vat build could not be run: ${String(error)}`;
    throw new CommandRefusalError('RUN_INCOMPLETE', `${why} (in ${cwd}), so nothing was installed.`, { cause: error });
  }
  logger.info('');
}

/**
 * Handle npm postinstall hook
 */
async function handleNpmPostinstall(run: InstallRun): Promise<void> {
  const { options, logger } = run;
  logger.info(`📥 Running npm postinstall hook`);

  // The postinstall lane resolves its source (the package directory) whether or
  // not it installs: a skip is an answer, `ok` with no skills — never a failure
  // inside `npm install -g`.
  const cwd = process.cwd();
  setSource(run, cwd, 'npm-postinstall');

  if (!isGlobalNpmInstall()) {
    logger.info('   Skipping: Not a global npm install');
    return;
  }

  if (!options.userInstallWithoutPlugin) {
    // Check for pre-built plugin tree (dist/.claude/plugins/marketplaces/)
    const marketplacesDir = safePath.join(cwd, PLUGIN_MARKETPLACES_SUBPATH);
    if (!pathExists(marketplacesDir)) {
      logger.info(`   No plugin tree found at dist/.claude/plugins/marketplaces/`);
      logger.info(`   Run 'vat build' to generate plugin artifacts before publishing.`);
      logger.info(`   Skipping install — no skills registered.`);
      return;
    }
    const packageJson = await readPackageJson(cwd);
    logger.info(`   Package: ${packageJson.name}@${packageJson.version ?? 'unknown'}`);
    logger.info(`   Plugin tree detected — copying to ~/.claude/plugins/`);
    await copyPluginTree(run, marketplacesDir, packageJson);
    return;
  }

  // --user-install-without-plugin: install skills directly to ~/.claude/skills/
  const { packageJson, skills } = await readPackageJsonVatMetadata(cwd);

  logger.info(`   Package: ${packageJson.name}@${packageJson.version ?? 'unknown'}`);
  logger.info(`   Skills found: ${skills.length}`);

  await installDeclaredSkills(run, cwd, skills);
}

/** What a package's `vat.replaces` removes, resolved and checked before anything changes. */
interface ReplacesPlan {
  /** `<plugin>@<marketplace>` keys to uninstall. */
  pluginKeys: string[];
  /** Legacy flat-skill paths under the skills directory that are there now. */
  flatSkillPaths: string[];
}

/**
 * Resolve `vat.replaces` against what is on disk, BEFORE anything changes:
 * every flat-skill entry is one path segment, and every flat-skill path the OS
 * refuses to examine is refused here (`INPUT_UNREADABLE`) — not after the new
 * install, when the run could only stop half-replaced. A replaced plugin the
 * package itself ships into that marketplace is not a removal: the install
 * replaces it, and uninstalling it afterwards would remove the new one.
 *
 * Each entry comes from the INSTALLED package's package.json and becomes an
 * `rm -rf` with no flag in front of it: `"../victim"` used to remove a sibling of
 * the skills dir, and with the default paths `"../.."` is $HOME.
 */
export function planReplaces(
  replaces: PackageJsonVatReplaces | undefined,
  marketplacesDir: string,
  marketplaceNames: readonly string[],
  paths: Pick<ReturnType<typeof getClaudeUserPaths>, 'skillsDir'>,
): ReplacesPlan {
  const flatSkillPaths: string[] = [];
  for (const skillName of replaces?.flatSkills ?? []) {
    const skillPath = safePath.join(paths.skillsDir, assertSkillEntryName(skillName, 'vat.replaces.flatSkills'));
    try {
      lstatSync(skillPath); // not following links: a dangling one is still a legacy install to remove
      flatSkillPaths.push(skillPath);
    } catch (error) {
      // Absent is nothing to remove. One the OS refuses to examine is not: the
      // legacy install is still there and a silent skip leaves it beside its replacement.
      if (!isPathAbsentError(error)) throw unstatablePathRefusal(skillPath, error);
    }
  }
  const pluginKeys: string[] = [];
  for (const mp of marketplaceNames) {
    const shipped = new Set(listSubdirectories(safePath.join(marketplacesDir, mp, 'plugins')));
    for (const oldPlugin of replaces?.plugins ?? []) {
      if (!shipped.has(oldPlugin)) pluginKeys.push(`${oldPlugin}@${mp}`);
    }
  }
  return { pluginKeys, flatSkillPaths };
}

/**
 * Remove what {@link planReplaces} resolved — run AFTER the new install is in
 * place, so a failed install leaves the user what it would have replaced.
 * A removal the OS refuses is the run stopping partway
 * (`CLAUDE_USER_STATE_WRITE_FAILED` → `RUN_INCOMPLETE`), the new install
 * already on disk and reported. Idempotent: `uninstallPlugin` handles "not found".
 */
export async function applyReplaces(
  plan: ReplacesPlan,
  paths: ReturnType<typeof getClaudeUserPaths>,
  dryRun: boolean,
  logger: Logger,
): Promise<void> {
  // In order: each uninstall is a read-modify-write of the ~/.claude registry files.
  await forEachInOrder(plan.pluginKeys, async (pluginKey) => {
    if (dryRun) {
      logger.info(`   [dry-run] Would uninstall old plugin: ${pluginKey}`);
      return;
    }
    logger.info(`   Removing old plugin: ${pluginKey}`);
    // A renamed plugin can be the one just installed on disk (`Old` → `old` on a
    // case-insensitive filesystem): the uninstall keeps that directory and says so.
    const { warning } = await uninstallPlugin({ pluginKey, paths, dryRun: false });
    if (warning !== undefined) logger.warn(`   ${warning}`);
  });
  // In order: the first removal the OS refuses stops the run, with the log naming each one before it.
  await forEachInOrder(plan.flatSkillPaths, async (skillPath) => {
    if (dryRun) {
      logger.info(`   [dry-run] Would remove legacy flat skill: ${toForwardSlash(skillPath)}`);
      return;
    }
    logger.info(`   Removing legacy flat skill: ${toForwardSlash(skillPath)}`);
    await codedUserStateWrite(
      `remove the legacy flat skill ${skillPath} this package replaces (the package itself is installed)`,
      () => rm(skillPath, { recursive: true, force: true }),
    );
  });
}

/**
 * Copy one marketplace into place and register its plugins. Its skills are
 * recorded once copied — before registration — so a registration that refuses
 * still reports what the copy left on disk.
 */
async function copyMarketplace(
  run: InstallRun,
  srcMpDir: string,
  ctx: { mpName: string; version: string; packageName: string; paths: ReturnType<typeof getClaudeUserPaths> },
): Promise<void> {
  const { logger, dryRun } = run;
  const destMpDir = safePath.join(ctx.paths.marketplacesDir, ctx.mpName);

  // Replace the marketplace directory entirely so skills removed from the
  // package do not persist in the user's Claude installation — staged and
  // swapped, never deleted first: a copy the OS refuses must leave the
  // installed marketplace (which the registry still points at) whole.
  logger.info(`   ${dryRun ? '[dry-run] Would copy' : 'Copying'} marketplace: ${ctx.mpName} → ${destMpDir}`);
  if (!dryRun) {
    const warnings = await codedUserStateWrite(`copy marketplace ${ctx.mpName} to ${destMpDir}`, () => replaceDirectory(srcMpDir, destMpDir));
    reportCleanupWarnings(run, warnings, ctx.mpName);
  }

  const pluginNames = listSubdirectories(safePath.join(srcMpDir, 'plugins'));
  for (const pluginName of pluginNames) {
    for (const skillName of listSubdirectories(safePath.join(srcMpDir, 'plugins', pluginName, 'skills'))) {
      run.skills.push({ name: skillName, installPath: safePath.join(destMpDir, 'plugins', pluginName, 'skills', skillName), sourcePath: null });
    }
  }
  if (dryRun) return;
  // In order: each registration is a read-modify-write of the ~/.claude registry files.
  await forEachInOrder(pluginNames, (pluginName) =>
    registerPlugin(run, { ...ctx, pluginName, pluginDir: safePath.join(destMpDir, 'plugins', pluginName) }, ctx.paths));
}

/**
 * Copy pre-built plugin tree to ~/.claude/plugins/ and update registry.
 *
 * This is a "dumb copy" — the dist/.claude/plugins/marketplaces/ tree mirrors
 * the target ~/.claude/plugins/marketplaces/ structure exactly. No path rewriting,
 * no assembly, no skill resolution. Just recursive copy + registry update.
 * Skills are recorded once copied, before registration; under `--dry-run`
 * nothing is copied or registered.
 */
async function copyPluginTree(
  run: InstallRun,
  marketplacesDir: string,
  packageJson: Pick<PackageJson, 'name' | 'vat'> & { version?: string | undefined },
): Promise<void> {
  const { logger, dryRun } = run;
  const paths = getClaudeUserPaths();
  const version = packageJson.version ?? '0.0.0';
  const marketplaceNames = listSubdirectories(marketplacesDir);
  assertPackagePluginNames(marketplacesDir, marketplaceNames, packageJson, version);
  const replaced = planReplaces(packageJson.vat?.replaces, marketplacesDir, marketplaceNames, paths);
  // The whole source is proven readable before anything changes: a file the
  // copy cannot read is the package's refusal (INPUT_UNREADABLE), not a copy
  // that failed partway.
  for (const mpName of marketplaceNames) requirePluginSource(safePath.join(marketplacesDir, mpName));

  // In order: each marketplace registers by read-modify-write of the ~/.claude registry files.
  await forEachInOrder(marketplaceNames, (mpName) =>
    copyMarketplace(run, safePath.join(marketplacesDir, mpName), { mpName, version, packageName: packageJson.name, paths }));

  // Only once the new tree is in place: a failed copy leaves what it replaces.
  await applyReplaces(replaced, paths, dryRun, logger);
}

/**
 * Check the destination for a copy install: free, or occupied under `--force`.
 * Nothing is removed here — the new tree is swapped in by {@link swapInSkill}.
 *
 * @returns The skill's install path
 */
function checkInstallDestination(run: InstallRun, skillName: string): string {
  const { options } = run;
  const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;
  // The declared name is author-controlled (SKILL.md `name:`, package.json
  // `vat.skills[]`) and `--force` replaces whatever is at this path.
  const installPath = safePath.join(skillsDir, assertSkillEntryName(skillName, 'skill name'));

  let exists = false;
  try {
    lstatSync(installPath);
    exists = true;
  } catch (error) {
    // Does not exist. A refusal is not that: it used to read as "free", and
    // the extraction that followed then met the same refusal without a name.
    if (!isPathAbsentError(error)) throw unstatablePathRefusal(installPath, error);
  }

  if (exists && !options.force) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Skill already exists at ${installPath}. Use --force to overwrite.`
    );
  }
  return installPath;
}

/**
 * Make `installPath` a copy of the skill tree at `source`: staged beside it and
 * swapped in whole, so a copy that fails leaves the previous skill in place
 * (`--force` used to remove it first). A previous tree the swap could not
 * remove is a cleanup warning, not a failure.
 */
async function swapInSkill(run: InstallRun, source: string, installPath: string, skillName: string): Promise<void> {
  const warnings = await codedUserStateWrite(`install skill ${skillName} to ${installPath}`, () => replaceDirectory(source, installPath));
  reportCleanupWarnings(run, warnings, skillName);
}

/**
 * Copy one skill build into the skills directory, and record it installed.
 */
async function installSkillFromPath(run: InstallRun, skillPath: string, skillName: string): Promise<void> {
  // The source declares a skill whose build is absent or unreadable: one
  // absent-vs-unreadable predicate decides which, as for every path argument.
  try {
    statSync(skillPath);
  } catch (error) {
    const refusal = unstatablePathRefusal(skillPath, error);
    throw new CommandRefusalError(refusal.refusal, `Skill "${skillName}" has no build to install. ${refusal.message}`, { cause: error });
  }

  // Every file of it, before anything changes — dry run or real.
  requirePluginSource(skillPath);
  const installPath = checkInstallDestination(run, skillName);

  if (!run.dryRun) {
    run.logger.info(`   Installing ${skillName}...`);
    await swapInSkill(run, skillPath, installPath, skillName);
  }
  run.skills.push({ name: skillName, installPath, sourcePath: null });
}

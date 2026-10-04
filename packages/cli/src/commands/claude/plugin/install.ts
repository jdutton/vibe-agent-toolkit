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


import { existsSync, lstatSync, readdirSync, cpSync, statSync } from 'node:fs';
import {  mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { basename } from 'node:path';

import { readDeclaredSkillName } from '@vibe-agent-toolkit/agent-skills';
import { codedUserStateWrite, getClaudeUserPaths, installPlugin, uninstallPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { buildReport, createRegistryIssue, toFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { direntKindFollowingSync, isPathAbsentError, isSingleFsSegment, isVatError, normalizedTmpdir, toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
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
 * List immediate subdirectory names inside a directory, following links.
 * Returns empty array when the directory does not exist.
 *
 * Followed on purpose: a `--dev` install puts a plugin or marketplace here AS
 * a symlink, and `Dirent.isDirectory()` is false for a link — so every dev
 * install was invisible to the listing that uninstalls, lists and re-installs.
 */
function listSubdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => direntKindFollowingSync(dir, d) === 'directory')
    .map(d => d.name);
}

/**
 * Register a plugin in the Claude plugin registry. A failure propagates coded
 * (`CLAUDE_USER_STATE_UNREADABLE`, `CLAUDE_USER_STATE_WRITE_FAILED`): a plugin
 * that is not registered is never reported installed.
 */
async function registerPlugin(
  ctx: { mpName: string; pluginName: string; pluginDir: string; version: string; packageName: string },
  paths: ReturnType<typeof getClaudeUserPaths>,
  logger: Logger,
): Promise<void> {
  const { warnings } = await installPlugin({
    marketplaceName: ctx.mpName,
    pluginName: ctx.pluginName,
    pluginDir: ctx.pluginDir,
    version: ctx.version,
    source: { source: 'npm', package: ctx.packageName, version: ctx.version },
    paths,
  });
  logger.info(`   Registered plugin ${ctx.pluginName}@${ctx.mpName} in Claude plugin registry`);
  for (const warning of warnings) logger.warn(`   ${warning}`);
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
  - findings: COMPONENT_DECLARED_BUT_MISSING (warning) for a --dev plugin skill whose build is missing

Exit Codes:
  0 - Installed (a warning does not fail the run)
  2 - The run could not install: a missing or unknown source, a skill that exists
      without --force, an unknown --target (USAGE_INVALID); --target claude.ai
      (NOT_IMPLEMENTED); an unreadable source (INPUT_UNREADABLE); npm pack failing
      (EXTERNAL_API_FAILED); --build whose vat build failed, or a copy or registry
      write that failed partway (RUN_INCOMPLETE). A refusal lists the skills already on disk.

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

  const tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-install-npm-'));

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
  for (const skillName of skillNames) {
    await installSkillFromPath(run, safePath.join(rootDir, 'dist', 'skills', skillNameToFsPath(skillName)), skillName);
  }
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

  // Plain skill directory. The package.json branch above installs each skill
  // under its declared name; do the same here rather than under whatever the
  // source directory happens to be called.
  const skillName =
    options.name ??
    readDeclaredSkillName(safePath.join(sourcePath, 'SKILL.md')) ??
    basename(sourcePath);
  await installSkillFromPath(run, sourcePath, skillName);
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

  const skillName = options.name ?? basename(sourcePath, '.zip');
  const installPath = await prepareInstallation(run, skillName);

  if (!run.dryRun) {
    logger.info('   Extracting ZIP...');
    const zip = new AdmZip(sourcePath);
    zip.extractAllTo(installPath, /* overwrite */ true);
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

  const tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-install-tgz-'));

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
  for (const skillEntry of skillEntries) {
    await symlinkDevSkill(run, ctx, skillEntry.name, destSkillsDir);
  }
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
    await registerPlugin({ ...ctx, pluginDir: ctx.destPluginDir }, ctx.paths, run.logger);
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
  for (const pluginName of listSubdirectories(pluginsDir)) {
    await devInstallPlugin(run, {
      mpName,
      pluginName,
      srcPluginDir: safePath.join(pluginsDir, pluginName),
      destPluginDir: safePath.join(destMpDir, 'plugins', pluginName),
      packageName: packageInfo.name,
      version: packageInfo.version,
      cwd: packageInfo.cwd,
      paths,
    });
  }
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

  // Remove old plugins/flat skills this package replaces, before installing
  if (packageJson.vat?.replaces) {
    await executeReplaces(packageJson.vat.replaces, listSubdirectories(marketplacesDir), getClaudeUserPaths(), run.dryRun, logger);
  }

  const packageInfo = { name: packageJson.name, version: packageJson.version ?? '0.0.0', cwd };
  for (const mpName of listSubdirectories(marketplacesDir)) {
    await devInstallMarketplace(run, mpName, safePath.join(marketplacesDir, mpName), packageInfo);
  }
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

/**
 * Execute vat.replaces cleanup before installing the new plugin.
 *
 * Removes old plugin registrations and legacy flat-skill installs that this
 * package now supersedes. Runs before the new plugin is copied/symlinked so
 * Claude Code never sees stale duplicate entries.
 *
 * Idempotent — uninstallPlugin handles "not found" gracefully.
 */
export async function removeFlatSkill(skillPath: string, logger: Logger): Promise<void> {
  logger.info(`   Removing legacy flat skill: ${toForwardSlash(skillPath)}`);
  await rm(skillPath, { recursive: true, force: true });
}

export function logFlatSkillRemoval(skillPath: string, logger: Logger): void {
  logger.info(`   [dry-run] Would remove legacy flat skill: ${toForwardSlash(skillPath)}`);
}

export async function removeOldPlugins(
  oldPlugins: string[] | undefined,
  marketplaceNames: string[],
  paths: ReturnType<typeof getClaudeUserPaths>,
  dryRun: boolean,
  logger: Logger
): Promise<void> {
  for (const mp of marketplaceNames) {
    for (const oldPlugin of oldPlugins ?? []) {
      const pluginKey = `${oldPlugin}@${mp}`;
      if (dryRun) {
        logger.info(`   [dry-run] Would uninstall old plugin: ${pluginKey}`);
      } else {
        logger.info(`   Removing old plugin: ${pluginKey}`);
        await uninstallPlugin({ pluginKey, paths, dryRun: false });
      }
    }
  }
}

export async function executeReplaces(
  replaces: PackageJsonVatReplaces,
  marketplaceNames: string[],
  paths: ReturnType<typeof getClaudeUserPaths>,
  dryRun: boolean,
  logger: Logger
): Promise<void> {
  // Remove old plugin entries from all marketplaces this package ships into
  await removeOldPlugins(replaces.plugins, marketplaceNames, paths, dryRun, logger);

  // Remove legacy flat-skill installs from ~/.claude/skills/<name>
  for (const skillName of replaces.flatSkills ?? []) {
    // The entry comes from the INSTALLED package's package.json, and this is
    // an `rm -rf` with no flag in front of it: `"../victim"` used to remove a
    // sibling of the skills dir (with the default paths, `"../.."` is $HOME).
    const skillPath = safePath.join(paths.skillsDir, assertSkillEntryName(skillName, 'vat.replaces.flatSkills'));
    let pathExists = false;
    try {
      lstatSync(skillPath); // throws if path itself doesn't exist (doesn't follow symlinks)
      pathExists = true;
    } catch (error) {
      // Path doesn't exist — nothing to remove. One the OS refuses to examine
      // is not "nothing to remove": the legacy install is still there and a
      // silent skip leaves it beside its replacement.
      if (!isPathAbsentError(error)) throw unstatablePathRefusal(skillPath, error);
    }

    if (pathExists) {
      if (dryRun) {
        logFlatSkillRemoval(skillPath, logger);
      } else {
        await removeFlatSkill(skillPath, logger);
      }
    }
  }
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
  // package do not persist in the user's Claude installation.
  logger.info(`   ${dryRun ? '[dry-run] Would copy' : 'Copying'} marketplace: ${ctx.mpName} → ${destMpDir}`);
  if (!dryRun) {
    await codedUserStateWrite(`copy marketplace ${ctx.mpName} to ${destMpDir}`, async () => {
      await rm(destMpDir, { recursive: true, force: true });
      await mkdir(destMpDir, { recursive: true });
      cpSync(srcMpDir, destMpDir, { recursive: true, force: true });
    });
  }

  const pluginNames = listSubdirectories(safePath.join(srcMpDir, 'plugins'));
  for (const pluginName of pluginNames) {
    for (const skillName of listSubdirectories(safePath.join(srcMpDir, 'plugins', pluginName, 'skills'))) {
      run.skills.push({ name: skillName, installPath: safePath.join(destMpDir, 'plugins', pluginName, 'skills', skillName), sourcePath: null });
    }
  }
  if (dryRun) return;
  for (const pluginName of pluginNames) {
    await registerPlugin({ ...ctx, pluginName, pluginDir: safePath.join(destMpDir, 'plugins', pluginName) }, ctx.paths, logger);
  }
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

  // Remove any old plugins/flat skills this package replaces, before installing
  if (packageJson.vat?.replaces) {
    await executeReplaces(packageJson.vat.replaces, marketplaceNames, paths, dryRun, logger);
  }

  for (const mpName of marketplaceNames) {
    await copyMarketplace(run, safePath.join(marketplacesDir, mpName), { mpName, version, packageName: packageJson.name, paths });
  }
}

/**
 * Check the destination for a copy install, clearing it under `--force`.
 *
 * @returns The skill's install path
 */
async function prepareInstallation(run: InstallRun, skillName: string): Promise<string> {
  const { options, dryRun } = run;
  const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;
  // The declared name is author-controlled (SKILL.md `name:`, package.json
  // `vat.skills[]`) and `--force` turns this path into an `rm -rf`.
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

  if (exists && options.force && !dryRun) {
    await rm(installPath, { recursive: true, force: true });
  }

  if (!dryRun) {
    await mkdir(skillsDir, { recursive: true });
  }

  return installPath;
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

  const installPath = await prepareInstallation(run, skillName);

  if (!run.dryRun) {
    run.logger.info(`   Installing ${skillName}...`);
    cpSync(skillPath, installPath, { recursive: true, force: true });
  }
  run.skills.push({ name: skillName, installPath, sourcePath: null });
}

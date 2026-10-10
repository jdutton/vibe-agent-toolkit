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
 *
 * Every lane resolves what it installs from (staging an archive under $TMPDIR first),
 * then calls {@link planInstall} and {@link executeInstall}: ONE plan of tree changes —
 * the marketplace copy, each plugin's cache, each skill, everything `vat.replaces`
 * removes — and the registry edit that agrees with it, applied as one transaction.
 */

import { readdirSync, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { basename } from 'node:path';

import { readDeclaredSkillName } from '@vibe-agent-toolkit/agent-skills';
import {
  type DevSkillLink,
  getClaudeUserPaths,
  linkDevSkills,
  PLUGIN_KEY_INVALID_CODE,
  planPackageInstall,
  type PackageMarketplaceInstall,
  type RegistryEdit,
  requirePluginInstallNames,
} from '@vibe-agent-toolkit/claude-marketplace';
import { buildReport, createRegistryIssue, toFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  applyTreePlan,
  classifyFsFault,
  copyTree,
  direntKindFollowingSync,
  forEachInOrder,
  fsBoundary,
  type FsBoundary,
  type FsSide,
  isPathAbsentError,
  isSingleFsSegment,
  isTreeChangeResidue,
  isVatError,
  pathPresent,
  type PlannedChange,
  planTreeChanges,
  proveTreeReadable,
  requireConfirmedAbsent,
  safePath,
  TREE_DEST_NOT_OWNED_CODE,
  type TreeChange,
  type TreePlan,
  withFsFault,
  withFsFaultSync,
} from '@vibe-agent-toolkit/utils';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import { Command } from 'commander';

import { archiveFailure, extractTarballSync, openZip, type StagedZip } from '../../../utils/archive-staging.js';
import { CommandRefusalError, refusalCodeOf } from '../../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, leftoverIssue, NOTHING_FINISHED, type FinishedWork } from '../../../utils/document-writer.js';
import { inStaging, occupiedRefusal, skillCopyChange } from '../../../utils/install-plan.js';
import { createLogger } from '../../../utils/logger.js';
import { requireInputPath } from '../../../utils/project-root-policy.js';

import {
  detectSource,
  downloadNpmPackage,
  isGlobalNpmInstall,
  readPackageJson,
  readPackageJsonVatMetadata,
  type PackageJson,
  type SkillSource,
} from './helpers.js';
import type { PluginInstallData, PluginInstallReport } from './install-schema.js';
import { keptForSiblingFindings } from './kept-findings.js';

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
export interface InstalledSkill {
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
 * One install run: the invocation, and what it has done SO FAR. A lane records its
 * skills and findings only once its one transaction has committed (or, under
 * `--dry-run`, once it is planned), so a refusal reports exactly what is on disk.
 */
interface InstallRun {
  readonly options: PluginInstallCommandOptions;
  readonly logger: Logger;
  readonly dryRun: boolean;
  /** Set by the lane as soon as it knows what it installs from. */
  source: { label: string; type: SkillSource; symlink: boolean } | undefined;
  readonly skills: InstalledSkill[];
  readonly issues: ValidationIssue[];
  /**
   * Where the run's trees are, as each lane learns them: what it installs from
   * (`source`) and the staging it extracts into (`environment`). A raw filesystem fault
   * that escapes a lane is classified by the path the OS named against these; anything
   * under neither is the Claude state the run writes (`destination`).
   */
  readonly roots: { readonly source: string[]; readonly environment: string[] };
}

/** A fresh run of `options`, nothing done yet. */
function newInstallRun(options: PluginInstallCommandOptions, logger: Logger): InstallRun {
  return { options, logger, dryRun: options.dryRun === true, source: undefined, skills: [], issues: [], roots: { source: [], environment: [] } };
}

/** The classifier over the run's trees: a fault's side is decided by the path it names. */
function boundaryOf(run: InstallRun): FsBoundary {
  return fsBoundary({ source: run.roots.source, environment: run.roots.environment }, { origin: 'content' });
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

/** A source FILE argument (a .zip, a .tgz): absent is the invocation's mistake, refused the input's. */
function assertSourceFile(path: string): void {
  requireInputPath(path, { origin: 'argument', message: `Path does not exist: ${path}` });
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
 * installed, on `side` (the operator's tree, or VAT's staging when it was extracted
 * there), following links. An empty array when the directory is absent — believed
 * only when its parent's listing agrees; a directory the OS will not list (or an
 * entry it will not stat) is a fault on `side`, naming it.
 *
 * Followed on purpose: a built plugin tree may hold a plugin or a skill AS a
 * symlink, and `Dirent.isDirectory()` is false for a link.
 *
 * A tree-change leftover (`.<name>.vat-staged-*`, what a killed build leaves beside
 * what it was replacing) is never one of them: it is not a marketplace, a plugin or a skill.
 */
function listSubdirectories(dir: string, side: FsSide): string[] {
  const ctx = { side, action: 'list the package directory', path: dir } as const;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!isPathAbsentError(error)) throw classifyFsFault(error, ctx);
    requireConfirmedAbsent(dir, error, ctx, { follows: true });
    return [];
  }
  return withFsFaultSync(ctx, () => entries.filter((d) => !isTreeChangeResidue(d.name) && direntKindFollowingSync(dir, d) === 'directory').map((d) => d.name));
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
  packageJson: PackageJsonForInstall,
  version: string,
  side: FsSide,
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
    for (const pluginName of listSubdirectories(safePath.join(marketplacesDir, marketplaceName, 'plugins'), side)) {
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
    .option('-f, --force', 'Overwrite an existing skill, or a marketplace directory VAT did not install from this package', false)
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

  A marketplace directory already at ~/.claude/plugins/marketplaces/<name> is
  replaced only when VAT installed it from this same package (its .vat-marketplace
  marker says so; for an install made by a VAT older than the marker, the
  known_marketplaces.json entry naming this package does). Anything else there — a
  marketplace Claude Code added, or one another package installed — is refused
  with nothing changed; --force replaces it.

  One transaction: the marketplace copy, each plugin's cache, each skill, the
  registry files and everything vat.replaces removes change together, or not at
  all. --dry-run prints the plan, one line per change ([dry-run] create|replace|
  remove|keep|subsumed <what> <path>), and changes nothing.

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
    TREE_CLEANUP_INCOMPLETE (warning), its link the path, when the install is complete but a
    previous tree it replaced (left as .<name>.vat-staged-*.previous beside it) or its
    $TMPDIR staging directory could not be removed;
    PLUGIN_KEPT_SIBLING_UNEXAMINED (warning), its link the directory, for a plugin
    vat.replaces kept because a directory it may be could not be examined

Exit Codes:
  0 - Installed (a warning does not fail the run)
  2 - The run could not install: a missing or unknown source, a skill that exists
      without --force (an EMPTY directory there is replaced without it), a marketplace
      directory VAT did not install from this package (without --force), an unknown
      --target, a plain directory with no SKILL.md (USAGE_INVALID); --target claude.ai (NOT_IMPLEMENTED); an unreadable
      source (a package directory it cannot list, or a named pipe, socket or
      device in the package, refused unopened, included), a .zip that is
      not a ZIP archive, holds an entry that does not inflate or cannot be
      extracted, a .tgz (or npm tarball) that is not a tarball or holds an
      entry that cannot be extracted, a registry file that is not JSON, a
      package whose vat.replaces is not { plugins?: string[], flatSkills?: string[] },
      whose plugin or marketplace directory, version, vat.replaces.plugins or
      vat.replaces.flatSkills entry is not one path segment (or whose version
      begins with ".") (INPUT_UNREADABLE); npm pack failing, a full $TMPDIR during
      its download included (EXTERNAL_API_FAILED); --build whose vat build failed,
      a staging copy under $TMPDIR it could not create or extract into (full,
      read-only, out of descriptors), a destination under ~/.claude (or -s) it
      cannot examine or write (RUN_INCOMPLETE). Every such refusal changes
      nothing under ~/.claude. Only a tree vat.replaces removes that the OS will
      not delete once the registry is written refuses after the install
      (RUN_INCOMPLETE naming it), and then lists the installed skills. A plugin
      vat.replaces names that is the just-installed plugin on disk (Old -> old on a
      case-insensitive filesystem) loses only its registry entry.

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
  const run = newInstallRun(options, logger);
  const { dryRun } = run;

  let outcome: InstallOutcome | undefined;
  try {
    await runInstall(source, run);
    outcome = outcomeOf(run);
    // Every lane names its source before it can return; reaching here without one is a defect.
    if (outcome === undefined) throw new Error('install lane returned without naming its source');
  } catch (error) {
    // A raw filesystem fault is classified by the path it names against the run's trees;
    // anything already coded or classified passes through as it is.
    const refusal = boundaryOf(run).classify(error, 'install the plugin', 'destination');
    // Whatever installed before the refusal is still reported.
    endWithRefusal('claude plugin install', refusalCodeOf(refusal), refusal, 'yaml', GATE, installFinished(outcomeOf(run), dryRun));
  }

  logInstallOutcome(outcome, dryRun, logger);
  endWithReport('claude plugin install', buildPluginInstallReport(outcome, dryRun, Date.now() - startTime), 'yaml');
}

// --- the one plan -----------------------------------------------------------------------------

/** The input kind of a package's built plugin tree. */
const PLUGIN_TREE = 'plugin-tree';

/** What a package's `package.json` must tell a plugin-tree install. */
type PackageJsonForInstall = PackageJson;

/**
 * What a lane installs, once resolved — every path in it on `side`: the operator's tree
 * (`source`) or VAT's staging under $TMPDIR (`environment`).
 * - `plugin-tree`: a package directory whose built `dist/.claude/plugins/marketplaces/` is installed, with its package.json.
 * - `skills`: the declared skills of a package, each built at `<rootDir>/dist/skills/<name>`.
 * - `skill-dir`: one skill directory, installed under `skillName`.
 */
type InstallInput =
  | { readonly kind: typeof PLUGIN_TREE; readonly side: FsSide; readonly rootDir: string; readonly packageJson: PackageJsonForInstall }
  | { readonly kind: 'skills'; readonly side: FsSide; readonly rootDir: string; readonly skillNames: readonly string[] }
  | { readonly kind: 'skill-dir'; readonly side: FsSide; readonly skillPath: string; readonly skillName: string };

/** An install, planned: its tree changes, the registry edit that agrees with them, and what it reports once done. */
interface PlannedInstall {
  readonly changes: readonly TreeChange[];
  /** The registry edit, run as the plan's `afterSwap`; `null` for a lane that installs no plugin. */
  readonly registry: RegistryEdit | null;
  /**
   * Each replaced plugin key, the index in `changes` of its cache's removal, and whether the package
   * installs that very key too (it then stays registered, as the new install).
   */
  readonly replaced: ReadonlyArray<{ readonly pluginKey: string; readonly index: number; readonly reinstalled: boolean }>;
  readonly skills: readonly InstalledSkill[];
  /** Findings known once planned (a --dev skill with no build). */
  readonly issues: readonly ValidationIssue[];
}

/** One skill copied into the skills directory: absent build is the invocation's mistake. */
function skillCopy(run: InstallRun, side: FsSide, skillPath: string, skillName: string): { change: TreeChange; skill: InstalledSkill } {
  // The source declares a skill whose build is absent or unreadable: absent is the
  // invocation's mistake, as for every path argument; unreadable is classified on its side —
  // the operator's tree, or VAT's own staging an archive was extracted into.
  if (!pathPresent(skillPath, 'follow', side, 'confirmed')) {
    throw new CommandRefusalError('USAGE_INVALID', `Skill "${skillName}" has no build to install. Path does not exist: ${skillPath}`);
  }
  const skillsDir = run.options.skillsDir ?? getClaudeUserPaths().skillsDir;
  // The declared name is author-controlled (SKILL.md `name:`, package.json `vat.skills[]`) and
  // `--force` replaces whatever is at this path.
  const installPath = safePath.join(skillsDir, assertSkillEntryName(skillName, 'skill name'));
  return {
    change: skillCopyChange({ name: skillName, source: skillPath, dest: installPath }, side, run.options.force === true),
    skill: { name: skillName, installPath, sourcePath: null },
  };
}

function planSkills(run: InstallRun, side: FsSide, skills: ReadonlyArray<{ path: string; name: string }>): PlannedInstall {
  const copies = skills.map(({ path, name }) => skillCopy(run, side, path, name));
  return { changes: copies.map((copy) => copy.change), registry: null, replaced: [], skills: copies.map((copy) => copy.skill), issues: [] };
}

/** Where one plugin of a package comes from, and where its marketplace copy goes. */
interface PluginSource {
  /** The side the package is on: every read of it is classified there. */
  readonly side: FsSide;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly srcPluginDir: string;
  readonly destPluginDir: string;
}

/** Entries of a plugin other than its skills: what `--dev` copies (it links each skill instead). */
const notSkills = (relative: string): boolean => relative !== 'skills';
/** Entries of a marketplace other than its plugins: what `--dev` copies before building each plugin. */
const notPlugins = (relative: string): boolean => relative !== 'plugins';
/** Entries of a marketplace other than a plugin's skills: what a `--dev` install reads of it. */
const notPluginSkills = (relative: string): boolean => !/^plugins\/[^/]+\/skills$/.test(relative);

/** One `--dev` plugin, planned: whether its tree has a `skills/` directory, the links to make in it, and what it reports. */
interface DevPlugin {
  readonly plugin: PluginSource;
  readonly hasSkills: boolean;
  readonly links: DevSkillLink[];
  readonly skills: InstalledSkill[];
  readonly issues: ValidationIssue[];
}

/** The `--dev` links of one plugin: each skill its tree declares and `dist/skills/` holds; each one it does not, a finding. */
function devPlugin(plugin: PluginSource, rootDir: string): DevPlugin {
  const skillsDir = safePath.join(plugin.srcPluginDir, 'skills');
  const result: DevPlugin = { plugin, hasSkills: pathPresent(skillsDir, 'follow', plugin.side, 'confirmed'), links: [], skills: [], issues: [] };
  for (const name of listSubdirectories(skillsDir, plugin.side)) {
    const target = safePath.resolve(rootDir, 'dist', 'skills', name);
    if (!pathPresent(target, 'follow', plugin.side, 'confirmed')) {
      result.issues.push(createRegistryIssue(
        'COMPONENT_DECLARED_BUT_MISSING',
        `Plugin "${plugin.pluginName}" declares skill "${name}", but it is not built — it was not linked. Run vat build, then re-install.`,
        { location: safePath.relative(rootDir, target) },
      ));
      continue;
    }
    result.links.push({ name, target });
    result.skills.push({ name: `${plugin.pluginName}:${name}`, installPath: safePath.join(plugin.destPluginDir, 'skills', name), sourcePath: target });
  }
  return result;
}

/**
 * Fill `into` with one `--dev` plugin: its non-skill content copied, and a link per built
 * skill to `dist/skills/<name>`, so a rebuild is picked up live.
 */
async function writeDevPlugin(dev: DevPlugin, into: string): Promise<void> {
  await copyTree(dev.plugin.srcPluginDir, into, { links: 'preserve', side: dev.plugin.side, onto: 'fresh', filter: notSkills });
  if (dev.hasSkills) await linkDevSkills(into, dev.links);
}

/** The plugins one marketplace of the package ships, with where each goes under `paths`. */
function pluginsOf(side: FsSide, srcMpDir: string, marketplaceName: string, destMpDir: string): PluginSource[] {
  return listSubdirectories(safePath.join(srcMpDir, 'plugins'), side).map((pluginName) => ({
    side,
    marketplaceName,
    pluginName,
    srcPluginDir: safePath.join(srcMpDir, 'plugins', pluginName),
    destPluginDir: safePath.join(destMpDir, 'plugins', pluginName),
  }));
}

/** One marketplace of the package, as its install, the skills it holds once installed, and what planning it found. */
interface BuiltMarketplace {
  readonly install: PackageMarketplaceInstall;
  readonly skills: readonly InstalledSkill[];
  readonly issues: readonly ValidationIssue[];
}

/** One marketplace of a copy install: the package's tree copied whole, and each plugin's cache copied from it. */
function copiedMarketplace(marketplaceName: string, srcMpDir: string, plugins: readonly PluginSource[], side: FsSide): BuiltMarketplace {
  const skills = plugins.flatMap((plugin) =>
    listSubdirectories(safePath.join(plugin.srcPluginDir, 'skills'), side).map((name) => ({ name, installPath: safePath.join(plugin.destPluginDir, 'skills', name), sourcePath: null })));
  return {
    install: {
      marketplaceName,
      write: (staged) => copyTree(srcMpDir, staged, { links: 'preserve', side, onto: 'fresh' }),
      reads: [srcMpDir],
      // A `write` fill, not a `copy`: the planner proves every `copy` source again, and the whole package was
      // proven readable once already ({@link planPluginTree}). The holding check still sees it (`reads`).
      plugins: plugins.map(({ pluginName, srcPluginDir }) => ({
        pluginName,
        cacheFill: { from: 'write', write: (staged) => copyTree(srcPluginDir, staged, { links: 'preserve', side, onto: 'fresh' }), reads: [srcPluginDir] },
      })),
    },
    skills,
    issues: [],
  };
}

/** One marketplace of a `--dev` install: its non-plugin content copied, each plugin built with links, the cache built the same way. */
function devMarketplace(marketplaceName: string, srcMpDir: string, plugins: readonly PluginSource[], rootDir: string, side: FsSide): BuiltMarketplace {
  const linked = plugins.map((plugin) => devPlugin(plugin, rootDir));
  return {
    install: {
      marketplaceName,
      write: async (staged) => {
        await copyTree(srcMpDir, staged, { links: 'preserve', side, onto: 'fresh', filter: notPlugins });
        // In order: each plugin is built into the one staged tree, and the first refusal stops the fill.
        await forEachInOrder(linked, (dev) => writeDevPlugin(dev, safePath.join(staged, 'plugins', dev.plugin.pluginName)));
      },
      reads: [srcMpDir],
      plugins: linked.map((dev) => ({
        pluginName: dev.plugin.pluginName,
        cacheFill: { from: 'write', write: (staged) => writeDevPlugin(dev, staged), reads: [dev.plugin.srcPluginDir] },
      })),
    },
    skills: linked.flatMap((each) => each.skills),
    issues: linked.flatMap((each) => each.issues),
  };
}

/**
 * Plan a plugin-tree install: every marketplace the package ships replaced whole (with
 * VAT's marker), each plugin's cache, each `vat.replaces` plugin's cache and flat skill
 * removed, and the registry edit — one plan. Every name is checked and the whole source
 * proven readable before anything is decided. A marketplace directory already there is
 * replaced only when VAT installed it from this very package, or under `force` (`--force`).
 */
async function planPluginTree(input: Extract<InstallInput, { kind: typeof PLUGIN_TREE }>, mode: 'copy' | 'dev', force: boolean): Promise<PlannedInstall> {
  const { rootDir, packageJson, side } = input;
  const marketplacesDir = safePath.join(rootDir, PLUGIN_MARKETPLACES_SUBPATH);
  const paths = getClaudeUserPaths();
  const version = packageJson.version ?? '0.0.0';
  const marketplaceNames = listSubdirectories(marketplacesDir, side);
  assertPackagePluginNames(marketplacesDir, marketplaceNames, packageJson, version, side);
  // Every file of the package, before anything changes — dry run or real: a file the
  // install cannot read is the package's refusal (INPUT_UNREADABLE).
  const proof = mode === 'dev' ? { links: 'preserve', side, filter: notPluginSkills } as const : { links: 'preserve', side } as const;
  // In order: the first unreadable entry named is the first marketplace's, deterministically.
  await forEachInOrder(marketplaceNames, (mpName) => proveTreeReadable(safePath.join(marketplacesDir, mpName), proof));

  const built = marketplaceNames.map((mpName): BuiltMarketplace => {
    const srcMpDir = safePath.join(marketplacesDir, mpName);
    const plugins = pluginsOf(side, srcMpDir, mpName, safePath.join(paths.marketplacesDir, mpName));
    return mode === 'dev' ? devMarketplace(mpName, srcMpDir, plugins, rootDir, side) : copiedMarketplace(mpName, srcMpDir, plugins, side);
  });
  const replaces = packageJson.vat?.replaces;
  const shipped = new Set(built.flatMap(({ install }) => install.plugins.map(({ pluginName }) => `${pluginName}@${install.marketplaceName}`)));
  const planned = planPackageInstall({
    marketplaces: built.map((each) => each.install),
    version,
    source: { source: 'npm', package: packageJson.name, version },
    replacedPluginKeys: marketplaceNames.flatMap((mp) => (replaces?.plugins ?? []).map((plugin) => `${plugin}@${mp}`)),
    force,
    paths,
  });
  const flatSkills = (replaces?.flatSkills ?? []).map((name): TreeChange => ({
    op: 'remove',
    dest: safePath.join(paths.skillsDir, assertSkillEntryName(name, 'vat.replaces.flatSkills')),
    // The package says it replaces this legacy install: whatever is there goes.
    ownership: { kind: 'force' },
    label: `legacy flat skill ${name}`,
  }));
  return {
    changes: [...planned.changes, ...flatSkills],
    registry: planned.registry,
    replaced: planned.replaced.map((each) => ({ ...each, reinstalled: shipped.has(each.pluginKey) })),
    skills: built.flatMap((each) => each.skills),
    issues: built.flatMap((each) => each.issues),
  };
}

/**
 * Plan an install of `input`, with no side effect: the tree changes, the registry edit,
 * and what the run reports once they are done. `mode` is `dev` only for a plugin tree
 * whose skills are linked, not copied (`--dev`).
 */
function planInstall(run: InstallRun, input: InstallInput, mode: 'copy' | 'dev'): Promise<PlannedInstall> {
  if (input.kind === PLUGIN_TREE) return planPluginTree(input, mode, run.options.force === true);
  // A skills lane plans synchronously; a refusal still rejects the returned promise.
  return Promise.resolve().then(() => planSkills(run, input.side, input.kind === 'skills'
    ? input.skillNames.map((name) => ({ path: safePath.join(input.rootDir, 'dist', 'skills', skillNameToFsPath(name)), name }))
    : [{ path: input.skillPath, name: input.skillName }]));
}

/** A package directory's plugin tree, as the input of {@link planInstall}. */
function pluginTree(side: FsSide, rootDir: string, packageJson: PackageJsonForInstall): InstallInput {
  return { kind: PLUGIN_TREE, side, rootDir, packageJson };
}

/** What the decided plan did with each replaced plugin: a warning per directory kept, and a finding per one kept for an unexaminable sibling. */
function replacedOutcome(run: InstallRun, planned: PlannedInstall, plan: TreePlan): ValidationIssue[] {
  const decided = planned.replaced.flatMap(({ pluginKey, index, reinstalled }) => {
    const change: PlannedChange | undefined = plan.changes[index];
    return change === undefined ? [] : [{ pluginKey, change, reinstalled }];
  });
  for (const { pluginKey, change, reinstalled } of decided) {
    // A key the package installs again stays registered: nothing to warn about.
    if (change.action === 'keep' && change.existing !== 'absent' && !reinstalled) {
      run.logger.warn(`   Plugin "${pluginKey}" is removed from the registry, but ${change.change.dest} is kept (${change.reason ?? 'kept'})`);
    }
  }
  return keptForSiblingFindings(decided.flatMap(({ change }) =>
    (change.action === 'keep' && change.unexaminedSibling !== undefined ? [{ path: change.change.dest, sibling: change.unexaminedSibling }] : [])));
}

/** Record what the run did: called once the transaction committed, or once a dry run is planned. */
function record(run: InstallRun, planned: PlannedInstall, findings: readonly ValidationIssue[]): void {
  run.skills.push(...planned.skills);
  run.issues.push(...planned.issues, ...findings);
}

/**
 * Carry out a planned install as ONE transaction: every tree staged and swapped, then the
 * registry written (`afterSwap`); a failure before the registry is written puts every tree
 * and registry file back. Under `--dry-run` the plan's lines are printed and nothing changes.
 * What the run installed is recorded the moment the registry is written, so a failure after
 * that (a replaced tree the OS will not delete) reports it.
 */
async function executeInstall(run: InstallRun, planned: PlannedInstall): Promise<void> {
  let plan: TreePlan;
  try {
    plan = await planTreeChanges(planned.changes);
  } catch (error: unknown) {
    throw notOwnedRefusal(occupiedRefusal(error));
  }
  const findings = replacedOutcome(run, planned, plan);
  const prefix = run.dryRun ? '[dry-run] ' : '';
  for (const line of plan.describe()) run.logger.info(`   ${prefix}${line}`);
  if (run.dryRun) {
    record(run, planned, findings);
    return;
  }
  const { warnings } = await applyTreePlan(plan, {
    afterSwap: async () => {
      await planned.registry?.apply();
      record(run, planned, findings);
    },
  });
  for (const { path, message } of warnings) leftover(run, leftoverIssue(message, path));
}

/** A marketplace directory VAT cannot prove it installed from this package, as the invocation's refusal saying how to proceed; anything else as itself. */
function notOwnedRefusal(error: unknown): unknown {
  if (!isVatError(error, TREE_DEST_NOT_OWNED_CODE)) return error;
  return new CommandRefusalError(
    'USAGE_INVALID',
    `${error.message}. Nothing was changed. Uninstall what is there first — \`vat claude plugin uninstall <plugin>@<marketplace>\` when VAT installed it, Claude Code's /plugin when it did — or pass --force to replace it.`,
    { cause: error },
  );
}

/** A leftover of a complete install, as a warning naming it. */
function leftover(run: InstallRun, issue: ValidationIssue): void {
  run.logger.warn(`   ${issue.message}`);
  run.issues.push(issue);
}

/** Plan and execute `input`: every lane's last step. */
async function install(run: InstallRun, input: InstallInput, mode: 'copy' | 'dev'): Promise<void> {
  await executeInstall(run, await planInstall(run, input, mode));
}

/** Run `work` in a fresh `$TMPDIR` staging directory (VAT's own: `environment`), disposed of after: see {@link inStaging}. */
function stagedIn(run: InstallRun, prefix: string, work: (dir: string) => Promise<void>): Promise<void> {
  return inStaging(prefix, async (dir) => {
    run.roots.environment.push(dir);
    await work(dir);
  }, (issue) => leftover(run, issue));
}

// --- the lanes --------------------------------------------------------------------------------

/**
 * The package at `rootDir`, as `readPackageJson` is told of it: its side, and what the user named —
 * the directory itself, or, where `rootDir` is VAT's staging (`environment`: a staging directory
 * under $TMPDIR names nothing they have), the archive or npm spec the run was given.
 */
function packageOf(run: InstallRun, rootDir: string, side: FsSide): { side: FsSide; label: string } {
  const named = side === 'environment' && run.source !== undefined ? `The package ${run.source.label}` : `The package directory ${rootDir}`;
  return { side, label: named };
}

/** A package directory's install: its plugin tree, or (none, or `--user-install-without-plugin`) its declared skills. */
async function installPackageDir(run: InstallRun, rootDir: string, side: FsSide): Promise<void> {
  if (run.options.userInstallWithoutPlugin !== true && pathPresent(safePath.join(rootDir, PLUGIN_MARKETPLACES_SUBPATH), 'follow', side, 'confirmed')) {
    run.logger.info('   Plugin detected — installing via Claude plugin system');
    await install(run, pluginTree(side, rootDir, await readPackageJson(rootDir, packageOf(run, rootDir, side))), 'copy');
    return;
  }
  const { packageJson, skills } = await readPackageJsonVatMetadata(rootDir, packageOf(run, rootDir, side));
  await install(run, { kind: 'skills', side, rootDir, skillNames: selectSkills(skills, run.options.name, packageJson.name) }, 'copy');
}

/**
 * Handle npm package installation
 */
async function handleNpmInstall(source: string, run: InstallRun): Promise<void> {
  const { logger } = run;
  const packageName = source.startsWith('npm:') ? source.slice(4) : source;
  setSource(run, `npm:${packageName}`, 'npm');

  logger.info(`📥 Installing skill from npm: ${packageName}`);
  await stagedIn(run, 'vat-install-npm-', async (tempDir) => {
    logger.info('   Downloading package...');
    const extractedPath = downloadNpmPackage(packageName, tempDir);
    await installPackageDir(run, extractedPath, 'environment');
  });
}

/**
 * Handle local directory installation
 */
async function handleLocalInstall(source: string, run: InstallRun): Promise<void> {
  const { options, logger } = run;
  const sourcePath = safePath.resolve(source);
  setSource(run, `local:${sourcePath}`, 'local');
  run.roots.source.push(sourcePath);

  logger.info(`📥 Installing skill from directory: ${sourcePath}`);

  // A package: its pre-built plugin tree, or each skill its vat.skills declares.
  const marketplacesDir = safePath.join(sourcePath, PLUGIN_MARKETPLACES_SUBPATH);
  if ((!options.userInstallWithoutPlugin && pathPresent(marketplacesDir, 'follow', 'source', 'confirmed')) || pathPresent(safePath.join(sourcePath, 'package.json'), 'follow', 'source', 'confirmed')) {
    await installPackageDir(run, sourcePath, 'source');
    return;
  }

  // Plain skill directory: it must hold a SKILL.md, or any directory would
  // install as a skill. A source that names nothing keeps its own refusal below.
  if (pathPresent(sourcePath, 'follow', 'source', 'confirmed') && !pathPresent(safePath.join(sourcePath, 'SKILL.md'), 'follow', 'source', 'confirmed')) {
    throw new CommandRefusalError('USAGE_INVALID', `No SKILL.md found at the root of: ${sourcePath}`);
  }
  // The package.json branch above installs each skill under its declared name;
  // do the same here rather than under whatever the source directory is called.
  const skillName =
    options.name ??
    readDeclaredSkillName(safePath.join(sourcePath, 'SKILL.md')) ??
    basename(sourcePath);
  await install(run, { kind: 'skill-dir', side: 'source', skillPath: sourcePath, skillName }, 'copy');
}

/**
 * The refusal of a ZIP with no SKILL.md at its root: it would install as a directory Claude Code
 * never loads as a skill. The archive is the input (`INPUT_UNREADABLE`); where the SKILL.md is one
 * folder down — the usual result of zipping a folder — the message says which, and what to zip instead.
 */
function zipHoldsNoSkill(zipPath: string, extracted: string): CommandRefusalError {
  const inner = listSubdirectories(extracted, 'environment').filter((name) => pathPresent(safePath.join(extracted, name, 'SKILL.md'), 'follow', 'environment', 'confirmed'));
  const hint = inner.length === 0
    ? 'A skill archive holds SKILL.md at its top level.'
    : `Its SKILL.md is one folder down, in ${inner.join(', ')}/: zip the CONTENTS of that folder, not the folder.`;
  return new CommandRefusalError('INPUT_UNREADABLE', `${zipPath} holds no SKILL.md at its root, so it is not a skill; nothing was installed. ${hint}`);
}

/**
 * Handle ZIP file installation
 */
async function handleZipInstall(source: string, run: InstallRun): Promise<void> {
  const { options, logger } = run;
  const sourcePath = safePath.resolve(source);
  setSource(run, sourcePath, 'zip');
  run.roots.source.push(sourcePath);

  logger.info(`📥 Installing skill from ZIP: ${sourcePath}`);
  assertSourceFile(sourcePath);

  // Read WHOLE first. Opening parses only the central directory — entry data is
  // inflated (and its CRC checked) lazily, so a corrupt entry would throw from the
  // extraction, uncoded.
  let zip: StagedZip;
  try {
    zip = openZip(sourcePath);
    for (const entry of zip.zip.getEntries()) entry.getData();
  } catch (error) {
    // Nothing is staged yet: a fault here is the archive's, or the machine's.
    throw archiveFailure(sourcePath, [], error);
  }

  // Extracted to staging first: an archive the pre-read accepts can still fail to
  // EXTRACT (a file `a` and a file `a/b`), and nothing under ~/.claude has changed then.
  await stagedIn(run, 'vat-install-zip-', async (tempDir) => {
    logger.info('   Extracting ZIP...');
    const extracted = safePath.join(tempDir, 'skill');
    await withFsFault({ side: 'environment', action: 'create the staging directory', path: extracted }, () => fs.mkdir(extracted));
    zip.extractTo(sourcePath, extracted);
    // The directory lane's rule, applied to what was extracted: a skill is a directory with a
    // SKILL.md at its root, installed under the name that SKILL.md declares.
    const skillMd = safePath.join(extracted, 'SKILL.md');
    if (!pathPresent(skillMd, 'follow', 'environment', 'confirmed')) throw zipHoldsNoSkill(sourcePath, extracted);
    const skillName = options.name ?? readDeclaredSkillName(skillMd) ?? basename(sourcePath, '.zip');
    await install(run, { kind: 'skill-dir', side: 'environment', skillPath: extracted, skillName }, 'copy');
  });
}

/**
 * Handle npm tarball (.tgz / .tar.gz) installation.
 * npm pack format: all package files are under a `package/` subdirectory in the tarball.
 * Extracts to a temp directory then installs the plugin tree, or the declared skills.
 */
async function handleTgzInstall(source: string, run: InstallRun): Promise<void> {
  const { logger } = run;
  const sourcePath = safePath.resolve(source);
  setSource(run, sourcePath, 'tgz');
  run.roots.source.push(sourcePath);

  logger.info(`📥 Installing skill from tarball: ${sourcePath}`);
  assertSourceFile(sourcePath);

  await stagedIn(run, 'vat-install-tgz-', async (tempDir) => {
    logger.info('   Extracting tarball...');
    // Synchronously: an asynchronous extraction rejects at its first failure (a refused read of the
    // archive) while entries are still being written, so the staging was removed under writes that
    // then left files in $TMPDIR. A synchronous one has written everything it ever will when it throws.
    extractTarballSync(sourcePath, tempDir);
    // npm pack tarballs extract under package/ subdirectory
    const packageDir = safePath.join(tempDir, 'package');
    await installPackageDir(run, pathPresent(packageDir, 'follow', 'environment', 'confirmed') ? packageDir : tempDir, 'environment');
  });
}

/**
 * Handle development mode installation via plugin tree (symlinks).
 *
 * Reads the pre-built plugin tree from dist/.claude/plugins/marketplaces/:
 * - Copies non-skill content (.claude-plugin/ dirs) to ~/.claude/plugins/
 * - For each skill directory under plugins/{plugin}/skills/{name}/, creates a
 *   symlink to the corresponding dist/skills/{name}/ directory
 * - Registers each plugin in the Claude plugin registry
 *
 * Each marketplace is ONE replace, built whole in staging and swapped in: the installed
 * marketplace is never deleted first. Skills appear in Claude Code as {plugin}:{skill}.
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
  run.roots.source.push(cwd);

  if (options.build) {
    runBuild(cwd, logger);
  }

  // Check for pre-built plugin tree
  const marketplacesDir = safePath.join(cwd, PLUGIN_MARKETPLACES_SUBPATH);
  if (!pathPresent(marketplacesDir, 'follow', 'source', 'confirmed')) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Plugin tree not found at ${marketplacesDir}\n` +
        `Run: vat build first (builds the plugin tree)`
    );
  }

  const packageJson = await readPackageJson(cwd, packageOf(run, cwd, 'source'));
  setSource(run, packageJson.name, 'dev', true);
  logger.info(`📥 Dev-installing plugin tree from ${packageJson.name}`);
  await install(run, pluginTree('source', cwd, packageJson), 'dev');
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
  run.roots.source.push(cwd);

  if (!isGlobalNpmInstall()) {
    logger.info('   Skipping: Not a global npm install');
    return;
  }

  if (!options.userInstallWithoutPlugin) {
    // Check for pre-built plugin tree (dist/.claude/plugins/marketplaces/)
    const marketplacesDir = safePath.join(cwd, PLUGIN_MARKETPLACES_SUBPATH);
    if (!pathPresent(marketplacesDir, 'follow', 'source', 'confirmed')) {
      logger.info(`   No plugin tree found at dist/.claude/plugins/marketplaces/`);
      logger.info(`   Run 'vat build' to generate plugin artifacts before publishing.`);
      logger.info(`   Skipping install — no skills registered.`);
      return;
    }
    const packageJson = await readPackageJson(cwd, packageOf(run, cwd, 'source'));
    logger.info(`   Package: ${packageJson.name}@${packageJson.version ?? 'unknown'}`);
    logger.info(`   Plugin tree detected — copying to ~/.claude/plugins/`);
    await install(run, pluginTree('source', cwd, packageJson), 'copy');
    return;
  }

  // --user-install-without-plugin: install skills directly to ~/.claude/skills/
  const { packageJson, skills } = await readPackageJsonVatMetadata(cwd, packageOf(run, cwd, 'source'));

  logger.info(`   Package: ${packageJson.name}@${packageJson.version ?? 'unknown'}`);
  logger.info(`   Skills found: ${skills.length}`);

  await install(run, { kind: 'skills', side: 'source', rootDir: cwd, skillNames: skills }, 'copy');
}

/** Test-facing seam: the pure decisions of this module, reached by its unit tests. */
export const __internal = {
  assertInstallTarget,
  assertPackagePluginNames,
  boundaryOf,
  executeInstall,
  leftover,
  logInstallOutcome,
  newInstallRun,
  notPlugins,
  notPluginSkills,
  notSkills,
  outcomeOf,
  planInstall,
  record,
  replacedOutcome,
  selectSkills,
  setSource,
  skillNameToFsPath,
  stagedIn,
};

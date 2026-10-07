/**
 * vat skills install — cross-platform flat skill install command.
 *
 * Installs a SKILL.md-based skill to one of 7 supported platforms, at either
 * user scope (home dir) or project scope (CWD). Pre-verifies with validateSkill()
 * before making any filesystem changes, and publishes the `Report<T>` envelope
 * (`install-schema.ts`).
 *
 * Supports local directory, ZIP file, .tgz tarball, and npm: package sources.
 *
 * Every refusal is coded where it is raised: an unusable invocation or source
 * (`--target`, `--name`, no SKILL.md, a name collision, an existing skill
 * without `--force`) is `USAGE_INVALID`; a source the OS or the archive reader
 * will not read — or an install target whose existence the OS will not let
 * VAT check — is `INPUT_UNREADABLE`; a registry that will not hand over an
 * npm: package is `EXTERNAL_API_FAILED`; a copy that fails partway is
 * `RUN_INCOMPLETE`, publishing the skills already installed. A skill that fails
 * its validation is not a refusal: it is the skill's own error findings, and
 * the whole batch installs nothing.
 */

import { cpSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';

import { validateSkill } from '@vibe-agent-toolkit/agent-skills';
import { buildReport, toFindings, withDurationMs, type Finding, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  direntKindFollowingSync,
  isSingleFsSegment,
  mapConcurrentFailingInOrder,
  mkdirSyncReal,
  normalizedTmpdir,
  resolveSkillTarget,
  safePath,
  SKILL_SCOPE_NAMES,
  SKILL_TARGET_NAMES,
  type SkillScope,
  type SkillTarget,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { Command } from 'commander';

import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED, type FinishedWork } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';
import { pathPresent, unstatablePathRefusal } from '../../utils/project-root-policy.js';

import type { SkillsInstallData, SkillsInstallReport } from './install-schema.js';
import {
  discardingOnFailure,
  extractTarballToTemp,
  findSkillsDirInNpmPackage,
  holdsSkillMd,
  readSourceDir,
  removeResolvedTempDirs,
  resolveNpmOrTarballSource,
} from './source-resolvers.js';

/** `vat skills install` has no `--strict`: a validation error already stops the batch. */
const GATE = { strict: false } as const;

export interface InstallCommandOptions {
  target: string;
  scope: string;
  /** Override skill name (single-skill sources only). */
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  /**
   * Current working directory. Passed explicitly for testability.
   * Defaults to process.cwd() when invoked from the CLI.
   */
  cwd?: string;
}

interface DiscoveredSkill {
  dir: string;
  name: string;
}

/**
 * Locate one or more skill directories under a source directory.
 * Priority: SKILL.md at root wins over subdirectories.
 *
 * Returns paths only. The skill's *name* is a separate question, answered by
 * its frontmatter — see {@link preVerifySkill}.
 */
function discoverSkillDirs(sourceDir: string): string[] {
  if (holdsSkillMd(sourceDir)) {
    return [sourceDir];
  }

  // Scan immediate subdirectories for any that contain a SKILL.md.
  const dirs: string[] = [];
  for (const entry of readSourceDir(sourceDir)) {
    if (direntKindFollowingSync(sourceDir, entry) !== 'directory') continue;
    const candidate = safePath.join(sourceDir, entry.name);
    if (holdsSkillMd(candidate)) {
      dirs.push(candidate);
    }
  }

  if (dirs.length === 0) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `No SKILL.md found at root or in subdirectories of: ${sourceDir}`,
    );
  }

  return dirs;
}

/**
 * Reject a name that would escape the install directory. The declared name is
 * author-controlled and an npm: or ZIP source is not trusted input.
 */
function assertInstallableName(name: string, origin: string): void {
  if (!isSingleFsSegment(name)) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Invalid skill name "${name}" (${origin}). ` +
        `Name must be a single path segment: no separators, not "." or "..".`,
    );
  }
}

/** One source skill after validation: its issues, and — when it has no error — the name it installs as. */
interface VerifiedSkill {
  dir: string;
  issues: ValidationIssue[];
  /** `undefined` when validation found an error: the batch installs nothing. */
  declaredName: string | undefined;
}

/**
 * Validate a skill and read the name it declares for itself.
 *
 * The frontmatter `name` is authoritative — it is what VAT keys on everywhere
 * else, and it is the only identity an archived skill carries. The directory
 * leaf is incidental: for a ZIP whose SKILL.md sits at the archive root, that
 * leaf is the extraction temp dir.
 */
async function preVerifySkill(skillDir: string): Promise<VerifiedSkill> {
  const skillMdPath = safePath.join(skillDir, 'SKILL.md');
  // An install source (npm, ZIP, directory) carries no config that governs it.
  const result = await validateSkill({
    skillPath: skillMdPath,
    validation: {},
  });
  const issues = result.issues ?? [];
  if (result.summary.errors > 0) {
    return { dir: skillDir, issues, declaredName: undefined };
  }

  const declared = result.metadata?.name;
  if (typeof declared !== 'string' || declared.trim() === '') {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `SKILL.md at ${skillDir} declares no name; cannot determine where to install it.`,
    );
  }
  assertInstallableName(declared, `declared in ${toForwardSlash(skillMdPath)}`);
  return { dir: skillDir, issues, declaredName: declared };
}

/**
 * Two skills in one source claiming the same name would install over each
 * other, last write winning silently. Fail the whole batch instead.
 */
function assertNoNameCollisions(skills: DiscoveredSkill[]): void {
  const seen = new Map<string, string>();
  for (const skill of skills) {
    const prior = seen.get(skill.name);
    if (prior !== undefined) {
      throw new CommandRefusalError(
        'USAGE_INVALID',
        `Two skills in this source both declare the name "${skill.name}":\n` +
          `  - ${toForwardSlash(prior)}\n` +
          `  - ${toForwardSlash(skill.dir)}\n` +
          `Rename one in its SKILL.md frontmatter, or install them separately.`,
      );
    }
    seen.set(skill.name, skill.dir);
  }
}

interface InstallPlan {
  name: string;
  skillDir: string;
  installPath: string;
  alreadyExists: boolean;
}

function buildInstallPlan(
  skill: DiscoveredSkill,
  installDir: string,
  options: InstallCommandOptions,
): InstallPlan {
  const installPath = safePath.join(installDir, skill.name);

  const alreadyExists = pathPresent(installPath, 'entry');

  if (alreadyExists && !options.force && !options.dryRun) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Skill "${skill.name}" is already installed at ${installPath}. Use --force to overwrite.`,
    );
  }

  return { name: skill.name, skillDir: skill.dir, installPath, alreadyExists };
}

/**
 * Copy one planned skill into place. A copy the OS refuses partway is the run
 * stopping (`RUN_INCOMPLETE`), not VAT's defect: the caller publishes the
 * skills already installed.
 */
function executeInstallPlan(plan: InstallPlan): void {
  try {
    if (plan.alreadyExists) {
      rmSync(plan.installPath, { recursive: true, force: true });
    }
    mkdirSyncReal(safePath.join(plan.installPath, '..'), { recursive: true });
    cpSync(plan.skillDir, plan.installPath, { recursive: true, force: true });
  } catch (error) {
    throw new CommandRefusalError('RUN_INCOMPLETE', `Could not install "${plan.name}" at ${plan.installPath}: ${errorMessageOf(error)}`, { cause: error });
  }
}

/**
 * Extract a ZIP file to a temp directory and return the extraction root.
 * Caller is responsible for cleanup; a ZIP the reader refuses leaves nothing behind.
 */
async function extractZipToTemp(zipPath: string): Promise<string> {
  const tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-skills-install-zip-'));
  await discardingOnFailure(tempDir, () => {
    try {
      new AdmZip(zipPath).extractAllTo(tempDir, /* overwrite */ true);
    } catch (error) {
      throw new CommandRefusalError('INPUT_UNREADABLE', `ZIP cannot be read: ${zipPath} (${errorMessageOf(error)})`, { cause: error });
    }
  });
  return tempDir;
}

/**
 * Find a skill root inside an extracted ZIP. The ZIP may contain a single
 * top-level directory (e.g. `my-skill/SKILL.md`) or have SKILL.md at the root.
 */
function findSkillRootInExtracted(extractedDir: string): string {
  if (holdsSkillMd(extractedDir)) {
    return extractedDir;
  }
  // Otherwise look for a single subdirectory containing SKILL.md
  for (const entry of readSourceDir(extractedDir)) {
    if (direntKindFollowingSync(extractedDir, entry) !== 'directory') continue;
    const candidate = safePath.join(extractedDir, entry.name);
    if (holdsSkillMd(candidate)) {
      return candidate;
    }
  }
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `ZIP does not contain a SKILL.md at root or in a top-level directory: ${extractedDir}`,
  );
}

interface ResolvedSource {
  /** The resolved directory containing SKILL.md (may be inside an extracted ZIP). */
  dir: string;
  /** Temp directories to clean up after install (e.g. ZIP extraction root). */
  tempDirs: string[];
}

/**
 * Resolve the source argument to a local directory, extracting ZIPs/tarballs or
 * downloading from npm as needed. Caller must clean up `tempDirs` after use.
 */
async function resolveSource(source: string): Promise<ResolvedSource> {
  // npm: prefix — download from registry
  if (source.startsWith('npm:')) {
    const resolved = await resolveNpmOrTarballSource(source);
    return { dir: resolved.skillsDir, tempDirs: resolved.tempDirs };
  }

  // The source argument: absent is the invocation's mistake, unreadable the input's.
  const sourcePath = safePath.resolve(source);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(sourcePath);
  } catch (error) {
    throw unstatablePathRefusal(sourcePath, error);
  }

  if (stat.isFile() && sourcePath.endsWith('.zip')) {
    const extractRoot = await extractZipToTemp(sourcePath);
    const dir = await discardingOnFailure(extractRoot, () => findSkillRootInExtracted(extractRoot));
    return { dir, tempDirs: [extractRoot] };
  }
  if (stat.isFile() && (sourcePath.endsWith('.tgz') || sourcePath.endsWith('.tar.gz'))) {
    const { tempDir, packageDir } = await extractTarballToTemp(sourcePath);
    const dir = await discardingOnFailure(tempDir, () => findSkillsDirInNpmPackage(packageDir));
    return { dir, tempDirs: [tempDir] };
  }
  if (stat.isDirectory()) {
    return { dir: sourcePath, tempDirs: [] };
  }
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `Source must be a directory, .zip, .tgz, or npm:@scope/package: ${sourcePath}`,
  );
}

/**
 * Check the --name override against the discovered skill count before doing any
 * validation work, so an unusable flag fails fast and unambiguously.
 */
function assertNameOverrideApplies(skillDirCount: number, name: string): void {
  assertInstallableName(name, '--name');
  if (skillDirCount > 1) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `--name is only valid for single-skill sources; found ${skillDirCount} skills.`,
    );
  }
}

/** `--target` and `--scope` name a placement this command knows — checked before any source is fetched. */
function assertPlacement(target: string, scope: string): asserts target is SkillTarget {
  if (!(SKILL_TARGET_NAMES as readonly string[]).includes(target)) {
    throw new CommandRefusalError('USAGE_INVALID', `Invalid --target "${target}". Valid targets: ${SKILL_TARGET_NAMES.join(', ')}`);
  }
  if (!(SKILL_SCOPE_NAMES as readonly string[]).includes(scope)) {
    throw new CommandRefusalError('USAGE_INVALID', `Invalid --scope "${scope}". Valid scopes: ${SKILL_SCOPE_NAMES.join(', ')}`);
  }
}

/** The published row for a plan: `alreadyInstalled` only under `--dry-run`, where it is the plan's warning. */
function planRow(plan: InstallPlan, dryRun: boolean): SkillsInstallData['skills'][number] {
  const row = { name: plan.name, installPath: toForwardSlash(plan.installPath) };
  return dryRun ? { ...row, alreadyInstalled: plan.alreadyExists } : row;
}

/**
 * What a run has finished, for a refusal to publish: the skills validated and
 * their findings, and — once copying has started — the skills already installed.
 */
interface InstallProgress {
  examined: number;
  findings: Finding[];
  data: SkillsInstallData | null;
}

/** Validate every skill, then (unless one failed) plan and install them all. */
async function installFromDir(
  sourceDir: string,
  base: SkillsInstallData,
  options: InstallCommandOptions,
  progress: InstallProgress,
): Promise<SkillsInstallReport> {
  const skillDirs = discoverSkillDirs(sourceDir);
  // Reject an unusable --name override before doing any real work.
  if (options.name !== undefined) assertNameOverrideApplies(skillDirs.length, options.name);

  // Pre-verify ALL skills before touching the filesystem. Verification also
  // yields each skill's declared name, which is what it installs as.
  // Read-only and independent; a refusal still names the first bad skill in order.
  const verified: VerifiedSkill[] = await mapConcurrentFailingInOrder(skillDirs, (dir) => preVerifySkill(dir));
  const findings = toFindings(verified.flatMap((skill) => skill.issues));
  progress.examined = verified.length;
  progress.findings = findings;

  const discovered: DiscoveredSkill[] = [];
  for (const skill of verified) {
    if (skill.declaredName !== undefined) discovered.push({ dir: skill.dir, name: options.name ?? skill.declaredName });
  }
  if (discovered.length < verified.length) {
    // All-or-nothing: a skill with an error finding installs nothing in the batch.
    return buildReport({ examined: verified.length, findings, data: base, gate: GATE });
  }
  assertNoNameCollisions(discovered);

  // Build and check install plans (detect conflicts before copying).
  const installDir = resolveSkillTarget(base.target as SkillTarget, base.scope as SkillScope, options.cwd ?? process.cwd());
  const plans = discovered.map((skill) => buildInstallPlan(skill, installDir, options));

  const installed: SkillsInstallData = { ...base, skills: [] };
  if (!base.dryRun) {
    progress.data = installed;
    for (const plan of plans) {
      executeInstallPlan(plan);
      installed.skills.push(planRow(plan, false));
    }
  }
  return buildReport({
    examined: verified.length,
    findings,
    data: { ...base, skills: plans.map((plan) => planRow(plan, base.dryRun)) },
    gate: GATE,
  });
}

export async function installCommand(
  source: string,
  options: InstallCommandOptions,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const progress: InstallProgress = { examined: 0, findings: [], data: null };

  let report: SkillsInstallReport;
  try {
    assertPlacement(options.target, options.scope);
    const base: SkillsInstallData = {
      // The raw source string for npm: prefixes, the resolved path otherwise.
      source: source.startsWith('npm:') ? source : toForwardSlash(safePath.resolve(source)),
      target: options.target,
      scope: options.scope,
      dryRun: options.dryRun === true,
      skills: [],
    };
    const resolved = await resolveSource(source);
    try {
      report = await installFromDir(resolved.dir, base, options, progress);
    } finally {
      await removeResolvedTempDirs(resolved.tempDirs, logger);
    }
  } catch (error) {
    // Validation that finished is published even when nothing was installed.
    const finished: FinishedWork = progress.examined === 0
      ? NOTHING_FINISHED
      : { examined: progress.examined, findings: progress.findings, data: progress.data };
    endWithRefusal('skills install', refusalCodeOf(error), error, 'yaml', GATE, finished);
  }

  const count = report.data?.skills.length ?? 0;
  if (report.status === 'findings' && report.summary.errors > 0) {
    logger.info('\nNothing installed: a skill failed validation (see the findings).');
  } else if (options.dryRun) {
    logger.info(`\nDry-run complete: ${count} skill(s) would be installed.`);
  } else {
    logger.info(`\nInstalled ${count} skill(s) to ${options.target} (${options.scope} scope)`);
  }
  endWithReport('skills install', withDurationMs(report, Date.now() - startTime), 'yaml');
}

export function createInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install a skill to one of 7 platform targets (user or project scope)')
    .argument('<source>', 'Source: local directory, ZIP file, or npm:@scope/package')
    .requiredOption('--target <target>', `Platform target: ${SKILL_TARGET_NAMES.join(' | ')}`)
    .requiredOption('--scope <scope>', `Install scope: ${SKILL_SCOPE_NAMES.join(' | ')}`)
    .option('-n, --name <name>', 'Override skill name (single-skill sources only)')
    .option('-f, --force', 'Overwrite existing skill')
    .option('--dry-run', 'Preview install without writing files')
    .action(async (source: string) => {
      await installCommand(source, command.optsWithGlobals<InstallCommandOptions>());
    })
    .addHelpText(
      'after',
      `
Description:
  Installs a fully-formed skill to a platform-specific directory. Both --target
  and --scope are required — no defaults. Skills are pre-verified before any
  filesystem changes; a validation failure means zero files written.

  Each skill installs under the name its SKILL.md frontmatter declares, not the
  name of the directory it came from — a ZIP or npm source has no meaningful
  directory name. Override with --name.

Visibility:
  VAT's own inspection commands are Claude-scoped: "vat skills list --user" and
  "vat audit --user" read ~/.claude only. A skill installed to any other target
  lands correctly but is invisible to them.

Targets (user path / project path):
  claude    ~/.claude/skills/       .claude/skills/
  codex     ~/.agents/skills/       .agents/skills/
  copilot   ~/.copilot/skills/      .github/skills/
  gemini    ~/.gemini/skills/       .gemini/skills/
  cursor    ~/.cursor/skills/       .cursor/skills/
  windsurf  ~/.codeium/windsurf/skills/   .windsurf/skills/
  agents    ~/.agents/skills/       .agents/skills/

Output (YAML report on stdout):
  - status: ok, findings, or error when the install could not run
  - examined: skills in the install plan
  - findings: each skill's validation findings (an error installs nothing)
  - data.skills[]: installed (or, with --dry-run, planned) skills;
    alreadyInstalled on each under --dry-run

Exit Codes:
  0 - Installed, or dry-run complete
  1 - A skill failed validation: nothing installed
  2 - Could not install: a bad --target/--scope/--name or source, a skill already
      installed without --force, an unreadable source (or an install path the OS
      will not let VAT check), an npm registry failure, or a copy that failed
      partway (the skills already installed are listed)

Example:
  $ vat skills install ./dist/skills/my-skill --target claude --scope user
`,
    );

  return command;
}

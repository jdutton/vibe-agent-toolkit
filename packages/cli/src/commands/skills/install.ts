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
 * The whole batch is ONE tree-change plan: every skill is staged beside its
 * destination and swapped in together, or nothing changes — a refusal installed
 * nothing. `--dry-run` prints that plan and stops; it refuses what the real run
 * would refuse.
 *
 * Every refusal is coded where it is raised: an unusable invocation or source
 * (`--target`, `--name`, no SKILL.md, a name collision, something already at an
 * install path without `--force`) is `USAGE_INVALID`; a source the OS or the
 * archive reader will not read is `INPUT_UNREADABLE`; a registry that will not
 * hand over an npm: package is `EXTERNAL_API_FAILED`; an install target the OS
 * will not let VAT examine or write (it is what the install writes), or a
 * staging copy under `$TMPDIR` the disk will not hold, is `RUN_INCOMPLETE`. A
 * skill that fails its validation is not a refusal: it is the skill's own error
 * findings, and the whole batch installs nothing.
 */

import { validateSkill } from '@vibe-agent-toolkit/agent-skills';
import { buildReport, toFindings, withDurationMs, type Finding, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  applyTreePlan,
  direntKindFollowingSync,
  type FsBoundary,
  fsBoundary,
  type FsSide,
  isSingleFsSegment,
  isTreeChangeResidue,
  mapConcurrentFailingInOrder,
  planTreeChanges,
  resolveSkillTarget,
  safePath,
  SKILL_SCOPE_NAMES,
  SKILL_TARGET_NAMES,
  type SkillScope,
  type SkillTarget,
  toForwardSlash,
  type TreePlan,
} from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { archiveFailure, openZip, type StagedZip } from '../../utils/archive-staging.js';
import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, leftoverIssue, NOTHING_FINISHED, type FinishedWork } from '../../utils/document-writer.js';
import { inStaging, occupiedRefusal, skillCopyChange } from '../../utils/install-plan.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { requireInputPath } from '../../utils/project-root-policy.js';

import type { SkillsInstallData, SkillsInstallReport } from './install-schema.js';
import {
  discardingOnFailure,
  extractTarballToTemp,
  findSkillsDirInNpmPackage,
  holdsSkillMd,
  readSourceDir,
  resolveNpmOrTarballSource,
  withResolvedTempDirs,
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
    // A staged or parked tree a `vat skills build` left beside a bundle holds a SKILL.md, and is no skill.
    if (isTreeChangeResidue(entry.name) || direntKindFollowingSync(sourceDir, entry) !== 'directory') continue;
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
async function preVerifySkill(skillDir: string, boundary: FsBoundary, side: FsSide): Promise<VerifiedSkill> {
  const skillMdPath = safePath.join(skillDir, 'SKILL.md');
  // An install source (npm, ZIP, directory) carries no config that governs it. A read the
  // OS refuses is classified by the path it named: see {@link sourceBoundary}.
  // The tree is on the side its lane declared (ResolvedSource.side): the validator's own walk faults there.
  const result = await boundary.run(`validate the skill at ${skillDir}`, side, () => validateSkill({
    skillPath: skillMdPath,
    validation: {},
    side,
  }));
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
  /** VAT's own staging the source was extracted into under `$TMPDIR` (none for a directory the operator named). */
  tempDirs: string[];
  /**
   * The side every skill under `dir` is on, decided by the lane that resolved it: a directory the
   * operator named is their input (`source`); a ZIP, tarball or npm package VAT extracted into
   * `$TMPDIR` is VAT's own scratch (`environment`). Declared, never re-derived from a path.
   */
  side: FsSide;
}

/**
 * Resolve the source argument to a local directory — extracting a ZIP or tarball, or
 * downloading from npm, into `$TMPDIR` staging — and run `work` on it. The staging is
 * disposed of after; a ZIP staging that outlives a finished `work` is a warning in the run's leftovers.
 */
async function withResolvedSource<T>(source: string, run: InstallRun, work: (resolved: ResolvedSource) => Promise<T>): Promise<T> {
  // npm: prefix — download from registry
  if (source.startsWith('npm:')) {
    const resolved = await resolveNpmOrTarballSource(source);
    return inResolvedTempDirs({ dir: resolved.skillsDir, tempDirs: resolved.tempDirs, side: 'environment' }, run, work);
  }

  // The source argument: absent is the invocation's mistake, unreadable the input's.
  const sourcePath = safePath.resolve(source);
  const stat = requireInputPath(sourcePath, { origin: 'argument', message: `Path does not exist: ${sourcePath}` });

  if (stat.isFile() && sourcePath.endsWith('.zip')) {
    return fromZip(sourcePath, run, work);
  }
  if (stat.isFile() && (sourcePath.endsWith('.tgz') || sourcePath.endsWith('.tar.gz'))) {
    const { tempDir, packageDir } = await extractTarballToTemp(sourcePath);
    const dir = await discardingOnFailure(tempDir, () => findSkillsDirInNpmPackage(packageDir));
    return inResolvedTempDirs({ dir, tempDirs: [tempDir], side: 'environment' }, run, work);
  }
  if (stat.isDirectory()) {
    return work({ dir: sourcePath, tempDirs: [], side: 'source' });
  }
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `Source must be a directory, .zip, .tgz, or npm:@scope/package: ${sourcePath}`,
  );
}

/** Run `work` on a source resolved into temp directories, disposing of them after: one that stays is a warning in the run's leftovers. */
async function inResolvedTempDirs<T>(resolved: ResolvedSource, run: InstallRun, work: (resolved: ResolvedSource) => Promise<T>): Promise<T> {
  const { value, leftovers } = await withResolvedTempDirs(resolved.tempDirs, () => work(resolved));
  run.leftovers.push(...leftovers);
  return value;
}

/**
 * A ZIP, extracted into a fresh `$TMPDIR` staging directory ({@link inStaging}) and handed to
 * `work`. The ZIP may hold one top-level directory (`my-skill/SKILL.md`) or SKILL.md at its root.
 */
async function fromZip<T>(zipPath: string, run: InstallRun, work: (resolved: ResolvedSource) => Promise<T>): Promise<T> {
  // A holder, not a `let`: `work` resolves inside the staging callback, where flow analysis cannot see.
  const holder: { result?: { value: T } } = {};
  await inStaging('vat-skills-install-zip-', async (staging) => {
    let zip: StagedZip;
    try {
      zip = openZip(zipPath);
    } catch (error) {
      // Nothing is staged by the open: a fault here is the archive's, or the machine's.
      throw archiveFailure(zipPath, [], error);
    }
    zip.extractTo(zipPath, staging);
    holder.result = { value: await work({ dir: findSkillRootInExtracted(staging), tempDirs: [staging], side: 'environment' }) };
  }, (issue) => run.leftovers.push(issue));
  // `inStaging` resolves only once `work` has.
  if (holder.result === undefined) throw new Error('vat skills install: the ZIP staging resolved without running the install');
  return holder.result.value;
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

/** One skill of the batch: its name, where it is read from and where it installs. */
interface PlannedSkill {
  readonly name: string;
  readonly source: string;
  readonly dest: string;
}

/** The published row for a skill: `alreadyInstalled` only under `--dry-run`, where it says the plan replaces something. */
function planRow(skill: PlannedSkill, occupied: boolean, dryRun: boolean): SkillsInstallData['skills'][number] {
  const row = { name: skill.name, installPath: toForwardSlash(skill.dest) };
  return dryRun ? { ...row, alreadyInstalled: occupied } : row;
}

/**
 * What a run has finished, for a refusal to publish: the skills validated and
 * their findings. Never an installed skill: the batch is one transaction, so a
 * refusal installed nothing.
 */
interface InstallProgress {
  examined: number;
  findings: Finding[];
}

/** One run's logger, and what it made and could not remove: each a warning on the report. */
interface InstallRun {
  readonly logger: Logger;
  readonly leftovers: ValidationIssue[];
}

/** What a run that was not refused produced, before it is a report. */
interface InstallOutcome {
  readonly examined: number;
  readonly findings: Finding[];
  readonly data: SkillsInstallData;
}

/**
 * Which side a read of the resolved source is on, by the path the OS named: a directory
 * the operator named is their input (`source`); a ZIP, tarball or npm package VAT
 * extracted under `$TMPDIR` is VAT's own scratch (`environment`).
 */
function sourceBoundary(resolved: ResolvedSource): FsBoundary {
  return fsBoundary(resolved.side === 'environment' ? { environment: resolved.tempDirs } : { source: [resolved.dir] }, { origin: 'content' });
}

/**
 * Plan the batch as ONE tree change — each skill a `replace` that must find its destination
 * free, or (`--force`) may take whatever is there — print it, and (unless `--dry-run`) apply
 * it. A previous install the OS will not remove once replaced is a warning in the run's
 * leftovers. Returns, per skill, whether something was already at its install path.
 */
async function installBatch(skills: readonly PlannedSkill[], side: FsSide, options: InstallCommandOptions, run: InstallRun): Promise<boolean[]> {
  let plan: TreePlan;
  try {
    plan = await planTreeChanges(skills.map((skill) => skillCopyChange(skill, side, options.force === true)));
  } catch (error: unknown) {
    throw occupiedRefusal(error);
  }
  const prefix = options.dryRun === true ? '[dry-run] ' : '';
  for (const line of plan.describe()) run.logger.info(`   ${prefix}${line}`);
  if (options.dryRun !== true) {
    const { warnings } = await applyTreePlan(plan);
    run.leftovers.push(...warnings.map(({ message, path }) => leftoverIssue(message, path)));
  }
  return plan.changes.map((change) => change.existing !== 'absent');
}

/** Validate every skill, then (unless one failed) plan and install them all. */
async function installFromDir(
  resolved: ResolvedSource,
  base: SkillsInstallData,
  options: InstallCommandOptions,
  progress: InstallProgress,
  run: InstallRun,
): Promise<InstallOutcome> {
  const skillDirs = discoverSkillDirs(resolved.dir);
  const boundary = sourceBoundary(resolved);
  // Reject an unusable --name override before doing any real work.
  if (options.name !== undefined) assertNameOverrideApplies(skillDirs.length, options.name);

  // Pre-verify ALL skills before touching the filesystem. Verification also
  // yields each skill's declared name, which is what it installs as.
  // Read-only and independent; a refusal still names the first bad skill in order.
  const verified: VerifiedSkill[] = await mapConcurrentFailingInOrder(skillDirs, (dir) => preVerifySkill(dir, boundary, resolved.side));
  const findings = toFindings(verified.flatMap((skill) => skill.issues));
  progress.examined = verified.length;
  progress.findings = findings;

  const discovered: DiscoveredSkill[] = [];
  for (const skill of verified) {
    if (skill.declaredName !== undefined) discovered.push({ dir: skill.dir, name: options.name ?? skill.declaredName });
  }
  if (discovered.length < verified.length) {
    // All-or-nothing: a skill with an error finding installs nothing in the batch.
    return { examined: verified.length, findings, data: base };
  }
  assertNoNameCollisions(discovered);

  const installDir = resolveSkillTarget(base.target as SkillTarget, base.scope as SkillScope, options.cwd ?? process.cwd());
  const skills = discovered.map((skill): PlannedSkill => ({ name: skill.name, source: skill.dir, dest: safePath.join(installDir, skill.name) }));
  const occupied = await installBatch(skills, resolved.side, options, run);
  return {
    examined: verified.length,
    findings,
    data: { ...base, skills: skills.map((skill, index) => planRow(skill, occupied[index] === true, base.dryRun)) },
  };
}

export async function installCommand(
  source: string,
  options: InstallCommandOptions,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const progress: InstallProgress = { examined: 0, findings: [] };
  const run: InstallRun = { logger, leftovers: [] };

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
    const outcome = await withResolvedSource(source, run, (resolved) => installFromDir(resolved, base, options, progress, run));
    for (const leftover of run.leftovers) logger.warn(`   ${leftover.message}`);
    report = buildReport({ ...outcome, findings: [...outcome.findings, ...toFindings(run.leftovers)], gate: GATE });
  } catch (error) {
    // Validation that finished is published even when nothing was installed; a refusal installed nothing.
    const finished: FinishedWork = progress.examined === 0
      ? NOTHING_FINISHED
      : { examined: progress.examined, findings: progress.findings, data: null };
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
  filesystem changes; a validation failure means zero files written. The
  whole batch installs as one transaction: every skill lands, or none does.
  --dry-run prints the plan (one create/replace line per skill) and refuses
  exactly what the real run would.

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
  - findings: each skill's validation findings (an error installs nothing),
    and TREE_CLEANUP_INCOMPLETE warnings naming what the install could not
    remove once it was done (a replaced skill, the $TMPDIR staging)
  - data.skills[]: installed (or, with --dry-run, planned) skills;
    alreadyInstalled on each under --dry-run; data is null on exit 2

Exit Codes:
  0 - Installed, or dry-run complete
  1 - A skill failed validation: nothing installed
  2 - Could not install, and nothing was installed: a bad --target/--scope/--name
      or source, something already at an install path without --force, an
      unreadable source (or an install path the OS will not let VAT examine or
      write), a .zip/.tgz holding an entry that cannot be extracted, an npm
      registry failure, or a staging copy under $TMPDIR or beside the install
      path it could not create or write (full, read-only)

Example:
  $ vat skills install ./dist/skills/my-skill --target claude --scope user
`,
    );

  return command;
}

/** Test-facing seam: the pure decisions of this module, reached by its unit tests. */
export const __internal = { assertInstallableName, assertNameOverrideApplies, assertNoNameCollisions, assertPlacement, planRow, sourceBoundary };

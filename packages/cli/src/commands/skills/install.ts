/**
 * vat skills install — cross-platform flat skill install command.
 *
 * Installs a SKILL.md-based skill to one of 7 supported platforms, at either
 * user scope (home dir) or project scope (CWD). Pre-verifies with validateSkill()
 * before making any filesystem changes.
 *
 * Supports local directory, ZIP file, .tgz tarball, and npm: package sources.
 */

import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename } from 'node:path';

import { validateSkill } from '@vibe-agent-toolkit/agent-skills';
import {
  mkdirSyncReal,
  normalizedTmpdir,
  resolveSkillTarget,
  safePath,
  toForwardSlash,
  SKILL_TARGET_NAMES,
  SKILL_SCOPE_NAMES,
  type SkillTarget,
  type SkillScope,
} from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

import {
  extractTarballToTemp,
  findSkillsDirInNpmPackage,
  resolveNpmOrTarballSource,
} from './source-resolvers.js';

/**
 * Expected install failure (exit 1).
 */
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

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
 * Locate one or more skills under a source directory.
 * Priority: SKILL.md at root wins over subdirectories.
 */
function discoverSkills(sourceDir: string): DiscoveredSkill[] {
  const rootSkillMd = safePath.join(sourceDir, 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller validated source
  if (existsSync(rootSkillMd)) {
    return [{ dir: sourceDir, name: basename(sourceDir) }];
  }

  // Scan immediate subdirectories for any that contain a SKILL.md.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller validated source
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = safePath.join(sourceDir, entry.name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from source
    if (existsSync(safePath.join(candidate, 'SKILL.md'))) {
      skills.push({ dir: candidate, name: entry.name });
    }
  }

  if (skills.length === 0) {
    throw new InstallError(
      `No SKILL.md found at root or in subdirectories of: ${sourceDir}`,
    );
  }

  return skills;
}

async function preVerifySkill(skillDir: string): Promise<void> {
  const skillMdPath = safePath.join(skillDir, 'SKILL.md');
  const result = await validateSkill({
    skillPath: skillMdPath,
  });
  if (result.status === 'error') {
    const issueSummary = (result.issues ?? [])
      .filter((i) => i.severity === 'error')
      .map((i) => `  - ${i.message}`)
      .join('\n');
    throw new InstallError(
      `Skill validation failed for ${skillDir}:\n${issueSummary || '  (no details)'}`,
    );
  }
}

interface InstallPlan {
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

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- install path derived from args
  const alreadyExists = existsSync(installPath);

  if (alreadyExists && !options.force && !options.dryRun) {
    throw new InstallError(
      `Skill "${skill.name}" is already installed at ${installPath}. Use --force to overwrite.`,
    );
  }

  return { skillDir: skill.dir, installPath, alreadyExists };
}

function executeInstallPlan(plan: InstallPlan, options: InstallCommandOptions): void {
  if (options.dryRun) return;

  if (plan.alreadyExists && options.force) {
    rmSync(plan.installPath, { recursive: true, force: true });
  }

  const parentDir = safePath.join(plan.installPath, '..');
  mkdirSyncReal(parentDir, { recursive: true });
  cpSync(plan.skillDir, plan.installPath, { recursive: true, force: true });
}

function emitYamlSummary(args: {
  source: string;
  target: string;
  scope: string;
  skills: InstallPlan[];
  dryRun: boolean;
  duration: number;
}): void {
  const statusLine = args.dryRun ? 'status: dry-run' : 'status: success';
  process.stdout.write(`---\n${statusLine}\n`);
  process.stdout.write(`source: ${toForwardSlash(args.source)}\n`);
  process.stdout.write(`target: ${args.target}\n`);
  process.stdout.write(`scope: ${args.scope}\n`);
  process.stdout.write(`skillsInstalled: ${args.skills.length}\n`);
  process.stdout.write(`skills:\n`);
  for (const plan of args.skills) {
    process.stdout.write(`  - name: ${basename(plan.installPath)}\n`);
    process.stdout.write(`    installPath: ${toForwardSlash(plan.installPath)}\n`);
    if (args.dryRun) {
      process.stdout.write(`    alreadyInstalled: ${plan.alreadyExists}\n`);
    }
  }
  process.stdout.write(`duration: ${args.duration}ms\n`);
}

/**
 * Extract a ZIP file to a temp directory and return the extraction root.
 * Caller is responsible for cleanup.
 */
async function extractZipToTemp(zipPath: string): Promise<string> {
  const tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-skills-install-zip-'));
  const zip = new AdmZip(zipPath);
  // eslint-disable-next-line sonarjs/no-unsafe-unzip -- extracted to a dedicated temp dir, not user-visible path
  zip.extractAllTo(tempDir, /* overwrite */ true);
  return tempDir;
}

/**
 * Find a skill root inside an extracted ZIP. The ZIP may contain a single
 * top-level directory (e.g. `my-skill/SKILL.md`) or have SKILL.md at the root.
 */
function findSkillRootInExtracted(extractedDir: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp path we just created
  if (existsSync(safePath.join(extractedDir, 'SKILL.md'))) {
    return extractedDir;
  }
  // Otherwise look for a single subdirectory containing SKILL.md
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp path
  const entries = readdirSync(extractedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = safePath.join(extractedDir, entry.name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp path
    if (existsSync(safePath.join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }
  throw new InstallError(
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

  const sourcePath = safePath.resolve(source);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-provided CLI arg
  if (!existsSync(sourcePath)) {
    throw new InstallError(`Source path not found: ${sourcePath}`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated above
  const stat = lstatSync(sourcePath);

  if (stat.isFile() && sourcePath.endsWith('.zip')) {
    const extractRoot = await extractZipToTemp(sourcePath);
    return { dir: findSkillRootInExtracted(extractRoot), tempDirs: [extractRoot] };
  }
  if (stat.isFile() && (sourcePath.endsWith('.tgz') || sourcePath.endsWith('.tar.gz'))) {
    const { tempDir, packageDir } = await extractTarballToTemp(sourcePath);
    return { dir: findSkillsDirInNpmPackage(packageDir), tempDirs: [tempDir] };
  }
  if (stat.isDirectory()) {
    return { dir: sourcePath, tempDirs: [] };
  }
  throw new InstallError(
    `Source must be a directory, .zip, .tgz, or npm:@scope/package: ${sourcePath}`,
  );
}

function applyNameOverride(discovered: DiscoveredSkill[], name: string): void {
  // Prevent path traversal: reject names containing slashes, backslashes, or ..
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new InstallError(
      `Invalid skill name "${name}". Name must not contain path separators or "..".`,
    );
  }
  if (discovered.length > 1) {
    throw new InstallError(
      `--name is only valid for single-skill sources; found ${discovered.length} skills.`,
    );
  }
  const first = discovered[0];
  if (first) {
    discovered[0] = { ...first, name };
  }
}

export async function installCommand(
  source: string,
  options: InstallCommandOptions,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const cwd = options.cwd ?? process.cwd();
    const target = options.target as SkillTarget;
    const scope = options.scope as SkillScope;

    // 1. Resolve source — dispatch by type (directory, ZIP, tgz, npm:).
    // For display: use the raw source string for npm: prefixes, resolved path otherwise.
    const displaySource = source.startsWith('npm:') ? source : safePath.resolve(source);
    const resolved = await resolveSource(source);

    try {
      // 2. Discover skills in source.
      const discovered = discoverSkills(resolved.dir);

      // 3. Apply --name override (only valid for single-skill sources).
      if (options.name !== undefined) {
        applyNameOverride(discovered, options.name);
      }

      // 4. Pre-verify ALL skills before touching the filesystem.
      for (const skill of discovered) {
        await preVerifySkill(skill.dir);
      }

      // 5. Resolve install directory.
      const installDir = resolveSkillTarget(target, scope, cwd);

      // 6. Build and check install plans (detect conflicts before copying).
      const plans = discovered.map((skill) => buildInstallPlan(skill, installDir, options));

      // 7. Execute install (no-op if dry-run).
      for (const plan of plans) {
        executeInstallPlan(plan, options);
      }

      const duration = Date.now() - startTime;
      emitYamlSummary({
        source: displaySource,
        target,
        scope,
        skills: plans,
        dryRun: options.dryRun === true,
        duration,
      });

      if (options.dryRun) {
        logger.info(`\nDry-run complete: ${plans.length} skill(s) would be installed.`);
      } else {
        logger.info(`\nInstalled ${plans.length} skill(s) to ${toForwardSlash(installDir)}`);
      }
    } finally {
      for (const dir of resolved.tempDirs) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  } catch (error) {
    if (error instanceof InstallError) {
      const duration = Date.now() - startTime;
      const firstLine = error.message.split('\n')[0] ?? 'Unknown error';
      logger.error(`Install failed: ${error.message}`);
      process.stdout.write(
        `---\nstatus: error\nerror: ${firstLine}\nduration: ${duration}ms\n`,
      );
      throw error;
    }
    handleCommandError(error, logger, startTime, 'SkillsInstall');
  }
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
      try {
        const opts = command.optsWithGlobals<InstallCommandOptions>();
        await installCommand(source, opts);
      } catch (err) {
        if (err instanceof InstallError) {
          process.exit(1);
        }
        process.exit(2);
      }
    })
    .addHelpText(
      'after',
      `
Description:
  Installs a fully-formed skill to a platform-specific directory. Both --target
  and --scope are required — no defaults. Skills are pre-verified before any
  filesystem changes; a validation failure means zero files written.

Targets (user path / project path):
  claude    ~/.claude/skills/       .claude/skills/
  codex     ~/.agents/skills/       .agents/skills/
  copilot   ~/.copilot/skills/      .github/skills/
  gemini    ~/.gemini/skills/       .gemini/skills/
  cursor    ~/.cursor/skills/       .cursor/skills/
  windsurf  ~/.codeium/windsurf/skills/   .windsurf/skills/
  agents    ~/.agents/skills/       .agents/skills/

Exit Codes:
  0 - Install successful (or dry-run complete)
  1 - Install error (validation failed, conflict without --force, bad source)
  2 - System error

Example:
  $ vat skills install ./dist/skills/my-skill --target claude --scope user
`,
    );

  return command;
}

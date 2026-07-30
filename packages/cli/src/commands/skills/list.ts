/**
 * List skills in project or user installation
 *
 * By default, lists project skills. Use --user flag to list user-installed skills.
 * Supports npm:@scope/pkg and local .tgz/.tar.gz sources for inspecting packages
 * without installing them.
 */

import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { readDeclaredSkillName } from '@vibe-agent-toolkit/agent-skills';
import { getClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { scan, type ScanSummary } from '@vibe-agent-toolkit/discovery';
import { safePath } from '@vibe-agent-toolkit/utils';

import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
import { relativizePathEntries } from '../../utils/relativize-paths.js';
import { discoverSkills, validateSkillFilename } from '../../utils/skill-discovery.js';
import { scanUserContext } from '../../utils/user-context-scanner.js';

import { isNpmOrTarballSource, resolveNpmOrTarballSource } from './source-resolvers.js';

export interface SkillsListCommandOptions {
  user?: boolean;
  verbose?: boolean;
  debug?: boolean;
}

interface DiscoveredSkill {
  name: string;
  path: string;
  valid: boolean;
  warning?: string;
}

/**
 * The name a skill goes by: what its frontmatter declares.
 *
 * `vat skills list` is the preview for `vat skills install`, which keys on the
 * declared name — so listing a directory leaf here would name a directory the
 * install never creates. The leaf is only a fallback for a SKILL.md too damaged
 * to declare anything; `vat audit` reports that separately.
 */
function extractSkillName(skillPath: string): string {
  return readDeclaredSkillName(skillPath) ?? basename(dirname(skillPath));
}

/**
 * Convert discovered skills to DiscoveredSkill format with validation
 */
function processDiscoveredSkills(
  discoveredSkills: Array<{ path: string }>
): DiscoveredSkill[] {
  return discoveredSkills.map(s => {
    const filenameCheck = validateSkillFilename(s.path);
    const skill: DiscoveredSkill = {
      path: s.path,
      name: extractSkillName(s.path),
      valid: filenameCheck.valid,
    };
    // Only add warning if it exists (exactOptionalPropertyTypes)
    if (filenameCheck.message !== undefined) {
      skill.warning = filenameCheck.message;
    }
    return skill;
  });
}

/**
 * Render the skills payload as YAML.
 *
 * Pure — returns the document rather than writing it — so the emitted shape,
 * `path` included, is under unit test instead of only under a CLI spawn.
 *
 * `root` is stated once and is the only absolute path in the document; every
 * `path` beneath it is relative to it. Absolute paths here named the operator's
 * home directory on every `--user` run and made two machines' output undiffable.
 */
export function formatSkillsYaml(
  skills: readonly DiscoveredSkill[],
  context: string,
  root: string,
): string {
  const lines = [
    '---',
    'status: success',
    `root: ${root}`,
    `context: ${context}`,
    `skillsFound: ${skills.length}`,
    'skills:',
  ];

  for (const skill of relativizePathEntries(skills, root)) {
    lines.push(`  - name: ${skill.name}`, `    path: ${skill.path}`, `    valid: ${skill.valid}`);
    if (skill.warning) {
      lines.push(`    warning: "${skill.warning}"`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Output human-readable skill list.
 *
 * Deliberately keeps ABSOLUTE paths: this goes to stderr for a person reading a
 * terminal, where a full path is the one you can click or paste. The
 * root-relative contract governs the stdout YAML document, which states its
 * `root` alongside; stderr states no root, so a relative path there would be
 * unresolvable.
 */
function outputSkillsHuman(
  skills: DiscoveredSkill[],
  logger: ReturnType<typeof createLogger>,
  options: SkillsListCommandOptions
): void {
  if (skills.length === 0) {
    logger.info(`\n   No skills found`);
    return;
  }

  logger.info(`\n   Found ${skills.length} skill${skills.length === 1 ? '' : 's'}:\n`);

  for (const skill of skills) {
    const statusIcon = skill.valid ? '✅' : '⚠️';
    const displayName = skill.name;

    if (options.verbose) {
      logger.info(`   ${statusIcon} ${displayName}`);
      if (skill.warning) {
        logger.info(`      Warning: ${skill.warning}`);
      }
      logger.info(`      Path: ${skill.path}\n`);
    } else if (skill.warning) {
      logger.info(`   ${statusIcon} ${displayName} (${skill.warning})`);
    } else {
      logger.info(`   ${statusIcon} ${displayName}`);
    }
  }
}

/**
 * Scan a dist/skills/ directory tree for SKILL.md files and return DiscoveredSkill[].
 * Each immediate subdirectory that contains a SKILL.md is treated as one skill.
 */
function scanSkillsDir(skillsDir: string): DiscoveredSkill[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp path from trusted source
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = safePath.join(skillsDir, entry.name);
    const skillMd = safePath.join(candidate, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from temp path
    if (existsSync(skillMd)) {
      const filenameCheck = validateSkillFilename(skillMd);
      const skill: DiscoveredSkill = {
        path: skillMd,
        name: extractSkillName(skillMd),
        valid: filenameCheck.valid,
      };
      if (filenameCheck.message !== undefined) {
        skill.warning = filenameCheck.message;
      }
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * List skills from an npm: or .tgz/.tar.gz source without installing.
 */
async function listFromNpmSource(
  source: string,
  logger: ReturnType<typeof createLogger>,
  options: SkillsListCommandOptions,
): Promise<void> {
  logger.info(`📋 Inspecting npm/tgz source: ${source}`);

  const resolved = await resolveNpmOrTarballSource(source);

  try {
    const skills = scanSkillsDir(resolved.skillsDir);
    // The extracted package's own skills dir is the base — the enclosing temp
    // directory is an implementation detail nobody can act on.
    process.stdout.write(formatSkillsYaml(skills, 'npm', resolved.skillsDir));
    outputSkillsHuman(skills, logger, options);
    process.exit(0);
  } finally {
    for (const dir of resolved.tempDirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export async function listCommand(
  pathArg: string | undefined,
  options: SkillsListCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  try {
    // npm: or .tgz/.tar.gz source — inspect without installing
    if (pathArg !== undefined && isNpmOrTarballSource(pathArg)) {
      await listFromNpmSource(pathArg, logger, options);
      return; // process.exit(0) called inside listFromNpmSource
    }

    let skills: DiscoveredSkill[];
    let context: string;
    // The ONE base every reported path is relative to. User and project runs
    // scan different trees, so each names its own.
    let root: string;

    if (options.user) {
      // User context: scan ~/.claude
      logger.info('📋 Listing user-installed skills');

      const { plugins, skills: standaloneSkills } = await scanUserContext();
      const allResources = [...plugins, ...standaloneSkills];
      const discoveredSkills = discoverSkills(allResources);
      skills = processDiscoveredSkills(discoveredSkills);
      context = 'user';
      // `scanUserContext` covers ~/.claude/plugins and ~/.claude/skills, so
      // their common parent is the base that spans both.
      root = getClaudeUserPaths().claudeDir;
    } else {
      // Project context: use resources config
      const rootDir = pathArg ?? process.cwd();
      logger.info(`📋 Listing skills in: ${rootDir}`);

      const config = loadConfig(rootDir);

      const scanResult: ScanSummary = await scan({
        path: rootDir,
        recursive: true,
        include: config?.resources?.include ?? [],
        exclude: config?.resources?.exclude ?? [],
      });

      const discoveredSkills = discoverSkills(scanResult.results);
      skills = processDiscoveredSkills(discoveredSkills);
      context = 'project';
      root = safePath.resolve(rootDir);
    }

    // Output YAML to stdout
    process.stdout.write(formatSkillsYaml(skills, context, root));

    // Human-friendly output to stderr
    outputSkillsHuman(skills, logger, options);

    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to list skills: ${errorMessage}`);
    process.exit(2);
  }
}

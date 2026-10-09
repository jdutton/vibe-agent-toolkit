/**
 * List skills in project or user installation
 *
 * By default, lists project skills. Use --user flag to list user-installed skills.
 * Supports npm:@scope/pkg and local .tgz/.tar.gz sources for inspecting packages
 * without installing them.
 */

import { basename, dirname } from 'node:path';

import { materializeIssue, readDeclaredSkillName } from '@vibe-agent-toolkit/agent-skills';
import { getClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { scan, type ScanSummary } from '@vibe-agent-toolkit/discovery';
import { buildReport, toFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { direntKindFollowingSync, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import type { DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { loadConfig } from '../../utils/config-loader.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';
import { assertReadableDirectoryArgument } from '../../utils/project-root-policy.js';
import { relativizePathEntries } from '../../utils/relativize-paths.js';
import { discoverSkills, validateSkillFilename } from '../../utils/skill-discovery.js';
import { scanUserContext } from '../../utils/user-context-scanner.js';

import type { SkillsListReport } from './list-schema.js';
import { holdsSkillMd, isNpmOrTarballSource, readSourceDir, resolveNpmOrTarballSource, withResolvedTempDirs } from './source-resolvers.js';

interface SkillsListCommandOptions {
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

/** `vat skills list` has no `--strict`: its one finding is a warning about what it could not see. */
const GATE = { strict: false } as const;

/** What one listing run found: the skills, where they are relative to, and what it could not list. */
interface Listing {
  skills: DiscoveredSkill[];
  context: string;
  /** The ONE base every published path is relative to. */
  root: string;
  unreadable: readonly DirectoryRefusal[];
  /** Temp directories the listing could not remove once it was done: one `TREE_CLEANUP_INCOMPLETE` warning each. */
  leftovers: readonly ValidationIssue[];
  /** Search roots scanned — see `SKILLS_LIST_EXAMINED`. */
  examined: number;
}

/**
 * The `SCAN_PATH_UNREADABLE` warning for a directory the scan could not list:
 * the count is then a floor, not the answer, and the document a CI wrapper
 * reads is where that has to be said — stderr is not.
 */
function unlistableDirectoryFinding(refusal: DirectoryRefusal, root: string): ValidationIssue {
  const location = toForwardSlash(safePath.relative(root, refusal.directory)) || '.';
  return materializeIssue('SCAN_PATH_UNREADABLE', {
    location,
    detail: `${location}: listing was refused with ${refusal.code}; any skill beneath it is missing from this list`,
  });
}

/**
 * Build the report. Pure: no file system, no `process.exit` — so the emitted
 * shape, `path` included, is under unit test instead of only under a CLI spawn.
 *
 * `root` is stated once and is the only absolute path in the document; every
 * `path` beneath it, skill and finding alike, is relative to it. Absolute paths
 * here named the operator's home directory on every `--user` run and made two
 * machines' output undiffable.
 *
 * @param listing - What the run found, and the roots it scanned
 * @param durationMs - How long the run took
 */
export function buildSkillsListReport(listing: Listing, durationMs: number): SkillsListReport {
  return buildReport({
    examined: listing.examined,
    findings: [
      ...toFindings(listing.unreadable.map((refusal) => unlistableDirectoryFinding(refusal, listing.root))),
      ...toFindings(listing.leftovers),
    ],
    data: {
      root: listing.root,
      context: listing.context,
      skills: relativizePathEntries(listing.skills, listing.root),
    },
    gate: GATE,
    durationMs,
  });
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
  unreadable: readonly DirectoryRefusal[],
  logger: ReturnType<typeof createLogger>,
  options: SkillsListCommandOptions
): void {
  // Absolute, like every other path on this channel — see the docstring.
  for (const refusal of unreadable) {
    logger.info(
      `warning: could not list ${refusal.directory} (${refusal.code}); any skill beneath it is missing from this list.`,
    );
  }
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
  const skills: DiscoveredSkill[] = [];

  for (const entry of readSourceDir(skillsDir)) {
    // Followed: a `--dev` install is a symlinked skill directory and is listed.
    if (direntKindFollowingSync(skillsDir, entry) !== 'directory') continue;
    const candidate = safePath.join(skillsDir, entry.name);
    if (holdsSkillMd(candidate)) {
      skills.push(...processDiscoveredSkills([{ path: safePath.join(candidate, 'SKILL.md') }]));
    }
  }

  return skills;
}

/**
 * List skills from an npm: or .tgz/.tar.gz source without installing.
 */
async function listFromNpmSource(source: string, logger: ReturnType<typeof createLogger>): Promise<Listing> {
  logger.info(`📋 Inspecting npm/tgz source: ${source}`);

  const resolved = await resolveNpmOrTarballSource(source);
  // The extracted package's own skills dir is the base — the enclosing temp
  // directory is an implementation detail nobody can act on. `[]` is a
  // statement, not a default: this is one listing of a tree this process just
  // extracted, and a listing it cannot read refuses the run instead.
  const { value: skills, leftovers } = await withResolvedTempDirs(resolved.tempDirs, () => scanSkillsDir(resolved.skillsDir));
  return { skills, context: 'npm', root: resolved.skillsDir, unreadable: [], leftovers, examined: 1 };
}

/** `--user`: Claude's `plugins/` and `skills/` directories — both scanned, an absent one empty. */
async function listUserSkills(logger: ReturnType<typeof createLogger>): Promise<Listing> {
  logger.info('📋 Listing user-installed skills');

  const { plugins, skills: standaloneSkills, unreadable } = await scanUserContext();
  return {
    skills: processDiscoveredSkills(discoverSkills([...plugins, ...standaloneSkills])),
    context: 'user',
    // `scanUserContext` covers ~/.claude/plugins and ~/.claude/skills, so
    // their common parent is the base that spans both.
    root: getClaudeUserPaths().claudeDir,
    unreadable,
    leftovers: [],
    examined: USER_SEARCH_ROOTS,
  };
}

/** Claude's `plugins/` and `skills/` directories. */
const USER_SEARCH_ROOTS = 2;

/** A project directory: the argument (refused when it names no readable directory), or the cwd. */
async function listProjectSkills(pathArg: string | undefined, logger: ReturnType<typeof createLogger>): Promise<Listing> {
  const rootDir = pathArg === undefined ? process.cwd() : assertReadableDirectoryArgument(pathArg);
  logger.info(`📋 Listing skills in: ${rootDir}`);

  const config = loadConfig(rootDir);
  const scanResult: ScanSummary = await scan({
    path: rootDir,
    recursive: true,
    include: config?.resources?.include ?? [],
    exclude: config?.resources?.exclude ?? [],
  });

  return {
    skills: processDiscoveredSkills(discoverSkills(scanResult.results)),
    context: 'project',
    root: safePath.resolve(rootDir),
    unreadable: scanResult.unreadable,
    leftovers: [],
    examined: 1,
  };
}

function gatherListing(pathArg: string | undefined, options: SkillsListCommandOptions, logger: ReturnType<typeof createLogger>): Promise<Listing> {
  // npm: or .tgz/.tar.gz source — inspect without installing
  if (pathArg !== undefined && isNpmOrTarballSource(pathArg)) return listFromNpmSource(pathArg, logger);
  if (options.user) return listUserSkills(logger);
  return listProjectSkills(pathArg, logger);
}

export async function listCommand(
  pathArg: string | undefined,
  options: SkillsListCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let listing: Listing;
  try {
    listing = await gatherListing(pathArg, options, logger);
  } catch (error) {
    endWithRefusal('skills list', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }

  // Human-friendly output to stderr, then the report on stdout.
  outputSkillsHuman(listing.skills, listing.unreadable, logger, options);
  endWithReport('skills list', buildSkillsListReport(listing, Date.now() - startTime), 'yaml');
}

/** Test-facing seam: the pure decisions of this module, reached by its unit tests. */
export const __internal = { outputSkillsHuman };

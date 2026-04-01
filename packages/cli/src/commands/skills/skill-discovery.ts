/**
 * Skill discovery from config yaml
 *
 * Reads skills.include/exclude glob patterns from vibe-agent-toolkit.config.yaml,
 * finds matching SKILL.md files, and extracts skill names from frontmatter.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
import { crawlDirectory } from '@vibe-agent-toolkit/utils';

import type { DiscoveredSkill } from './command-helpers.js';

/**
 * Directories that should always be excluded from skill discovery for performance.
 */
const DISCOVERY_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/coverage/**',
];

/**
 * Read skill name from SKILL.md frontmatter.
 * Falls back to H1 title, then filename.
 */
async function readSkillName(skillPath: string): Promise<string | undefined> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillPath from glob discovery
  const content = await readFile(skillPath, 'utf-8');
  const parsed = await parseMarkdown(skillPath);
  const name = parsed.frontmatter?.['name'];
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }
  // Fallback: try H1 title
  // eslint-disable-next-line sonarjs/slow-regex -- Using [^\n]+ instead of .+ to avoid backtracking
  const h1Match = /^#\s+([^\n]+)$/m.exec(content);
  if (h1Match?.[1]) {
    return h1Match[1].trim();
  }
  return basename(skillPath, '.md');
}

/**
 * Discover skills from config yaml skills section.
 *
 * Uses crawlDirectory from utils for glob matching (picomatch-based,
 * cross-platform, no additional dependencies).
 *
 * @param skillsConfig - The skills section from vibe-agent-toolkit.config.yaml
 * @param projectRoot - Absolute path to project root (where config yaml lives)
 * @returns Array of discovered skills with names and source paths
 */
export async function discoverSkillsFromConfig(
  skillsConfig: SkillsConfig,
  projectRoot: string
): Promise<DiscoveredSkill[]> {
  const { include, exclude } = skillsConfig;

  // Discover SKILL.md files using crawlDirectory (picomatch globs)
  const skillPaths = await crawlDirectory({
    baseDir: projectRoot,
    include,
    exclude: [
      ...DISCOVERY_EXCLUDE,
      ...(exclude ?? []),
    ],
    dot: true, // Match through dot-directories (e.g., .claude/worktrees/)
  });

  const discovered: DiscoveredSkill[] = [];

  for (const skillPath of skillPaths) {
    const name = await readSkillName(skillPath);
    if (!name) {
      continue;
    }

    discovered.push({ name, sourcePath: skillPath });
  }

  return discovered;
}

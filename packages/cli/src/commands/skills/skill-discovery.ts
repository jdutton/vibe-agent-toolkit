/**
 * Skill discovery from config yaml
 *
 * Reads skills.include/exclude glob patterns from vibe-agent-toolkit.config.yaml,
 * finds matching SKILL.md files, and extracts skill names from frontmatter.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { parseFileCached } from '@vibe-agent-toolkit/resources';
import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
import { crawlDirectory, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

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
 * Read a skill's name from SKILL.md frontmatter, falling back to its H1 title and
 * then its filename. Exported so the Claude plugin build resolves a plugin-local
 * skill's name through the SAME definition `vat skills build` uses — per-skill
 * config is keyed by name, so two answers would mean two effective configs.
 */
export async function readSkillName(skillPath: string): Promise<string | undefined> {
  const parsed = await parseFileCached(skillPath, 'markdown');
  // The H1 fallback below reads the SAME bytes the parse already decoded, so it
  // uses `parsed.content` rather than a second read of the same path.
  const content = parsed.content;
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
 * Split an include pattern into its literal base directory and its glob
 * remainder. `picomatch.scan` already does the heavy lifting for proper
 * glob patterns; the manual split handles pure-literal paths so a single
 * SKILL.md file is still crawlable from its parent directory.
 */
function splitIncludePattern(pattern: string): { base: string; glob: string } {
  const scanned = picomatch.scan(pattern);
  if (scanned.isGlob) {
    return { base: scanned.base, glob: scanned.glob };
  }
  // Literal path (no glob metachars): match the file from its parent.
  const slash = pattern.lastIndexOf('/');
  if (slash === -1) {
    return { base: '', glob: pattern };
  }
  return { base: pattern.slice(0, slash), glob: pattern.slice(slash + 1) };
}

/**
 * Group include patterns by their effective scan root. Each pattern's literal
 * prefix (resolved against `projectRoot`) becomes the absolute scan root for
 * its glob remainder, which is what lets `..` segments escape `projectRoot`.
 */
function groupIncludePatternsByBase(
  include: string[],
  projectRoot: string,
): Map<string, string[]> {
  const patternsByBase = new Map<string, string[]>();
  for (const pattern of include) {
    const { base, glob } = splitIncludePattern(pattern);
    const absBase = safePath.resolve(projectRoot, base || '.');
    const effectiveGlob = glob.length > 0 ? glob : '**/*';
    const existing = patternsByBase.get(absBase) ?? [];
    existing.push(effectiveGlob);
    patternsByBase.set(absBase, existing);
  }
  return patternsByBase;
}

/**
 * Crawl one effective scan root. Returns absolute paths, or an empty array if
 * the root does not exist (mirrors audit's filesystem-first tolerance for
 * patterns pointing at nothing).
 */
async function crawlOneBase(base: string, globs: string[]): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- base derived from validated config
  if (!existsSync(base)) {
    return [];
  }
  return crawlDirectory({
    baseDir: base,
    include: globs,
    exclude: DISCOVERY_EXCLUDE,
    // A skill the author has written but not yet committed MUST be discoverable.
    // Without this, `crawlDirectory`'s `git ls-files` fast path sees only tracked
    // files, so a brand-new SKILL.md is invisible: `vat skills validate` reports
    // one fewer skill and exits 0, and `vat skills build` silently does not ship
    // it. Nothing warns — the count is the only tell, and you have to know what
    // it should have been. `includeUntracked` is the documented knob for exactly
    // this and keeps the fast path (unlike `respectGitignore: false`, which costs
    // a full walk); the inventory lane already used it for the same reason.
    includeUntracked: true,
  });
}

/**
 * Discover skills from config yaml skills section.
 *
 * Each include pattern is resolved against `projectRoot` and may step out of
 * the package via `..` (e.g. `"../../docs/skills/*\/SKILL.md"` in a monorepo
 * where SKILL.md files live alongside, not inside, the package). Patterns are
 * grouped by their effective scan root so `crawlDirectory` is invoked once per
 * root rather than blindly walking from `projectRoot`.
 *
 * User-supplied excludes are matched against paths relative to `projectRoot`
 * so anchored excludes like `docs/private/**` keep their original meaning
 * regardless of which scan root produced the candidate file.
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

  const patternsByBase = groupIncludePatternsByBase(include, projectRoot);
  const userExcludeMatcher = exclude && exclude.length > 0
    ? picomatch(exclude, { dot: true })
    : null;

  const foundAbsPaths = new Set<string>();
  for (const [base, globs] of patternsByBase) {
    const crawled = await crawlOneBase(base, globs);
    for (const absPath of crawled) {
      if (userExcludeMatcher) {
        const relFromProject = toForwardSlash(safePath.relative(projectRoot, absPath));
        if (userExcludeMatcher(relFromProject)) continue;
      }
      foundAbsPaths.add(safePath.resolve(absPath));
    }
  }

  const discovered: DiscoveredSkill[] = [];
  for (const skillPath of foundAbsPaths) {
    const name = await readSkillName(skillPath);
    if (name) discovered.push({ name, sourcePath: skillPath });
  }
  return discovered;
}

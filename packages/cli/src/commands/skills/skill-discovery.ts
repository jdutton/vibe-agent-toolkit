/**
 * Skill discovery from config yaml
 *
 * Reads skills.include/exclude glob patterns from vibe-agent-toolkit.config.yaml,
 * finds matching SKILL.md files, and extracts skill names from frontmatter.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import type { PluginLocalSkillIndex } from '@vibe-agent-toolkit/agent-skills';
import { parseFileCached } from '@vibe-agent-toolkit/resources';
import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectory, type UnreadablePolicy } from '@vibe-agent-toolkit/utils/crawl';
import picomatch from 'picomatch';

import type { DiscoveredSkill } from './command-helpers.js';

/**
 * How discovery treats a directory its crawl cannot list. REQUIRED at every
 * call — there is no default, so `tsc` enumerates the callers and each one
 * carries its decision at the call site.
 *
 * `'refuse'` — discovery throws `DirectoryListingRefusedError` with the
 * adopter-facing sentence (root-relative directory, `skills.include` remedy),
 * because a shorter skill list is the tell-less drop every command downstream
 * would then confidently work from. The right answer for `vat skills validate`,
 * `vat skills build`, `vat verify` and the rest, which must not act on a
 * population they could not see. Discovery owns the sentence, which is why the
 * arm is a literal here rather than the crawler's `{ refuse: { root, remedy } }`.
 *
 * `{ degrade }` — for a caller whose honest answer is to keep going: `vat
 * audit`, which reports an unreadable path as `SCAN_PATH_UNREADABLE` and
 * validates every readable sibling. Discovery enumerates around the refused
 * directory, hands the refusal to the handler, and returns every skill it
 * COULD see. The same arm, same shape, as the crawler's own.
 *
 * 🪤 This was `DiscoveryOptions { onUnreadable?: … }`, optional, defaulting to
 * refuse. Every caller that omitted it compiled, and the one that should have
 * degraded surfaced a round later as a HIGH.
 */
export type DiscoveryUnreadablePolicy = 'refuse' | Extract<UnreadablePolicy, { degrade: unknown }>;

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
 * then its filename. The Claude plugin build and `vat verify` reach it through
 * {@link readPluginLocalSkillName}, so a plugin-local skill is named by the SAME
 * definition `vat skills build` uses — per-skill config is keyed by name, so two
 * answers would mean two effective configs.
 *
 * The fallback is a KEY, not a verdict. A name is optional on the agentskills.io
 * schema, so a nameless frontmatter block is a legal skill and needs a key; a
 * file with NO frontmatter at all is not a skill, but discovery still returns it
 * under this key so the glob match is reported rather than dropped — the
 * packaging validator refuses it as `SKILL_MISSING_FRONTMATTER`, located at the
 * file's path. Excluding it here instead would shrink the denominator silently,
 * which is the exact tell-less drop `includeUntracked` below exists to prevent.
 */
async function readSkillName(skillPath: string): Promise<string | undefined> {
  const parsed = await parseFileCached(skillPath, 'markdown');
  // The H1 fallback below reads the SAME bytes the parse already decoded, so it
  // uses `parsed.content` rather than a second read of the same path.
  const content = parsed.content;
  const name = parsed.frontmatter?.['name'];
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }
  // Fallback: try H1 title
  // `[ \t]` is a single fixed-width class, not a quantifier, so it cannot compete
  // with the `[^\n]*` capture for the same space — that ambiguity is what made the
  // old `\s+([^\n]+)` form backtrack super-linearly. .trim() below is unchanged.
  const h1Match = /^#[ \t]([^\n]*)$/m.exec(content);
  if (h1Match?.[1]) {
    return h1Match[1].trim();
  }
  return basename(skillPath, '.md');
}

/**
 * The declared name of each plugin-local skill, keyed by its resolved source directory
 * — the key per-skill config goes by (see `pluginLocalSkillConfigEntry`). `vat verify`
 * reads it ONCE per run, for every location in the index, including a location no
 * `skills.include` glob reaches: that skill still has a declared name, and the plugin
 * build packages it under that name's config.
 */
export type PluginLocalSkillNames = ReadonlyMap<string, string>;

/**
 * The declared name of the plugin-local skill in `skillSourceDir` ({@link readSkillName}),
 * else `skillDirPath`'s trailing segment. The plugin build and `vat verify` both name a
 * plugin-local skill through THIS, so they look up the same config.
 */
export async function readPluginLocalSkillName(skillSourceDir: string, skillDirPath: string): Promise<string> {
  return (await readSkillName(safePath.join(skillSourceDir, 'SKILL.md'))) ?? basename(skillDirPath);
}

/** {@link PluginLocalSkillNames} for every location in `pluginLocal`. */
export async function readPluginLocalSkillNames(pluginLocal: PluginLocalSkillIndex): Promise<PluginLocalSkillNames> {
  const names = new Map<string, string>();
  for (const loc of pluginLocal.locations) {
    const key = safePath.resolve(loc.skillSourceDir);
    if (!names.has(key)) names.set(key, await readPluginLocalSkillName(loc.skillSourceDir, loc.skillDirPath));
  }
  return names;
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
async function crawlOneBase(
  base: string,
  globs: string[],
  projectRoot: string,
  unreadable: DiscoveryUnreadablePolicy,
): Promise<string[]> {
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
    // Under `'refuse'`, a directory the crawl cannot LIST stops discovery, by
    // name. The alternative — enumerate around it — is the same tell-less drop
    // described above, from the other direction: one fewer skill, exit 0, and
    // every command downstream (build, validate, verify, audit's config-aware
    // lane) confidently working from the shorter list. The remedy names
    // `skills.include` rather than `skills.exclude`, because `exclude` is
    // applied to the crawl's RESULT and cannot stop the crawl from entering
    // the directory; only a narrower include base can. Expressed against the
    // project root — the coordinates the include pattern itself is written in,
    // `..` and all.
    //
    // A caller that has decided to degrade passes its handler straight through
    // (see {@link DiscoveryUnreadablePolicy}); the refusal is then reported by
    // that caller, and the crawl continues past the directory.
    unreadable: unreadable === 'refuse'
      ? { refuse: { root: projectRoot, remedy: SKILLS_INCLUDE_REMEDY } }
      : unreadable,
  });
}

/** The knob an adopter has when `skills.include` reaches a directory the crawl cannot list. */
export const SKILLS_INCLUDE_REMEDY =
  'Fix the permissions on that directory, or narrow the `skills.include` pattern so its base no longer reaches into it.';

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
 * @param unreadable - What to do with a directory the crawl cannot list —
 *   see {@link DiscoveryUnreadablePolicy}; required, no default
 * @returns Array of discovered skills with names and source paths
 */
export async function discoverSkillsFromConfig(
  skillsConfig: SkillsConfig,
  projectRoot: string,
  unreadable: DiscoveryUnreadablePolicy,
): Promise<DiscoveredSkill[]> {
  const { include, exclude } = skillsConfig;

  const patternsByBase = groupIncludePatternsByBase(include, projectRoot);
  const userExcludeMatcher = exclude && exclude.length > 0
    ? picomatch(exclude, { dot: true })
    : null;

  const foundAbsPaths = new Set<string>();
  for (const [base, globs] of patternsByBase) {
    const crawled = await crawlOneBase(base, globs, projectRoot, unreadable);
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

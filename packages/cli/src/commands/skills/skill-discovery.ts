/**
 * Skill discovery from config yaml
 *
 * Reads skills.include/exclude glob patterns from vibe-agent-toolkit.config.yaml,
 * finds matching SKILL.md files, and extracts skill names from frontmatter.
 */

import { basename } from 'node:path';

import type { PluginLocalSkillIndex } from '@vibe-agent-toolkit/agent-skills';
import {
  type ParseDispatcher,
  parseFileCached,
  type ParseRefusedResource,
  parseRefusedEntryFor,
  parseRefusedMessage,
  type ParseResult,
  type ParseRoute,
  type SkillsConfig,
  withParseDispatcher,
} from '@vibe-agent-toolkit/resources';
import { followedKindSync, forEachInOrder, fsFaultOf, issueLocation, mapConcurrentFailingInOrder, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectory, type UnreadablePolicy } from '@vibe-agent-toolkit/utils/crawl';
import picomatch from 'picomatch';

import { CommandRefusalError } from '../../utils/command-refusal.js';

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
 * arm is a literal here rather than the crawler's `{ refuse: { root, remedy, side } }`.
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

/** What one SKILL.md read gave a lane: its parse, or the parse worker's refusal of it for this run. */
export type SkillDocumentRead =
  | { readonly kind: 'parsed'; readonly document: ParseResult }
  | { readonly kind: 'refused'; readonly refused: ParseRefusedResource };

/** A skill's name, or the refusal that left it with none this run can read — never a fallback. */
export type SkillNameRead =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'refused'; readonly refused: ParseRefusedResource };

/**
 * What config discovery found: the skills it could name, and the SKILL.md files the parse
 * worker refused for this run. Both required: a refused skill has no name to key its config
 * by, so each caller reports these through the not-admitted contract or refuses the run.
 */
export interface SkillDiscovery {
  readonly skills: DiscoveredSkill[];
  readonly parseRefused: readonly ParseRefusedResource[];
}

/**
 * Parse a SKILL.md in the bounded worker (`parseFileCached`). A per-run refusal is carried as
 * `refused`; every other error — a broken parser install included — is rethrown.
 */
export async function skillDocumentOrRefused(skillPath: string, route: ParseRoute = {}): Promise<SkillDocumentRead> {
  try {
    return { kind: 'parsed', document: await parseFileCached(skillPath, 'markdown', route) };
  } catch (error) {
    const refused = parseRefusedEntryFor(skillPath, error);
    if (refused === undefined) throw error;
    return { kind: 'refused', refused };
  }
}

/** What a refused SKILL.md cost a lane that needed its skill's name. */
const SKILL_NAME_UNREAD = 'the skill it defines has no name this run can read, and nothing was done with it';

/**
 * The refusal of a run that needed the name of a skill whose SKILL.md the parse worker refused:
 * `INPUT_UNREADABLE` for a limit, `RUN_INCOMPLETE` for a dead worker, in the not-admitted sentence.
 */
export function skillParseRefusal(entry: ParseRefusedResource, locationRoot: string): CommandRefusalError {
  const message = parseRefusedMessage(entry, issueLocation(entry.filePath, locationRoot), SKILL_NAME_UNREAD);
  return new CommandRefusalError(entry.code === 'RESOURCE_PARSE_WORKER_DIED' ? 'RUN_INCOMPLETE' : 'INPUT_UNREADABLE', message);
}

/** The discovered skills, or the run's refusal when any SKILL.md was refused: for a verb that cannot act on what it could not name. */
export function namedSkillsOrRefuse(discovery: SkillDiscovery, locationRoot: string): DiscoveredSkill[] {
  const [first] = discovery.parseRefused;
  if (first !== undefined) throw skillParseRefusal(first, locationRoot);
  return discovery.skills;
}

/** The name `read` resolves to, or the run's refusal when the parse worker refused `skillMdPath`. */
export async function declaredNameOrRefuse(
  skillMdPath: string,
  read: Promise<string | undefined>,
  locationRoot: string,
): Promise<string | undefined> {
  try {
    return await read;
  } catch (error) {
    const refused = parseRefusedEntryFor(skillMdPath, error);
    if (refused === undefined) throw error;
    throw skillParseRefusal(refused, locationRoot);
  }
}

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
 *
 * A SKILL.md the parse worker refuses has no name: it is `refused`, never a key.
 */
async function readSkillName(skillPath: string, dispatcher: ParseDispatcher): Promise<SkillNameRead> {
  const read = await skillDocumentOrRefused(skillPath, { dispatcher });
  if (read.kind === 'refused') return read;
  // The H1 fallback below reads the SAME bytes the parse already decoded, so it
  // uses `content` rather than a second read of the same path.
  const { content, frontmatter } = read.document;
  const name = frontmatter?.['name'];
  if (typeof name === 'string' && name.length > 0) {
    return { kind: 'named', name };
  }
  // Fallback: try H1 title
  // `[ \t]` is a single fixed-width class, not a quantifier, so it cannot compete
  // with the `[^\n]*` capture for the same space — that ambiguity is what made the
  // old `\s+([^\n]+)` form backtrack super-linearly. .trim() below is unchanged.
  const h1Match = /^#[ \t]([^\n]*)$/m.exec(content);
  if (h1Match?.[1]) {
    return { kind: 'named', name: h1Match[1].trim() };
  }
  return { kind: 'named', name: basename(skillPath, '.md') };
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
 * The name of the plugin-local skill in `skillSourceDir` ({@link readSkillName}), or its
 * refusal. The plugin build and `vat verify` both name a plugin-local skill through THIS,
 * so they look up the same config.
 */
export function readPluginLocalSkillName(skillSourceDir: string, dispatcher?: ParseDispatcher): Promise<SkillNameRead> {
  return withParseDispatcher((run) => readSkillName(safePath.join(skillSourceDir, 'SKILL.md'), run), { dispatcher });
}

/** {@link PluginLocalSkillNames} for every location in `pluginLocal`, or the run's refusal ({@link skillParseRefusal}). */
export async function readPluginLocalSkillNames(pluginLocal: PluginLocalSkillIndex, locationRoot: string): Promise<PluginLocalSkillNames> {
  // The first location per resolved directory, as before; their reads are independent.
  const firstByKey = new Map<string, (typeof pluginLocal.locations)[number]>();
  for (const loc of pluginLocal.locations) {
    const key = safePath.resolve(loc.skillSourceDir);
    if (!firstByKey.has(key)) firstByKey.set(key, loc);
  }
  const entries = [...firstByKey];
  const read = await withParseDispatcher((dispatcher) =>
    mapConcurrentFailingInOrder(entries, ([, loc]) => readPluginLocalSkillName(loc.skillSourceDir, dispatcher)),
  );
  return new Map(entries.map(([key], index) => {
    const name = read[index] as SkillNameRead;
    if (name.kind === 'refused') throw skillParseRefusal(name.refused, locationRoot);
    return [key, name.name];
  }));
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
 * Whether a scan root resolves to nothing, its links read beneath the project root first. A probe
 * that could not examine it (the OS refused it, or its chain names a network path) is NOT absent:
 * the crawl is asked, and its `unreadable` policy decides — refusing the run or degrading past the
 * base by name — exactly as for a base whose listing is refused.
 */
function baseAbsent(base: string, projectRoot: string): boolean {
  try {
    return followedKindSync(base, projectRoot) === 'absent';
  } catch (error) {
    if (fsFaultOf(error) === undefined) throw error;
    return false;
  }
}

/**
 * Crawl one effective scan root. Returns absolute paths, or an empty array if
 * the root does not exist (mirrors audit's filesystem-first tolerance for
 * patterns pointing at nothing).
 */
function crawlOneBase(
  base: string,
  globs: string[],
  projectRoot: string,
  unreadable: DiscoveryUnreadablePolicy,
): Promise<string[]> {
  if (baseAbsent(base, projectRoot)) {
    return Promise.resolve([]);
  }
  return crawlDirectory({
    outputs: [],
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
      ? { refuse: { root: projectRoot, remedy: SKILLS_INCLUDE_REMEDY, side: 'source' } }
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
 * @returns The skills it named, with their source paths, and the SKILL.md files the parse worker refused
 */
export async function discoverSkillsFromConfig(
  skillsConfig: SkillsConfig,
  projectRoot: string,
  unreadable: DiscoveryUnreadablePolicy,
): Promise<SkillDiscovery> {
  const { include, exclude } = skillsConfig;

  const patternsByBase = groupIncludePatternsByBase(include, projectRoot);
  const userExcludeMatcher = exclude && exclude.length > 0
    ? picomatch(exclude, { dot: true })
    : null;

  const foundAbsPaths = new Set<string>();
  // One base at a time: under `'refuse'` the first unlistable directory in
  // pattern order is the one named, and a degrade handler hears them in order.
  await forEachInOrder(patternsByBase, async ([base, globs]) => {
    const crawled = await crawlOneBase(base, globs, projectRoot, unreadable);
    for (const absPath of crawled) {
      if (userExcludeMatcher) {
        const relFromProject = toForwardSlash(safePath.relative(projectRoot, absPath));
        if (userExcludeMatcher(relFromProject)) continue;
      }
      foundAbsPaths.add(safePath.resolve(absPath));
    }
  });

  // Independent reads, kept in discovery order.
  const skillPaths = [...foundAbsPaths];
  const names = await withParseDispatcher((dispatcher) =>
    mapConcurrentFailingInOrder(skillPaths, (skillPath) => readSkillName(skillPath, dispatcher)),
  );
  const skills: DiscoveredSkill[] = [];
  const parseRefused: ParseRefusedResource[] = [];
  for (const [index, sourcePath] of skillPaths.entries()) {
    const read = names[index] as SkillNameRead;
    if (read.kind === 'refused') parseRefused.push(read.refused);
    else if (read.name) skills.push({ name: read.name, sourcePath });
  }
  return { skills, parseRefused };
}

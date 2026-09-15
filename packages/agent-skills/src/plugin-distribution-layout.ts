/**
 * Plugin distribution layout helpers.
 *
 * Shared primitives for locating where `vat build --only claude` places
 * tree-copied plugin skills in the output tree, and where it reads them from.
 *
 * Consumed by `vat build`, `vat verify`, consistency-check and skill-reference
 * resolution so the path conventions can never drift between those commands.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync } from '@vibe-agent-toolkit/utils/crawl';
import { gitFindRoot, isGitIgnored } from '@vibe-agent-toolkit/utils/git';

/**
 * Absolute path to the built plugin output directory.
 *
 * Shape: `<configDir>/dist/.claude/plugins/marketplaces/<mp>/plugins/<name>/`
 *
 * Extracted verbatim from build.ts lines 577–580 so that build can later adopt
 * this helper with zero behavior change.
 */
export function getPluginOutputDir(
  configDir: string,
  marketplaceName: string,
  pluginName: string,
): string {
  return safePath.join(
    configDir,
    'dist',
    '.claude',
    'plugins',
    'marketplaces',
    marketplaceName,
    'plugins',
    pluginName,
  );
}

/**
 * Absolute path to the plugin source directory.
 *
 * Resolves to `<configDir>/<plugin.source>` when the plugin declares a custom
 * source, otherwise `<configDir>/plugins/<plugin.name>`.
 *
 * Extracted verbatim from build.ts lines 581–584.
 */
export function getPluginSourceDir(
  configDir: string,
  plugin: { name: string; source?: string | undefined },
): string {
  return safePath.join(
    configDir,
    plugin.source ?? safePath.join('plugins', plugin.name),
  );
}

/**
 * Every plugin-local SKILL DIRECTORY under `<pluginSourceDir>/skills/`, as a
 * forward-slash path relative to that `skills/` dir (`my-skill`,
 * `group/nested-skill`).
 *
 * Three properties, each of which a previous shape got wrong and shipped a bug:
 *
 * 1. **A skill is a directory holding a `SKILL.md`** — not "any immediate
 *    subdirectory of `skills/`". A `shared/` helper dir, a `_templates/` dir, or
 *    the mere PARENT of a nested skill is not a skill; it has no packager, so the
 *    plugin build's verbatim tree-copy is its only route into the bundle and it
 *    must not appear here.
 * 2. **Recursive.** Claude Code discovers `skills/<group>/<skill>/SKILL.md`, so
 *    VAT must too. A non-recursive listing left every nested plugin-local skill
 *    to the verbatim tree-copy — shipping its eval suite (answer key included),
 *    scratch files, and un-rewritten links, and producing it a SECOND time when
 *    the same skill was also selected from the pool.
 * 3. **Same file visibility as the tree-copy** (`crawlDirectorySync` with
 *    `respectGitignore`, i.e. tracked files only inside a git repo). The two
 *    producers of a plugin's `skills/` tree must agree on which files exist at
 *    all; a `readdirSync` listing saw gitignored/untracked skill directories the
 *    tree-copy would never have shipped, and packaged them into the published
 *    marketplace bundle.
 *
 * A skill nested INSIDE another skill (`a/SKILL.md` and `a/b/SKILL.md`) yields
 * only the outermost (`a`): the inner dir is part of the outer skill's own tree,
 * and packaging both would have the inner packager write into a directory the
 * outer packager owns.
 *
 * Returns `[]` when the `skills/` directory does not exist (pool-only plugin).
 */
export function listPluginSourceSkillDirs(pluginSourceDir: string): string[] {
  return crawlSkillDirs(pluginSourceDir, true);
}

/**
 * The skill directories under `<pluginSourceDir>/skills/` that exist ON DISK but are
 * INVISIBLE to {@link listPluginSourceSkillDirs} because git does not track them.
 *
 * Purely diagnostic. Git visibility is the correct filter — both producers of a
 * plugin's `skills/` tree honor it, and it is what stops a gitignored skill dir from
 * being published. But "correct" and "obvious" are different things: a skill the
 * author has just created and not yet `git add`ed is simply absent from the built
 * plugin, and a silent absence reads as a build that shipped everything. The caller
 * warns for these; a deliberately GITIGNORED dir is not in this list (see
 * {@link listUntrackedPluginSkillDirs}), because ignoring it IS the instruction.
 *
 * Returns `[]` outside a git repo, where every directory is visible anyway.
 */
export function listUntrackedPluginSkillDirs(pluginSourceDir: string): string[] {
  const skillsDir = safePath.join(pluginSourceDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  if (gitFindRoot(safePath.resolve(skillsDir)) === null) return [];

  const visible = new Set(listPluginSourceSkillDirs(pluginSourceDir));
  return crawlSkillDirs(pluginSourceDir, false).filter(
    (dir) => !visible.has(dir) && !isGitIgnored(safePath.join(skillsDir, dir), skillsDir),
  );
}

/**
 * Shared discovery for {@link listPluginSourceSkillDirs} (git-visible files, the
 * real answer) and {@link listUntrackedPluginSkillDirs} (every file on disk, the
 * diagnostic baseline). One implementation so the two listings can differ ONLY in
 * git visibility — the whole point of the comparison.
 */
function crawlSkillDirs(pluginSourceDir: string, respectGitignore: boolean): string[] {
  const skillsDir = safePath.join(pluginSourceDir, 'skills');
  if (!existsSync(skillsDir)) return [];

  // `exclude: []` (not the crawler's default) so this sees exactly what
  // treeCopyPlugin sees — the only filter either applies is git visibility.
  //
  // A directory this crawl cannot LIST stops the build, by name, for the same
  // reason the tree-copy stops: this listing decides which skills get packaged,
  // and a shorter answer ships a plugin missing every skill beneath the refused
  // directory while the build reports success — the one silent drop property 3
  // above exists to prevent. Expressed against the plugin source dir so the
  // message reads `skills/<group>`, the path the author sees.
  const skillFiles = crawlDirectorySync({
    baseDir: skillsDir,
    include: ['**/SKILL.md'],
    exclude: [],
    absolute: false,
    filesOnly: true,
    respectGitignore,
    unreadable: {
      refuse: {
        root: pluginSourceDir,
        remedy:
          'Fix the permissions on that directory, or move it out of the plugin\'s `skills/` tree so the build no longer has to list it.',
      },
    },
  });

  const dirs = skillFiles
    .map((rel) => toForwardSlash(dirname(rel)))
    // `dirname` of a bare `SKILL.md` is `.`: a skill file directly in `skills/` would
    // make the whole tree one skill, which is not a layout VAT recognizes and would
    // swallow every sibling.
    .filter((dir) => dir !== '.' && dir !== '')
    // Lexicographic order puts a parent immediately before its own descendants (a
    // proper prefix always sorts first), which is all the outermost-wins scan needs.
    .sort((a, b) => a.localeCompare(b));

  const outermost: string[] = [];
  for (const dir of dirs) {
    if (!outermost.some((kept) => toForwardSlash(dir).startsWith(`${toForwardSlash(kept)}/`))) {
      outermost.push(dir);
    }
  }
  return outermost;
}

/** Location of a single skill shipped via source tree-copy. */
export interface DistributedSkillLocation {
  /** Name of the marketplace this skill ships through. */
  marketplaceName: string;
  /** Name of the plugin that contains this skill. */
  pluginName: string;
  /**
   * Forward-slash path of the skill's directory RELATIVE to the plugin's `skills/`
   * dir — `my-skill`, or `group/nested-skill` for a nested skill. A path, not a
   * bare name: the output layout mirrors the source layout, so a nested skill
   * ships at the same depth it was authored at.
   */
  skillDirPath: string;
  /** Absolute SOURCE skill dir: `<pluginSourceDir>/skills/<skillDirPath>`. */
  skillSourceDir: string;
  /** Absolute output path where `vat build` places the skill: `getPluginOutputDir(...)/skills/<skillDirPath>`. */
  skillOutputDir: string;
}

/**
 * Every plugin-local skill across all marketplaces in the config, paired with the
 * output directory where `vat build` places it.
 *
 * "Tree-copied" in the name is historical: plugin-local skills are PACKAGED (see
 * `packagePluginLocalSkills` in the CLI's plugin build), not copied verbatim. The
 * locations are unchanged, which is what every consumer here actually needs.
 *
 * Pool-only plugins — those whose source `skills/` directory is absent on disk
 * — contribute nothing to the result.
 */
export function computeTreeCopiedSkillLocations(
  config: ProjectConfig,
  configDir: string,
): DistributedSkillLocation[] {
  const locations: DistributedSkillLocation[] = [];

  const marketplaces = config.claude?.marketplaces;
  if (!marketplaces) return locations;

  for (const [marketplaceName, marketplace] of Object.entries(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      const pluginSourceDir = getPluginSourceDir(configDir, plugin);
      const skillDirPaths = listPluginSourceSkillDirs(pluginSourceDir);
      if (skillDirPaths.length === 0) continue;

      const pluginOutputDir = getPluginOutputDir(configDir, marketplaceName, plugin.name);
      for (const skillDirPath of skillDirPaths) {
        locations.push({
          marketplaceName,
          pluginName: plugin.name,
          skillDirPath,
          skillSourceDir: safePath.join(pluginSourceDir, 'skills', skillDirPath),
          skillOutputDir: safePath.join(pluginOutputDir, 'skills', skillDirPath),
        });
      }
    }
  }

  return locations;
}

/** FS-safe single path segment for a skill name (colon → `__`, invalid on Windows). */
export function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

/**
 * Why a skill sitting under a plugin's `skills/` directory is NOT plugin-local — the
 * plugin build does not ship it:
 *   - `untracked` — its directory IS `skillSourceDir`: a skill directory under plugin
 *     `pluginName`'s `skills/` that git does not track ({@link listUntrackedPluginSkillDirs});
 *     `git add` makes it ship.
 *   - `nested` — its directory is inside `outer`, another skill's directory under plugin
 *     `outer.pluginName`'s `skills/` (tracked or not), and the plugin build packages only
 *     the outermost skill directory — so `git add` changes nothing for it.
 */
export type PluginSkillExclusion =
  | ({ readonly kind: 'untracked' } & UntrackedPluginSkillDir)
  | { readonly kind: 'nested'; readonly outer: UntrackedPluginSkillDir };

/** The plugin-local skills a project ships — see {@link indexPluginLocalSkills}. */
export interface PluginLocalSkillIndex {
  /** Every plugin-local skill location, as {@link computeTreeCopiedSkillLocations} lists them. */
  readonly locations: readonly DistributedSkillLocation[];
  /**
   * The location of the skill whose `SKILL.md` is at `skillMdPath` — matched by the
   * directory holding that file — or `undefined` when the skill is not plugin-local.
   * One plugin listed in several marketplaces yields one location per listing; this is
   * the FIRST, in config order (see {@link locationsOf} for all of them).
   */
  locationOf(skillMdPath: string): DistributedSkillLocation | undefined;
  /** Every location of the skill whose `SKILL.md` is at `skillMdPath`, in config order; `[]` when not plugin-local. */
  locationsOf(skillMdPath: string): readonly DistributedSkillLocation[];
  /**
   * Why the skill whose `SKILL.md` is at `skillMdPath` is NOT plugin-local although it sits
   * under a plugin's `skills/` dir — or `undefined` when it IS plugin-local, or is under no
   * plugin's `skills/` dir at all (or is gitignored there: ignoring it is the instruction).
   * Diagnostic: the untracked half lists the disk, so it runs only when first asked.
   */
  exclusionOf(skillMdPath: string): PluginSkillExclusion | undefined;
}

/**
 * THE answer to "is this skill plugin-local — does it ship with its plugin?", for every
 * lane that asks: `vat build` / `vat skills build` and `vat verify` (what they report as
 * in-place), the consistency check (plugin assignment, `SKILL_UNPUBLISHED`), and
 * skill-reference resolution (where a skill builds to).
 *
 * Derived from what the claude phase actually PACKAGES — {@link computeTreeCopiedSkillLocations},
 * i.e. git-visible, outermost skill directories under a plugin's `skills/` — never from a
 * path prefix. A prefix also claimed a skill the plugin build does not ship: one not yet
 * `git add`ed (reported as shipping while the build warned it was not packaged), or one
 * nested inside another skill's directory.
 *
 * Keyed by the skill's SOURCE DIRECTORY, never its declared name: a name is not unique
 * across a project (a repo-only skill may share one with a plugin-local skill) and is
 * unrelated to the directory the build lists. Exact directories also make the
 * `skills/` vs `skills-extra/` boundary structural.
 *
 * Build ONCE per invocation: listing the locations runs the crawl for every plugin.
 */
export function indexPluginLocalSkills(config: ProjectConfig, configDir: string): PluginLocalSkillIndex {
  // First plugin per source dir: two listings of one source dir list the same disk.
  const pluginBySourceDir = new Map<string, string>();
  for (const marketplace of Object.values(config.claude?.marketplaces ?? {})) {
    for (const plugin of marketplace.plugins) {
      const sourceDir = getPluginSourceDir(configDir, plugin);
      if (!pluginBySourceDir.has(sourceDir)) pluginBySourceDir.set(sourceDir, plugin.name);
    }
  }
  return indexSkillLocations(computeTreeCopiedSkillLocations(config, configDir), () =>
    [...pluginBySourceDir].flatMap(([sourceDir, pluginName]) =>
      listUntrackedPluginSkillDirs(sourceDir).map((dir) => ({ pluginName, skillSourceDir: safePath.join(sourceDir, 'skills', dir) })),
    ),
  );
}

/** An untracked skill directory under a plugin's `skills/` — see {@link listUntrackedPluginSkillDirs}. */
export interface UntrackedPluginSkillDir {
  readonly pluginName: string;
  /** Absolute source directory. */
  readonly skillSourceDir: string;
}

/**
 * The pure half of {@link indexPluginLocalSkills}: index `locations` (config order) by
 * source directory, the first listing winning `locationOf`. `listUntracked` — every
 * untracked skill directory under a plugin's `skills/` — is called at most once, and
 * only when {@link PluginLocalSkillIndex.exclusionOf} first gets past the nested check.
 */
export function indexSkillLocations(
  locations: readonly DistributedSkillLocation[],
  listUntracked: () => readonly UntrackedPluginSkillDir[],
): PluginLocalSkillIndex {
  const bySourceDir = new Map<string, DistributedSkillLocation[]>();
  for (const loc of locations) {
    const key = safePath.resolve(loc.skillSourceDir);
    bySourceDir.set(key, [...(bySourceDir.get(key) ?? []), loc]);
  }
  const skillDirOf = (skillMdPath: string): string => safePath.resolve(dirname(safePath.resolve(skillMdPath)));
  const locationsOf = (skillMdPath: string): readonly DistributedSkillLocation[] => bySourceDir.get(skillDirOf(skillMdPath)) ?? [];
  const isUnder = (dir: string, ancestor: string): boolean =>
    toForwardSlash(dir).startsWith(`${toForwardSlash(safePath.resolve(ancestor))}/`);
  let untracked: readonly UntrackedPluginSkillDir[] | undefined;

  return {
    locations,
    locationsOf,
    locationOf: (skillMdPath) => locationsOf(skillMdPath)[0],
    exclusionOf: (skillMdPath) => {
      if (locationsOf(skillMdPath).length > 0) return undefined;
      const skillDir = skillDirOf(skillMdPath);
      const outer = locations.find((loc) => isUnder(skillDir, loc.skillSourceDir));
      if (outer !== undefined) return { kind: 'nested', outer: { pluginName: outer.pluginName, skillSourceDir: outer.skillSourceDir } };
      untracked ??= listUntracked();
      // Inside an UNTRACKED outer skill is still nested: `git add` on the outer dir ships
      // the outer skill and leaves this one nested inside it.
      const untrackedOuter = untracked.find((dir) => isUnder(skillDir, dir.skillSourceDir));
      if (untrackedOuter !== undefined) return { kind: 'nested', outer: untrackedOuter };
      const own = untracked.find((dir) => safePath.resolve(dir.skillSourceDir) === skillDir);
      return own === undefined ? undefined : { kind: 'untracked', ...own };
    },
  };
}

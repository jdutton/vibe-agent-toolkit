/**
 * Consistency check module — cross-references discovered skills against
 * package.json vat.skills and plugin assignments.
 *
 * Config.yaml discovery is the SOURCE OF TRUTH for what skills exist.
 * package.json is a SUSPECT being validated, never an input for truth.
 */

import { existsSync } from 'node:fs';

import { getPluginSourceDir } from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import type { Severity } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGit } from '@vibe-agent-toolkit/utils/git';

import { readPackageJsonOrAbsent } from '../utils/package-json.js';
import { isSkillPublished, mergeSkillPackagingConfig } from '../utils/skill-packaging-config.js';

import type { DiscoveredSkill } from './skills/command-helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsistencyIssue {
  severity: Severity;
  code: string;
  message: string;
  fix: string;
}

export interface ConsistencyCheckResult {
  issues: ConsistencyIssue[];
  summary: {
    discoveredSkills: number;
    publishedSkills: number;
    unpublishedSkills: number;
    errors: number;
    warnings: number;
    infos: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a discovered skill is a POOL skill (distributed through `dist/skills`),
 * through the ONE predicate every lane uses — `isSkillPublished` over the MERGED
 * config — so `skills.defaults.publish` counts here exactly as it does in
 * `vat build` and `vat verify`. The per-name reader this replaces looked at
 * `skills.config.<name>` alone.
 */
function publishedByConfig(skillName: string, config: ProjectConfig): boolean {
  return isSkillPublished(mergeSkillPackagingConfig(
    config.skills?.defaults as Record<string, unknown> | undefined,
    config.skills?.config?.[skillName] as Record<string, unknown> | undefined,
  ));
}

/**
 * The names of every discovered skill that is PLUGIN-LOCAL: its `sourcePath`
 * sits under some plugin's `<getPluginSourceDir(projectRoot, plugin)>/skills/`.
 *
 * Matched by physical location, never by `publish`: a plugin-local skill ships
 * with its plugin whatever the flag says (see `isSkillPublished`), so both the
 * assignment and the unpublished-info lane ask this set, not the flag.
 *
 * A trailing slash on the prefix enforces a path-separator boundary, so a
 * sibling directory with a common prefix (`/skills` vs `/skills-extra`) is not
 * a false match.
 */
function pluginLocalSkillNames(
  config: ProjectConfig,
  discoveredSkills: DiscoveredSkill[],
  projectRoot: string,
): Set<string> {
  const names = new Set<string>();
  const marketplaces = config.claude?.marketplaces;
  if (!marketplaces) return names;
  for (const marketplace of Object.values(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      const srcSkillsPrefix = `${safePath.join(getPluginSourceDir(projectRoot, plugin), 'skills')}/`;
      for (const skill of discoveredSkills) {
        if (toForwardSlash(skill.sourcePath).startsWith(srcSkillsPrefix)) names.add(skill.name);
      }
    }
  }
  return names;
}

/**
 * Read the `vat.skills` array from `package.json` at the given project root.
 * Returns `undefined` when no `package.json` or no `vat.skills` field exists.
 */
export function readVatSkillsFromPackageJson(
  projectRoot: string
): string[] | undefined {
  // Absent manifest, or one with no `vat.skills`: nothing declared. A manifest
  // that is there and cannot be read is NOT "nothing declared" — it used to be,
  // and the cross-check then verified nothing and said so nowhere.
  const pkg = readPackageJsonOrAbsent(safePath.join(projectRoot, 'package.json'));
  const vat = pkg?.['vat'] as Record<string, unknown> | undefined;

  if (!vat || !Array.isArray(vat['skills'])) {
    return undefined;
  }

  return vat['skills'] as string[];
}

/**
 * Match a skill name against a simple glob selector.
 *
 * Supported forms:
 * - exact match: `"my-skill"`
 * - prefix wildcard: `"prefix*"`
 * - suffix wildcard: `"*suffix"`
 * - contains wildcard: `"*fragment*"`
 */
export function matchesSimpleGlob(
  skillName: string,
  selector: string
): boolean {
  if (selector === '*') {
    return true;
  }

  const startsWithStar = selector.startsWith('*');
  const endsWithStar = selector.endsWith('*');

  if (startsWithStar && endsWithStar) {
    // *contains*
    const fragment = selector.slice(1, -1);
    return fragment.length > 0 && skillName.includes(fragment);
  }

  if (endsWithStar) {
    // prefix*
    const prefix = selector.slice(0, -1);
    return skillName.startsWith(prefix);
  }

  if (startsWithStar) {
    // *suffix
    const suffix = selector.slice(1);
    return skillName.endsWith(suffix);
  }

  // exact match
  return skillName === selector;
}

/**
 * Add published skills matching a plugin's skill selector to the assigned set.
 */
function addMatchingSkills(
  assigned: Set<string>,
  pluginSkills: '*' | string[],
  publishedSkillNames: string[]
): void {
  if (pluginSkills === '*') {
    for (const name of publishedSkillNames) {
      assigned.add(name);
    }
    return;
  }
  for (const selector of pluginSkills) {
    for (const name of publishedSkillNames) {
      if (matchesSimpleGlob(name, selector)) {
        assigned.add(name);
      }
    }
  }
}

/**
 * Resolve which skills are assigned to at least one plugin.
 *
 * Assignment is additive per plugin:
 * - **Pool path**: `plugin.skills` glob selectors matched against PUBLISHED skill
 *   names — a `publish: false` skill is not in the pool, so no selector reaches it.
 * - **Plugin-local path**: any discovered skill whose `sourcePath` lives under
 *   `<getPluginSourceDir(projectRoot, plugin)>/skills/` is assigned by physical
 *   location, INDEPENDENT of `publish` — it ships with its plugin either way.
 *
 * Returns the set of skill names assigned to at least one plugin.
 */
export function resolveAssignedSkills(
  config: ProjectConfig,
  discoveredSkills: DiscoveredSkill[],
  projectRoot: string
): Set<string> {
  const assigned = pluginLocalSkillNames(config, discoveredSkills, projectRoot);
  const marketplaces = config.claude?.marketplaces;

  if (!marketplaces) {
    return assigned;
  }

  // Compute published names once for pool-selector matching
  const publishedNames = discoveredSkills
    .filter((s) => publishedByConfig(s.name, config))
    .map((s) => s.name);

  for (const marketplace of Object.values(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      addMatchingSkills(assigned, plugin.skills, publishedNames);
    }
  }

  return assigned;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkConfigReferencesUnknownSkill(
  discoveredNames: Set<string>,
  config: ProjectConfig
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const configuredSkills = config.skills?.config;

  if (!configuredSkills) {
    return issues;
  }

  for (const name of Object.keys(configuredSkills)) {
    if (!discoveredNames.has(name)) {
      issues.push({
        severity: 'error',
        code: 'CONFIG_REFERENCES_UNKNOWN_SKILL',
        message: `skills.config references skill "${name}" but no SKILL.md with that name was discovered by config globs.`,
        fix: `Check for typos in vibe-agent-toolkit.config.yaml: skills.config.${name}. The skill name must match the "name" field in a discovered SKILL.md frontmatter.`,
      });
    }
  }

  return issues;
}

function checkPublishedSkillNotInPackageJson(
  publishedNames: string[],
  vatSkills: string[] | undefined
): ConsistencyIssue[] {
  if (vatSkills === undefined) {
    // No package.json or no vat.skills — nothing to validate against
    return [];
  }

  const issues: ConsistencyIssue[] = [];
  const vatSkillsSet = new Set(vatSkills);

  for (const name of publishedNames) {
    if (!vatSkillsSet.has(name)) {
      issues.push({
        severity: 'error',
        code: 'PUBLISHED_SKILL_NOT_IN_PACKAGE_JSON',
        message: `Skill "${name}" is published (skills.config.${name}.publish is true by default) but not listed in package.json vat.skills.`,
        fix: `Either add "${name}" to the vat.skills array in package.json, or opt out of publishing by setting publish: false in vibe-agent-toolkit.config.yaml: skills.config.${name}.publish: false`,
      });
    }
  }

  return issues;
}

function checkPackageJsonListsUnknownSkill(
  discoveredNames: Set<string>,
  vatSkills: string[] | undefined
): ConsistencyIssue[] {
  if (vatSkills === undefined) {
    return [];
  }

  const issues: ConsistencyIssue[] = [];

  for (const name of vatSkills) {
    if (!discoveredNames.has(name)) {
      issues.push({
        severity: 'error',
        code: 'PACKAGE_JSON_LISTS_UNKNOWN_SKILL',
        message: `package.json vat.skills lists "${name}" but no SKILL.md with that name was discovered by config globs.`,
        fix: `Remove "${name}" from the vat.skills array in package.json, or ensure a SKILL.md with name "${name}" exists and is matched by the include patterns in vibe-agent-toolkit.config.yaml: skills.include.`,
      });
    }
  }

  return issues;
}

function checkUnpublishedSkillInPackageJson(
  unpublishedNames: string[],
  vatSkills: string[] | undefined
): ConsistencyIssue[] {
  if (vatSkills === undefined) {
    return [];
  }

  const issues: ConsistencyIssue[] = [];
  const vatSkillsSet = new Set(vatSkills);

  for (const name of unpublishedNames) {
    if (vatSkillsSet.has(name)) {
      issues.push({
        severity: 'warning',
        code: 'UNPUBLISHED_SKILL_IN_PACKAGE_JSON',
        message: `Skill "${name}" is marked publish: false but is still listed in package.json vat.skills. This is contradictory.`,
        fix: `Either remove "${name}" from the vat.skills array in package.json, or remove the publish: false setting in vibe-agent-toolkit.config.yaml: skills.config.${name}.publish.`,
      });
    }
  }

  return issues;
}

function checkPublishedSkillNotInPlugin(
  publishedNames: string[],
  config: ProjectConfig,
  assignedSkills: Set<string>
): ConsistencyIssue[] {
  if (!config.claude?.marketplaces) {
    return [];
  }

  const issues: ConsistencyIssue[] = [];

  for (const name of publishedNames) {
    if (!assignedSkills.has(name)) {
      issues.push({
        severity: 'error',
        code: 'PUBLISHED_SKILL_NOT_IN_PLUGIN',
        message: `Skill "${name}" is published but not assigned to any plugin in claude.marketplaces.`,
        fix: `Either add "${name}" to a plugin's skills array in vibe-agent-toolkit.config.yaml: claude.marketplaces.<marketplace>.plugins[].skills, or opt out of publishing by setting publish: false in vibe-agent-toolkit.config.yaml: skills.config.${name}.publish: false`,
      });
    }
  }

  return issues;
}

/**
 * Check a single plugin's skill selectors against discovered skill names.
 */
/**
 * A selector matching only IN-PLACE skills selects nothing: the claude phase picks
 * from `dist/skills`, which never carries them, so the plugin would silently ship
 * without them. `shipping` is every skill that ships — published, or plugin-local.
 */
function checkPluginSelectors(
  pluginSkills: string[],
  pluginName: string,
  marketplaceName: string,
  names: { discovered: Set<string>; shipping: Set<string> },
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const where = `vibe-agent-toolkit.config.yaml: claude.marketplaces.${marketplaceName}.plugins (plugin "${pluginName}")`;

  for (const selector of pluginSkills) {
    const matching = [...names.discovered].filter((name) => matchesSimpleGlob(name, selector));
    if (matching.length === 0) {
      issues.push({
        severity: 'error',
        code: 'PLUGIN_REFERENCES_UNKNOWN_SKILL',
        message: `Plugin "${pluginName}" in marketplace "${marketplaceName}" references skill selector "${selector}" which matches no discovered skill.`,
        fix: `Check for typos in ${where}. The selector must match at least one discovered SKILL.md name.`,
      });
    } else if (!matching.some((name) => names.shipping.has(name))) {
      issues.push({
        severity: 'error',
        code: 'PLUGIN_REFERENCES_UNKNOWN_SKILL',
        message: `Plugin "${pluginName}" in marketplace "${marketplaceName}" references skill selector "${selector}", which matches only in-place skills (publish: false) — never built into dist/skills, so the plugin would ship without them.`,
        fix: `Set skills.config.<name>.publish: true for the skill(s) this plugin ships, or remove the selector from ${where}.`,
      });
    }
  }

  return issues;
}

function checkPluginReferencesUnknownSkill(
  names: { discovered: Set<string>; shipping: Set<string> },
  config: ProjectConfig
): ConsistencyIssue[] {
  const marketplaces = config.claude?.marketplaces;

  if (!marketplaces) {
    return [];
  }

  const issues: ConsistencyIssue[] = [];

  for (const [marketplaceName, marketplace] of Object.entries(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      if (plugin.skills === '*') {
        continue;
      }
      issues.push(...checkPluginSelectors(plugin.skills, plugin.name, marketplaceName, names));
    }
  }

  return issues;
}

/**
 * One info per IN-PLACE pool skill. A plugin-local skill is excluded: it still
 * ships with its plugin, so "in-place" would be a false statement about it.
 */
function checkSkillUnpublished(
  unpublishedNames: string[],
  pluginLocalNames: Set<string>,
): ConsistencyIssue[] {
  return unpublishedNames.filter((name) => !pluginLocalNames.has(name)).map((name) => ({
    severity: 'info' as const,
    code: 'SKILL_UNPUBLISHED',
    message: `Skill "${name}" is publish: false — an in-place skill: validated at source, never bundled into dist/skills, never expected by vat verify.`,
    fix: `To distribute this skill through the pool, set publish: true in vibe-agent-toolkit.config.yaml: skills.config.${name}.publish (or drop the false under skills.defaults).`,
  }));
}

/**
 * Read the `files` array from a package's `package.json`.
 * Returns an empty array when the file is absent or has no `files` field. A
 * manifest that is there and cannot be read throws — an empty allowlist is a
 * finding ("vendor/ is not shipped"), and it must not be minted by a parse error.
 */
function readPackageJsonFilesAllowlist(packageDir: string): string[] {
  const pkg = readPackageJsonOrAbsent(safePath.join(packageDir, 'package.json'));
  const files = pkg?.['files'];
  return Array.isArray(files) ? (files as string[]) : [];
}

/**
 * Check vendored skill-creator licensing artifacts for the agent-skills package.
 *
 * When the project root contains `packages/agent-skills/` (i.e., this is the
 * vibe-agent-toolkit monorepo), assert that:
 *   - vendor/skill-creator/LICENSE.txt is present
 *   - vendor/skill-creator/ATTRIBUTION.md is present
 *   - "vendor/" is in the package.json files allowlist
 *   - vendor/skill-creator/LICENSE.txt is not gitignored
 *
 * Returns an error-severity ConsistencyIssue for each problem found.
 * Returns an empty array when the agent-skills package is not present (not in this monorepo).
 */
function checkVendoredLicensing(projectRoot: string): ConsistencyIssue[] {
  const agentSkillsDir = safePath.join(projectRoot, 'packages/agent-skills');
  if (!existsSync(agentSkillsDir)) {
    return []; // not in this monorepo — skip
  }

  const filesAllowlist = readPackageJsonFilesAllowlist(agentSkillsDir);
  const problems = assertVendoredLicensingShipped(agentSkillsDir, filesAllowlist);

  return problems.map((problem) => ({
    severity: 'error' as const,
    code: 'VENDORED_LICENSING_MISSING',
    message: problem,
    fix: 'Ensure vendor/skill-creator/ contains LICENSE.txt and ATTRIBUTION.md, and that "vendor/" is listed in packages/agent-skills/package.json files array.',
  }));
}

// ---------------------------------------------------------------------------
// Vendored licensing assertions
// ---------------------------------------------------------------------------

/**
 * Assert that vendored skill-creator licensing artifacts are present on disk
 * and declared in the npm `files` allowlist.
 *
 * Returns a list of human-readable problem strings (empty array = no problems).
 *
 * Checks:
 *   (1) vendor/skill-creator/LICENSE.txt is present under packageDir
 *   (2) vendor/skill-creator/ATTRIBUTION.md is present under packageDir
 *   (3) 'vendor/' or 'vendor/skill-creator/' appears in filesAllowlist
 *   (4) vendor/skill-creator/LICENSE.txt is NOT gitignored (skipped if git unavailable)
 */
export function assertVendoredLicensingShipped(
  packageDir: string,
  filesAllowlist: string[],
): string[] {
  const problems: string[] = [];

  const licensePath = safePath.join(packageDir, 'vendor/skill-creator/LICENSE.txt');
  const attributionPath = safePath.join(packageDir, 'vendor/skill-creator/ATTRIBUTION.md');

  // (1) LICENSE.txt present on disk
  if (!existsSync(licensePath)) {
    problems.push(
      'vendor/skill-creator/LICENSE.txt is missing — Apache-2.0 requires distributing the license with the code. Add the LICENSE.txt from the upstream skill-creator repository.',
    );
  }

  // (2) ATTRIBUTION.md present on disk
  if (!existsSync(attributionPath)) {
    problems.push(
      'vendor/skill-creator/ATTRIBUTION.md is missing — attribution file must document the upstream source, pinned commit, and Apache-2.0 §4(b) modifications list.',
    );
  }

  // (3) 'vendor/' or 'vendor/skill-creator/' in the npm files allowlist
  const vendorInAllowlist = filesAllowlist.some(
    (entry) => entry === 'vendor/' || entry === 'vendor/skill-creator/' || entry === 'vendor',
  );
  if (!vendorInAllowlist) {
    problems.push(
      '"vendor/" is not listed in the package.json files allowlist — vendored LICENSE.txt and ATTRIBUTION.md will not ship in the npm tarball. Add "vendor/" to the files array in package.json.',
    );
  }

  // (4) LICENSE.txt not gitignored (best-effort; skip if git is unavailable)
  if (existsSync(licensePath)) {
    const gitResult = runGit(['check-ignore', '--quiet', licensePath], { cwd: packageDir });
    // git check-ignore exits 0 if the path IS ignored, 1 if not ignored, error(-1) if git unavailable
    if (gitResult.ok) {
      problems.push(
        'vendor/skill-creator/LICENSE.txt is gitignored — the LICENSE.txt must be committed so it ships with the package. Remove the gitignore rule covering this path.',
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all consistency checks.
 *
 * @param discoveredSkills - Skills found via config.yaml glob discovery (source of truth)
 * @param config - Parsed project configuration
 * @param projectRoot - Project root directory (for reading package.json)
 * @returns Consistency check result with issues and summary
 */
export function runConsistencyChecks(
  discoveredSkills: DiscoveredSkill[],
  config: ProjectConfig,
  projectRoot: string
): ConsistencyCheckResult {
  const discoveredNames = new Set(discoveredSkills.map((s) => s.name));

  const publishedNames: string[] = [];
  const unpublishedNames: string[] = [];
  for (const s of discoveredSkills) {
    (publishedByConfig(s.name, config) ? publishedNames : unpublishedNames).push(s.name);
  }

  const vatSkills = readVatSkillsFromPackageJson(projectRoot);
  const assignedSkills = resolveAssignedSkills(config, discoveredSkills, projectRoot);
  const pluginLocalNames = pluginLocalSkillNames(config, discoveredSkills, projectRoot);

  // Run checks in specified order
  const issues: ConsistencyIssue[] = [
    ...checkConfigReferencesUnknownSkill(discoveredNames, config),
    ...checkPublishedSkillNotInPackageJson(publishedNames, vatSkills),
    ...checkPackageJsonListsUnknownSkill(discoveredNames, vatSkills),
    ...checkUnpublishedSkillInPackageJson(unpublishedNames, vatSkills),
    ...checkPublishedSkillNotInPlugin(publishedNames, config, assignedSkills),
    ...checkPluginReferencesUnknownSkill(
      { discovered: discoveredNames, shipping: new Set([...publishedNames, ...pluginLocalNames]) },
      config,
    ),
    ...checkSkillUnpublished(unpublishedNames, pluginLocalNames),
    ...checkVendoredLicensing(projectRoot),
  ];

  return {
    issues,
    summary: {
      discoveredSkills: discoveredSkills.length,
      publishedSkills: publishedNames.length,
      unpublishedSkills: unpublishedNames.length,
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      infos: issues.filter((i) => i.severity === 'info').length,
    },
  };
}

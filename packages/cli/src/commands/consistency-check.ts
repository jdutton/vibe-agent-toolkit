/**
 * Consistency check module — cross-references discovered skills against
 * package.json vat.skills and plugin assignments.
 *
 * Config.yaml discovery is the SOURCE OF TRUTH for what skills exist.
 * package.json is a SUSPECT being validated, never an input for truth.
 */

import { readFileSync, existsSync } from 'node:fs';

import { getPluginSourceDir } from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig, SkillPackagingConfig } from '@vibe-agent-toolkit/resources';
import { runGit, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { DiscoveredSkill } from './skills/command-helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsistencyIssueSeverity = 'error' | 'warning' | 'info';

export interface ConsistencyIssue {
  severity: ConsistencyIssueSeverity;
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
 * Determine whether a skill is published.
 * `publish` defaults to `true` when not set in skills.config.
 */
export function isSkillPublished(
  skillName: string,
  config: ProjectConfig
): boolean {
  const perSkill: SkillPackagingConfig | undefined =
    config.skills?.config?.[skillName];

  // Default to true when publish is not explicitly set
  if (perSkill?.publish === undefined) {
    return true;
  }

  return perSkill.publish;
}

/**
 * Read the `vat.skills` array from `package.json` at the given project root.
 * Returns `undefined` when no `package.json` or no `vat.skills` field exists.
 */
export function readVatSkillsFromPackageJson(
  projectRoot: string
): string[] | undefined {
  const pkgPath = safePath.join(projectRoot, 'package.json');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pkgPath derived from projectRoot parameter
  if (!existsSync(pkgPath)) {
    return undefined;
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pkgPath derived from projectRoot parameter
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const vat = pkg['vat'] as Record<string, unknown> | undefined;

    if (!vat || !Array.isArray(vat['skills'])) {
      return undefined;
    }

    return vat['skills'] as string[];
  } catch {
    return undefined;
  }
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
 * Resolve which published skills are assigned to at least one plugin.
 *
 * Assignment is additive per plugin:
 * - **Pool path**: `plugin.skills` glob selectors matched against published skill names.
 * - **Source tree-copy path**: any discovered published skill whose `sourcePath` lives
 *   under `<getPluginSourceDir(projectRoot, plugin)>/skills/` is considered assigned,
 *   matched by physical location rather than name selectors.
 *
 * Returns the set of published skill names assigned to at least one plugin.
 */
export function resolveAssignedSkills(
  config: ProjectConfig,
  discoveredSkills: DiscoveredSkill[],
  projectRoot: string
): Set<string> {
  const assigned = new Set<string>();
  const marketplaces = config.claude?.marketplaces;

  if (!marketplaces) {
    return assigned;
  }

  // Compute published names once for pool-selector matching
  const publishedNames = discoveredSkills
    .filter((s) => isSkillPublished(s.name, config))
    .map((s) => s.name);

  for (const marketplace of Object.values(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      // Pool path: existing glob selector matching (unchanged)
      addMatchingSkills(assigned, plugin.skills, publishedNames);

      // Source tree-copy path: match by physical location under <pluginSourceDir>/skills/
      // Use a trailing slash to enforce a path-separator boundary and avoid false matches
      // against sibling directories with a common prefix (e.g. /skills vs /skills-extra).
      const srcSkillsDir = safePath.join(getPluginSourceDir(projectRoot, plugin), 'skills');
      const srcSkillsPrefix = `${srcSkillsDir}/`;

      for (const skill of discoveredSkills) {
        if (!isSkillPublished(skill.name, config)) continue;
        if (toForwardSlash(skill.sourcePath).startsWith(srcSkillsPrefix)) {
          assigned.add(skill.name);
        }
      }
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
function checkPluginSelectors(
  pluginSkills: string[],
  pluginName: string,
  marketplaceName: string,
  discoveredNames: Set<string>
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  for (const selector of pluginSkills) {
    const matchesAny = [...discoveredNames].some((name) =>
      matchesSimpleGlob(name, selector)
    );

    if (!matchesAny) {
      issues.push({
        severity: 'error',
        code: 'PLUGIN_REFERENCES_UNKNOWN_SKILL',
        message: `Plugin "${pluginName}" in marketplace "${marketplaceName}" references skill selector "${selector}" which matches no discovered skill.`,
        fix: `Check for typos in vibe-agent-toolkit.config.yaml: claude.marketplaces.${marketplaceName}.plugins (plugin "${pluginName}"). The selector must match at least one discovered SKILL.md name.`,
      });
    }
  }

  return issues;
}

function checkPluginReferencesUnknownSkill(
  discoveredNames: Set<string>,
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
      issues.push(...checkPluginSelectors(plugin.skills, plugin.name, marketplaceName, discoveredNames));
    }
  }

  return issues;
}

function checkSkillUnpublished(
  unpublishedNames: string[]
): ConsistencyIssue[] {
  return unpublishedNames.map((name) => ({
    severity: 'info' as const,
    code: 'SKILL_UNPUBLISHED',
    message: `Skill "${name}" is marked publish: false — not distributed.`,
    fix: `To publish this skill, remove the publish: false setting in vibe-agent-toolkit.config.yaml: skills.config.${name}.publish.`,
  }));
}

/**
 * Read the `files` array from a package's `package.json`.
 * Returns an empty array when the file is absent, unreadable, or has no `files` field.
 */
function readPackageJsonFilesAllowlist(packageDir: string): string[] {
  const pkgPath = safePath.join(packageDir, 'package.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pkgPath derived from trusted packageDir parameter
  if (!existsSync(pkgPath)) {
    return [];
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pkgPath derived from trusted packageDir parameter
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(pkg['files'])) {
      return [];
    }
    return pkg['files'] as string[];
  } catch {
    return [];
  }
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- agentSkillsDir derived from trusted projectRoot
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- packageDir is a trusted project root parameter
  if (!existsSync(licensePath)) {
    problems.push(
      'vendor/skill-creator/LICENSE.txt is missing — Apache-2.0 requires distributing the license with the code. Add the LICENSE.txt from the upstream skill-creator repository.',
    );
  }

  // (2) ATTRIBUTION.md present on disk
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- packageDir is a trusted project root parameter
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- licensePath is derived from trusted packageDir parameter
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
    (isSkillPublished(s.name, config) ? publishedNames : unpublishedNames).push(s.name);
  }

  const vatSkills = readVatSkillsFromPackageJson(projectRoot);
  const assignedSkills = resolveAssignedSkills(config, discoveredSkills, projectRoot);

  // Run checks in specified order
  const issues: ConsistencyIssue[] = [
    ...checkConfigReferencesUnknownSkill(discoveredNames, config),
    ...checkPublishedSkillNotInPackageJson(publishedNames, vatSkills),
    ...checkPackageJsonListsUnknownSkill(discoveredNames, vatSkills),
    ...checkUnpublishedSkillInPackageJson(unpublishedNames, vatSkills),
    ...checkPublishedSkillNotInPlugin(publishedNames, config, assignedSkills),
    ...checkPluginReferencesUnknownSkill(discoveredNames, config),
    ...checkSkillUnpublished(unpublishedNames),
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

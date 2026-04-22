/**
 * Consistency check module — cross-references discovered skills against
 * package.json vat.skills and plugin assignments.
 *
 * Config.yaml discovery is the SOURCE OF TRUTH for what skills exist.
 * package.json is a SUSPECT being validated, never an input for truth.
 */

import { readFileSync, existsSync } from 'node:fs';

import type { ProjectConfig, SkillPackagingConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

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
 * Returns the set of published skill names that matched at least one
 * plugin skill selector across all marketplaces.
 */
export function resolveAssignedSkills(
  config: ProjectConfig,
  publishedSkillNames: string[]
): Set<string> {
  const assigned = new Set<string>();
  const marketplaces = config.claude?.marketplaces;

  if (!marketplaces) {
    return assigned;
  }

  for (const marketplace of Object.values(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      if (plugin.skills !== undefined) {
        addMatchingSkills(assigned, plugin.skills, publishedSkillNames);
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
      if (plugin.skills === '*' || plugin.skills === undefined) {
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
  const assignedSkills = resolveAssignedSkills(config, publishedNames);

  // Run checks in specified order
  const issues: ConsistencyIssue[] = [
    ...checkConfigReferencesUnknownSkill(discoveredNames, config),
    ...checkPublishedSkillNotInPackageJson(publishedNames, vatSkills),
    ...checkPackageJsonListsUnknownSkill(discoveredNames, vatSkills),
    ...checkUnpublishedSkillInPackageJson(unpublishedNames, vatSkills),
    ...checkPublishedSkillNotInPlugin(publishedNames, config, assignedSkills),
    ...checkPluginReferencesUnknownSkill(discoveredNames, config),
    ...checkSkillUnpublished(unpublishedNames),
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

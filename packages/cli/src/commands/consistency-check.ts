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

  // Run checks in specified order
  const issues: ConsistencyIssue[] = [
    ...checkConfigReferencesUnknownSkill(discoveredNames, config),
    ...checkPublishedSkillNotInPackageJson(publishedNames, vatSkills),
    ...checkPackageJsonListsUnknownSkill(discoveredNames, vatSkills),
    ...checkUnpublishedSkillInPackageJson(unpublishedNames, vatSkills),
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

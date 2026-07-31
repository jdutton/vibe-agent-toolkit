/**
 * Shared per-skill packaging-config resolution.
 *
 * The nearest-ancestor config walk-up that {@link resolveSkillReference},
 * `vat audit`, and `vat skill review` all use to resolve a single SKILL.md to
 * its governing `skills.config` block. Lives here (not in audit) because three
 * commands depend on it; future CLI work extends THIS, not a fourth copy.
 *
 * Does NOT compose configs across VAT projects — only the nearest-ancestor
 * `vibe-agent-toolkit.config.yaml` contributes.
 */
import type { DeclaredEvalSuite, SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import { findProjectRoot, safePath } from '@vibe-agent-toolkit/utils';

import { discoverSkillsFromConfig } from '../commands/skills/skill-discovery.js';
import { type loadConfig, loadConfigCached } from '../utils/config-loader.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../utils/skill-packaging-config.js';

/** configRoot → (abs SKILL.md path → declared skill name). One expansion per root. */
const skillDiscoveryCache = new Map<string, Map<string, string>>();

/** configRoot → the project's declared eval suites. One discovery + merge per root. */
const declaredEvalSuiteCache = new Map<string, DeclaredEvalSuite[]>();

/** Clear the per-root discovery caches (call when fixtures mutate between in-process runs). */
export function resetSkillDiscoveryCache(): void {
  skillDiscoveryCache.clear();
  declaredEvalSuiteCache.clear();
}

/**
 * The project's declared eval suites for the config root governing `skillPath`.
 *
 * The single-skill counterpart to `collectDeclaredEvalSuites`: commands that resolve one
 * SKILL.md at a time (`vat audit`, `vat skill review`, `vat skill test`) still need the
 * WHOLE project's declarations, because test input is a project-wide rule — another
 * skill's eval suite is an answer key no matter whose bundle is being built.
 *
 * Memoized per config root so a run over N skills under one root pays for discovery
 * once, not N times. Returns `[]` when there is no governing config or no skills
 * section — wild mode, where there is no project to enumerate.
 */
export async function resolveProjectDeclaredEvalSuites(
  skillPath: string,
): Promise<DeclaredEvalSuite[]> {
  const projectRoot = findProjectRoot(safePath.resolve(safePath.join(skillPath, '..')));
  if (projectRoot === null) return [];
  const cached = declaredEvalSuiteCache.get(projectRoot);
  if (cached !== undefined) return cached;

  let suites: DeclaredEvalSuite[] = [];
  try {
    const config = loadConfigCached(projectRoot);
    if (config?.skills !== undefined) {
      suites = collectDeclaredEvalSuites(
        config.skills,
        await discoverSkillsFromConfig(config.skills, projectRoot),
      );
    }
  } catch {
    // A broken or unreadable config is already reported by the caller's own config
    // load; degrade to the subject's own declaration rather than aborting the run.
    suites = [];
  }
  declaredEvalSuiteCache.set(projectRoot, suites);
  return suites;
}

export async function getDiscoveredSkillsByPath(
  skillsSection: NonNullable<ReturnType<typeof loadConfig>>['skills'],
  configRoot: string,
): Promise<Map<string, string>> {
  const cached = skillDiscoveryCache.get(configRoot);
  if (cached !== undefined) return cached;
  const map = new Map<string, string>();
  if (skillsSection !== undefined) {
    const discovered = await discoverSkillsFromConfig(skillsSection, configRoot);
    for (const entry of discovered) {
      map.set(safePath.resolve(entry.sourcePath), entry.name);
    }
  }
  skillDiscoveryCache.set(configRoot, map);
  return map;
}

/**
 * Resolve the merged packaging config for one SKILL.md by walking UP to its
 * nearest-ancestor config and matching the skill by absolute path. Returns the
 * FULL merge (`skills.defaults` + `skills.config[name]`, keeping
 * `validation.allow`). `null` when there is no governing config, no `skills`
 * section, or the skill is not declared (wild mode).
 */
export async function resolveSkillPackagingConfig(
  skillPath: string,
): Promise<SkillPackagingConfig | null> {
  const absSkillPath = safePath.resolve(skillPath);
  const skillDir = safePath.resolve(safePath.join(absSkillPath, '..'));
  const projectRoot = findProjectRoot(skillDir);
  if (projectRoot === null) return null;
  const config = loadConfigCached(projectRoot);
  if (config?.skills === undefined) return null;

  let matchedName: string | undefined;
  try {
    const byPath = await getDiscoveredSkillsByPath(config.skills, projectRoot);
    matchedName = byPath.get(absSkillPath);
  } catch {
    return null;
  }
  if (matchedName === undefined) return null;

  const { defaults, config: perSkillConfig } = config.skills;
  return mergeSkillPackagingConfig(
    defaults as Record<string, unknown> | undefined,
    perSkillConfig?.[matchedName] as Record<string, unknown> | undefined,
  );
}

/**
 * Audit's display variant: keep `validation.severity`, drop `validation.allow`
 * (audit shows every finding, including ones an `allow` entry would suppress).
 * Drops `validation` entirely when no severity is present.
 */
export function stripValidationAllowForDisplay(config: SkillPackagingConfig): SkillPackagingConfig {
  const out: SkillPackagingConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && key !== 'validation') {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  const validation = (config as { validation?: { severity?: unknown; allow?: unknown } }).validation;
  if (validation?.severity !== undefined) {
    (out as Record<string, unknown>)['validation'] = { severity: validation.severity };
  }
  return out;
}

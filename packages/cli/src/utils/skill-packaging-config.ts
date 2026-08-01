/**
 * Shared helper for merging skill packaging config from VAT config YAML.
 *
 * Every lane that reasons about a skill — `vat skills build`, `vat skills validate`,
 * `vat skill review`, `vat audit`, and the Claude plugin build — merges
 * `skills.defaults` with per-skill overrides (`skills.config.<name>`) through THIS
 * function, so no two lanes can disagree about a skill's effective config.
 *
 * Most fields are a shallow override: a per-skill value replaces the default
 * outright. `files:` is the exception — see below.
 */

import { mergeFilesConfig, type DeclaredEvalSuite, type SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';
import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Merge defaults with per-skill overrides, dropping undefined values.
 *
 * Zod-inferred optional types surface explicit `undefined` which is not
 * assignable to optional-but-not-undefined properties — this helper strips
 * those so the returned config is type-clean.
 *
 * `files:` merges ADDITIVELY (defaults ∪ per-skill, per-skill winning on a
 * duplicate dest) rather than being replaced, because a default `files:` entry is
 * a project-wide artifact every skill needs, not a value a skill overrides by
 * declaring one of its own. This was previously implemented only inside
 * `vat skills build`, so the read-only lanes saw a DIFFERENT effective config than
 * the build did — the exact class of divergence this module exists to prevent.
 */
export function mergeSkillPackagingConfig(
  defaults: Record<string, unknown> | undefined,
  perSkillOverrides: Record<string, unknown> | undefined,
): SkillPackagingConfig {
  const merged = { ...defaults, ...perSkillOverrides };
  const packagingConfig: SkillPackagingConfig = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      (packagingConfig as Record<string, unknown>)[key] = value;
    }
  }

  const defaultFiles = defaults?.['files'] as SkillPackagingConfig['files'];
  const perSkillFiles = perSkillOverrides?.['files'] as SkillPackagingConfig['files'];
  if (defaultFiles !== undefined || perSkillFiles !== undefined) {
    const mergedFiles = mergeFilesConfig(defaultFiles, perSkillFiles);
    if (mergedFiles.length > 0) {
      packagingConfig.files = mergedFiles;
    }
  }

  return packagingConfig;
}

/**
 * The PROJECT's declared eval suites: one {@link DeclaredEvalSuite} per discovered
 * skill, from the same discovery + merge every lane already runs.
 *
 * Test input never ships, and that rule is project-wide rather than per-skill — a file
 * ANY skill declares as its eval suite is an answer key, and no other skill's bundle may
 * carry it. Every lane that packages or models a bundle therefore needs the whole
 * project's declarations, not just the subject's.
 *
 * Build this ONCE per invocation, from the UNFILTERED discovery, and pass the same array
 * down to every skill:
 *   - unfiltered, because `--skill x` narrows what is BUILT, never what counts as test
 *     input; a suite excluded from the run is still an answer key;
 *   - once, because assembling it per skill would walk the project's whole skills config
 *     inside a per-skill loop — a per-item cost against whole-corpus work.
 */
export function collectDeclaredEvalSuites(
  skillsConfig: SkillsConfig | undefined,
  discovered: ReadonlyArray<{ name: string; sourcePath: string }>,
): DeclaredEvalSuite[] {
  if (skillsConfig === undefined) return [];
  const { defaults, config: perSkillConfig } = skillsConfig;
  return discovered.map((skill) => ({
    skillDir: safePath.resolve(skill.sourcePath, '..'),
    config: mergeSkillPackagingConfig(
      defaults as Record<string, unknown> | undefined,
      perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
    ),
  }));
}

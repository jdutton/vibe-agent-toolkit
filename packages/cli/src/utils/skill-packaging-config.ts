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

import { mergeFilesConfig, type SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';

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

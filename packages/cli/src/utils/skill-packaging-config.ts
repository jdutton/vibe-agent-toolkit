/**
 * Shared helper for merging skill packaging config from VAT config YAML.
 *
 * Both `vat skills validate` and `vat skill review` need to merge
 * `skills.defaults` with per-skill overrides (`skills.config.<name>`) and
 * strip undefined values so the result satisfies `exactOptionalPropertyTypes`.
 * Centralized here so both call sites agree on semantics and we don't
 * duplicate the merge logic.
 */

import type { SkillPackagingConfig } from '@vibe-agent-toolkit/agent-skills';

/**
 * Merge defaults with per-skill overrides, dropping undefined values.
 *
 * Zod-inferred optional types surface explicit `undefined` which is not
 * assignable to optional-but-not-undefined properties — this helper strips
 * those so the returned config is type-clean.
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
  return packagingConfig;
}

/**
 * The packager and the packaging validator in a run of their own, as a library
 * caller outside a verb holds one (`withSkillRegistries`), homed on the skill's
 * directory: the run's skill registries are required by both, so a test that
 * calls either directly supplies them here.
 */

import {
  packageSkill,
  validateSkillForPackaging,
  withSkillRegistries,
  type PackageSkillOptions,
  type PackageSkillResult,
  type PackagingValidationResult,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * `packageSkill` in a run of its own.
 *
 * @param skillPath - The SKILL.md
 * @param options - Packaging options, without `registries`
 * @returns The package result
 */
export function packageSkillInRun(skillPath: string, options: Omit<PackageSkillOptions, 'registries'>): Promise<PackageSkillResult> {
  return withSkillRegistries(safePath.resolve(skillPath, '..'), (registries) => packageSkill(skillPath, { ...options, registries }));
}

/**
 * `validateSkillForPackaging` in a run of its own, with the read-only verb's shared
 * context: `'refuse'`, no outputs, no dispatcher.
 *
 * @param skillPath - The SKILL.md
 * @param resourcesValidation - The resources validation config
 * @param packagingConfig - The skill's packaging config
 * @param context - Source or built
 * @returns The validation result
 */
export function validateForPackagingInRun(
  skillPath: string,
  resourcesValidation: Parameters<typeof validateSkillForPackaging>[1],
  packagingConfig?: SkillPackagingConfig,
  context: 'source' | 'built' = 'source',
): Promise<PackagingValidationResult> {
  return withSkillRegistries(safePath.resolve(skillPath, '..'), (registries) =>
    validateSkillForPackaging(skillPath, resourcesValidation, packagingConfig, context, {
      unreadable: 'refuse',
      outputs: [],
      dispatcher: undefined,
      registries,
    }));
}

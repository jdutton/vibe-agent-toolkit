/**
 * configure-writer — byte-surgical YAML upsert for `skills.config.<skill>.test`
 *
 * Pure function: string → string. Uses `updateYamlIn` from
 * `@vibe-agent-toolkit/utils` to change the **minimum bytes possible** so
 * the adopter's hand-authored formatting (inline comments, flow sequences,
 * long strings, quote styles) is never disturbed outside the touched node.
 *
 * Init case (no existing `test` node): creates `skills.config.<skill>.test` and
 * any intermediate map nodes, splicing only the new fragment — every line
 * outside the inserted block remains byte-identical to the input.
 * Surgical case (existing `test` node): only the supplied knobs are updated;
 * sibling knobs, their values, and inline comments are byte-identical to the
 * input.
 *
 * The output MUST satisfy TestConfigSchema.parse (round-trip invariant) — callers
 * can and should validate before writing.
 */

import type { TestConfig } from '@vibe-agent-toolkit/resources';
import { updateYamlIn, type YamlScalarValue } from '@vibe-agent-toolkit/utils/yaml';

/**
 * Upsert `skills.config.<skillName>.test` in `yamlText` with the supplied knobs.
 *
 * - If `skills.config.<skillName>.test` does not yet exist, creates it (and any
 *   intermediate map nodes) by splicing the minimum fragment into the document —
 *   every line outside the insertion site is byte-identical to the input.
 * - If it already exists, only the knobs present in `knobs` are updated —
 *   unspecified knobs and their inline comments are byte-identical to the input.
 *
 * Only scalar-valued knobs (string, number, boolean) are supported by this
 * function. Complex fields (arrays, records) must be written by direct YAML
 * editing if needed.
 *
 * @param yamlText  - Current content of vibe-agent-toolkit.config.yaml
 * @param skillName - The skill key under `skills.config`
 * @param knobs     - Partial TestConfig to write (only defined scalar keys are touched)
 * @returns Updated YAML text (same EOL style as input, minimum bytes changed)
 */
export function upsertTestConfig(
  yamlText: string,
  skillName: string,
  knobs: Partial<TestConfig>,
): string {
  let text = yamlText;
  for (const [key, value] of Object.entries(knobs)) {
    if (value === undefined) continue;
    text = updateYamlIn(text, ['skills', 'config', skillName, 'test', key], value as YamlScalarValue);
  }
  return text;
}

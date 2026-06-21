/**
 * configure-writer — comment-preserving YAML upsert for `skills.config.<skill>.test`
 *
 * Pure function: string → string. Uses the yaml Document API (same pattern as
 * frontmatter-editor.ts in packages/resources) so surrounding comments and key
 * ordering are preserved on surgical updates.
 *
 * Init case (no existing `test` node): creates `skills.config.<skill>.test` and
 * any intermediate map nodes, writing the supplied knobs.
 * Surgical case (existing `test` node): only updates the supplied knobs, leaving
 * all other knob values and comments intact.
 *
 * The output MUST satisfy TestConfigSchema.parse (round-trip invariant) — callers
 * can and should validate before writing.
 */

import type { TestConfig } from '@vibe-agent-toolkit/resources';
import { parseDocument } from 'yaml';

/**
 * Upsert `skills.config.<skillName>.test` in `yamlText` with the supplied knobs.
 *
 * - If `skills.config.<skillName>.test` does not yet exist, creates it (and any
 *   intermediate map nodes) via `setIn`, which preserves surrounding comments.
 * - If it already exists, only the knobs present in `knobs` are updated —
 *   unspecified knobs and their values are left intact.
 *
 * @param yamlText  - Current content of vibe-agent-toolkit.config.yaml
 * @param skillName - The skill key under `skills.config`
 * @param knobs     - Partial TestConfig to write (only defined keys are touched)
 * @returns Updated YAML text (same EOL style as input)
 */
export function upsertTestConfig(
  yamlText: string,
  skillName: string,
  knobs: Partial<TestConfig>,
): string {
  const doc = parseDocument(yamlText, { prettyErrors: true });

  for (const [key, value] of Object.entries(knobs)) {
    if (value === undefined) continue;
    doc.setIn(['skills', 'config', skillName, 'test', key], value);
  }

  return doc.toString();
}

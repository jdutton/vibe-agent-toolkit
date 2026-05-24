/**
 * Parse and validate the corpus manifest and trigger-prompts YAML files.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- inputs are user-supplied manifest paths */

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import {
  CorpusManifestSchema,
  TriggerPromptsFileSchema,
  type CorpusManifest,
  type TriggerPrompt,
  type TriggerPromptsFile,
} from '../types.js';

export function loadManifest(manifestPath: string): CorpusManifest {
  const raw = readFileSync(manifestPath, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  return CorpusManifestSchema.parse(parsed);
}

export function loadTriggerPrompts(promptsPath: string): TriggerPromptsFile {
  const raw = readFileSync(promptsPath, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  return TriggerPromptsFileSchema.parse(parsed);
}

export function indexPromptsById(file: TriggerPromptsFile): Map<string, TriggerPromptsFile['prompts'][number]> {
  const idx = new Map<string, TriggerPromptsFile['prompts'][number]>();
  for (const p of file.prompts) {
    if (idx.has(p.id)) {
      throw new Error(`Duplicate trigger prompt id: ${p.id}`);
    }
    idx.set(p.id, p);
  }
  return idx;
}

/**
 * Cross-file invariant: every manifest entry must reference at least one
 * `positive` AND one `negative` trigger prompt. Zod can't express this since
 * the prompts live in a separate YAML file; the run loop relies on this
 * pairing so positive (should-invoke) and negative (should-not-invoke)
 * coverage are guaranteed per skill.
 */
export function validateEntryPromptKinds(
  manifest: CorpusManifest,
  promptById: ReadonlyMap<string, TriggerPrompt>,
): void {
  for (const entry of manifest.entries) {
    const resolved: TriggerPrompt[] = [];
    for (const id of entry.triggerPromptRefs) {
      const prompt = promptById.get(id);
      if (!prompt) {
        throw new Error(`entry ${entry.id} references missing prompt ${id}`);
      }
      resolved.push(prompt);
    }
    const hasPositive = resolved.some((p) => p.kind === 'positive');
    const hasNegative = resolved.some((p) => p.kind === 'negative');
    if (!hasPositive || !hasNegative) {
      throw new Error(
        `entry ${entry.id} must reference at least one positive and one negative prompt; ` +
          `got kinds: [${resolved.map((p) => p.kind).join(', ')}]`,
      );
    }
  }
}

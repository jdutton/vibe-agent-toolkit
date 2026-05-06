/**
 * Seed schema + parser for `corpus/seed.yaml`. The seed is the committed
 * config of plugins tracked by `vat corpus scan`. Per-entry `validation:`
 * mirrors the `skills.defaults.validation` block of the project config
 * schema (severity overrides + allow entries).
 */

import { existsSync, readFileSync } from 'node:fs';

import * as yaml from 'js-yaml';
import { z } from 'zod';

const ValidationAllowEntrySchema = z.object({
  code: z.string().min(1),
  reason: z.string().min(1),
});

const ValidationBlockSchema = z
  .object({
    severity: z.record(z.string(), z.enum(['error', 'warning', 'info', 'ignore'])).optional(),
    allow: z.array(ValidationAllowEntrySchema).optional(),
  })
  .strict();

const PluginEntrySchema = z
  .object({
    source: z.string().min(1),
    name: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/, 'name must be [A-Za-z0-9_-]+ (presentation label)'),
    validation: ValidationBlockSchema.optional(),
  })
  .strict();

const SeedSchema = z
  .object({
    plugins: z.array(PluginEntrySchema).min(1),
  })
  .strict();

export type ValidationAllowEntry = z.infer<typeof ValidationAllowEntrySchema>;
export type ValidationBlock = z.infer<typeof ValidationBlockSchema>;
export type PluginEntry = z.infer<typeof PluginEntrySchema>;
export type Seed = z.infer<typeof SeedSchema>;

/**
 * Load and validate `corpus/seed.yaml` (or another seed-shaped YAML file).
 * Throws on missing file, malformed YAML, schema violations, duplicate
 * `source` keys, or duplicate `name` labels.
 */
export function loadSeedFile(path: string): Seed {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied seed file path
  if (!existsSync(path)) {
    throw new Error(`Seed file not found: ${path}`);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied seed file path
  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw);
  const seed = SeedSchema.parse(parsed);

  const sources = new Set<string>();
  const names = new Set<string>();
  for (const entry of seed.plugins) {
    if (sources.has(entry.source)) {
      throw new Error(`Seed has duplicate source: ${entry.source}`);
    }
    if (names.has(entry.name)) {
      throw new Error(`Seed has duplicate name: ${entry.name}`);
    }
    sources.add(entry.source);
    names.add(entry.name);
  }

  return seed;
}

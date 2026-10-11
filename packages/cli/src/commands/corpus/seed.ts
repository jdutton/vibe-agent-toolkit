/**
 * Seed schema + parser for `corpus/seed.yaml`. The seed is the committed
 * config of plugins tracked by `vat corpus scan`. Per-entry `validation:`
 * mirrors the `skills.defaults.validation` block of the project config
 * schema (severity overrides + allow entries).
 */

import * as yaml from 'yaml';
import { z } from 'zod';

import { CommandRefusalError, errorMessageOf } from '../../utils/command-refusal.js';
import { readInputFile } from '../../utils/project-root-policy.js';

const ValidationAllowEntrySchema = z.object({
  code: z.string().min(1),
  reason: z.string().min(1),
}).strict();

const ValidationBlockSchema = z
  .object({
    severity: z.record(z.string(), z.enum(['error', 'warning', 'info', 'ignore'])).optional(),
    allow: z.array(ValidationAllowEntrySchema).optional(),
  })
  .strict();

// `bucket` is the reporting posture: `official` entries allow named findings;
// `community` entries are aggregate-only.
const PluginEntrySchema = z
  .object({
    source: z.string().min(1),
    name: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/, 'name must be [A-Za-z0-9_-]+ (presentation label)'),
    bucket: z.enum(['official', 'community']),
    confidence: z.enum(['first-party', 'curated', 'listed']),
    maturity: z.enum(['production', 'experimental', 'example']),
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

/** The seed's own mistake: it is the operator's config for the scan. */
function seedInvalid(path: string, why: string, cause?: unknown): CommandRefusalError {
  return new CommandRefusalError('CONFIG_INVALID', `Seed file ${path} is invalid: ${why}`, cause === undefined ? undefined : { cause });
}

/** Parse the seed's text as YAML and against {@link SeedSchema}, refusing either as the seed's mistake. */
function parseSeed(path: string, raw: string): Seed {
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (error) {
    throw seedInvalid(path, errorMessageOf(error), error);
  }
  const result = SeedSchema.safeParse(parsed);
  if (!result.success) throw seedInvalid(path, result.error.message, result.error);
  return result.data;
}

/**
 * Load and validate `corpus/seed.yaml` (or another seed-shaped YAML file).
 *
 * @throws {CommandRefusalError} `USAGE_INVALID` when the file is not there (the
 *   argument names nothing); `INPUT_UNREADABLE` when the OS refuses it;
 *   `CONFIG_INVALID` for malformed YAML, a schema violation, or a duplicate
 *   `source` or `name`
 */
export function loadSeedFile(path: string): Seed {
  const raw = readInputFile(path, { origin: 'argument', message: `Seed file not found: ${path}` });
  const seed = parseSeed(path, raw);

  const sources = new Set<string>();
  const names = new Set<string>();
  for (const entry of seed.plugins) {
    if (sources.has(entry.source)) {
      throw seedInvalid(path, `duplicate source: ${entry.source}`);
    }
    if (names.has(entry.name)) {
      throw seedInvalid(path, `duplicate name: ${entry.name}`);
    }
    sources.add(entry.source);
    names.add(entry.name);
  }

  return seed;
}

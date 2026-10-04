/**
 * The document `vat audit settings` publishes, apart from the command.
 *
 * A sibling module for the same reason as `audit-schema.ts`: the published-shape
 * registry imports it, and the command imports the writer that imports the
 * registry.
 *
 * The verb has three modes and one envelope. `data.mode` says which one ran,
 * and each mode's `data` is what it read — the findings (a shadowed rule, an
 * invalid field, a deprecated path) are the envelope's, never `data`'s.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../utils/run-integrity.js';

/** What `examined` counts for `vat audit settings`, and the remedy when it is zero. */
export const AUDIT_SETTINGS_EXAMINED: ExaminedDeclaration = {
  unit: 'settings documents',
  whenZero: 'No Claude settings file could be read from here — run from the project directory, or run vat audit settings --show-paths to see which settings paths exist and are readable.',
};

/**
 * The directory the command ran in — the ONE absolute path in the document,
 * and the base every other path (a finding's `location`, a layer's `file`, a
 * rule's source, a probed `path`) is forward-slashed and relative to, as
 * `vat audit`'s `data.root` is. A settings file on another Windows drive has no
 * relative spelling and is the one path published absolutely.
 */
const root = z.string();

/** `--file <path>`: the one settings file named. */
const FileModeSchema = z.object({
  mode: z.literal('file'),
  root,
  /** The file, relative to `root`. */
  file: z.string(),
  detectedType: z.enum(['managed', 'user', 'project', 'unknown']),
  /** How `detectedType` was arrived at: `declared` (--type), `inferred`, `ambiguous`, or `undetermined` (not JSON; an unreadable file is refused, never reported). */
  typeConfidence: z.enum(['declared', 'inferred', 'ambiguous', 'undetermined']),
  /** `null` when the file is not a JSON object, so there are no fields to list — not the same answer as `[]`. */
  fields: z.array(z.object({ key: z.string(), value: z.string().optional(), count: z.number().int().optional() }).strict()).nullable(),
}).strict();

/** `--show-paths`: every settings path Claude Code reads, probed. */
const PathsModeSchema = z.object({
  mode: z.literal('paths'),
  root,
  paths: z.array(z.object({
    label: z.string(),
    path: z.string(),
    /** `undetermined` when the probe itself failed — not the same answer as `false`. */
    exists: z.union([z.boolean(), z.literal('undetermined')]),
    readable: z.union([z.boolean(), z.literal('undetermined')]),
    level: z.string(),
    accessError: z.string().optional(),
  }).strict()),
}).strict();

/** The default mode: the settings the layers merge into, from the working directory. */
const EffectiveModeSchema = z.object({
  mode: z.literal('effective'),
  root,
  /** Every settings file loaded, highest precedence first. */
  layers: z.array(z.object({ level: z.string(), file: z.string() }).strict()),
  /** Merged values, each with its source; keys are Claude Code's settings keys. */
  effectiveSettings: z.record(z.string(), z.unknown()),
  /** Rules that can never take effect, and what shadows each. The findings say the same thing, one per rule. */
  conflicts: z.array(z.object({
    kind: z.string(),
    rule: z.string(),
    ruleSource: z.string(),
    ruleLevel: z.string(),
    ruleList: z.string(),
    shadowedBy: z.string(),
    shadowedBySource: z.string(),
    shadowedByLevel: z.string(),
    shadowedByList: z.string(),
  }).strict()),
}).strict();

const AuditSettingsDataSchema = z.discriminatedUnion('mode', [FileModeSchema, PathsModeSchema, EffectiveModeSchema]);

export type AuditSettingsData = z.infer<typeof AuditSettingsDataSchema>;

/** The document this command publishes. */
export const AUDIT_SETTINGS_REPORT_SCHEMA = reportSchema(AuditSettingsDataSchema, FindingSchema);

export type AuditSettingsReport = Report<AuditSettingsData>;


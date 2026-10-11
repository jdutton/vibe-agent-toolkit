/**
 * The document `vat audit` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 *
 * 🔑 **One meaning of `summary`.** The document used to carry two: a header
 * `summary` counting FILES beside a per-file `summary` counting FINDINGS. The
 * envelope's `summary` counts findings; the file counts are `data.counts`,
 * and the number of files read is the envelope's `examined`.
 */

import { FindingSchema, reportSchema, SeverityCountsSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../utils/run-integrity.js';

/** What `examined` counts for `vat audit` (and the corpus scan's per-plugin audit), and the remedy when it is zero. */
export const AUDIT_EXAMINED: ExaminedDeclaration = {
  unit: 'files',
  whenZero: 'The scan root holds nothing auditable — check the path and skills.include.',
};

/** Where a URL audit's tree came from — the base its paths are relative to. */
const ProvenanceSchema = z.object({
  /** The URL as the operator typed it. */
  url: z.string(),
  /** The branch or tag cloned. */
  ref: z.string(),
  /** The full commit SHA of the cloned ref. */
  commit: z.string(),
  subpath: z.string().optional(),
}).strict();

/** A path a lane enumerated and could not read, root-relative, and why. */
const UncheckedPathSchema = z.object({ path: z.string(), reason: z.string() }).strict();

/**
 * One record the compatibility analyzer produced (evidence, observation,
 * verdict). Their shapes are `@vibe-agent-toolkit/claude-marketplace`'s
 * exported types, published verbatim; this document owns the block around them.
 */
const AnalyzerRecordSchema = z.record(z.string(), z.unknown());

/** The analyzer's result for one plugin. */
const CompatibilityResultSchema = z.object({
  plugin: z.string(),
  version: z.string().optional(),
  declaredTargets: z.array(z.string()).optional(),
  /** Present only under `--verbose`. */
  evidence: z.array(AnalyzerRecordSchema).optional(),
  observations: z.array(AnalyzerRecordSchema),
  verdicts: z.array(AnalyzerRecordSchema),
  unchecked: z.array(UncheckedPathSchema),
  /** FILES the analysis walked, by kind — never `summary`, which counts findings. */
  fileCounts: z.object({
    totalFiles: z.number().int().nonnegative(),
    skillFiles: z.number().int().nonnegative(),
    scriptFiles: z.number().int().nonnegative(),
    hookFiles: z.number().int().nonnegative(),
    mcpConfigs: z.number().int().nonnegative(),
  }).strict(),
}).strict();

/** The block when the analyzer could not run for the plugin at all — said, never omitted. */
const CompatibilityUnavailableSchema = z.object({ analyzed: z.literal(false), reason: z.string() }).strict();

/** One settings conflict, as `checkSettingsCompatibility` found it. */
const SettingsConflictSchema = z.object({
  type: z.string(),
  detail: z.string(),
  blockedBy: z.string(),
  value: z.string(),
  settingsFile: z.string(),
  settingsLevel: z.string(),
}).strict();

/** The `settings:` block under `--compat --settings`. */
const SettingsBlockSchema = z.object({
  /** `false` when a conflict was found OR when anything went unchecked. */
  compatible: z.boolean(),
  conflicts: z.array(SettingsConflictSchema),
  /** Present only when non-empty. */
  unchecked: z.array(UncheckedPathSchema).optional(),
}).strict();

/** One audited file (or refused path): what it is and how its findings are distributed. Its findings are the envelope's. */
const AuditFileSchema = z.object({
  /** Relative to `data.root` — or to the clone, for a URL audit. */
  path: z.string(),
  type: z.enum(['agent-skill', 'vat-agent', 'claude-plugin', 'marketplace', 'registry', 'unknown']),
  /** Literal: `findings` iff this file carries any finding. */
  status: z.enum(['ok', 'findings']),
  /** This file's findings by severity. */
  summary: SeverityCountsSchema,
  /** Under `--compat`, on every `claude-plugin` entry. */
  compatibility: z.union([CompatibilityUnavailableSchema, CompatibilityResultSchema]).optional(),
  /** Under `--compat --settings`, on every `claude-plugin` entry. */
  settings: SettingsBlockSchema.optional(),
}).strict();

/** One skill in the `--user` view. */
const HierarchicalSkillSchema = z.object({
  name: z.string(),
  path: z.string(),
  status: z.enum(['ok', 'findings']),
  summary: SeverityCountsSchema,
  /** A cached copy's standing against its installed source. */
  cacheStatus: z.enum(['stale', 'orphaned', 'fresh']).optional(),
}).strict();

const HierarchicalPluginSchema = z.object({ name: z.string(), skills: z.array(HierarchicalSkillSchema) }).strict();

/** `--user` only: the skills grouped by where Claude Code installed them. */
const HierarchicalSchema = z.object({
  marketplaces: z.array(z.object({ name: z.string(), plugins: z.array(HierarchicalPluginSchema) }).strict()),
  cachedPlugins: z.array(HierarchicalPluginSchema),
  standalonePlugins: z.array(HierarchicalPluginSchema),
  standaloneSkills: z.array(HierarchicalSkillSchema),
}).strict();

const AuditDataSchema = z.object({
  /**
   * The invocation scan root — the ONE absolute path in the document, and the
   * base every `path` and finding `location` is relative to. `null` for a URL
   * audit, and only then: the clone lives in a random tempdir nothing
   * downstream can resolve, so `provenance` names the base instead.
   */
  root: z.string().nullable(),
  /** A URL audit's source; `null` for every other audit. */
  provenance: ProvenanceSchema.nullable(),
  /** FILES by their worst actionable severity. The files read are `examined`; a refused path is in `pathsUnreadable` and no other count. */
  counts: z.object({
    filesPassed: z.number().int().nonnegative(),
    filesWithWarnings: z.number().int().nonnegative(),
    filesWithErrors: z.number().int().nonnegative(),
    pathsUnreadable: z.number().int().nonnegative(),
  }).strict(),
  files: z.array(AuditFileSchema),
  /** `--user` only; `null` for every other audit. */
  hierarchical: HierarchicalSchema.nullable(),
}).strict().refine((data) => (data.root === null) === (data.provenance !== null), {
  message: 'root is null exactly when the audit is a URL audit (provenance names the base instead)',
  path: ['root'],
});

/**
 * The document this command publishes. Every finding about a FILE names it in
 * `location` (a validator's finding without one inherits its row's path); the
 * one finding with no file is the run's own `RESOURCE_CHECK_BROKEN` over zero
 * files, which is about the run.
 */
export const AUDIT_REPORT_SCHEMA = reportSchema(AuditDataSchema, FindingSchema);

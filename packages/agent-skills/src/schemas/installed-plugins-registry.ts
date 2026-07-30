import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * `installed_plugins.json` is written and owned by Claude Code — VAT only reads it.
 * Per VAT's Postel's Law rule (CLAUDE.md: "Reading outside world → liberal"), these
 * schemas `.passthrough()` and keep `scope` open: an unrecognized field or install
 * scope is drift in someone else's file, not an error in the user's setup.
 *
 * Modelling it strictly turned every shape Claude Code added — the `project` scope,
 * its `projectPath` companion, the removal of `isLocal` — into a wall of false errors.
 *
 * Liberality alone would be blindness, so it is paired with
 * {@link detectInstalledPluginsRegistryDrift}: what passthrough absorbs still gets
 * reported, at `info`, as `REGISTRY_SHAPE_DRIFT`.
 */

/**
 * Install scopes VAT's model knows about. Not enforced by the schema — a scope
 * outside this list parses fine and is reported as drift instead.
 */
export const KNOWN_INSTALLATION_SCOPES = [
  'user',
  'system',
  'project',
  'local',
] as const;

const KNOWN_SCOPE_SET: ReadonlySet<string> = new Set(KNOWN_INSTALLATION_SCOPES);

/**
 * Single plugin installation entry
 */
const PluginInstallationSchema = z
  .object({
    scope: z
      .string()
      .describe(
        `Installation scope (recognized: ${KNOWN_INSTALLATION_SCOPES.join(', ')}; others pass through as drift)`,
      ),

    projectPath: z
      .string()
      .optional()
      .describe('Absolute path to the project a project-scoped installation belongs to'),

    installPath: z
      .string()
      .describe('Absolute path to installed plugin directory'),

    version: z
      .string()
      .describe('Installed version (semver or commit SHA)'),

    installedAt: z
      .string()
      .datetime()
      .describe('ISO 8601 timestamp when plugin was first installed'),

    lastUpdated: z
      .string()
      .datetime()
      .describe('ISO 8601 timestamp when plugin was last updated'),

    gitCommitSha: z
      .string()
      .optional()
      .describe('Git commit SHA for git-based installations'),

    isLocal: z
      .boolean()
      .optional()
      .describe(
        'Whether plugin is installed locally (not from marketplace). Current Claude Code no longer writes this field.',
      ),
  })
  .passthrough();

/**
 * Schema for installed_plugins.json registry
 * Tracks all installed plugins with version and path info
 *
 * Format: { "plugin-name@marketplace-name": [installation entries] }
 *
 * A single plugin can have multiple installations (e.g., both user and project scope).
 */
export const InstalledPluginsRegistrySchema = z
  .object({
    version: z.literal(2).describe('Registry format version (currently 2)'),

    plugins: z
      .record(
        z
          .string()
          .regex(/^[^@]+@[^@]+$/, 'Key must be in format "plugin@marketplace"'),
        z.array(PluginInstallationSchema).min(1),
      )
      .describe('Map of plugin@marketplace to installation entries'),
  })
  .passthrough()
  .describe('Installed plugins registry structure');

export type InstalledPluginsRegistry = z.infer<
  typeof InstalledPluginsRegistrySchema
>;
export type PluginInstallation = z.infer<typeof PluginInstallationSchema>;

export const InstalledPluginsRegistryJsonSchema = zodToJsonSchema(
  InstalledPluginsRegistrySchema,
  { name: 'InstalledPluginsRegistry', $refStrategy: 'none' },
);

/** One thing in the registry that VAT's model does not recognize. */
export interface RegistryShapeDrift {
  /** Dotted pointer to the unrecognized field, or to the field carrying an unrecognized value. */
  field: string;
  /** Human-readable description of what was not recognized. */
  message: string;
}

const KNOWN_REGISTRY_KEYS: ReadonlySet<string> = new Set(['version', 'plugins']);

const KNOWN_INSTALLATION_KEYS: ReadonlySet<string> = new Set([
  'scope',
  'projectPath',
  'installPath',
  'version',
  'installedAt',
  'lastUpdated',
  'gitCommitSha',
  'isLocal',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect drift observations for one installation entry.
 *
 * @param entry - Candidate installation entry (may be any shape)
 * @param pointer - Dotted pointer to the entry, e.g. `plugins.foo@bar.0`
 * @param record - Accumulator, keyed by message so N entries sharing one unknown
 *   field produce one observation rather than N identical ones
 */
function collectEntryDrift(
  entry: unknown,
  pointer: string,
  record: Map<string, RegistryShapeDrift>,
): void {
  if (!isRecord(entry)) {
    return;
  }

  for (const key of Object.keys(entry)) {
    if (!KNOWN_INSTALLATION_KEYS.has(key)) {
      const message = `Installation entries carry unrecognized field '${key}'`;
      if (!record.has(message)) {
        record.set(message, { field: `${pointer}.${key}`, message });
      }
    }
  }

  const scope = entry['scope'];
  if (typeof scope === 'string' && !KNOWN_SCOPE_SET.has(scope)) {
    const message = `Installation scope '${scope}' is not one of the recognized scopes (${KNOWN_INSTALLATION_SCOPES.join(', ')})`;
    if (!record.has(message)) {
      record.set(message, { field: `${pointer}.scope`, message });
    }
  }
}

/**
 * Report what `.passthrough()` absorbed: fields and scope values in an
 * installed-plugins registry that VAT's model does not recognize.
 *
 * Deduplicated by message — the point is "Claude Code writes something new",
 * not "it wrote it 28 times".
 *
 * @param data - Parsed registry JSON (any shape; non-objects yield no drift)
 * @returns One observation per distinct unrecognized field or scope value
 */
export function detectInstalledPluginsRegistryDrift(
  data: unknown,
): RegistryShapeDrift[] {
  const found = new Map<string, RegistryShapeDrift>();

  if (!isRecord(data)) {
    return [];
  }

  for (const key of Object.keys(data)) {
    if (!KNOWN_REGISTRY_KEYS.has(key)) {
      const message = `Registry carries unrecognized top-level field '${key}'`;
      found.set(message, { field: key, message });
    }
  }

  const plugins = data['plugins'];
  if (isRecord(plugins)) {
    for (const [pluginKey, entries] of Object.entries(plugins)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const [index, entry] of entries.entries()) {
        collectEntryDrift(entry, `plugins.${pluginKey}.${index}`, found);
      }
    }
  }

  return [...found.values()];
}

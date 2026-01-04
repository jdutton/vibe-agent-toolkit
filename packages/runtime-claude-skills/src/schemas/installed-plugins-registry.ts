import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Single plugin installation entry
 */
const PluginInstallationSchema = z
  .object({
    scope: z
      .enum(['user', 'system'])
      .describe('Installation scope (user or system-wide)'),

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
      .describe('Whether plugin is installed locally (not from marketplace)'),
  })
  .strict();

/**
 * Schema for installed_plugins.json registry
 * Tracks all installed plugins with version and path info
 *
 * Format: { "plugin-name@marketplace-name": [installation entries] }
 *
 * A single plugin can have multiple installations (e.g., both user and system scope).
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
  .strict()
  .describe('Installed plugins registry structure');

export type InstalledPluginsRegistry = z.infer<
  typeof InstalledPluginsRegistrySchema
>;
export type PluginInstallation = z.infer<typeof PluginInstallationSchema>;

export const InstalledPluginsRegistryJsonSchema = zodToJsonSchema(
  InstalledPluginsRegistrySchema,
  { name: 'InstalledPluginsRegistry', $refStrategy: 'none' },
);

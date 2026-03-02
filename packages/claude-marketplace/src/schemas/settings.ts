import { z } from 'zod';

import { HooksConfigSchema } from './hooks-config.js';
import { McpServerPolicySchema } from './mcp-policy-config.js';
import { PermissionsConfigSchema } from './permissions.js';
import { SandboxConfigSchema } from './sandbox-config.js';

/**
 * Source descriptor for a known marketplace.
 * Uses .passthrough() per Postel's Law — liberal reading of external settings files.
 */
export const MarketplaceSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('github'), repo: z.string(), ref: z.string().optional(), sha: z.string().optional() }),
  z.object({ source: z.literal('url'), url: z.string(), ref: z.string().optional() }),
  z.object({ source: z.literal('npm'), package: z.string(), version: z.string().optional(), registry: z.string().optional() }),
  z.object({ source: z.literal('hostPattern'), hostPattern: z.string() }),
]).and(z.object({}).passthrough());

export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

// Fields valid at ALL levels (user + project + managed)
const SharedSettingsSchema = z
  .object({
    model: z.string().optional(),
    permissions: PermissionsConfigSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    hooks: HooksConfigSchema.optional(),
    enabledMcpjsonServers: z.array(z.string()).optional(),
    allowedMcpServers: z.array(McpServerPolicySchema).optional(),
    deniedMcpServers: z.array(McpServerPolicySchema).optional(),
    extraKnownMarketplaces: z.record(z.string(), z.object({
      source: MarketplaceSourceSchema,
      autoUpdate: z.boolean().optional(),
    }).passthrough()).optional(),
    enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

// Managed-settings-only fields (enterprise/IT admin)
// Note: forceLoginMethod appears once — duplicate removed per zod requirement
export const ManagedSettingsSchema = SharedSettingsSchema.extend({
  availableModels: z.array(z.string()).optional(),
  forceLoginMethod: z.enum(['claudeai', 'console']).optional(),
  forceLoginOrgUUID: z.string().uuid().optional(),
  apiKeyHelper: z.string().optional(),
  companyAnnouncements: z.array(z.string()).optional(),
  cleanupPeriodDays: z.number().int().positive().optional(),
  outputStyle: z.string().optional(),
  language: z.string().optional(),
  autoUpdatesChannel: z.enum(['stable', 'beta', 'alpha']).optional(),
  disableAllHooks: z.boolean().optional(),
  allowManagedHooksOnly: z.boolean().optional(),
  sandbox: SandboxConfigSchema.optional(),
  enableAllProjectMcpServers: z.boolean().optional(),
  strictKnownMarketplaces: z.array(MarketplaceSourceSchema).optional(),
}).passthrough();

export const UserSettingsSchema = SharedSettingsSchema;
export const ProjectSettingsSchema = SharedSettingsSchema;

export type ManagedSettings = z.infer<typeof ManagedSettingsSchema>;
export type UserSettings = z.infer<typeof UserSettingsSchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

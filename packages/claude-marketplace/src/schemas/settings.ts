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

/**
 * Attribution configuration for git commits and pull requests.
 *
 * @see https://code.claude.com/docs/en/settings — "Git & Attribution" section
 */
const AttributionConfigSchema = z
  .object({
    commit: z.string().optional(),
    pr: z.string().optional(),
  })
  .passthrough();

/**
 * Spinner customization.
 *
 * @see https://code.claude.com/docs/en/settings — "UI & Display" section
 */
const SpinnerVerbsSchema = z
  .object({
    mode: z.enum(['append', 'replace']).optional(),
    verbs: z.array(z.string()).optional(),
  })
  .passthrough();

const SpinnerTipsOverrideSchema = z
  .object({
    excludeDefault: z.boolean().optional(),
    tips: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Status line or file suggestion command configuration.
 */
const CommandConfigSchema = z
  .object({
    type: z.literal('command'),
    command: z.string(),
  })
  .passthrough();

/**
 * Fields valid at ALL settings levels (user + project + managed).
 *
 * @see https://code.claude.com/docs/en/settings
 */
const SharedSettingsSchema = z
  .object({
    // Model
    model: z.string().optional(),
    alwaysThinkingEnabled: z.boolean().optional(),

    // Permissions
    permissions: PermissionsConfigSchema.optional(),

    // Environment
    env: z.record(z.string(), z.string()).optional(),

    // Hooks & automation
    hooks: HooksConfigSchema.optional(),
    statusLine: CommandConfigSchema.optional(),
    fileSuggestion: CommandConfigSchema.optional(),

    // MCP servers
    enabledMcpjsonServers: z.array(z.string()).optional(),
    disabledMcpjsonServers: z.array(z.string()).optional(),
    allowedMcpServers: z.array(McpServerPolicySchema).optional(),
    deniedMcpServers: z.array(McpServerPolicySchema).optional(),

    // Plugins & marketplaces
    extraKnownMarketplaces: z.record(z.string(), z.object({
      source: MarketplaceSourceSchema,
      autoUpdate: z.boolean().optional(),
    }).passthrough()).optional(),
    enabledPlugins: z.record(z.string(), z.boolean()).optional(),

    // Sandbox
    sandbox: SandboxConfigSchema.optional(),

    // Git & attribution
    attribution: AttributionConfigSchema.optional(),
    /** @deprecated Use `attribution` instead */
    includeCoAuthoredBy: z.boolean().optional(),
    includeGitInstructions: z.boolean().optional(),

    // UI & display
    language: z.string().optional(),
    outputStyle: z.string().optional(),
    showTurnDuration: z.boolean().optional(),
    spinnerVerbs: SpinnerVerbsSchema.optional(),
    spinnerTipsEnabled: z.boolean().optional(),
    spinnerTipsOverride: SpinnerTipsOverrideSchema.optional(),
    terminalProgressBarEnabled: z.boolean().optional(),
    prefersReducedMotion: z.boolean().optional(),

    // Files & directories
    respectGitignore: z.boolean().optional(),
    plansDirectory: z.string().optional(),
    cleanupPeriodDays: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * Managed-settings-only fields (enterprise/IT admin).
 * Extends shared settings with enterprise lockdown and policy fields.
 *
 * @see https://code.claude.com/docs/en/settings — managed settings section
 */
export const ManagedSettingsSchema = SharedSettingsSchema.extend({
  // Model restrictions
  availableModels: z.array(z.string()).optional(),

  // Authentication & API
  forceLoginMethod: z.enum(['claudeai', 'console']).optional(),
  forceLoginOrgUUID: z.string().uuid().optional(),
  apiKeyHelper: z.string().optional(),
  otelHeadersHelper: z.string().optional(),
  awsAuthRefresh: z.string().optional(),
  awsCredentialExport: z.string().optional(),

  // Enterprise announcements
  companyAnnouncements: z.array(z.string()).optional(),

  // Update channel
  autoUpdatesChannel: z.enum(['stable', 'latest']).optional(),

  // Hooks lockdown
  disableAllHooks: z.boolean().optional(),
  allowManagedHooksOnly: z.boolean().optional(),

  // Permission lockdown
  allowManagedPermissionRulesOnly: z.boolean().optional(),

  // MCP lockdown
  enableAllProjectMcpServers: z.boolean().optional(),
  allowManagedMcpServersOnly: z.boolean().optional(),

  // Marketplace lockdown
  strictKnownMarketplaces: z.array(MarketplaceSourceSchema).optional(),
  blockedMarketplaces: z.array(MarketplaceSourceSchema).optional(),
  pluginTrustMessage: z.string().optional(),

  // HTTP hooks lockdown
  allowedHttpHookUrls: z.array(z.string()).optional(),
  httpHookAllowedEnvVars: z.array(z.string()).optional(),

  // Effort level
  CLAUDE_CODE_EFFORT_LEVEL: z.enum(['low', 'medium', 'high']).optional(),

  // Teammate mode
  teammateMode: z.enum(['auto', 'in-process', 'tmux']).optional(),

  // Fast mode
  fastModePerSessionOptIn: z.boolean().optional(),
}).passthrough();

export const UserSettingsSchema = SharedSettingsSchema;
export const ProjectSettingsSchema = SharedSettingsSchema;

export type ManagedSettings = z.infer<typeof ManagedSettingsSchema>;
export type UserSettings = z.infer<typeof UserSettingsSchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/**
 * @vibe-agent-toolkit/claude-marketplace
 * Claude plugin marketplace tools: compatibility analysis, provenance tracking, enterprise config
 */

export type {
  CompatibilityResult,
  EvidenceSource,
  ScannerOutput,
  SettingsConflict,
  SettingsConflictType,
  Target,
} from './types.js';

export { analyzeCompatibility } from './compatibility-analyzer.js';
export type { AnalyzeCompatibilityOptions } from './compatibility-analyzer.js';

// Marketplace defaults / target resolution
export {
  readMarketplaceDefaultTargets,
  resolveEffectiveTargets,
} from './marketplace-defaults.js';

// Verdict engine
export { computeVerdicts } from './verdict-engine.js';
export type { Verdict, VerdictCode, VerdictInput } from './verdict-engine.js';

// Paths
export type { ClaudeProjectPaths, ClaudeUserPaths } from './paths/claude-paths.js';
export {
  buildClaudeUserPaths,
  getClaudeProjectPaths,
  getClaudeUserPaths,
} from './paths/claude-paths.js';
export {
  getManagedSettingsCandidatePaths,
  WINDOWS_LEGACY_MANAGED_SETTINGS_PATH,
} from './paths/managed-settings-path.js';

// Schemas
export type {
  ClaudeAuthConfig,
  ClaudeModelConfig,
  HooksConfig,
  ManagedSettings,
  McpServerPolicy,
  PermissionsConfig,
  ProjectSettings,
  SandboxConfig,
  SandboxFilesystem,
  SandboxNetwork,
  UserSettings,
} from './schemas/index.js';
export {
  ClaudeAuthConfigSchema,
  ClaudeModelConfigSchema,
  HooksConfigSchema,
  ManagedSettingsSchema,
  MarketplaceSourceSchema,
  McpServerPolicySchema,
  PermissionsConfigSchema,
  ProjectSettingsSchema,
  SandboxConfigSchema,
  SandboxFilesystemSchema,
  SandboxNetworkSchema,
  UserSettingsSchema,
} from './schemas/index.js';

// Plugin registry
export type {
  InstalledPluginEntry,
  InstalledPlugins,
  InstallPluginOptions,
  InstallPluginSource,
  KnownMarketplaceEntry,
  KnownMarketplaces,
  MarketplaceSource,
} from './install/plugin-registry.js';
export {
  installPlugin,
  readInstalledPlugins,
  readKnownMarketplaces,
  writeInstalledPlugins,
  writeKnownMarketplaces,
} from './install/plugin-registry.js';

// Plugin uninstall
export type {
  UninstallPluginOptions,
  UninstallPluginResult,
} from './install/plugin-uninstall.js';
export { findPluginsByPackage, uninstallPlugin } from './install/plugin-uninstall.js';

// Plugin list
export type {
  ListedLegacySkill,
  ListedPlugin,
  PluginListResult,
} from './install/plugin-list.js';
export { listLocalPlugins } from './install/plugin-list.js';

// Org API client
export type { OrgApiClientOptions, PaginationParams, ReportPaginationParams, MultipartFile, MultipartResult } from './org/org-api-client.js';
export { createOrgApiClientFromEnv, OrgApiClient, buildMultipartFormData } from './org/org-api-client.js';

// Settings
export type {
  BashRuleType,
  EffectivePermissions,
  EffectiveSettings,
  ParsedBashRule,
  ProvenanceRule,
  ProvenanceValue,
  ReadSettingsOptions,
  RuleConflict,
  RuleConflictKind,
  SettingProvenance,
  SettingsAuditResult,
  SettingsLayer,
  SettingsLevel,
  SettingsPathEntry,
  SettingsPathsResult,
  SettingsValidateResult,
} from './settings/index.js';
export {
  analyzeRuleConflicts,
  auditSettings,
  checkSettingsCompatibility,
  getSettingsFileFields,
  getSettingsPaths,
  isSubsumedBy,
  matchesBashRule,
  matchesPathRule,
  matchesPermissionRule,
  mergeSettingsLayers,
  readEffectiveSettings,
  readSettingsLayers,
  resolveSettingsPaths,
  validateSettingsFile,
} from './settings/index.js';

// Claude plugin manifest schema (moved from agent-skills in Chunk 1)
export {
  ClaudePluginJsonSchema,
  ClaudePluginSchema,
  type ClaudePlugin,
} from './schemas/claude-plugin.js';

// Plugin validator (moved from agent-skills in Chunk 1)
export { validatePlugin } from './validators/plugin-validator.js';

// Inventory layer (added in Chunk 2 — vendor-specific concrete classes)
export {
  ClaudeInstallInventory,
  ClaudeMarketplaceInventory,
  ClaudePluginInventory,
  ClaudeSkillInventory,
} from './inventory/index.js';
export { extractClaudeSkillInventory } from './inventory/index.js';
export { extractClaudePluginInventory } from './inventory/index.js';
export { extractClaudeMarketplaceInventory } from './inventory/index.js';
export { extractClaudeInstallInventory } from './inventory/index.js';

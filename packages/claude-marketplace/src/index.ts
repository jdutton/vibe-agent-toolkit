/**
 * @vibe-agent-toolkit/claude-marketplace
 * Claude plugin marketplace tools: compatibility analysis, provenance tracking, enterprise config
 */

export type {
  CompatibilityEvidence,
  CompatibilityResult,
  EvidenceSource,
  SettingsConflict,
  SettingsConflictType,
  Target,
  Verdict,
} from './types.js';

export { ALL_TARGETS } from './types.js';

export { analyzeCompatibility } from './compatibility-analyzer.js';

// Paths
export type { ClaudeProjectPaths, ClaudeUserPaths } from './paths/claude-paths.js';
export {
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

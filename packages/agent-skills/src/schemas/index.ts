/**
 * Schema exports for agent-skills package
 */

export {
  AgentSkillFrontmatterJsonSchema,
  AgentSkillFrontmatterSchema,
  VATAgentSkillFrontmatterSchema,
  type AgentSkillFrontmatter,
  type VATAgentSkillFrontmatter,
} from './agent-skill-frontmatter.js';

export {
  detectInstalledPluginsRegistryDrift,
  InstalledPluginsRegistryJsonSchema,
  InstalledPluginsRegistrySchema,
  KNOWN_INSTALLATION_SCOPES,
  type InstalledPluginsRegistry,
  type PluginInstallation,
} from './installed-plugins-registry.js';

export {
  detectKnownMarketplacesRegistryDrift,
  KNOWN_MARKETPLACE_SOURCE_KINDS,
  KnownMarketplacesRegistryJsonSchema,
  KnownMarketplacesRegistrySchema,
  type KnownMarketplacesRegistry,
  type MarketplaceEntry,
  type MarketplaceSource,
} from './known-marketplaces-registry.js';

export type { RegistryShapeDrift } from './registry-drift.js';

export {
  MarketplaceManifestJsonSchema,
  MarketplaceManifestSchema,
  type MarketplaceManifest,
} from './marketplace-manifest.js';

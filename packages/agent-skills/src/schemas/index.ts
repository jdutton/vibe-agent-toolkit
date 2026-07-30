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
  type RegistryShapeDrift,
} from './installed-plugins-registry.js';

export {
  KnownMarketplacesRegistryJsonSchema,
  KnownMarketplacesRegistrySchema,
  type KnownMarketplacesRegistry,
  type MarketplaceEntry,
  type MarketplaceSource,
} from './known-marketplaces-registry.js';

export {
  MarketplaceManifestJsonSchema,
  MarketplaceManifestSchema,
  type MarketplaceManifest,
} from './marketplace-manifest.js';

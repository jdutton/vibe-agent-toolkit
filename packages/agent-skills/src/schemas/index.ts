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

export { ClaudePluginJsonSchema, ClaudePluginSchema, type ClaudePlugin } from './claude-plugin.js';

export { PluginJsonSchema, type PluginJson } from './plugin-json.js';

export {
  InstalledPluginsRegistryJsonSchema,
  InstalledPluginsRegistrySchema,
  type InstalledPluginsRegistry,
  type PluginInstallation,
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

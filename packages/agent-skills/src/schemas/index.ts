/**
 * Schema exports for agent-skills package
 */

export {
  ClaudeSkillFrontmatterSchema,
  VATClaudeSkillFrontmatterSchema,
  type ClaudeSkillFrontmatter,
  type VATClaudeSkillFrontmatter,
} from './claude-skill-frontmatter.js';

export { PluginJsonSchema, PluginSchema, type Plugin } from './plugin.js';

export {
  MarketplaceJsonSchema,
  MarketplaceSchema,
  type LspServerConfig,
  type Marketplace,
  type MarketplacePlugin,
  type PluginSource,
} from './marketplace.js';

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

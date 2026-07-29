/**
 * `.claude-plugin/marketplace.json` assembly.
 *
 * Pure: takes the marketplace's identity plus one entry per built plugin and
 * returns the manifest object to serialize. No filesystem, no config loading.
 *
 * The `author` on each entry is the plugin's ALREADY-MERGED author (see
 * `mergePluginJson`), never a fresh copy of the config `owner`. The two manifests
 * name the same author, so they must be built from the same value: rebuilding the
 * entry from `owner` dropped every author subfield VAT's config cannot express
 * (`url`, ...) from the marketplace listing while plugin.json kept it — the same
 * data loss, on the surface consumers actually browse.
 *
 * The marketplace-level `owner` is a different thing and does still come straight
 * from config: it identifies who publishes the marketplace, not who wrote a plugin.
 */

/** One built plugin, as marketplace.json describes it. */
export interface MarketplaceJsonPluginEntry {
  name: string;
  description?: string | undefined;
  version?: string | undefined;
  /** The plugin's merged author — `MergePluginJsonResult.author`. */
  author: Record<string, unknown>;
}

export interface BuildMarketplaceJsonArgs {
  /** Marketplace name (the key under `claude.marketplaces`). */
  name: string;
  /** Marketplace owner, straight from config. */
  owner: { name: string; email?: string | undefined };
  plugins: readonly MarketplaceJsonPluginEntry[];
}

export function buildMarketplaceJson(args: BuildMarketplaceJsonArgs): Record<string, unknown> {
  return {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: args.name,
    owner: {
      name: args.owner.name,
      ...(args.owner.email ? { email: args.owner.email } : {}),
    },
    plugins: args.plugins.map((plugin) => ({
      name: plugin.name,
      ...(plugin.description ? { description: plugin.description } : {}),
      source: `./plugins/${plugin.name}`,
      ...(plugin.version ? { version: plugin.version } : {}),
      author: plugin.author,
    })),
  };
}

/**
 * `.claude-plugin/marketplace.json` assembly.
 *
 * Pure: takes the marketplace's identity plus one entry per plugin (built
 * locally or referenced externally) and returns the manifest object to
 * serialize. No filesystem, no config loading.
 *
 * The `author` on a BUILT entry is the plugin's ALREADY-MERGED author (see
 * `mergePluginJson`), never a fresh copy of the config `owner`. The two manifests
 * name the same author, so they must be built from the same value: rebuilding the
 * entry from `owner` dropped every author subfield VAT's config cannot express
 * (`url`, ...) from the marketplace listing while plugin.json kept it — the same
 * data loss, on the surface consumers actually browse. An EXTERNAL entry has no
 * local plugin.json to merge, so it carries no `author` at all — the referenced
 * repo's own manifest is the source of truth for that, and fabricating one here
 * would misattribute someone else's plugin to this marketplace's owner.
 */

/** A plugin built locally by this marketplace, as marketplace.json describes it. */
export interface BuiltMarketplaceJsonPluginEntry {
  kind: 'built';
  name: string;
  description?: string | undefined;
  version?: string | undefined;
  /** The plugin's merged author — `MergePluginJsonResult.author`. */
  author: Record<string, unknown>;
}

/**
 * A plugin referenced from another marketplace/repo. `source` is emitted
 * verbatim — VAT never builds or copies its content (see `ExternalPluginSourceSchema`
 * in `@vibe-agent-toolkit/resources`).
 */
export interface ExternalMarketplaceJsonPluginEntry {
  kind: 'external';
  name: string;
  description?: string | undefined;
  version?: string | undefined;
  source: Record<string, unknown>;
}

export type MarketplaceJsonPluginEntry =
  | BuiltMarketplaceJsonPluginEntry
  | ExternalMarketplaceJsonPluginEntry;

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
      source: plugin.kind === 'external' ? plugin.source : `./plugins/${plugin.name}`,
      ...(plugin.version ? { version: plugin.version } : {}),
      ...(plugin.kind === 'built' ? { author: plugin.author } : {}),
    })),
  };
}

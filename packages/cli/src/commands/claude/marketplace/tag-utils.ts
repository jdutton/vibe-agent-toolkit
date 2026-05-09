/**
 * Format a per-plugin source-repo tag name for the multi-plugin marketplace
 * publish flow.
 *
 * Plugin-name validation (`/^[a-z0-9][a-z0-9-]*$/`) is enforced upstream by
 * `ClaudeMarketplacePluginEntrySchema`; semver validation is enforced upstream
 * by the schema's `version` refine. This formatter only enforces non-empty
 * inputs.
 */
export function pluginTagName(name: string, version: string): string {
  if (!name) throw new Error('Plugin name is required for tag naming');
  if (!version) throw new Error('Version is required for tag naming');
  return `${name}-v${version}`;
}

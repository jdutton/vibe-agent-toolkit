import yaml from 'js-yaml';

import type { AnyInventory, InstallInventory, MarketplaceInventory, PluginInventory } from './types.js';

export const INVENTORY_SCHEMA_VERSION = 'vat.inventory/v1alpha';

type Format = 'yaml' | 'json';

/**
 * Serialize an inventory with a top-level schema discriminator.
 *
 * The discriminator must come FIRST in the output so consumers can
 * sniff the schema version without parsing the whole document.
 */
export function serializeInventory(inv: AnyInventory, format: Format = 'yaml'): string {
	const envelope = { schema: INVENTORY_SCHEMA_VERSION, ...inv };
	if (format === 'json') {
		return JSON.stringify(envelope, null, 2) + '\n';
	}
	return yaml.dump(envelope, { noRefs: true, lineWidth: 120, sortKeys: false });
}

/**
 * Shallow projection: keep top-level structure but drop transitive nesting.
 *
 * - Plugin → discovered.skills replaced with [] (the skills list is preserved
 *   as ComponentRefs in declared.skills if the manifest declared them).
 * - Marketplace → discovered.plugins replaced with [].
 * - Install → marketplaces and plugins replaced with [].
 *
 * Use case: tooling that wants top-level structure without the bulk.
 */
export function serializeInventoryShallow(inv: AnyInventory, format: Format = 'yaml'): string {
	return serializeInventory(shallowProject(inv), format);
}

function shallowProject(inv: AnyInventory): AnyInventory {
	if (inv.kind === 'plugin') {
		const projected: PluginInventory = { ...inv, discovered: { ...inv.discovered, skills: [] } };
		return projected;
	}
	if (inv.kind === 'marketplace') {
		const projected: MarketplaceInventory = { ...inv, discovered: { ...inv.discovered, plugins: [] } };
		return projected;
	}
	if (inv.kind === 'install') {
		const projected: InstallInventory = { ...inv, marketplaces: [], plugins: [] };
		return projected;
	}
	return inv;
}

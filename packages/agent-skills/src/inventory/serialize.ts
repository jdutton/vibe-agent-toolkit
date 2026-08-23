import * as yaml from 'yaml';

import type { AnyInventory, InstallInventory, MarketplaceInventory, PluginInventory } from './types.js';

type Format = 'yaml' | 'json';

/*
 * A list the projection did not walk is `null`, never `[]`.
 *
 * `null` is already this repo's vocabulary for "no answer here" — see
 * `DeclaredList`, where `null` means the manifest omitted the field and `[]`
 * means it declared an explicitly empty one. A shallow projection is the same
 * distinction on the discovered side: `null` = "not walked", `[]` = "walked and
 * found nothing". Writing `[]` for a list nobody looked at made a `--shallow`
 * document byte-identical to a real scan of an empty plugin.
 */

type ShallowPluginInventory = Omit<PluginInventory, 'discovered'> & {
	discovered: Omit<PluginInventory['discovered'], 'skills'> & { skills: null };
};

type ShallowMarketplaceInventory = Omit<MarketplaceInventory, 'discovered'> & {
	discovered: { plugins: null };
};

type ShallowInstallInventory = Omit<InstallInventory, 'marketplaces' | 'plugins'> & {
	marketplaces: ShallowMarketplaceInventory[];
	plugins: ShallowPluginInventory[];
};

/**
 * An inventory as projected for serialization. Structurally an inventory, except
 * that lists the projection skipped are {@link NotWalked} rather than empty.
 */
export type ShallowInventory =
	| ShallowMarketplaceInventory
	| ShallowPluginInventory
	| ShallowInstallInventory
	| AnyInventory;

/**
 * Serialize an inventory.
 *
 * The document carries NO version label. A consumer that needs to know which
 * shape it is holding reads `kind` — the structural discriminator that is part
 * of the model itself — and, under pre-1.0, pins the VAT version it ran.
 */
export function serializeInventory(inv: AnyInventory, format: Format = 'yaml'): string {
	return emit(inv, format);
}

/**
 * Shallow projection: keep top-level structure but drop transitive nesting.
 *
 * Every list the projection skips is emitted as `null` — NOT as `[]` — and the
 * document carries a top-level `projection: shallow` marker, so a consumer can
 * tell an unwalked list from an empty one both per-field and document-wide.
 *
 * - Plugin → `discovered.skills: null` (the skills list is preserved as
 *   ComponentRefs in `declared.skills` if the manifest declared them).
 * - Marketplace → `discovered.plugins: null`.
 * - Install → each marketplace and plugin shallow-projected (their own
 *   discovered children unwalked, but path/manifest/declared kept).
 *
 * Use case: tooling that wants top-level structure without the bulk.
 */
export function serializeInventoryShallow(inv: AnyInventory, format: Format = 'yaml'): string {
	return emit({ projection: 'shallow', ...shallowProject(inv) }, format);
}

function emit(envelope: object, format: Format): string {
	if (format === 'json') {
		return JSON.stringify(envelope, null, 2) + '\n';
	}
	return yaml.stringify(envelope, { aliasDuplicateObjects: false, lineWidth: 120 });
}

function shallowProject(inv: AnyInventory): ShallowInventory {
	if (inv.kind === 'plugin') {
		return { ...inv, discovered: { ...inv.discovered, skills: null } };
	}
	if (inv.kind === 'marketplace') {
		return { ...inv, discovered: { plugins: null } };
	}
	if (inv.kind === 'install') {
		// Project each child shallow: marketplaces lose discovered.plugins,
		// plugins lose discovered.skills, but each child still carries its
		// path, manifest, and declared lists.
		return {
			...inv,
			marketplaces: inv.marketplaces.map((m) => shallowProject(m) as ShallowMarketplaceInventory),
			plugins: inv.plugins.map((p) => shallowProject(p) as ShallowPluginInventory),
		};
	}
	return inv;
}

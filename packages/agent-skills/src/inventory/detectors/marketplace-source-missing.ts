/**
 * Detector: MARKETPLACE_PLUGIN_SOURCE_MISSING
 *
 * Pure function — no I/O. Consumes a MarketplaceInventory and returns a
 * ValidationIssue for each path-sourced plugin declaration whose resolved
 * path does not exist on disk. Git/npm/unknown source types are out of scope
 * and are silently skipped.
 */

import type { ValidationIssue } from '../../validators/types.js';
import type { MarketplaceInventory } from '../types.js';

export function detectMarketplacePluginSourceMissing(inv: MarketplaceInventory): ValidationIssue[] {
	return inv.declared.plugins
		.filter(p => p.source === 'path' && !p.exists)
		.map(p => ({
			severity: 'error' as const,
			code: 'MARKETPLACE_PLUGIN_SOURCE_MISSING' as const,
			message: `Marketplace declares plugin with source "${p.manifestPath}" but the path does not exist.`,
			location: p.resolvedPath,
			fix: 'Correct the source path or remove the entry from marketplace.plugins[].',
		}));
}

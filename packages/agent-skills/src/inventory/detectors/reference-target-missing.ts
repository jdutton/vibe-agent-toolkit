/**
 * Detector: REFERENCE_TARGET_MISSING
 *
 * Pure function — no I/O. Consumes a PluginInventory and returns a
 * ValidationIssue for each cross-component reference in the manifest that
 * resolves to a path that does not exist on disk.
 */

import type { ValidationIssue } from '../../validators/types.js';
import type { PluginInventory } from '../types.js';

export function detectReferenceTargetMissing(inv: PluginInventory): ValidationIssue[] {
	return inv.references
		.filter(ref => !ref.exists)
		.map(ref => ({
			severity: 'error' as const,
			code: 'REFERENCE_TARGET_MISSING' as const,
			message: `Reference at ${ref.from} resolves to "${ref.to}" which does not exist.`,
			location: ref.to,
			fix: 'Add the referenced file or correct the path in the manifest.',
		}));
}

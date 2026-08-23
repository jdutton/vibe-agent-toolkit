/**
 * Detector: REFERENCE_TARGET_MISSING
 *
 * Pure function — no I/O. Consumes a PluginInventory and returns a
 * ValidationIssue for each cross-component reference in the manifest that
 * resolves to a path that does not exist on disk.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import type { PluginInventory } from '../types.js';

export function detectReferenceTargetMissing(
	inv: PluginInventory,
	locationRoot: string,
): ValidationIssue[] {
	// Three anchors, three genuinely different things — packing any two of them
	// into one string is what this detector used to do:
	//   location — the manifest you open to fix it
	//   field    — `ResolvedReference.from`, which is ALREADY a dotted manifest
	//              pointer ("hooks[0].script"), never a filesystem path
	//   link     — the target that does not exist, so emphatically NOT the
	//              location: naming a nonexistent path as "where to look" is
	//              advice you cannot follow
	const manifestLocation = issueLocation(
		safePath.join(inv.path, '.claude-plugin', 'plugin.json'),
		locationRoot,
	);
	return inv.references
		.filter(ref => !ref.exists)
		.map(ref => {
			const target = issueLocation(ref.to, locationRoot);
			return {
				severity: 'error' as const,
				code: 'REFERENCE_TARGET_MISSING' as const,
				message: `Reference at ${ref.from} resolves to "${target}" which does not exist.`,
				location: manifestLocation,
				field: ref.from,
				link: target,
				fix: 'Add the referenced file or correct the path in the manifest.',
			};
		});
}

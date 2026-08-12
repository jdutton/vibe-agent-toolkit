/**
 * Detector: COMPONENT_DECLARED_BUT_MISSING
 *
 * Pure function — no I/O. Consumes a PluginInventory and returns a
 * ValidationIssue for each declared component path that does not exist on
 * disk. Covers all seven component fields in the manifest.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import type { PluginInventory } from '../types.js';

type ComponentField = keyof PluginInventory['declared'];
const FIELDS: ComponentField[] = [
	'skills',
	'commands',
	'agents',
	'hooks',
	'mcpServers',
	'outputStyles',
	'lspServers',
];

export function detectDeclaredButMissing(inv: PluginInventory, locationRoot: string): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	// Anchor contract: `location` is a project-relative POSIX path.
	const manifestLocation = issueLocation(safePath.join(inv.path, '.claude-plugin', 'plugin.json'), locationRoot);
	for (const field of FIELDS) {
		const list = inv.declared[field];
		if (list === null) continue;
		for (const ref of list) {
			if (!ref.exists) {
				issues.push({
					severity: 'warning',
					code: 'COMPONENT_DECLARED_BUT_MISSING',
					message: `Manifest declares ${field}: "${ref.manifestPath}" but the path does not exist on disk.`,
					location: manifestLocation,
					fix: 'Add the missing file, remove the declaration, or correct the path.',
				});
			}
		}
	}
	return issues;
}

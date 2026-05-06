/**
 * Detector: COMPONENT_DECLARED_BUT_MISSING
 *
 * Pure function — no I/O. Consumes a PluginInventory and returns a
 * ValidationIssue for each declared component path that does not exist on
 * disk. Covers all seven component fields in the manifest.
 */

import type { ValidationIssue } from '../../validators/types.js';
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

export function detectDeclaredButMissing(inv: PluginInventory): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const field of FIELDS) {
		const list = inv.declared[field];
		if (list === null) continue;
		for (const ref of list) {
			if (!ref.exists) {
				issues.push({
					severity: 'warning',
					code: 'COMPONENT_DECLARED_BUT_MISSING',
					message: `Manifest declares ${field}: "${ref.manifestPath}" but the path does not exist on disk.`,
					location: `${inv.path}/.claude-plugin/plugin.json`,
					fix: 'Add the missing file, remove the declaration, or correct the path.',
				});
			}
		}
	}
	return issues;
}

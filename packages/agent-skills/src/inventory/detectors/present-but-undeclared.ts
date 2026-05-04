/**
 * Detector: COMPONENT_PRESENT_BUT_UNDECLARED
 *
 * Pure function — no I/O. Consumes a PluginInventory and returns a
 * ValidationIssue for each discovered component that is absent from the
 * manifest's explicit declaration list. Fires only when the manifest
 * declares an explicit list (including []) — omitting the field entirely
 * means auto-discovery is intentional and this detector is silent.
 */

import type { ValidationIssue } from '../../validators/types.js';
import type { PluginInventory, ComponentRef } from '../types.js';

export function detectPresentButUndeclared(inv: PluginInventory): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	checkSkills(inv, issues);
	checkRefList('commands', inv.discovered.commands, inv.declared.commands, issues);
	checkRefList('agents', inv.discovered.agents, inv.declared.agents, issues);
	return issues;
}

function checkSkills(inv: PluginInventory, issues: ValidationIssue[]): void {
	const declared = inv.declared.skills;
	if (declared === null) return; // auto-discovery intentional
	const declaredResolved = new Set(declared.map(d => d.resolvedPath));
	for (const skill of inv.discovered.skills) {
		if (!declaredResolved.has(skill.path)) {
			issues.push(makeIssue('skills', skill.path));
		}
	}
}

function checkRefList(
	field: 'commands' | 'agents',
	discovered: ComponentRef[],
	declared: ComponentRef[] | null,
	issues: ValidationIssue[],
): void {
	if (declared === null) return;
	const declaredResolved = new Set(declared.map(d => d.resolvedPath));
	for (const ref of discovered) {
		if (!declaredResolved.has(ref.resolvedPath)) {
			issues.push(makeIssue(field, ref.resolvedPath));
		}
	}
}

function makeIssue(field: string, filePath: string): ValidationIssue {
	return {
		severity: 'info',
		code: 'COMPONENT_PRESENT_BUT_UNDECLARED',
		message: `${field}: "${filePath}" is on disk but the manifest declares an explicit ${field} list that omits it.`,
		location: filePath,
		fix: `Add ${filePath} to the manifest's "${field}" field, or remove the file.`,
	};
}



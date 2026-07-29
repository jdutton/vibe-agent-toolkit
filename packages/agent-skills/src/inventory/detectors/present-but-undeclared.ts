/**
 * Detector: COMPONENT_PRESENT_BUT_UNDECLARED
 *
 * Pure function — no I/O. Consumes a PluginInventory and returns a
 * ValidationIssue for each discovered component that is absent from the
 * manifest's explicit declaration list. Fires only when the manifest
 * declares an explicit list (including []) — omitting the field entirely
 * means auto-discovery is intentional and this detector is silent.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { issueLocation } from '@vibe-agent-toolkit/utils';

import type { PluginInventory, ComponentRef } from '../types.js';

export function detectPresentButUndeclared(inv: PluginInventory, projectRoot: string): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	checkSkills(inv, projectRoot, issues);
	checkRefList('commands', inv.discovered.commands, inv.declared.commands, projectRoot, issues);
	checkRefList('agents', inv.discovered.agents, inv.declared.agents, projectRoot, issues);
	return issues;
}

function checkSkills(inv: PluginInventory, projectRoot: string, issues: ValidationIssue[]): void {
	const declared = inv.declared.skills;
	if (declared === null) return; // auto-discovery intentional
	const declaredResolved = new Set(declared.map(d => d.resolvedPath));
	for (const skill of inv.discovered.skills) {
		if (!declaredResolved.has(skill.path)) {
			issues.push(makeIssue('skills', skill.path, projectRoot));
		}
	}
}

function checkRefList(
	field: 'commands' | 'agents',
	discovered: ComponentRef[],
	declared: ComponentRef[] | null,
	projectRoot: string,
	issues: ValidationIssue[],
): void {
	if (declared === null) return;
	const declaredResolved = new Set(declared.map(d => d.resolvedPath));
	for (const ref of discovered) {
		if (!declaredResolved.has(ref.resolvedPath)) {
			issues.push(makeIssue(field, ref.resolvedPath, projectRoot));
		}
	}
}

function makeIssue(field: string, filePath: string, projectRoot: string): ValidationIssue {
	const location = issueLocation(filePath, projectRoot);
	return {
		severity: 'info',
		code: 'COMPONENT_PRESENT_BUT_UNDECLARED',
		message: `${field}: "${location}" is on disk but the manifest declares an explicit ${field} list that omits it.`,
		location,
		fix: `Add ${location} to the manifest's "${field}" field, or remove the file.`,
	};
}



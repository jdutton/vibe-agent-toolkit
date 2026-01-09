/* eslint-disable security/detect-non-literal-fs-filename -- File paths are validated before use */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PluginSchema } from '../schemas/plugin.js';

import type { ValidationIssue, ValidationResult } from './types.js';
import {
	calculateValidationStatus,
	generateFixSuggestion,
} from './validation-utils.js';

const PLUGIN_TYPE = 'claude-plugin' as const;

/**
 * Validate a plugin directory structure
 *
 * @param pluginPath - Absolute path to plugin directory
 * @returns Validation result with issues
 */
export async function validatePlugin(pluginPath: string): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];
	const pluginJsonPath = join(pluginPath, '.claude-plugin', 'plugin.json');

	// Check plugin.json exists
	if (!existsSync(pluginJsonPath)) {
		issues.push({
			severity: 'error',
			code: 'PLUGIN_MISSING_MANIFEST',
			message: 'Plugin manifest not found',
			location: `${pluginPath}/.claude-plugin/plugin.json`,
			fix: 'Create .claude-plugin/plugin.json with required fields (name, description, version)',
		});

		return {
			path: pluginPath,
			type: PLUGIN_TYPE,
			status: 'error',
			summary: 'Plugin manifest missing',
			issues,
		};
	}

	// Parse and validate plugin.json
	let pluginData: unknown;
	try {
		const content = readFileSync(pluginJsonPath, 'utf-8');
		pluginData = JSON.parse(content);
	} catch (error) {
		issues.push({
			severity: 'error',
			code: 'PLUGIN_INVALID_JSON',
			message: `Failed to parse plugin.json: ${error instanceof Error ? error.message : 'Unknown error'}`,
			location: pluginJsonPath,
			fix: 'Fix JSON syntax errors in plugin.json',
		});

		return {
			path: pluginPath,
			type: PLUGIN_TYPE,
			status: 'error',
			summary: 'Plugin manifest is invalid JSON',
			issues,
		};
	}

	// Validate against schema
	const result = PluginSchema.safeParse(pluginData);
	if (!result.success) {
		for (const zodIssue of result.error.issues) {
			issues.push({
				severity: 'error',
				code: 'PLUGIN_INVALID_SCHEMA',
				message: zodIssue.message,
				location: `${pluginJsonPath}:${zodIssue.path.join('.')}`,
				fix: generateFixSuggestion(zodIssue),
			});
		}
	}

	const status = calculateValidationStatus(issues);

	const validationResult: ValidationResult = {
		path: pluginPath,
		type: PLUGIN_TYPE,
		status,
		summary:
			status === 'success' ? 'Valid plugin' : `Found ${issues.length} issue(s)`,
		issues,
	};

	if (result.success) {
		validationResult.metadata = {
			name: result.data.name,
			version: result.data.version,
		};
	}

	return validationResult;
}

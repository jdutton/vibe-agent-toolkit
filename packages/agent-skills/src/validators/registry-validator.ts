/* eslint-disable security/detect-non-literal-fs-filename -- File paths are validated before use */
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { calculateValidationStatus, countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { issueLocation } from '@vibe-agent-toolkit/utils';
import type { z } from 'zod';

import { InstalledPluginsRegistrySchema } from '../schemas/installed-plugins-registry.js';
import { KnownMarketplacesRegistrySchema } from '../schemas/known-marketplaces-registry.js';

import { type AnchorRootOptions, resolveAnchorRoot } from './anchor-root.js';
import type { ValidationResult } from './types.js';
import { generateFixSuggestion } from './validation-utils.js';

const REGISTRY_TYPE = 'registry' as const;
const REGISTRY_FILE_NOT_FOUND_MESSAGE = 'Registry file not found';

/**
 * Common validation logic for registry files
 */
function validateRegistryFile(
	filePath: string,
	schema: z.ZodType,
	successMessage: string,
	locationRoot: string | undefined,
): ValidationResult {
	const issues: ValidationIssue[] = [];
	// Anchor contract: `location` is relative to the run's ONE stated root. When
	// no run root is supplied, registry files are pointed at directly, so the
	// enclosing project is discovered the same way the skills lane discovers it.
	const location = issueLocation(filePath, resolveAnchorRoot(locationRoot, dirname(filePath)));

	// Check file exists
	if (!existsSync(filePath)) {
		issues.push({
			severity: 'error',
			code: 'REGISTRY_MISSING_FILE',
			message: REGISTRY_FILE_NOT_FOUND_MESSAGE,
			location,
			fix: 'Create the registry file at the specified path',
		});

		return {
			path: filePath,
			type: REGISTRY_TYPE,
			status: 'error',
			summary: REGISTRY_FILE_NOT_FOUND_MESSAGE,
			issues,
			issueCounts: countBySeverity(issues),
		};
	}

	// Parse JSON
	let data: unknown;
	try {
		const content = readFileSync(filePath, 'utf-8');
		data = JSON.parse(content);
	} catch (error) {
		issues.push({
			severity: 'error',
			code: 'REGISTRY_INVALID_JSON',
			message: `Failed to parse registry file: ${error instanceof Error ? error.message : 'Unknown error'}`,
			location,
			fix: 'Fix JSON syntax errors in the registry file',
		});

		return {
			path: filePath,
			type: REGISTRY_TYPE,
			status: 'error',
			summary: 'Registry file is invalid JSON',
			issues,
			issueCounts: countBySeverity(issues),
		};
	}

	// Validate against schema
	const result = schema.safeParse(data);
	if (!result.success) {
		for (const zodIssue of result.error.issues) {
			issues.push({
				severity: 'error',
				code: 'REGISTRY_INVALID_SCHEMA',
				message: zodIssue.message,
				location,
				field: zodIssue.path.join('.'),
				fix: generateFixSuggestion(zodIssue),
			});
		}
	}

	const status = calculateValidationStatus(issues);

	return {
		path: filePath,
		type: REGISTRY_TYPE,
		status,
		summary:
			status === 'success' ? successMessage : `Found ${issues.length} issue(s)`,
		issues,
		issueCounts: countBySeverity(issues),
	};
}

/**
 * Validate an installed plugins registry file
 *
 * @param filePath - Absolute path to installed_plugins.json file
 * @param options - Anchor base for emitted locations (see {@link AnchorRootOptions})
 * @returns Validation result with issues
 */
export async function validateInstalledPluginsRegistry(
	filePath: string,
	options?: AnchorRootOptions,
): Promise<ValidationResult> {
	return validateRegistryFile(
		filePath,
		InstalledPluginsRegistrySchema,
		'Valid installed plugins registry',
		options?.locationRoot,
	);
}

/**
 * Validate a known marketplaces registry file
 *
 * @param filePath - Absolute path to known_marketplaces.json file
 * @param options - Anchor base for emitted locations (see {@link AnchorRootOptions})
 * @returns Validation result with issues
 */
export async function validateKnownMarketplacesRegistry(
	filePath: string,
	options?: AnchorRootOptions,
): Promise<ValidationResult> {
	return validateRegistryFile(
		filePath,
		KnownMarketplacesRegistrySchema,
		'Valid known marketplaces registry',
		options?.locationRoot,
	);
}

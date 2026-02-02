/* eslint-disable security/detect-non-literal-fs-filename -- File paths are validated before use */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MarketplaceSchema } from '../schemas/marketplace.js';

import type { ValidationIssue, ValidationResult } from './types.js';
import {
	calculateValidationStatus,
	generateFixSuggestion,
} from './validation-utils.js';

const MARKETPLACE_TYPE = 'marketplace' as const;

/**
 * Validate a marketplace directory structure
 *
 * @param marketplacePath - Absolute path to marketplace directory
 * @returns Validation result with issues
 */
export async function validateMarketplace(
	marketplacePath: string,
): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];
	const marketplaceJsonPath = join(
		marketplacePath,
		'.claude-plugin',
		'marketplace.json',
	);

	// Check marketplace.json exists
	if (!existsSync(marketplaceJsonPath)) {
		issues.push({
			severity: 'error',
			code: 'MARKETPLACE_MISSING_MANIFEST',
			message: 'Marketplace manifest not found',
			location: `${marketplacePath}/.claude-plugin/marketplace.json`,
			fix: 'Create .claude-plugin/marketplace.json with required fields (name, owner, plugins)',
		});

		return {
			path: marketplacePath,
			type: MARKETPLACE_TYPE,
			status: 'error',
			summary: 'Marketplace manifest missing',
			issues,
		};
	}

	// Parse and validate marketplace.json
	let marketplaceData: unknown;
	try {
		const content = readFileSync(marketplaceJsonPath, 'utf-8');
		marketplaceData = JSON.parse(content);
	} catch (error) {
		issues.push({
			severity: 'error',
			code: 'MARKETPLACE_INVALID_JSON',
			message: `Failed to parse marketplace.json: ${error instanceof Error ? error.message : 'Unknown error'}`,
			location: marketplaceJsonPath,
			fix: 'Fix JSON syntax errors in marketplace.json',
		});

		return {
			path: marketplacePath,
			type: MARKETPLACE_TYPE,
			status: 'error',
			summary: 'Marketplace manifest is invalid JSON',
			issues,
		};
	}

	// Validate against schema
	const result = MarketplaceSchema.safeParse(marketplaceData);
	if (!result.success) {
		for (const zodIssue of result.error.issues) {
			issues.push({
				severity: 'error',
				code: 'MARKETPLACE_INVALID_SCHEMA',
				message: zodIssue.message,
				location: `${marketplaceJsonPath}:${zodIssue.path.join('.')}`,
				fix: generateFixSuggestion(zodIssue),
			});
		}
	}

	const status = calculateValidationStatus(issues);

	const validationResult: ValidationResult = {
		path: marketplacePath,
		type: MARKETPLACE_TYPE,
		status,
		summary:
			status === 'success'
				? 'Valid marketplace'
				: `Found ${issues.length} issue(s)`,
		issues,
	};

	if (result.success) {
		const metadata: ValidationResult['metadata'] = {
			name: result.data.name,
		};

		if (result.data.metadata?.version) {
			metadata.version = result.data.metadata.version;
		}

		validationResult.metadata = metadata;
	}

	return validationResult;
}

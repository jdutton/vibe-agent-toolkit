/* eslint-disable security/detect-non-literal-fs-filename -- File paths are validated before use */
import { existsSync, readFileSync } from 'node:fs';

import { calculateValidationStatus, countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import { MarketplaceManifestSchema } from '../schemas/marketplace-manifest.js';

import { type AnchorRootOptions, resolveAnchorRoot } from './anchor-root.js';
import type { ValidationResult } from './types.js';
import { generateFixSuggestion } from './validation-utils.js';

const MARKETPLACE_TYPE = 'marketplace' as const;

/**
 * Validate a marketplace directory structure against the MarketplaceManifestSchema.
 *
 * @see https://code.claude.com/docs/en/plugins-reference — Official marketplace manifest spec
 * @param marketplacePath - Absolute path to marketplace directory
 * @param options - Anchor base for emitted locations (see {@link AnchorRootOptions})
 * @returns Validation result with issues
 */
export async function validateMarketplace(
	marketplacePath: string,
	options?: AnchorRootOptions,
): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];
	const marketplaceJsonPath = safePath.join(marketplacePath, '.claude-plugin', 'marketplace.json');
	// Anchor contract: relative to the run's ONE stated root, never absolute.
	const location = issueLocation(marketplaceJsonPath, resolveAnchorRoot(options?.locationRoot, marketplacePath));

	// Check marketplace.json exists
	if (!existsSync(marketplaceJsonPath)) {
		issues.push({
			severity: 'error',
			code: 'MARKETPLACE_MISSING_MANIFEST',
			message: 'Marketplace manifest not found',
			location,
			fix: 'Create .claude-plugin/marketplace.json with required fields (name, owner, plugins)',
		});

		return {
			path: marketplacePath,
			type: MARKETPLACE_TYPE,
			status: 'error',
			summary: 'Marketplace manifest missing',
			issues,
			issueCounts: countBySeverity(issues),
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
			location,
			fix: 'Fix JSON syntax errors in marketplace.json',
		});

		return {
			path: marketplacePath,
			type: MARKETPLACE_TYPE,
			status: 'error',
			summary: 'Marketplace manifest is invalid JSON',
			issues,
			issueCounts: countBySeverity(issues),
		};
	}

	// Validate against schema
	const result = MarketplaceManifestSchema.safeParse(marketplaceData);
	if (!result.success) {
		for (const zodIssue of result.error.issues) {
			issues.push({
				severity: 'error',
				code: 'MARKETPLACE_INVALID_SCHEMA',
				message: zodIssue.message,
				location,
				field: zodIssue.path.join('.'),
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
			status === 'success' ? 'Valid marketplace' : `Found ${issues.length} issue(s)`,
		issues,
		issueCounts: countBySeverity(issues),
	};

	if (result.success) {
		validationResult.metadata = {
			name: result.data.name,
			...(result.data.description !== undefined && { description: result.data.description }),
			...(result.data.version !== undefined && { version: result.data.version }),
		};
	}

	return validationResult;
}

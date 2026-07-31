import { countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { issueLocation } from '@vibe-agent-toolkit/utils';

import { type AnchorRootOptions, resolveAnchorRoot } from './anchor-root.js';
import { detectResourceFormat } from './format-detection.js';
import { validateMarketplace } from './marketplace-validator.js';
import {
	validateInstalledPluginsRegistry,
	validateKnownMarketplacesRegistry,
} from './registry-validator.js';
import type { ValidationResult } from './types.js';

/**
 * A single-error `unknown`-format result.
 *
 * Both call sites go through here so `issueCounts` is DERIVED from the issue
 * rather than hand-written beside it — a literal `{ errors: 1, ... }` is a
 * second copy of the same fact and can drift from the array it describes.
 */
function unknownFormatResult(
	path: string,
	summary: string,
	issue: ValidationIssue,
): ValidationResult {
	const issues = [issue];
	return {
		path,
		type: 'unknown',
		status: 'error',
		summary,
		issues,
		issueCounts: countBySeverity(issues),
	};
}

export interface UnifiedValidateOptions extends AnchorRootOptions {
	/**
	 * Validator for claude-plugin directories. Required when validating plugin
	 * paths. Receives the run's anchor base so the plugin lane reports in the
	 * same coordinate system as every other lane in the run.
	 */
	validatePlugin?: (path: string, options: AnchorRootOptions) => Promise<ValidationResult>;
}

class ProgrammerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProgrammerError';
	}
}

/**
 * Unified validation function that automatically detects resource type
 * and routes to the appropriate validator
 *
 * @param resourcePath - Path to the resource to validate (file or directory)
 * @param opts - Optional injectable validators (e.g. validatePlugin from claude-marketplace)
 * @returns ValidationResult with type-specific validation
 *
 * @example
 * ```typescript
 * // Validates a marketplace directory
 * const result = await validate('/path/to/marketplace');
 *
 * // Validates a plugin directory (requires injectable validatePlugin)
 * const result = await validate('/path/to/plugin', { validatePlugin });
 *
 * // Validates a registry file
 * const result = await validate('/path/to/installed_plugins.json');
 * ```
 */
export async function validate(resourcePath: string, opts?: UnifiedValidateOptions): Promise<ValidationResult> {
	// One anchor base for every lane this dispatcher can route to, so a single
	// run never reports two resources in two coordinate systems.
	const anchor: AnchorRootOptions = opts?.locationRoot === undefined
		? {}
		: { locationRoot: opts.locationRoot };
	const unknownLocation = issueLocation(
		resourcePath,
		resolveAnchorRoot(opts?.locationRoot, resourcePath),
	);

	try {
		// Detect resource format
		const format = await detectResourceFormat(resourcePath);

		// Route to appropriate validator based on detected format
		switch (format.type) {
			case 'claude-plugin':
				if (opts?.validatePlugin === undefined) {
					throw new ProgrammerError(
						'Plugin validation requires opts.validatePlugin to be injected. ' +
						'Pass validatePlugin from @vibe-agent-toolkit/claude-marketplace to validate().',
					);
				}
				return await opts.validatePlugin(format.path, anchor);

			case 'marketplace':
				return await validateMarketplace(format.path, anchor);

			case 'installed-plugins-registry':
				return await validateInstalledPluginsRegistry(format.path, anchor);

			case 'known-marketplaces-registry':
				return await validateKnownMarketplacesRegistry(format.path, anchor);

			case 'unknown':
				// Create ValidationResult for unknown format
				return unknownFormatResult(
					format.path,
					format.reason ?? 'Unknown resource format',
					{
						severity: 'error',
						code: 'UNKNOWN_FORMAT',
						message: format.reason ?? 'Unknown resource format',
						location: unknownLocation,
						fix: 'Ensure the path points to a valid plugin directory, marketplace directory, or registry file',
					},
				);

			default: {
				// TypeScript exhaustiveness check
				const _exhaustive: never = format;
				throw new Error(`Unhandled format type: ${JSON.stringify(_exhaustive)}`);
			}
		}
	} catch (error) {
		if (error instanceof ProgrammerError) {
			throw error;
		}

		// Defensive error handling: convert unexpected errors to ValidationResult
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error occurred';

		return unknownFormatResult(
			resourcePath,
			`Validation failed: ${errorMessage}`,
			{
				severity: 'error',
				code: 'UNKNOWN_FORMAT',
				message: errorMessage,
				location: unknownLocation,
			},
		);
	}
}

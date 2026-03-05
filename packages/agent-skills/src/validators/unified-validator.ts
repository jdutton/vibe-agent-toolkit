import { detectResourceFormat } from './format-detection.js';
import { validateMarketplace } from './marketplace-validator.js';
import { validatePlugin } from './plugin-validator.js';
import {
	validateInstalledPluginsRegistry,
	validateKnownMarketplacesRegistry,
} from './registry-validator.js';
import type { ValidationResult } from './types.js';

/**
 * Unified validation function that automatically detects resource type
 * and routes to the appropriate validator
 *
 * @param resourcePath - Path to the resource to validate (file or directory)
 * @returns ValidationResult with type-specific validation
 *
 * @example
 * ```typescript
 * // Validates a plugin directory
 * const result = await validate('/path/to/plugin');
 *
 * // Validates a marketplace directory
 * const result = await validate('/path/to/marketplace');
 *
 * // Validates a registry file
 * const result = await validate('/path/to/installed_plugins.json');
 * ```
 */
export async function validate(resourcePath: string): Promise<ValidationResult> {
	try {
		// Detect resource format
		const format = await detectResourceFormat(resourcePath);

		// Route to appropriate validator based on detected format
		switch (format.type) {
			case 'claude-plugin':
				return await validatePlugin(format.path);

			case 'marketplace':
				return await validateMarketplace(format.path);

			case 'installed-plugins-registry':
				return await validateInstalledPluginsRegistry(format.path);

			case 'known-marketplaces-registry':
				return await validateKnownMarketplacesRegistry(format.path);

			case 'unknown':
				// Create ValidationResult for unknown format
				return {
					path: format.path,
					type: 'unknown',
					status: 'error',
					summary: format.reason ?? 'Unknown resource format',
					issues: [
						{
							severity: 'error',
							code: 'UNKNOWN_FORMAT',
							message: format.reason ?? 'Unknown resource format',
							location: format.path,
							fix: 'Ensure the path points to a valid plugin directory, marketplace directory, or registry file',
						},
					],
				};

			default: {
				// TypeScript exhaustiveness check
				const _exhaustive: never = format;
				throw new Error(`Unhandled format type: ${JSON.stringify(_exhaustive)}`);
			}
		}
	} catch (error) {
		// Defensive error handling: convert unexpected errors to ValidationResult
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error occurred';

		return {
			path: resourcePath,
			type: 'unknown',
			status: 'error',
			summary: `Validation failed: ${errorMessage}`,
			issues: [
				{
					severity: 'error',
					code: 'UNKNOWN_FORMAT',
					message: errorMessage,
					location: resourcePath,
				},
			],
		};
	}
}

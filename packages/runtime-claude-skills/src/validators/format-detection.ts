/* eslint-disable security/detect-non-literal-fs-filename -- validation functions access controlled paths */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MarketplaceSchema } from '../schemas/marketplace.js';

import type { ResourceFormat } from './types.js';

/**
 * Detects the format of a resource at the given path
 *
 * Detection logic:
 * 1. Check if path exists
 * 2. If directory:
 *    - Check for .claude-plugin/plugin.json → plugin
 *    - Check for .claude-plugin/marketplace.json → marketplace
 *    - If both exist:
 *      • Check if marketplace has plugin with source: "./" (co-located pattern) → marketplace
 *      • Otherwise → unknown (truly ambiguous)
 * 3. If file:
 *    - Must have .json extension
 *    - Check filename: installed_plugins.json or known_marketplaces.json
 * 4. Otherwise → unknown
 *
 * Co-located plugin pattern: A marketplace that contains a plugin in the same directory
 * (source: "./" or ".") rather than in a subdirectory. This is valid for single-plugin
 * marketplaces and avoids unnecessary directory nesting.
 *
 * @param resourcePath - Path to the resource to detect
 * @returns ResourceFormat discriminated union
 */
export async function detectResourceFormat(
	resourcePath: string,
): Promise<ResourceFormat> {
	try {
		// Check if path exists
		const exists = fs.existsSync(resourcePath);
		if (!exists) {
			return {
				type: 'unknown',
				path: resourcePath,
				reason: 'Path does not exist',
			};
		}

		const stats = fs.statSync(resourcePath);

		// Handle directories
		if (stats.isDirectory()) {
			return detectDirectoryFormat(resourcePath);
		}

		// Handle files
		if (stats.isFile()) {
			return detectFileFormat(resourcePath);
		}

		// Neither file nor directory
		return {
			type: 'unknown',
			path: resourcePath,
			reason: 'Path is neither a file nor a directory',
		};
	} catch (error) {
		// Catch all errors (permission denied, etc.) and return unknown
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		return {
			type: 'unknown',
			path: resourcePath,
			reason: `Error accessing path: ${errorMessage}`,
		};
	}
}

/**
 * Detects format for directory resources
 */
function detectDirectoryFormat(dirPath: string): ResourceFormat {
	const claudePluginDir = path.join(dirPath, '.claude-plugin');

	// Check if .claude-plugin directory exists
	if (!fs.existsSync(claudePluginDir)) {
		return {
			type: 'unknown',
			path: dirPath,
			reason: 'Directory contains no .claude-plugin subdirectory',
		};
	}

	// Check for both plugin.json and marketplace.json
	const pluginJsonPath = path.join(claudePluginDir, 'plugin.json');
	const marketplaceJsonPath = path.join(claudePluginDir, 'marketplace.json');

	const hasPlugin = fs.existsSync(pluginJsonPath);
	const hasMarketplace = fs.existsSync(marketplaceJsonPath);

	// Both files exist - check if this is a co-located plugin pattern
	if (hasPlugin && hasMarketplace) {
		// Read marketplace.json to check for co-located plugin pattern
		try {
			const marketplaceContent = fs.readFileSync(marketplaceJsonPath, 'utf-8');
			const marketplaceData = JSON.parse(marketplaceContent);
			const parseResult = MarketplaceSchema.safeParse(marketplaceData);

			if (parseResult.success) {
				// Check if marketplace contains a plugin with source pointing to current directory
				const hasColocatedPlugin = parseResult.data.plugins.some((plugin) => {
					const source =
						typeof plugin.source === 'string'
							? plugin.source
							: plugin.source.url;
					// Check for various forms of "current directory" references
					return (
						source === './' ||
						source === '.' ||
						source === '.\\' ||
						source === ''
					);
				});

				// If marketplace has co-located plugin, treat as marketplace
				if (hasColocatedPlugin) {
					return {
						type: 'marketplace',
						path: dirPath,
					};
				}
			}
		} catch {
			// If we can't read/parse marketplace.json, fall through to ambiguous error
		}

		// Truly ambiguous - both files exist but not co-located pattern
		return {
			type: 'unknown',
			path: dirPath,
			reason:
				'Ambiguous: directory contains both plugin.json and marketplace.json (not co-located pattern)',
		};
	}

	// Plugin detected
	if (hasPlugin) {
		return {
			type: 'claude-plugin',
			path: dirPath,
		};
	}

	// Marketplace detected
	if (hasMarketplace) {
		return {
			type: 'marketplace',
			path: dirPath,
		};
	}

	// Has .claude-plugin directory but no recognized files
	return {
		type: 'unknown',
		path: dirPath,
		reason:
			'Directory has .claude-plugin subdirectory but no plugin.json or marketplace.json',
	};
}

/**
 * Detects format for file resources
 */
function detectFileFormat(filePath: string): ResourceFormat {
	const extension = path.extname(filePath);
	const filename = path.basename(filePath);

	// Only accept .json files
	if (extension !== '.json') {
		return {
			type: 'unknown',
			path: filePath,
			reason: 'Not a JSON file',
		};
	}

	// Check for recognized registry filenames (case-sensitive, exact match)
	if (filename === 'installed_plugins.json') {
		return {
			type: 'installed-plugins-registry',
			path: filePath,
			filename,
		};
	}

	if (filename === 'known_marketplaces.json') {
		return {
			type: 'known-marketplaces-registry',
			path: filePath,
			filename,
		};
	}

	// JSON file but not a recognized registry
	return {
		type: 'unknown',
		path: filePath,
		reason: 'JSON file but not a recognized registry',
	};
}

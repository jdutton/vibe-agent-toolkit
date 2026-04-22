/* eslint-disable security/detect-non-literal-fs-filename -- validation functions access controlled paths */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { ResourceFormat, Surface } from './types.js';

const CLAUDE_PLUGIN_DIR_NAME = '.claude-plugin';

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
	const claudePluginDir = safePath.join(dirPath, CLAUDE_PLUGIN_DIR_NAME);

	// Check if .claude-plugin directory exists
	if (!fs.existsSync(claudePluginDir)) {
		return {
			type: 'unknown',
			path: dirPath,
			reason: 'Directory contains no .claude-plugin subdirectory',
		};
	}

	// Check for both plugin.json and marketplace.json
	const pluginJsonPath = safePath.join(claudePluginDir, 'plugin.json');
	const marketplaceJsonPath = safePath.join(claudePluginDir, 'marketplace.json');

	const hasPlugin = fs.existsSync(pluginJsonPath);
	const hasMarketplace = fs.existsSync(marketplaceJsonPath);

	// Both files exist - check if this is a co-located plugin pattern
	if (hasPlugin && hasMarketplace) {
		// Read marketplace.json to check for co-located plugin pattern
		try {
			const marketplaceContent = fs.readFileSync(marketplaceJsonPath, 'utf-8');
			const marketplaceData = JSON.parse(marketplaceContent) as Record<string, unknown>;
			const plugins = marketplaceData['plugins'];

			if (Array.isArray(plugins)) {
				// Check if marketplace contains a plugin with source pointing to current directory
				const hasColocatedPlugin = plugins.some((plugin: unknown) => {
					if (typeof plugin !== 'object' || plugin === null) return false;
					const source = (plugin as Record<string, unknown>)['source'];
					// Only local path sources can be co-located; URL/GitHub sources are remote
					if (typeof source !== 'string') return false;
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

/**
 * Enumerate all manifest surfaces present at a directory's root layer.
 *
 * Unlike {@link detectResourceFormat} (single-answer), this returns every
 * recognized manifest found in the same directory. A skill-claude-plugin
 * (root SKILL.md + .claude-plugin/plugin.json) returns two surfaces; a
 * canonical plugin layout returns one (SKILL.md lives under skills/<name>/,
 * not at the plugin root, so no agent-skill surface at this level).
 *
 * Detection rules (independent, all applied):
 * - `<dir>/SKILL.md` exists → { type: 'agent-skill', path: <dir>/SKILL.md }
 * - `<dir>/.claude-plugin/plugin.json` exists → { type: 'claude-plugin', path: <dir> }
 * - `<dir>/.claude-plugin/marketplace.json` exists → { type: 'marketplace', path: <dir> }
 *
 * Returns `[]` for nonexistent paths, files, or directories with no recognized manifests.
 *
 * @param dirPath - Absolute path to a directory
 * @returns Array of surfaces in enumerator-stable order (skill, plugin, marketplace)
 */
export async function enumerateSurfaces(dirPath: string): Promise<Surface[]> {
	try {
		if (!fs.existsSync(dirPath)) {
			return [];
		}
		const stats = fs.statSync(dirPath);
		if (!stats.isDirectory()) {
			return [];
		}
	} catch {
		return [];
	}

	const surfaces: Surface[] = [];

	const skillPath = safePath.join(dirPath, 'SKILL.md');
	if (fs.existsSync(skillPath)) {
		surfaces.push({ type: 'agent-skill', path: skillPath });
	}

	const pluginJsonPath = safePath.join(dirPath, CLAUDE_PLUGIN_DIR_NAME, 'plugin.json');
	const marketplaceJsonPath = safePath.join(dirPath, CLAUDE_PLUGIN_DIR_NAME, 'marketplace.json');
	const hasPlugin = fs.existsSync(pluginJsonPath);
	const hasMarketplace = fs.existsSync(marketplaceJsonPath);

	// Co-located plugin/marketplace pattern: when both plugin.json and
	// marketplace.json are present AND the marketplace references the current
	// directory via `source: "./"`, detectResourceFormat collapses to a single
	// `marketplace` surface. Preserve that collapse here so a co-located
	// marketplace does not produce two parallel results (marketplace AND plugin).
	const isColocated = hasPlugin && hasMarketplace && hasColocatedPluginInMarketplace(marketplaceJsonPath);

	if (hasPlugin && !isColocated) {
		surfaces.push({ type: 'claude-plugin', path: dirPath });
	}

	if (hasMarketplace) {
		surfaces.push({ type: 'marketplace', path: dirPath });
	}

	return surfaces;
}

/**
 * Returns true when marketplace.json declares a plugin with `source` pointing
 * at the current directory (`./`, `.`, etc.), indicating a single-directory
 * marketplace that owns the co-located plugin.
 *
 * Best-effort: swallows read/parse errors (caller treats as "not co-located").
 */
function hasColocatedPluginInMarketplace(marketplaceJsonPath: string): boolean {
	try {
		const content = fs.readFileSync(marketplaceJsonPath, 'utf-8');
		const data = JSON.parse(content) as Record<string, unknown>;
		const plugins = data['plugins'];
		if (!Array.isArray(plugins)) {
			return false;
		}
		return plugins.some((plugin: unknown) => {
			if (typeof plugin !== 'object' || plugin === null) return false;
			const source = (plugin as Record<string, unknown>)['source'];
			if (typeof source !== 'string') return false;
			return source === './' || source === '.' || source === '.\\' || source === '';
		});
	} catch {
		return false;
	}
}

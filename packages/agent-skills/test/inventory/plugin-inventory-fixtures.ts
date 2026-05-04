import type { ComponentRef, HookRef, PluginInventory, SkillInventory } from '../../src/inventory/index.js';

/**
 * Shared factory helpers for PluginInventory detector tests.
 * Keep construction details here so detector test files stay focused on behavior.
 */

export function makeComponentRef(manifestPath: string, exists: boolean): ComponentRef {
	return { manifestPath, resolvedPath: `/abs/${manifestPath}`, exists };
}

export function makeHookRef(manifestPath: string, exists: boolean, inline?: object): HookRef {
	return { manifestPath, resolvedPath: `/abs/${manifestPath}`, exists, ...(inline ? { inline } : {}) };
}

/** Build a minimal PluginInventory, overriding any declared fields as needed. */
export function makePluginInventory(
	declaredOverrides: Partial<PluginInventory['declared']> = {},
	discoveredOverrides: Partial<PluginInventory['discovered']> = {},
	pluginOverrides: Partial<Omit<PluginInventory, 'declared' | 'discovered'>> = {},
): PluginInventory {
	return {
		kind: 'plugin',
		vendor: 'claude-code',
		path: '/home/user/plugins/my-plugin',
		parseErrors: [],
		manifest: { name: 'my-plugin', version: '1.0.0' },
		shape: 'claude-plugin',
		declared: {
			skills: null,
			commands: null,
			agents: null,
			hooks: null,
			mcpServers: null,
			outputStyles: null,
			lspServers: null,
			...declaredOverrides,
		},
		discovered: {
			skills: [],
			commands: [],
			agents: [],
			...discoveredOverrides,
		},
		references: [],
		unexpected: { skillManifests: [], pluginManifests: [] },
		...pluginOverrides,
	};
}

/** Build a minimal SkillInventory for tests that need one. */
export function makeSkillInventory(path: string, name = 'test-skill'): SkillInventory {
	return {
		kind: 'skill',
		vendor: 'claude-code',
		path,
		parseErrors: [],
		manifest: { name },
		files: { skillMd: path, linked: [], packaged: [] },
	};
}

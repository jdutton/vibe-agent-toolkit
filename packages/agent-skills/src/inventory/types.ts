/**
 * Vendor-neutral inventory interfaces.
 *
 * The inventory layer is a single structural source of truth: "what does
 * this artifact (plugin, marketplace, skill, install root) actually
 * contain?" Detectors consume these interfaces; they never re-walk the
 * filesystem.
 *
 * Concrete vendor implementations (e.g. ClaudePluginInventory) live in
 * vendor-specific packages.
 */

export type ParseError = {
	path: string;
	message: string;
	line?: number;
};

export type ComponentRef = {
	/** Path as written in the manifest (relative or absolute). */
	manifestPath: string;
	/** Resolved absolute, normalized path (POSIX forward slashes via safePath.resolve). */
	resolvedPath: string;
	exists: boolean;
};

export type HookRef = ComponentRef & {
	/** Set when the manifest declared an inline config rather than a path. */
	inline?: object;
};

export type McpRef = ComponentRef & {
	/** Set when the manifest declared an inline config rather than a path. */
	inline?: object;
};

export type LspRef = ComponentRef & {
	/** Set when the manifest declared an inline config rather than a path. */
	inline?: object;
};

export type PluginRef = ComponentRef & {
	source: 'path' | 'git' | 'npm' | 'unknown';
};

export type ResolvedReference = {
	/** Dotted path into the manifest, e.g. "hooks[0].script". */
	from: string;
	/** Resolved absolute path. */
	to: string;
	exists: boolean;
};

export interface BaseInventory {
	kind: 'marketplace' | 'plugin' | 'skill' | 'install';
	vendor: string;
	path: string;
	parseErrors: ParseError[];
}

export interface MarketplaceInventory extends BaseInventory {
	kind: 'marketplace';
	manifest: { name?: string; description?: string };
	declared: {
		plugins: PluginRef[];
	};
	discovered: {
		plugins: PluginInventory[];
	};
}

/** Tri-state declaration; null = manifest omitted the field, [] = explicit empty. */
export type DeclaredList<T> = T[] | null;

export interface PluginInventory extends BaseInventory {
	kind: 'plugin';
	manifest: { name?: string; version?: string; description?: string };
	shape: 'claude-plugin' | 'skill-claude-plugin';
	declared: {
		skills: DeclaredList<ComponentRef>;
		commands: DeclaredList<ComponentRef>;
		agents: DeclaredList<ComponentRef>;
		hooks: DeclaredList<HookRef>;
		mcpServers: DeclaredList<McpRef>;
		outputStyles: DeclaredList<ComponentRef>;
		lspServers: DeclaredList<LspRef>;
	};
	discovered: {
		skills: SkillInventory[];
		commands: ComponentRef[];
		agents: ComponentRef[];
	};
	references: ResolvedReference[];
	unexpected: {
		skillManifests: string[];
		pluginManifests: string[];
	};
}

export interface SkillInventory extends BaseInventory {
	kind: 'skill';
	manifest: { name: string; description?: string };
	files: {
		skillMd: string;
		linked: string[];
		packaged: string[];
	};
}

export interface InstallInventory extends BaseInventory {
	kind: 'install';
	installRoot: string;
	marketplaces: MarketplaceInventory[];
	plugins: PluginInventory[];
}

export type AnyInventory =
	| MarketplaceInventory
	| PluginInventory
	| SkillInventory
	| InstallInventory;

export const isPluginInventory = (v: { kind: string }): v is PluginInventory =>
	v.kind === 'plugin';

export const isSkillInventory = (v: { kind: string }): v is SkillInventory =>
	v.kind === 'skill';

export const isMarketplaceInventory = (v: { kind: string }): v is MarketplaceInventory =>
	v.kind === 'marketplace';

export const isInstallInventory = (v: { kind: string }): v is InstallInventory =>
	v.kind === 'install';
